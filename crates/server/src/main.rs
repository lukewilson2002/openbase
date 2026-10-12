//! `opengrid` command-line entry point: the server and its admin commands.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::time::Duration;

use clap::{Parser, Subcommand};
use opengrid::config::Config;
use opengrid::state::AppState;

#[derive(Parser)]
#[command(name = "opengrid", version, about = "Self-hosted Airtable alternative")]
struct Cli {
    #[command(flatten)]
    config: Config,
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
enum Command {
    /// Run the web server (default).
    Serve,
    /// Apply database migrations and exit.
    Migrate,
    /// Create an administrator account.
    CreateAdmin {
        #[arg(long)]
        email: String,
        #[arg(long)]
        name: String,
        /// Read from OPENGRID_ADMIN_PASSWORD if not given.
        #[arg(long, env = "OPENGRID_ADMIN_PASSWORD", hide_env_values = true)]
        password: String,
    },
    /// Set a new password for a user and sign them out everywhere.
    ResetPassword {
        #[arg(long)]
        email: String,
        #[arg(long, env = "OPENGRID_NEW_PASSWORD", hide_env_values = true)]
        password: String,
    },
    /// Turn off two-factor authentication for a user who lost their
    /// authenticator, and sign them out everywhere.
    #[command(name = "disable-2fa")]
    Disable2fa {
        #[arg(long)]
        email: String,
    },
    /// Write a consistent backup archive (database + attachments).
    Backup {
        /// Output file (.tar.gz). Defaults to <data_dir>/backups/opengrid-<timestamp>.tar.gz
        #[arg(long)]
        out: Option<std::path::PathBuf>,
    },
    /// Check that the server on OPENGRID_BIND answers /api/health (exit 0) or
    /// not (exit 1). Used by the Docker HEALTHCHECK.
    Healthcheck,
    /// Restore a backup archive into the data directory. The server must be stopped.
    Restore {
        archive: std::path::PathBuf,
        /// Overwrite an existing database.
        #[arg(long)]
        force: bool,
    },
}

fn init_tracing(format: &str) {
    let filter = tracing_subscriber::EnvFilter::try_from_env("OPENGRID_LOG")
        .unwrap_or_else(|_| "info,tower_http=info".into());
    let builder = tracing_subscriber::fmt().with_env_filter(filter);
    if format == "json" {
        builder.json().init()
    } else {
        builder.init()
    }
}

/// Clear a user's TOTP secret and revoke their sessions (lost authenticator).
fn disable_two_factor(state: &AppState, email: &str) -> opengrid::error::AppResult<()> {
    let email = email.trim().to_string();
    state.db.write_sync(|tx| {
        let id: String = tx
            .query_row("SELECT id FROM users WHERE email = ?1", [&email], |r| {
                r.get(0)
            })
            .map_err(|_| opengrid::error::AppError::not_found("user"))?;
        tx.execute(
            "UPDATE users SET totp_enabled = 0, totp_secret = NULL, updated_at = ?1 WHERE id = ?2",
            rusqlite::params![opengrid::db::now_ms(), id],
        )?;
        opengrid::auth::session::delete_all_for_user(tx, &id, None)?;
        Ok(())
    })
}

/// Timeout for each step of the health check (connect, write, read).
const HEALTHCHECK_TIMEOUT: Duration = Duration::from_secs(3);

/// The address to probe for a listen address: wildcard binds (0.0.0.0, [::])
/// are probed on the loopback address of the same family.
fn health_target(bind: &str) -> Result<SocketAddr, String> {
    let addr = match bind.parse::<SocketAddr>() {
        Ok(a) => a,
        Err(_) => bind
            .to_socket_addrs()
            .map_err(|e| format!("cannot resolve {bind}: {e}"))?
            .next()
            .ok_or_else(|| format!("cannot resolve {bind}"))?,
    };
    let ip = match addr.ip() {
        std::net::IpAddr::V4(v4) if v4.is_unspecified() => std::net::Ipv4Addr::LOCALHOST.into(),
        std::net::IpAddr::V6(v6) if v6.is_unspecified() => std::net::Ipv6Addr::LOCALHOST.into(),
        ip => ip,
    };
    Ok(SocketAddr::new(ip, addr.port()))
}

/// `GET /api/health` over a plain TCP connection (no HTTP client dependency);
/// Ok only for a 200 response.
fn healthcheck(bind: &str, timeout: Duration) -> Result<(), String> {
    let addr = health_target(bind)?;
    let mut stream =
        TcpStream::connect_timeout(&addr, timeout).map_err(|e| format!("connect {addr}: {e}"))?;
    stream
        .set_read_timeout(Some(timeout))
        .and_then(|_| stream.set_write_timeout(Some(timeout)))
        .map_err(|e| e.to_string())?;
    let request = format!("GET /api/health HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\n\r\n");
    stream
        .write_all(request.as_bytes())
        .map_err(|e| format!("send: {e}"))?;
    let mut buf = Vec::with_capacity(256);
    let mut chunk = [0u8; 256];
    while !buf.windows(2).any(|w| w == b"\r\n") && buf.len() < 4096 {
        let n = stream.read(&mut chunk).map_err(|e| format!("read: {e}"))?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
    }
    let text = String::from_utf8_lossy(&buf);
    let status_line = text.lines().next().unwrap_or_default();
    let code = status_line.split_whitespace().nth(1).unwrap_or_default();
    if status_line.starts_with("HTTP/1.") && code == "200" {
        Ok(())
    } else if status_line.is_empty() {
        Err("empty response".into())
    } else {
        Err(format!("unexpected response: {status_line}"))
    }
}

fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    if matches!(cli.command, Some(Command::Healthcheck)) {
        match healthcheck(&cli.config.bind, HEALTHCHECK_TIMEOUT) {
            Ok(()) => std::process::exit(0),
            Err(e) => {
                eprintln!("unhealthy: {e}");
                std::process::exit(1);
            }
        }
    }
    init_tracing(&cli.config.log_format);
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .max_blocking_threads(16)
        .build()?;
    rt.block_on(run(cli))
}

