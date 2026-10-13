//! Outgoing email (invites, password resets, automation actions, the admin's test email).
//!
//! Everything sends through the [`Mailer`] trait held in `AppState`:
//! - [`SmtpMailer`] when an SMTP host is configured (lettre, rustls),
//! - [`NoopMailer`] otherwise: it logs that an email was skipped (never its
//!   body, which may contain a secret link),
//! - [`CapturingMailer`] in tests, so tests can read what would have been sent.
//!
//! `AppState::mailer` is the [`EmailService`], which sends through whichever of those matches the
//! *current* settings, so an administrator's change on the Admin -> Email page takes effect at
//! once, without a restart. The settings are layered per field: an `OPENBASE_SMTP_*` environment
//! variable (or command-line flag) that is set wins and is read-only on that page; otherwise the
//! value saved there (the `settings` table, see `store::email_settings`); otherwise the default.
//!
//! Request handlers never wait on SMTP: [`send_in_background`] spawns the send,
//! so response times don't depend on whether an email went out (which would
//! leak whether an account exists) and a slow mail server can't stall the API.

use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use futures::future::BoxFuture;
use lettre::message::Mailbox;
use lettre::message::header::ContentType;
use lettre::transport::smtp::authentication::Credentials;
use lettre::transport::smtp::client::{Tls, TlsParameters};
use lettre::{AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};
use ob_core::api::email::source;

use crate::config::Config;
use crate::error::{AppError, AppResult};
use crate::ratelimit::RateLimiter;

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

pub const DEFAULT_PORT: u16 = 587;
pub const DEFAULT_FROM: &str = "OpenBase <openbase@localhost>";

/// How the connection to the SMTP server is secured.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SmtpSecurity {
    /// Plain connection upgraded with STARTTLS (required, usually port 587).
    StartTls,
    /// TLS from the first byte (usually port 465).
    Tls,
    /// No encryption (a relay on the same machine or network only).
    None,
}

impl SmtpSecurity {
    pub fn parse(s: &str) -> AppResult<SmtpSecurity> {
        match s.trim().to_ascii_lowercase().as_str() {
            "starttls" => Ok(SmtpSecurity::StartTls),
            "tls" => Ok(SmtpSecurity::Tls),
            "none" => Ok(SmtpSecurity::None),
            other => Err(AppError::bad_request(format!(
                "invalid SMTP security '{other}' (expected starttls, tls or none)"
            ))),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            SmtpSecurity::StartTls => "starttls",
            SmtpSecurity::Tls => "tls",
            SmtpSecurity::None => "none",
        }
    }
}

/// A complete, effective SMTP configuration (there is a host).
#[derive(Clone, PartialEq, Eq)]
pub struct SmtpSettings {
    pub host: String,
    pub port: u16,
    pub security: SmtpSecurity,
    pub user: Option<String>,
    pub password: Option<String>,
    pub from: String,
}

// The password must never reach a log line or a panic message.
impl std::fmt::Debug for SmtpSettings {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SmtpSettings")
            .field("host", &self.host)
            .field("port", &self.port)
            .field("security", &self.security)
            .field("user", &self.user)
            .field("password", &self.password.as_ref().map(|_| "<set>"))
            .field("from", &self.from)
            .finish()
    }
}

/// The settings fields as optional, raw values: what the environment provides, or what is stored.
#[derive(Clone, Default, PartialEq, Eq)]
pub struct RawSmtp {
    pub host: Option<String>,
    pub port: Option<u16>,
    pub security: Option<String>,
    pub user: Option<String>,
    pub password: Option<String>,
    pub from: Option<String>,
}

impl std::fmt::Debug for RawSmtp {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RawSmtp")
            .field("host", &self.host)
            .field("port", &self.port)
            .field("security", &self.security)
            .field("user", &self.user)
            .field("password", &self.password.as_ref().map(|_| "<set>"))
            .field("from", &self.from)
            .finish()
    }
}

/// Blank values count as not set (an empty `OPENBASE_SMTP_USER=` in an env file must not lock
/// the field).
fn non_blank(v: &Option<String>) -> Option<String> {
    v.as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

impl RawSmtp {
    /// What `OPENBASE_SMTP_*` (or the command-line flags) provide.
    pub fn from_config(config: &Config) -> RawSmtp {
        RawSmtp {
            host: non_blank(&config.smtp_host),
            port: config.smtp_port,
            security: non_blank(&config.smtp_security),
            user: non_blank(&config.smtp_user),
            // A password may have meaningful spaces: only an empty one counts as unset.
            password: config.smtp_password.clone().filter(|p| !p.is_empty()),
            from: non_blank(&config.smtp_from),
        }
    }
}

/// Which layer each effective setting comes from (`ob_core::api::email::source`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Sources {
    pub host: &'static str,
    pub port: &'static str,
    pub security: &'static str,
    pub user: &'static str,
    pub password: &'static str,
    pub from: &'static str,
}

