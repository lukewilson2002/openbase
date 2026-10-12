//! Users.

use crate::error::{AppError, AppResult};

/// Trim and lightly validate an email address. Uniqueness is case-insensitive
/// (the column is COLLATE NOCASE).
pub fn normalize_email(email: &str) -> AppResult<String> {
    let e = email.trim();
    let valid = e.len() <= 254
        && e.split_once('@').is_some_and(|(local, domain)| {
            !local.is_empty()
                && domain.contains('.')
                && !domain.starts_with('.')
                && !domain.ends_with('.')
        })
        && !e.chars().any(|c| c.is_whitespace() || c.is_control());
    if !valid {
        return Err(AppError::bad_request("invalid email address"));
    }
    Ok(e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn email_validation() {
        assert_eq!(normalize_email("  a@b.co ").unwrap(), "a@b.co");
        assert!(normalize_email("nope").is_err());
        assert!(normalize_email("a@b").is_err());
        assert!(normalize_email("a b@c.com").is_err());
    }
}