async fn run(cli: Cli) -> anyhow::Result<()> {
    let config = cli.config;
    match cli.command.unwrap_or(Command::Serve) {
        Command::Serve => opengrid::serve(config).await,
        Command::Migrate => {
            AppState::open(config)?;
            println!(
                "database is at schema version {}",
                opengrid::db::schema_version()
            );
            Ok(())
        }
        Command::CreateAdmin {
            email,
            name,
            password,
        } => {
            let state = AppState::open(config)?;
            let id = opengrid::cli::create_admin(&state, &email, &name, &password)?;
            println!("created administrator {email} ({id})");
            Ok(())
        }
        Command::Disable2fa { email } => {
            let state = AppState::open(config)?;
            disable_two_factor(&state, &email)?;
            println!("two-factor authentication disabled for {email}; all sessions revoked");
            Ok(())
        }
        Command::ResetPassword { email, password } => {
            let state = AppState::open(config)?;
            opengrid::cli::reset_password(&state, &email, &password)?;
            println!("password updated for {email}; all sessions revoked");
            Ok(())
        }
        Command::Backup { out } => {
            let state = AppState::open(config)?;
            let path = opengrid::backup::create(&state, out.as_deref())?;
            println!("backup written to {}", path.display());
            Ok(())
        }
        // Handled in main() before the runtime starts.
        Command::Healthcheck => Ok(()),
        Command::Restore { archive, force } => {
            opengrid::backup::restore(&config, &archive, force)?;
            println!(
                "restored {} into {}",
                archive.display(),
                config.data_dir.display()
            );
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    /// Serve one connection with a canned response; returns the bind address.
    fn one_shot_server(response: &'static [u8]) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            if let Ok((mut s, _)) = listener.accept() {
                let mut buf = [0u8; 1024];
                let n = s.read(&mut buf).unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]).into_owned();
                if req.starts_with("GET /api/health HTTP/1.1\r\n") {
                    let _ = s.write_all(response);
                }
            }
        });
        addr.to_string()
    }

    #[test]
    fn healthy_on_200() {
        let bind = one_shot_server(b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok");
        assert_eq!(healthcheck(&bind, Duration::from_secs(3)), Ok(()));
    }

    #[test]
    fn unhealthy_on_error_status_or_garbage() {
        let bind = one_shot_server(b"HTTP/1.1 500 Internal Server Error\r\n\r\n");
        assert!(healthcheck(&bind, Duration::from_secs(3)).is_err());
        let bind = one_shot_server(b"NOT-HTTP banner\r\n");
        assert!(healthcheck(&bind, Duration::from_secs(3)).is_err());
        let bind = one_shot_server(b"");
        assert!(healthcheck(&bind, Duration::from_secs(3)).is_err());
    }

    #[test]
    fn unhealthy_when_nothing_listens() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let bind = listener.local_addr().unwrap().to_string();
        drop(listener);
        assert!(healthcheck(&bind, Duration::from_secs(3)).is_err());
    }

    #[test]
    fn times_out_on_silent_server() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let bind = listener.local_addr().unwrap().to_string();
        let start = std::time::Instant::now();
        assert!(healthcheck(&bind, Duration::from_millis(300)).is_err());
        assert!(start.elapsed() < Duration::from_secs(3));
        drop(listener);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn healthy_against_the_real_server() {
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::open(Config::for_tests(dir.path())).unwrap();
        let app = opengrid::http::router(state);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let bind = listener.local_addr().unwrap().to_string();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        let res = tokio::task::spawn_blocking(move || healthcheck(&bind, Duration::from_secs(3)))
            .await
            .unwrap();
        assert_eq!(res, Ok(()));
    }

    #[test]
    fn disable_two_factor_clears_secret_and_sessions() {
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::open(Config::for_tests(dir.path())).unwrap();
        state
            .db
            .write_sync(|tx| {
                tx.execute(
                    "INSERT INTO users (id, email, name, password_hash, totp_secret, totp_enabled, created_at, updated_at)
                     VALUES ('usr1', 'a@example.com', 'A', 'x', 'SECRET', 1, 0, 0)",
                    [],
                )?;
                opengrid::auth::session::create(tx, "usr1", false, None, None)?;
                Ok(())
            })
            .unwrap();
        disable_two_factor(&state, " A@example.com ").unwrap();
        let (enabled, secret, sessions): (bool, Option<String>, i64) = state
            .db
            .write_sync(|tx| {
                Ok(tx.query_row(
                    "SELECT totp_enabled, totp_secret, (SELECT count(*) FROM sessions) FROM users",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )?)
            })
            .unwrap();
        assert!(!enabled);
        assert_eq!(secret, None);
        assert_eq!(sessions, 0);
        assert!(disable_two_factor(&state, "nobody@example.com").is_err());
    }

    #[test]
    fn wildcard_binds_probe_loopback() {
        assert_eq!(
            health_target("0.0.0.0:8080").unwrap(),
            "127.0.0.1:8080".parse().unwrap()
        );
        assert_eq!(
            health_target("[::]:9000").unwrap(),
            "[::1]:9000".parse().unwrap()
        );
        assert_eq!(
            health_target("10.0.0.5:80").unwrap(),
            "10.0.0.5:80".parse().unwrap()
        );
        assert!(health_target("not an address").is_err());
    }
}
