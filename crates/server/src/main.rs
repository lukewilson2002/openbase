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
    /// Write a consistent backup archive (database + attachments).
    Backup {
        /// Output file (.tar.gz). Defaults to <data_dir>/backups/opengrid-<timestamp>.tar.gz
        #[arg(long)]
        out: Option<std::path::PathBuf>,
    },
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

fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
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
