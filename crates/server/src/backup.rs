//! Backups: a .tar.gz holding a consistent database snapshot (VACUUM INTO)
//! plus the attachments directory. Workstream: ops.

use std::path::{Path, PathBuf};

use crate::config::Config;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

pub fn create(_state: &AppState, _out: Option<&Path>) -> AppResult<PathBuf> {
    Err(AppError::internal("backup not implemented yet"))
}

pub fn restore(_config: &Config, _archive: &Path, _force: bool) -> AppResult<()> {
    Err(AppError::internal("restore not implemented yet"))
}
