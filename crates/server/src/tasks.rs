//! Background tasks run inside the server process (no external scheduler):
//! session purge, trash purge, history retention, daily backups, automation
//! runner, volatile-formula refresh. Workstream: ops (+ automations).

use crate::state::AppState;

pub fn spawn_all(_state: &AppState) {}
