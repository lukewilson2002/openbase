//! Runtime configuration. Every option is a CLI flag and an `OPENBASE_*`
//! environment variable; nothing else is required to run.

use std::path::PathBuf;

#[derive(Debug, Clone, clap::Args)]
pub struct Config {
    /// Directory holding the database, attachments and backups.
    #[arg(long, env = "OPENBASE_DATA_DIR", default_value = "./data")]
    pub data_dir: PathBuf,

    /// Address to listen on.
    #[arg(long, env = "OPENBASE_BIND", default_value = "127.0.0.1:8080")]
    pub bind: String,

    /// Public URL users reach OpenBase at, e.g. https://base.example.com.
    /// Used for links in emails, the Origin check and the Secure cookie flag.
    #[arg(
        long,
        env = "OPENBASE_PUBLIC_URL",
        default_value = "http://localhost:8080"
    )]
    pub public_url: String,

    /// Allow anyone to create an account. When false (default), new users
    /// need an invite; the very first account is always allowed and becomes admin.
    #[arg(long, env = "OPENBASE_OPEN_SIGNUP", default_value_t = false)]
    pub open_signup: bool,

    /// Take the client address from the last X-Forwarded-For entry (the one
    /// the reverse proxy added). Enable only when OpenBase is reachable solely
    /// through that proxy.
    #[arg(long, env = "OPENBASE_TRUST_PROXY", default_value_t = false)]
    pub trust_proxy: bool,

    /// Maximum size of one uploaded file, in megabytes.
    #[arg(long, env = "OPENBASE_MAX_UPLOAD_MB", default_value_t = 100)]
    pub max_upload_mb: u64,

    /// Hour of day (0-23, server local time) to take the automatic daily backup.
    /// Set to -1 to disable automatic backups.
    #[arg(
        long,
        env = "OPENBASE_BACKUP_HOUR",
        default_value_t = 3,
        allow_negative_numbers = true
    )]
    pub backup_hour: i32,

    /// Number of automatic backups to keep.
    #[arg(long, env = "OPENBASE_BACKUP_KEEP", default_value_t = 7)]
    pub backup_keep: usize,

    /// Days to keep deleted items in the trash before purging them.
    #[arg(long, env = "OPENBASE_TRASH_DAYS", default_value_t = 30)]
    pub trash_days: u32,

    /// Days of record history to keep (0 = forever).
    #[arg(long, env = "OPENBASE_HISTORY_DAYS", default_value_t = 365)]
    pub history_days: u32,

    /// Days of audit log (logins, password and token changes, invites, admin
    /// actions) to keep (0 = forever).
    #[arg(long, env = "OPENBASE_AUDIT_DAYS", default_value_t = 365)]
    pub audit_days: u32,

    /// Emails one user may cause per hour (invites and automation emails).
    #[arg(long, env = "OPENBASE_EMAIL_PER_USER_HOUR", default_value_t = 100)]
    pub email_per_user_hour: u32,

    /// Emails the whole instance may send per hour on behalf of users
    /// (invites and automation emails; password resets have their own limits).
    #[arg(long, env = "OPENBASE_EMAIL_PER_HOUR", default_value_t = 500)]
    pub email_per_hour: u32,

    /// SMTP server for outgoing email (invites, password resets, automations).
    /// Email features are disabled when unset (unless a host is saved on the Admin -> Email page).
    /// Every `OPENBASE_SMTP_*` option that is set wins over what is saved on that page and shows
    /// there as read-only.
    #[arg(long, env = "OPENBASE_SMTP_HOST")]
    pub smtp_host: Option<String>,
    /// SMTP port (default 587).
    #[arg(long, env = "OPENBASE_SMTP_PORT")]
    pub smtp_port: Option<u16>,
    #[arg(long, env = "OPENBASE_SMTP_USER")]
    pub smtp_user: Option<String>,
    #[arg(long, env = "OPENBASE_SMTP_PASSWORD", hide_env_values = true)]
    pub smtp_password: Option<String>,
    /// starttls (default), tls (implicit, usually port 465) or none (local relay only).
    #[arg(long, env = "OPENBASE_SMTP_SECURITY")]
    pub smtp_security: Option<String>,
    /// Sender address (default `OpenBase <openbase@localhost>`).
    #[arg(long, env = "OPENBASE_SMTP_FROM")]
    pub smtp_from: Option<String>,

    /// Allow automation webhooks to call private/loopback addresses
    /// (e.g. other services on your LAN). Off by default to prevent SSRF.
    #[arg(long, env = "OPENBASE_ALLOW_PRIVATE_WEBHOOKS", default_value_t = false)]
    pub allow_private_webhooks: bool,

    /// Requests per second one API token may make to the Airtable-compatible
    /// API (`/api/v1`). Excess requests answer 429 RATE_LIMIT_REACHED.
    #[arg(long, env = "OPENBASE_V1_RATE_PER_TOKEN", default_value_t = 5)]
    pub v1_rate_per_token: u32,

    /// Requests per second all API tokens of one user may make to `/api/v1`
    /// together.
    #[arg(long, env = "OPENBASE_V1_RATE_PER_USER", default_value_t = 50)]
    pub v1_rate_per_user: u32,

    /// Requests per second one API token may make to the MCP endpoint (`/mcp`;
    /// every JSON-RPC call is one request). Excess requests answer 429.
    #[arg(long, env = "OPENBASE_MCP_RATE_PER_TOKEN", default_value_t = 30)]
    pub mcp_rate_per_token: u32,

    /// Requests per second all API tokens of one user may make to `/mcp` together.
    #[arg(long, env = "OPENBASE_MCP_RATE_PER_USER", default_value_t = 100)]
    pub mcp_rate_per_user: u32,

    /// Extra browser origins (comma separated, e.g. https://inspector.example.com) allowed to
    /// call `/mcp`. The public URL's origin is always allowed; requests without an `Origin`
    /// header (every non-browser MCP client) are not affected.
    #[arg(long, env = "OPENBASE_MCP_ALLOWED_ORIGINS", value_delimiter = ',')]
    pub mcp_allowed_origins: Vec<String>,

    /// Let OAuth clients (MCP apps such as Claude or ChatGPT) register themselves at
    /// `POST /oauth/register` (RFC 7591). Turn it off to allow only clients that identify
    /// themselves with an HTTPS metadata document URL or that you add with
    /// `openbase oauth-client add`. The consent page still asks the user for every connection.
    #[arg(long, env = "OPENBASE_OAUTH_REGISTRATION", default_value_t = true, action = clap::ArgAction::Set)]
    pub oauth_registration: bool,

    /// DEVELOPMENT ONLY. Let OAuth client metadata documents (a `client_id` that is a URL) be
    /// fetched from loopback and private addresses, and from plain `http://localhost`, so a client
    /// under development on the same machine can identify itself. Off by default and independent
    /// of `OPENBASE_ALLOW_PRIVATE_WEBHOOKS` (which is for automations only): any signed-in user
    /// can make the server fetch such a URL, so on a shared or public instance this lets them
    /// probe the internal network. Never turn it on in production.
    #[arg(
        long,
        env = "OPENBASE_OAUTH_CIMD_ALLOW_PRIVATE",
        default_value_t = false
    )]
    pub oauth_cimd_allow_private: bool,

    /// Log format: "pretty" or "json".
    #[arg(long, env = "OPENBASE_LOG_FORMAT", default_value = "pretty")]
    pub log_format: String,
}

