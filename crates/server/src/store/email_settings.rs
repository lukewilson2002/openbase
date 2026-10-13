//! The SMTP settings saved on the Admin -> Email page: six rows of the `settings` table.
//!
//! These are the *stored* layer only; `email::resolve` layers the `OPENGRID_SMTP_*` environment
//! over them. The password row is written and read here and nowhere else sends it anywhere but
//! to the SMTP library: no API returns it, no log or audit row contains it. It sits in the
//! database in clear text (the server must present it to the mail server), so backups contain
//! it, like they contain the password hashes.

use rusqlite::{Connection, OptionalExtension, params};

use crate::email::RawSmtp;
use crate::error::AppResult;

const HOST: &str = "smtp.host";
const PORT: &str = "smtp.port";
const SECURITY: &str = "smtp.security";
const USER: &str = "smtp.user";
const PASSWORD: &str = "smtp.password";
const FROM: &str = "smtp.from";

fn get(conn: &Connection, key: &str) -> AppResult<Option<String>> {
    Ok(conn
        .query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| {
            r.get(0)
        })
        .optional()?)
}

fn put(conn: &Connection, key: &str, value: Option<&str>) -> AppResult<()> {
    match value {
        Some(v) => conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, v],
        )?,
        None => conn.execute("DELETE FROM settings WHERE key = ?1", [key])?,
    };
    Ok(())
}

/// The saved settings (all `None` on a fresh instance).
pub fn load(conn: &Connection) -> AppResult<RawSmtp> {
    Ok(RawSmtp {
        host: get(conn, HOST)?,
        port: get(conn, PORT)?.and_then(|p| p.parse().ok()),
        security: get(conn, SECURITY)?,
        user: get(conn, USER)?,
        password: get(conn, PASSWORD)?,
        from: get(conn, FROM)?,
    })
}

/// Replace the saved settings with `s` (a `None` field removes its row).
pub fn save(conn: &Connection, s: &RawSmtp) -> AppResult<()> {
    put(conn, HOST, s.host.as_deref())?;
    put(conn, PORT, s.port.map(|p| p.to_string()).as_deref())?;
    put(conn, SECURITY, s.security.as_deref())?;
    put(conn, USER, s.user.as_deref())?;
    put(conn, PASSWORD, s.password.as_deref())?;
    put(conn, FROM, s.from.as_deref())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(
            "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;",
        )
        .unwrap();
        c
    }

    #[test]
    fn round_trips_and_removes_cleared_fields() {
        let c = db();
        assert_eq!(load(&c).unwrap(), RawSmtp::default());
        let s = RawSmtp {
            host: Some("smtp.example.com".into()),
            port: Some(465),
            security: Some("tls".into()),
            user: Some("mailer".into()),
            password: Some("p@ss word".into()),
            from: Some("OpenGrid <og@example.com>".into()),
        };
        save(&c, &s).unwrap();
        assert_eq!(load(&c).unwrap(), s);
        let cleared = RawSmtp {
            user: None,
            password: None,
            ..s.clone()
        };
        save(&c, &cleared).unwrap();
        assert_eq!(load(&c).unwrap(), cleared);
        assert_eq!(
            c.query_row("SELECT count(*) FROM settings", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            4
        );
    }

    #[test]
    fn a_garbled_port_reads_as_unset() {
        let c = db();
        c.execute("INSERT INTO settings VALUES ('smtp.port', 'abc')", [])
            .unwrap();
        assert_eq!(load(&c).unwrap().port, None);
    }
}
