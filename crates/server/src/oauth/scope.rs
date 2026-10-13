//! The OAuth scopes OpenBase knows and how they map onto the token scope model.
//!
//! The user decides on the consent page what an app gets (`Read only`, `Read & edit`,
//! `Full control`); the scopes an app asks for are only an upper bound and a hint for the
//! preselected choice. The result is an ordinary [`TokenScope`] (`write`, `manage`, `base_ids`),
//! so every existing permission check, session-only rule and rate limit applies unchanged.

use ob_core::api::oauth::access as names;

use crate::auth::TokenScope;

pub const READ: &str = "openbase:read";
pub const WRITE: &str = "openbase:write";
pub const MANAGE: &str = "openbase:manage";

/// Every scope the server understands, lowest first.
pub const SUPPORTED: [&str; 3] = [READ, WRITE, MANAGE];

/// What an app can be given, lowest first.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Access {
    Read,
    Write,
    Manage,
}

impl Access {
    pub fn as_str(self) -> &'static str {
        match self {
            Access::Read => names::READ,
            Access::Write => names::WRITE,
            Access::Manage => names::MANAGE,
        }
    }

    pub fn parse(s: &str) -> Option<Access> {
        match s {
            names::READ => Some(Access::Read),
            names::WRITE => Some(Access::Write),
            names::MANAGE => Some(Access::Manage),
            _ => None,
        }
    }

    /// The scope name that asks for this level.
    pub fn scope_name(self) -> &'static str {
        match self {
            Access::Read => READ,
            Access::Write => WRITE,
            Access::Manage => MANAGE,
        }
    }

    /// The token scope for this level, limited to `base_ids` (None = every base).
    pub fn token_scope(self, base_ids: Option<Vec<String>>) -> TokenScope {
        TokenScope {
            write: self >= Access::Write,
            manage: self >= Access::Manage,
            base_ids,
        }
    }
}

/// The level a token scope amounts to.
pub fn access_of(scope: &TokenScope) -> Access {
    if scope.write && scope.manage {
        Access::Manage
    } else if scope.write {
        Access::Write
    } else {
        Access::Read
    }
}

/// The `scope` string of a token response / grant: every scope up to the granted level.
pub fn scope_string(scope: &TokenScope) -> String {
    let level = access_of(scope);
    SUPPORTED
        .iter()
        .take(level as usize + 1)
        .copied()
        .collect::<Vec<_>>()
        .join(" ")
}

/// The known scopes in a requested `scope` parameter (unknown ones are ignored, as RFC 6749
/// allows), normalized (deduplicated, lowest first), and the highest level among them.
pub fn requested(scope: Option<&str>) -> (String, Option<Access>) {
    let mut found: Vec<Access> = scope
        .unwrap_or("")
        .split_ascii_whitespace()
        .filter_map(|s| SUPPORTED.iter().position(|k| *k == s))
        .map(|i| [Access::Read, Access::Write, Access::Manage][i])
        .collect();
    found.sort();
    found.dedup();
    let text = found
        .iter()
        .map(|a| a.scope_name())
        .collect::<Vec<_>>()
        .join(" ");
    (text, found.last().copied())
}

/// The highest level named in a stored, normalized scope string.
pub fn max_requested(stored: &str) -> Option<Access> {
    requested(Some(stored)).1
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn levels_map_onto_token_scopes() {
        let r = Access::Read.token_scope(None);
        assert!(!r.write && !r.manage);
        let w = Access::Write.token_scope(Some(vec!["appA".into()]));
        assert!(w.write && !w.manage);
        assert_eq!(w.base_ids.as_deref(), Some(&["appA".to_string()][..]));
        let m = Access::Manage.token_scope(None);
        assert!(m.write && m.manage);
        for a in [Access::Read, Access::Write, Access::Manage] {
            assert_eq!(access_of(&a.token_scope(None)), a);
            assert_eq!(Access::parse(a.as_str()), Some(a));
        }
        assert_eq!(Access::parse("admin"), None);
    }

    #[test]
    fn scope_strings_list_every_level_up_to_the_grant() {
        assert_eq!(
            scope_string(&Access::Read.token_scope(None)),
            "openbase:read"
        );
        assert_eq!(
            scope_string(&Access::Write.token_scope(None)),
            "openbase:read openbase:write"
        );
        assert_eq!(
            scope_string(&Access::Manage.token_scope(None)),
            "openbase:read openbase:write openbase:manage"
        );
    }

    #[test]
    fn requested_scopes_ignore_unknown_names() {
        assert_eq!(requested(None), (String::new(), None));
        assert_eq!(requested(Some("openid profile")), (String::new(), None));
        assert_eq!(
            requested(Some("openbase:write  openbase:read openbase:write mcp")),
            (
                "openbase:read openbase:write".to_string(),
                Some(Access::Write)
            )
        );
        assert_eq!(
            max_requested("openbase:read openbase:manage"),
            Some(Access::Manage)
        );
    }
}