impl Config {
    pub fn db_path(&self) -> PathBuf {
        self.data_dir.join("openbase.db")
    }
    pub fn attachments_dir(&self) -> PathBuf {
        self.data_dir.join("attachments")
    }
    pub fn backups_dir(&self) -> PathBuf {
        self.data_dir.join("backups")
    }
    pub fn secure_cookies(&self) -> bool {
        self.public_url.starts_with("https://")
    }
    pub fn max_upload_bytes(&self) -> u64 {
        self.max_upload_mb.saturating_mul(1024 * 1024)
    }
    /// Origin (scheme://host[:port]) of `public_url`, for the CSRF Origin check.
    pub fn public_origin(&self) -> String {
        match url::Url::parse(&self.public_url) {
            Ok(u) => u.origin().ascii_serialization(),
            Err(_) => self.public_url.trim_end_matches('/').to_string(),
        }
    }

    /// The OAuth issuer: the public origin. No trailing slash, no path.
    pub fn oauth_issuer(&self) -> String {
        self.public_origin()
    }

    /// The canonical URI of the MCP server, the `resource` OAuth tokens are issued for.
    pub fn mcp_resource(&self) -> String {
        format!("{}/mcp", self.public_origin())
    }

    /// OAuth is advertised and served only over HTTPS, or over plain HTTP when the public URL is
    /// a loopback address (local testing, for example `claude mcp add` on the same machine).
    /// Over plain HTTP anywhere else, codes and tokens would cross the network in clear text.
    pub fn oauth_enabled(&self) -> bool {
        let Ok(u) = url::Url::parse(&self.public_url) else {
            return false;
        };
        match u.scheme() {
            "https" => u.host().is_some(),
            "http" => match u.host() {
                Some(url::Host::Domain(d)) => d.eq_ignore_ascii_case("localhost"),
                Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
                Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
                None => false,
            },
            _ => false,
        }
    }

    /// Configuration for tests: everything under `dir`, no email, no backups.
    pub fn for_tests(dir: &std::path::Path) -> Config {
        Config {
            data_dir: dir.to_path_buf(),
            bind: "127.0.0.1:0".into(),
            public_url: "http://localhost:8080".into(),
            open_signup: false,
            trust_proxy: false,
            max_upload_mb: 5,
            backup_hour: -1,
            backup_keep: 3,
            trash_days: 30,
            history_days: 365,
            audit_days: 365,
            email_per_user_hour: 100,
            email_per_hour: 500,
            smtp_host: None,
            smtp_port: None,
            smtp_user: None,
            smtp_password: None,
            smtp_security: None,
            smtp_from: None,
            allow_private_webhooks: false,
            // Tests make many requests per second with one token; the limit
            // itself is tested with the real defaults.
            v1_rate_per_token: 10_000,
            v1_rate_per_user: 10_000,
            mcp_rate_per_token: 10_000,
            mcp_rate_per_user: 10_000,
            mcp_allowed_origins: Vec::new(),
            oauth_registration: true,
            oauth_cimd_allow_private: false,
            log_format: "pretty".into(),
        }
    }
}
