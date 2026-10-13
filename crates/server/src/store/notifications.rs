//! In-app notifications (mentions, user-field assignment, automations).

use rusqlite::{Connection, params};
use serde_json::Value as Json;

use crate::db::now_ms;
use crate::error::AppResult;
use crate::ids::new_id;

/// Create a notification for `user_id`. `kind`: mention | assigned | invite | automation.
pub fn create(conn: &Connection, user_id: &str, kind: &str, payload: &Json) -> AppResult<String> {
    let id = new_id(ob_core::ids::NOTIFICATION);
    conn.execute(
        "INSERT INTO notifications (id, user_id, kind, payload, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![id, user_id, kind, payload.to_string(), now_ms()],
    )?;
    Ok(id)
}