/// The effective settings and where each field comes from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Resolved {
    /// `None` when there is no host: email is off.
    pub smtp: Option<SmtpSettings>,
    pub sources: Sources,
    /// Effective values even without a host, for display.
    pub port: u16,
    pub security: SmtpSecurity,
    pub from: String,
    pub user: Option<String>,
    pub password_set: bool,
}

/// Layer the settings: environment over stored over default. An invalid `security` or `from`
/// (from either layer) is an error.
pub fn resolve(env: &RawSmtp, stored: &RawSmtp) -> AppResult<Resolved> {
    fn pick<T>(env: Option<T>, stored: Option<T>, none: &'static str) -> (Option<T>, &'static str) {
        match (env, stored) {
            (Some(v), _) => (Some(v), source::ENVIRONMENT),
            (None, Some(v)) => (Some(v), source::SETTINGS),
            (None, None) => (None, none),
        }
    }
    let (host, host_src) = pick(non_blank(&env.host), non_blank(&stored.host), source::UNSET);
    let (port, port_src) = pick(env.port, stored.port, source::DEFAULT);
    let (security, security_src) = pick(
        non_blank(&env.security),
        non_blank(&stored.security),
        source::DEFAULT,
    );
    let (user, user_src) = pick(non_blank(&env.user), non_blank(&stored.user), source::UNSET);
    let (password, password_src) = pick(
        env.password.clone().filter(|p| !p.is_empty()),
        stored.password.clone().filter(|p| !p.is_empty()),
        source::UNSET,
    );
    let (from, from_src) = pick(
        non_blank(&env.from),
        non_blank(&stored.from),
        source::DEFAULT,
    );

    let security = match &security {
        Some(s) => SmtpSecurity::parse(s)?,
        None => SmtpSecurity::StartTls,
    };
    let from = from.unwrap_or_else(|| DEFAULT_FROM.to_string());
    from.parse::<Mailbox>()
        .map_err(|e| AppError::bad_request(format!("invalid sender address '{from}': {e}")))?;
    let port = port.unwrap_or(DEFAULT_PORT);
    let sources = Sources {
        host: host_src,
        port: port_src,
        security: security_src,
        user: user_src,
        password: password_src,
        from: from_src,
    };
    let smtp = host.map(|host| SmtpSettings {
        host,
        port,
        security,
        user: user.clone(),
        password: password.clone(),
        from: from.clone(),
    });
    Ok(Resolved {
        smtp,
        sources,
        port,
        security,
        from,
        user,
        password_set: password.is_some(),
    })
}

/// Builds the transport for a configuration. Production builds [`SmtpMailer`]; tests install a
/// capturing mailer.
pub type MailerFactory = Arc<dyn Fn(&SmtpSettings) -> AppResult<Arc<dyn Mailer>> + Send + Sync>;

/// The factory that talks real SMTP.
pub fn smtp_factory() -> MailerFactory {
    Arc::new(|s| Ok(Arc::new(SmtpMailer::new(s)?) as Arc<dyn Mailer>))
}

struct Current {
    resolved: Resolved,
    mailer: Arc<dyn Mailer>,
}

/// A configuration ready to be installed ([`EmailService::prepare`]).
pub struct Prepared(Current);

/// The instance's mail sender: sends through the transport for the current settings, which can be
/// replaced at run time ([`EmailService::apply`]).
pub struct EmailService {
    env: RawSmtp,
    factory: RwLock<MailerFactory>,
    current: RwLock<Current>,
}

impl EmailService {
    /// Build the service from the startup configuration and the stored settings, talking real
    /// SMTP. Fails when the environment's own settings are invalid (the server refuses to start
    /// with a typo in `OPENBASE_SMTP_SECURITY`). Invalid *stored* settings cannot occur (they are
    /// validated when saved) but would be ignored with a warning.
    pub fn new(config: &Config, stored: &RawSmtp) -> AppResult<Arc<EmailService>> {
        Self::with_factory(config, stored, smtp_factory())
    }

