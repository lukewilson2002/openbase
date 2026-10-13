//! Test helper for the live web contract tests (`web/contract`, `npm run test:contract`).
//!
//! The workspace API is not implemented yet, so the TypeScript tests cannot create a
//! workspace to invite people to. This helper opens a data directory's database, adds a
//! workspace plus a base owned by an existing user, and prints one JSON line:
//!
//!     {"workspace_id": "...", "base_id": "..."}
//!
//! It is an example target, so it is never part of the shipped binary. Delete it when the
//! workspace endpoints exist and the contract tests can create workspaces through the API.
//!
//!     cargo run -p opengrid --example contract_seed -- --data-dir DIR --email EMAIL

use std::path::PathBuf;
use std::time::Duration;

use clap::Parser;
use rusqlite::{Connection, params};

#[derive(Parser)]
struct Args {
    /// OPENGRID_DATA_DIR of the running (or stopped) server.
    #[arg(long)]
    data_dir: PathBuf,
    /// Email of an existing user; becomes workspace owner.
    #[arg(long)]
    email: String,
}

fn main() -> anyhow::Result<()> {
    let args = Args::parse();
    let mut conn = Connection::open(args.data_dir.join("opengrid.db"))?;
    // The server is running and holds the single writer: wait for our turn.
    conn.busy_timeout(Duration::from_secs(10))?;
    conn.pragma_update(None, "foreign_keys", true)?;
    let tx = conn.transaction()?;
    let user_id: String = tx.query_row(
        "SELECT id FROM users WHERE email = ?1",
        [&args.email],
        |r| r.get(0),
    )?;
    let ws = opengrid::ids::new_id(og_core::ids::WORKSPACE);
    let base = opengrid::ids::new_id(og_core::ids::BASE);
    let now = opengrid::db::now_ms();
    tx.execute(
        "INSERT INTO workspaces (id, name, created_by, created_at) VALUES (?1, 'Contract workspace', ?2, ?3)",
        params![ws, user_id, now],
    )?;
    tx.execute(
        "INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES (?1, ?2, 'owner', ?3)",
        params![ws, user_id, now],
    )?;
    tx.execute(
        "INSERT INTO bases (id, workspace_id, name, created_by, created_at) VALUES (?1, ?2, 'Contract base', ?3, ?4)",
        params![base, ws, user_id, now],
    )?;
    tx.commit()?;
    println!(
        "{}",
        serde_json::json!({ "workspace_id": ws, "base_id": base })
    );
    Ok(())
}
