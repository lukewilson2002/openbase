//! A small fake SMTP server for the transport tests: plain, STARTTLS (what Resend calls ports
//! 25/587/2587) or implicit TLS (465/2465), with `AUTH PLAIN` / `AUTH LOGIN` against one expected
//! username and password. It records the sign-ins it saw and the messages it accepted, so a test
//! can assert that the credentials really reached the server.
#![allow(dead_code)]

use std::sync::{Arc, Mutex};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;
use tokio_rustls::TlsAcceptor;
use tokio_rustls::rustls::ServerConfig;
use tokio_rustls::rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    /// No TLS at all.
    Plain,
    /// Plain greeting, `STARTTLS` offered and then required before `AUTH`.
    StartTls,
    /// TLS from the first byte.
    Implicit,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Mail {
    pub from: String,
    pub to: Vec<String>,
    pub data: String,
}

#[derive(Default)]
pub struct Seen {
    pub connections: usize,
    /// `(username, password, accepted)` for each AUTH attempt.
    pub auths: Vec<(String, String, bool)>,
    pub mails: Vec<Mail>,
    /// The name each client gave in EHLO.
    pub ehlo_names: Vec<String>,
}

pub struct FakeSmtp {
    pub port: u16,
    /// The throwaway CA/server certificate (DER), to be trusted by the client.
    pub cert_der: Vec<u8>,
    seen: Arc<Mutex<Seen>>,
}

impl FakeSmtp {
    pub fn with<R>(&self, f: impl FnOnce(&Seen) -> R) -> R {
        f(&self.seen.lock().unwrap())
    }
}

/// A self-signed certificate for `localhost` / `127.0.0.1`, as (DER certificate, DER PKCS#8 key).
pub fn self_signed() -> (Vec<u8>, Vec<u8>) {
    let ck =
        rcgen::generate_simple_self_signed(vec!["localhost".into(), "127.0.0.1".into()]).unwrap();
    (ck.cert.der().to_vec(), ck.signing_key.serialize_der())
}

/// Start a server on a free loopback port that accepts exactly `user` / `password`.
pub async fn start(mode: Mode, user: &str, password: &str) -> FakeSmtp {
    start_on(0, mode, user, password).await
}

/// [`start`] on a given port (0: any free one), for tests about well-known provider ports.
pub async fn start_on(port: u16, mode: Mode, user: &str, password: &str) -> FakeSmtp {
    let listener = TcpListener::bind(("127.0.0.1", port)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let (cert_der, key_der) = self_signed();
    let acceptor = {
        let provider = Arc::new(tokio_rustls::rustls::crypto::aws_lc_rs::default_provider());
        let config = ServerConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_no_client_auth()
            .with_single_cert(
                vec![CertificateDer::from(cert_der.clone())],
                PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key_der)),
            )
            .unwrap();
        TlsAcceptor::from(Arc::new(config))
    };
    let seen = Arc::new(Mutex::new(Seen::default()));
    let (user, password) = (user.to_string(), password.to_string());
    let task_seen = seen.clone();
    tokio::spawn(async move {
        loop {
            let Ok((sock, _)) = listener.accept().await else {
                return;
            };
            task_seen.lock().unwrap().connections += 1;
            let (acceptor, seen) = (acceptor.clone(), task_seen.clone());
            let (user, password) = (user.clone(), password.clone());
            tokio::spawn(async move {
                let creds = (user, password);
                match mode {
                    Mode::Plain => {
                        let _ = session(sock, mode, false, None, &creds, &seen).await;
                    }
                    Mode::Implicit => {
                        if let Ok(tls) = acceptor.accept(sock).await {
                            let _ = session(tls, mode, true, None, &creds, &seen).await;
                        }
                    }
                    Mode::StartTls => {
                        let _ = starttls_session(sock, acceptor, &creds, &seen).await;
                    }
                }
            });
        }
    });
    FakeSmtp {
        port,
        cert_der,
        seen,
    }
}

async fn starttls_session(
    sock: tokio::net::TcpStream,
    acceptor: TlsAcceptor,
    creds: &(String, String),
    seen: &Arc<Mutex<Seen>>,
) -> std::io::Result<()> {
    match session(sock, Mode::StartTls, false, None, creds, seen).await? {
        Next::Upgrade(sock) => {
            let tls = acceptor.accept(sock).await?;
            session(tls, Mode::StartTls, true, Some(()), creds, seen).await?;
        }
        Next::Done => {}
    }
    Ok(())
}

enum Next<S> {
    Done,
    Upgrade(S),
}