    pub fn with_factory(
        config: &Config,
        stored: &RawSmtp,
        factory: MailerFactory,
    ) -> AppResult<Arc<EmailService>> {
        let env = RawSmtp::from_config(config);
        let current = match build(&env, stored, &factory) {
            Ok(c) => c,
            Err(e) => {
                // The environment alone must be valid: that is the operator's mistake to fix.
                let c = build(&env, &RawSmtp::default(), &factory).map_err(|env_err| {
                    AppError::internal(format!("invalid OPENBASE_SMTP_* settings: {env_err}"))
                })?;
                tracing::warn!(error = %e, "ignoring the saved email settings: they do not work");
                c
            }
        };
        Ok(Arc::new(EmailService {
            env,
            factory: RwLock::new(factory),
            current: RwLock::new(current),
        }))
    }

    /// Whether email features are on (an SMTP host is configured, by either layer).
    pub fn enabled(&self) -> bool {
        self.read().resolved.smtp.is_some()
    }

    /// The effective settings and their sources.
    pub fn resolved(&self) -> Resolved {
        self.read().resolved.clone()
    }

    /// What the environment provides (the fields an administrator cannot change).
    pub fn env(&self) -> &RawSmtp {
        &self.env
    }

    /// The transport for the current settings.
    pub fn mailer(&self) -> Arc<dyn Mailer> {
        self.read().mailer.clone()
    }

    /// Validate `stored` against the environment and return what it would resolve to, without
    /// applying it.
    pub fn preview(&self, stored: &RawSmtp) -> AppResult<Resolved> {
        resolve(&self.env, stored)
    }

    /// Build the transport for `stored` without installing it, so a caller can persist the
    /// settings first and [`install`](Self::install) once that worked.
    pub fn prepare(&self, stored: &RawSmtp) -> AppResult<Prepared> {
        let factory = self
            .factory
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .clone();
        Ok(Prepared(build(&self.env, stored, &factory)?))
    }

    /// Switch to a prepared configuration now.
    pub fn install(&self, prepared: Prepared) {
        *self.current.write().unwrap_or_else(|p| p.into_inner()) = prepared.0;
    }

    /// Switch to new stored settings now. On error nothing changes.
    pub fn apply(&self, stored: &RawSmtp) -> AppResult<()> {
        let prepared = self.prepare(stored)?;
        self.install(prepared);
        Ok(())
    }

    /// Replace the transport factory and rebuild with `stored` (tests that need real SMTP, or a
    /// capturing mailer).
    pub fn set_factory(&self, factory: MailerFactory, stored: &RawSmtp) -> AppResult<()> {
        *self.factory.write().unwrap_or_else(|p| p.into_inner()) = factory;
        self.apply(stored)
    }

    fn read(&self) -> std::sync::RwLockReadGuard<'_, Current> {
        self.current.read().unwrap_or_else(|p| p.into_inner())
    }
}

fn build(env: &RawSmtp, stored: &RawSmtp, factory: &MailerFactory) -> AppResult<Current> {
    let resolved = resolve(env, stored)?;
    let mailer: Arc<dyn Mailer> = match &resolved.smtp {
        Some(smtp) => factory(smtp)?,
        None => Arc::new(NoopMailer),
    };
    Ok(Current { resolved, mailer })
}

impl Mailer for EmailService {
    fn send<'a>(
        &'a self,
        to: &'a str,
        subject: &'a str,
        body: &'a str,
    ) -> BoxFuture<'a, AppResult<()>> {
        let mailer = self.mailer();
        Box::pin(async move { mailer.send(to, subject, body).await })
    }
}

/// Charge `n` outgoing emails that `user_id` caused (invites, automation
/// emails) to the per-user and instance-wide hourly budgets
/// (`email_per_user_hour`, `email_per_hour`), so that no account can turn the
/// server's SMTP identity into a spam relay. 429 when either is exhausted.
pub fn spend_budget(
    limiter: &RateLimiter,
    config: &Config,
    user_id: &str,
    n: u32,
) -> AppResult<()> {
    let hour = Duration::from_secs(3600);
    limiter.check_n("email_user", user_id, n, config.email_per_user_hour, hour)?;
    limiter.check_n("email_all", "*", n, config.email_per_hour, hour)
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
    /// Build the transport from the effective settings. Does not connect.
    pub fn new(settings: &SmtpSettings) -> AppResult<SmtpMailer> {
        let host = settings.host.as_str();
        let from: Mailbox = settings.from.parse().map_err(|e| {
            AppError::bad_request(format!("invalid sender address '{}': {e}", settings.from))
        })?;
        let tls = match settings.security {
            SmtpSecurity::StartTls => Tls::Required(tls_params(host)?),
            SmtpSecurity::Tls => Tls::Wrapper(tls_params(host)?),
            SmtpSecurity::None => Tls::None,
        };
        let mut builder = AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(host)
            .port(settings.port)
            .tls(tls)
            .timeout(Some(Duration::from_secs(20)));
        if let (Some(user), Some(pass)) = (&settings.user, &settings.password) {
            builder = builder.credentials(Credentials::new(user.clone(), pass.clone()));
        }
        Ok(SmtpMailer {
            transport: builder.build(),
            from,
        })
    }
}

