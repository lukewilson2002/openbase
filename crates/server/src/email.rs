//! Outgoing email (invites, password resets, automation actions).
//!
//! Everything sends through the [`Mailer`] trait held in `AppState`:
//! - [`SmtpMailer`] when `smtp_host` is configured (lettre, rustls),
//! - [`NoopMailer`] otherwise: it logs that an email was skipped (never its
//!   body, which may contain a secret link),
//! - [`CapturingMailer`] in tests, so tests can read what would have been sent.
//!
//! Request handlers never wait on SMTP: [`send_in_background`] spawns the send,
//! so response times don't depend on whether an email went out (which would
//! leak whether an account exists) and a slow mail server can't stall the API.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::future::BoxFuture;
use lettre::message::Mailbox;
use lettre::message::header::ContentType;
use lettre::transport::smtp::authentication::Credentials;
use lettre::transport::smtp::client::{Tls, TlsParameters};
use lettre::{AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};

use crate::config::Config;
use crate::error::{AppError, AppResult};

/// A plain-text email sender.
pub trait Mailer: Send + Sync {
    /// Send one plain-text email to a single recipient.
    fn send<'a>(
        &'a self,
        to: &'a str,
        subject: &'a str,
        body: &'a str,
    ) -> BoxFuture<'a, AppResult<()>>;
}

/// Build the mailer for this configuration: SMTP when a host is set, else no-op.
pub fn from_config(config: &Config) -> AppResult<Arc<dyn Mailer>> {
    Ok(match &config.smtp_host {
        Some(_) => Arc::new(SmtpMailer::new(config)?),
        None => Arc::new(NoopMailer),
    })
}

/// Send an email without blocking the caller. Failures are logged (without
/// the body) and otherwise ignored.
pub fn send_in_background(mailer: Arc<dyn Mailer>, to: String, subject: String, body: String) {
    tokio::spawn(async move {
        if let Err(e) = mailer.send(&to, &subject, &body).await {
            tracing::warn!(to = %to, subject = %subject, error = %e, "failed to send email");
        }
    });
}

/// SMTP delivery via lettre.
pub struct SmtpMailer {
    transport: AsyncSmtpTransport<Tokio1Executor>,
    from: Mailbox,
}

impl SmtpMailer {
    /// Build the transport from `smtp_*` settings. Does not connect.
    pub fn new(config: &Config) -> AppResult<SmtpMailer> {
        let host = config
            .smtp_host
            .as_deref()
            .ok_or_else(|| AppError::internal("SMTP host is not configured"))?;
        let from: Mailbox = config.smtp_from.parse().map_err(|e| {
            AppError::internal(format!(
                "invalid OPENGRID_SMTP_FROM '{}': {e}",
                config.smtp_from
            ))
        })?;
        let tls = match config.smtp_security.as_str() {
            "starttls" => Tls::Required(tls_params(host)?),
            "tls" => Tls::Wrapper(tls_params(host)?),
            "none" => Tls::None,
            other => {
                return Err(AppError::internal(format!(
                    "invalid OPENGRID_SMTP_SECURITY '{other}' (expected starttls, tls or none)"
                )));
            }
        };
        let mut builder = AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(host)
            .port(config.smtp_port)
            .tls(tls)
            .timeout(Some(Duration::from_secs(20)));
        if let (Some(user), Some(pass)) = (&config.smtp_user, &config.smtp_password) {
            builder = builder.credentials(Credentials::new(user.clone(), pass.clone()));
        }
        Ok(SmtpMailer {
            transport: builder.build(),
            from,
        })
    }
}

fn tls_params(host: &str) -> AppResult<TlsParameters> {
    TlsParameters::new(host.to_string()).map_err(AppError::internal)
}

impl Mailer for SmtpMailer {
    fn send<'a>(
        &'a self,
        to: &'a str,
        subject: &'a str,
        body: &'a str,
    ) -> BoxFuture<'a, AppResult<()>> {
        Box::pin(async move {
            let to: Mailbox = to
                .parse()
                .map_err(|e| AppError::bad_request(format!("invalid recipient address: {e}")))?;
            let message = Message::builder()
                .from(self.from.clone())
                .to(to)
                .subject(subject)
                .header(ContentType::TEXT_PLAIN)
                .body(body.to_string())
                .map_err(AppError::internal)?;
            self.transport
                .send(message)
                .await
                .map_err(AppError::internal)?;
            Ok(())
        })
    }
}

/// Used when SMTP is not configured: records that an email was skipped.
pub struct NoopMailer;

impl Mailer for NoopMailer {
    fn send<'a>(
        &'a self,
        to: &'a str,
        subject: &'a str,
        _body: &'a str,
    ) -> BoxFuture<'a, AppResult<()>> {
        Box::pin(async move {
            tracing::info!(to = %to, subject = %subject, "email not sent: SMTP is not configured");
            Ok(())
        })
    }
}

/// One email captured by [`CapturingMailer`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SentEmail {
    pub to: String,
    pub subject: String,
    pub body: String,
}

/// Test mailer that keeps every email in memory.
#[derive(Default)]
pub struct CapturingMailer {
    sent: Mutex<Vec<SentEmail>>,
}

impl CapturingMailer {
    /// Everything sent so far, oldest first.
    pub fn sent(&self) -> Vec<SentEmail> {
        self.sent.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }

    /// Wait (up to ~2 s) until at least `n` emails were sent; returns them.
    /// Needed because handlers send in the background.
    pub async fn wait_for(&self, n: usize) -> Vec<SentEmail> {
        for _ in 0..200 {
            let sent = self.sent();
            if sent.len() >= n {
                return sent;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        self.sent()
    }
}

impl Mailer for CapturingMailer {
    fn send<'a>(
        &'a self,
        to: &'a str,
        subject: &'a str,
        body: &'a str,
    ) -> BoxFuture<'a, AppResult<()>> {
        Box::pin(async move {
            self.sent
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .push(SentEmail {
                    to: to.to_string(),
                    subject: subject.to_string(),
                    body: body.to_string(),
                });
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> Config {
        let mut c = Config::for_tests(std::path::Path::new("/tmp/unused"));
        c.smtp_host = Some("smtp.example.com".into());
        c
    }

    #[test]
    fn builds_smtp_mailer_for_each_security_mode() {
        for mode in ["starttls", "tls", "none"] {
            let mut c = config();
            c.smtp_security = mode.into();
            assert!(SmtpMailer::new(&c).is_ok(), "mode {mode}");
        }
    }

    #[test]
    fn rejects_bad_smtp_settings() {
        let mut c = config();
        c.smtp_security = "ssl3".into();
        assert!(SmtpMailer::new(&c).is_err());
        let mut c = config();
        c.smtp_from = "not an address".into();
        assert!(SmtpMailer::new(&c).is_err());
    }

    #[test]
    fn from_config_picks_noop_without_host() {
        let c = Config::for_tests(std::path::Path::new("/tmp/unused"));
        assert!(from_config(&c).is_ok());
    }

    #[tokio::test]
    async fn capturing_mailer_records_and_background_send_delivers() {
        let m = Arc::new(CapturingMailer::default());
        m.send("a@example.com", "Hi", "Body").await.unwrap();
        send_in_background(m.clone(), "b@example.com".into(), "S".into(), "B".into());
        let sent = m.wait_for(2).await;
        assert_eq!(sent.len(), 2);
        assert_eq!(sent[0].to, "a@example.com");
        assert_eq!(sent[1].subject, "S");
    }

    #[tokio::test]
    async fn noop_mailer_succeeds() {
        NoopMailer.send("a@example.com", "s", "b").await.unwrap();
    }
}