/// Serve one connection (or the second, encrypted half of a STARTTLS one).
async fn session<S>(
    stream: S,
    mode: Mode,
    encrypted: bool,
    resumed: Option<()>,
    creds: &(String, String),
    seen: &Arc<Mutex<Seen>>,
) -> std::io::Result<Next<S>>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let mut reader = BufReader::new(stream);
    if resumed.is_none() {
        reader
            .get_mut()
            .write_all(b"220 fake.smtp.test ESMTP ready\r\n")
            .await?;
    }
    let mut authed = false;
    let mut from = String::new();
    let mut to: Vec<String> = Vec::new();
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).await? == 0 {
            return Ok(Next::Done);
        }
        let line = line.trim_end().to_string();
        let up = line.to_ascii_uppercase();
        let w = reader.get_mut();
        if up.starts_with("EHLO") {
            seen.lock()
                .unwrap()
                .ehlo_names
                .push(line[4..].trim().to_string());
            let mut r = String::from("250-fake.smtp.test greets you\r\n250-8BITMIME\r\n");
            if mode == Mode::StartTls && !encrypted {
                r.push_str("250-STARTTLS\r\n");
            }
            if encrypted || mode == Mode::Plain {
                r.push_str("250-AUTH PLAIN LOGIN\r\n");
            }
            r.push_str("250 SIZE 10485760\r\n");
            w.write_all(r.as_bytes()).await?;
        } else if up.starts_with("HELO") {
            w.write_all(b"250 fake.smtp.test\r\n").await?;
        } else if up == "STARTTLS" && mode == Mode::StartTls && !encrypted {
            w.write_all(b"220 2.0.0 ready to start TLS\r\n").await?;
            return Ok(Next::Upgrade(reader.into_inner()));
        } else if up.starts_with("AUTH PLAIN") {
            let mut payload = line[10..].trim().to_string();
            if payload.is_empty() {
                w.write_all(b"334 \r\n").await?;
                let mut l = String::new();
                reader.read_line(&mut l).await?;
                payload = l.trim().to_string();
            }
            let decoded = B64.decode(payload).unwrap_or_default();
            let mut parts = decoded.split(|b| *b == 0);
            let _authzid = parts.next();
            let u = String::from_utf8_lossy(parts.next().unwrap_or_default()).to_string();
            let p = String::from_utf8_lossy(parts.next().unwrap_or_default()).to_string();
            authed = record_auth(seen, creds, u, p);
            let reply: &[u8] = if authed {
                b"235 2.7.0 Authentication successful\r\n"
            } else {
                b"535 5.7.8 Authentication credentials invalid\r\n"
            };
            reader.get_mut().write_all(reply).await?;
        } else if up.starts_with("AUTH LOGIN") {
            let w = reader.get_mut();
            w.write_all(b"334 VXNlcm5hbWU6\r\n").await?;
            let mut l = String::new();
            reader.read_line(&mut l).await?;
            let u = String::from_utf8_lossy(&B64.decode(l.trim()).unwrap_or_default()).to_string();
            reader.get_mut().write_all(b"334 UGFzc3dvcmQ6\r\n").await?;
            let mut l = String::new();
            reader.read_line(&mut l).await?;
            let p = String::from_utf8_lossy(&B64.decode(l.trim()).unwrap_or_default()).to_string();
            authed = record_auth(seen, creds, u, p);
            let reply: &[u8] = if authed {
                b"235 2.7.0 Authentication successful\r\n"
            } else {
                b"535 5.7.8 Authentication credentials invalid\r\n"
            };
            reader.get_mut().write_all(reply).await?;
        } else if up.starts_with("MAIL FROM") {
            if !authed {
                w.write_all(b"530 5.7.0 Authentication required\r\n")
                    .await?;
            } else {
                from = line[10..].trim().to_string();
                to.clear();
                w.write_all(b"250 2.1.0 ok\r\n").await?;
            }
        } else if up.starts_with("RCPT TO") {
            to.push(line[8..].trim().to_string());
            w.write_all(b"250 2.1.5 ok\r\n").await?;
        } else if up == "DATA" {
            w.write_all(b"354 end data with <CRLF>.<CRLF>\r\n").await?;
            let mut data = String::new();
            loop {
                let mut l = String::new();
                if reader.read_line(&mut l).await? == 0 {
                    return Ok(Next::Done);
                }
                if l.trim_end() == "." {
                    break;
                }
                data.push_str(&l);
            }
            seen.lock().unwrap().mails.push(Mail {
                from: from.clone(),
                to: to.clone(),
                data,
            });
            reader.get_mut().write_all(b"250 2.0.0 queued\r\n").await?;
        } else if up == "QUIT" {
            w.write_all(b"221 2.0.0 bye\r\n").await?;
            return Ok(Next::Done);
        } else if up == "RSET" || up == "NOOP" {
            w.write_all(b"250 ok\r\n").await?;
        } else {
            w.write_all(b"502 5.5.2 command not recognised\r\n").await?;
        }
    }
}

fn record_auth(
    seen: &Arc<Mutex<Seen>>,
    creds: &(String, String),
    user: String,
    password: String,
) -> bool {
    let ok = user == creds.0 && password == creds.1;
    seen.lock().unwrap().auths.push((user, password, ok));
    ok
}