fn tls_params(host: &str) -> AppResult<TlsParameters> {
    TlsParameters::new(host.to_string()).map_err(|e| AppError::bad_request(format!("{e}")))
}

/// An error and its causes on one line ("Connection error: Connection refused (os error 61)"),
/// which is what an administrator needs to see when a test email fails.
pub fn error_chain(e: &(dyn std::error::Error + 'static)) -> String {
    let mut out = e.to_string();
    let mut source = e.source();
    while let Some(cause) = source {
        let text = cause.to_string();
        if !out.contains(&text) {
            out.push_str(": ");
            out.push_str(&text);
        }
        source = cause.source();
    }
    out
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
                .map_err(|e| AppError::internal(error_chain(&e)))?;
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

    fn settings(security: SmtpSecurity) -> SmtpSettings {
        SmtpSettings {
            host: "smtp.example.com".into(),
            port: 587,
            security,
            user: None,
            password: None,
            from: DEFAULT_FROM.into(),
        }
    }

    #[test]
    fn builds_smtp_mailer_for_each_security_mode() {
        for mode in [
            SmtpSecurity::StartTls,
            SmtpSecurity::Tls,
            SmtpSecurity::None,
        ] {
            assert!(SmtpMailer::new(&settings(mode)).is_ok(), "mode {mode:?}");
        }
        let mut bad = settings(SmtpSecurity::None);
        bad.from = "not an address".into();
        assert!(SmtpMailer::new(&bad).is_err());
    }

    #[test]
    fn security_parses_case_insensitively_and_rejects_others() {
        assert_eq!(
            SmtpSecurity::parse(" STARTTLS ").unwrap(),
            SmtpSecurity::StartTls
        );
        assert_eq!(SmtpSecurity::parse("tls").unwrap().as_str(), "tls");
        assert_eq!(SmtpSecurity::parse("none").unwrap().as_str(), "none");
        assert!(SmtpSecurity::parse("ssl3").is_err());
    }

    #[test]
    fn debug_output_never_contains_the_password() {
        let mut s = settings(SmtpSecurity::StartTls);
        s.password = Some("hunter2-secret".into());
        assert!(!format!("{s:?}").contains("hunter2"));
        let raw = RawSmtp {
            password: Some("hunter2-secret".into()),
            ..Default::default()
        };
        assert!(!format!("{raw:?}").contains("hunter2"));
    }

    #[test]
    fn resolve_layers_environment_over_stored_over_default() {
        // nothing anywhere: off, defaults
        let r = resolve(&RawSmtp::default(), &RawSmtp::default()).unwrap();
        assert!(r.smtp.is_none());
        assert_eq!(
            (r.port, r.security, r.from.as_str()),
            (587, SmtpSecurity::StartTls, DEFAULT_FROM)
        );
        assert_eq!(r.sources.host, "unset");
        assert_eq!(r.sources.port, "default");
        assert_eq!(r.sources.password, "unset");

        let stored = RawSmtp {
            host: Some("stored.example.com".into()),
            port: Some(465),
            security: Some("tls".into()),
            user: Some("stored-user".into()),
            password: Some("stored-pass".into()),
            from: Some("Stored <s@example.com>".into()),
        };
        let r = resolve(&RawSmtp::default(), &stored).unwrap();
        let smtp = r.smtp.clone().unwrap();
        assert_eq!(smtp.host, "stored.example.com");
        assert_eq!(smtp.port, 465);
        assert_eq!(smtp.security, SmtpSecurity::Tls);
        assert_eq!(smtp.password.as_deref(), Some("stored-pass"));
        assert!(r.password_set);
        for src in [
            r.sources.host,
            r.sources.port,
            r.sources.security,
            r.sources.user,
            r.sources.password,
            r.sources.from,
        ] {
            assert_eq!(src, "settings");
        }

        // a field set by the environment wins for that field only
        let env = RawSmtp {
            host: Some("env.example.com".into()),
            password: Some("env-pass".into()),
            ..Default::default()
        };
        let r = resolve(&env, &stored).unwrap();
        let smtp = r.smtp.unwrap();
        assert_eq!(smtp.host, "env.example.com");
        assert_eq!(smtp.password.as_deref(), Some("env-pass"));
        assert_eq!(smtp.port, 465, "unset in the environment: the stored value");
        assert_eq!(smtp.user.as_deref(), Some("stored-user"));
        assert_eq!(r.sources.host, "environment");
        assert_eq!(r.sources.password, "environment");
        assert_eq!(r.sources.port, "settings");
    }

    #[test]
    fn blank_values_count_as_unset() {
        let env = RawSmtp {
            host: Some("  ".into()),
            user: Some(String::new()),
            ..Default::default()
        };
        let cfg = {
            let mut c = Config::for_tests(std::path::Path::new("/tmp/unused"));
            c.smtp_host = Some("  ".into());
            c.smtp_user = Some(String::new());
            c.smtp_password = Some(String::new());
            c
        };
        assert_eq!(RawSmtp::from_config(&cfg), RawSmtp::default());
        let r = resolve(&env, &RawSmtp::default()).unwrap();
        assert!(r.smtp.is_none());
        assert_eq!(r.sources.user, "unset");
    }

    #[test]
    fn resolve_rejects_bad_security_and_sender() {
        let bad_security = RawSmtp {
            security: Some("ssl3".into()),
            ..Default::default()
        };
        assert!(resolve(&bad_security, &RawSmtp::default()).is_err());
        let bad_from = RawSmtp {
            from: Some("not an address".into()),
            ..Default::default()
        };
        assert!(resolve(&RawSmtp::default(), &bad_from).is_err());
    }

    #[test]
    fn service_without_host_is_off_and_with_env_host_is_on() {
        let off = EmailService::new(
            &Config::for_tests(std::path::Path::new("/tmp/unused")),
            &RawSmtp::default(),
        )
        .unwrap();
        assert!(!off.enabled());
        let on = EmailService::new(&config(), &RawSmtp::default()).unwrap();
        assert!(on.enabled());
        assert_eq!(on.resolved().sources.host, "environment");
    }

    #[test]
    fn service_refuses_an_invalid_environment_but_ignores_invalid_stored_settings() {
        let mut c = config();
        c.smtp_security = Some("ssl3".into());
        assert!(EmailService::new(&c, &RawSmtp::default()).is_err());

        let stored = RawSmtp {
            host: Some("h.example.com".into()),
            from: Some("garbage".into()),
            ..Default::default()
        };
        let svc = EmailService::new(
            &Config::for_tests(std::path::Path::new("/tmp/unused")),
            &stored,
        )
        .unwrap();
        assert!(!svc.enabled(), "unusable stored settings leave email off");
    }

    #[tokio::test]
    async fn applying_settings_switches_the_transport_at_once() {
        let captured = Arc::new(CapturingMailer::default());
        let c2 = captured.clone();
        let factory: MailerFactory = Arc::new(move |_| Ok(c2.clone() as Arc<dyn Mailer>));
        let svc = EmailService::with_factory(
            &Config::for_tests(std::path::Path::new("/tmp/unused")),
            &RawSmtp::default(),
            factory,
        )
        .unwrap();
        assert!(!svc.enabled());
        svc.send("a@example.com", "off", "x").await.unwrap();
        assert!(captured.sent().is_empty(), "no host: nothing is delivered");

        svc.apply(&RawSmtp {
            host: Some("smtp.example.com".into()),
            ..Default::default()
        })
        .unwrap();
        assert!(svc.enabled());
        svc.send("a@example.com", "on", "x").await.unwrap();
        assert_eq!(captured.sent().len(), 1);

        // a failing apply changes nothing
        assert!(
            svc.apply(&RawSmtp {
                host: Some("smtp.example.com".into()),
                security: Some("bogus".into()),
                ..Default::default()
            })
            .is_err()
        );
        assert!(svc.enabled());
        // and clearing the host switches it off again
        svc.apply(&RawSmtp::default()).unwrap();
        assert!(!svc.enabled());
    }

    #[test]
    fn error_chain_includes_causes_once() {
        #[derive(Debug)]
        struct Outer(std::io::Error);
        impl std::fmt::Display for Outer {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                write!(f, "Connection error")
            }
        }
        impl std::error::Error for Outer {
            fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
                Some(&self.0)
            }
        }
        let e = Outer(std::io::Error::new(
            std::io::ErrorKind::ConnectionRefused,
            "Connection refused",
        ));
        assert_eq!(error_chain(&e), "Connection error: Connection refused");
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
