//! Redirect URIs: which ones may be registered, how a requested one is matched against them,
//! and what the consent page says about where the access goes.
//!
//! Rules (OAuth 2.1, RFC 8252, MCP authorization spec):
//!
//! - registered URIs are `https` URLs, or `http` URLs on a loopback host (`127.0.0.1`, `[::1]`,
//!   `localhost`), for apps that run on the user's own machine. Nothing else: no other `http`,
//!   no `javascript:`, `data:` or custom schemes, no credentials in the URL, no fragment, no
//!   wildcards;
//! - a requested URI must equal a registered one character for character. The one exception is
//!   RFC 8252 section 7.3: for a registered loopback URI the port is ignored, because a native
//!   app picks a free port at run time.

use url::{Host, Url};

/// Longest accepted redirect URI.
pub const MAX_REDIRECT_URI_LEN: usize = 2048;
/// Most redirect URIs one client can register.
pub const MAX_REDIRECT_URIS: usize = 10;

/// Parse and validate a redirect URI for registration. The error is a message for the registrant.
pub fn validate(uri: &str) -> Result<Url, String> {
    if uri.is_empty() || uri.len() > MAX_REDIRECT_URI_LEN {
        return Err(format!(
            "a redirect URI must be 1 to {MAX_REDIRECT_URI_LEN} characters long"
        ));
    }
    if uri
        .chars()
        .any(|c| c.is_control() || c.is_whitespace() || c == '\\' || c == '*')
    {
        return Err(
            "a redirect URI cannot contain whitespace, control characters, backslashes or wildcards"
                .into(),
        );
    }
    let url = Url::parse(uri).map_err(|_| "a redirect URI must be an absolute URL".to_string())?;
    if url.fragment().is_some() || uri.contains('#') {
        return Err("a redirect URI cannot have a fragment".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("a redirect URI cannot contain a user name or password".into());
    }
    match url.scheme() {
        "https" => {
            if url.host().is_none() {
                return Err("a redirect URI needs a host".into());
            }
            Ok(url)
        }
        "http" => {
            if loopback_host(&url) {
                Ok(url)
            } else {
                Err(
                    "http redirect URIs are only allowed for loopback addresses (127.0.0.1, \
                     [::1] or localhost); use https"
                        .into(),
                )
            }
        }
        other => Err(format!(
            "the redirect URI scheme '{other}' is not allowed; use https, or http on a loopback \
             address"
        )),
    }
}

fn loopback_host(url: &Url) -> bool {
    match url.host() {
        Some(Host::Domain(d)) => d.eq_ignore_ascii_case("localhost"),
        Some(Host::Ipv4(ip)) => ip.octets() == [127, 0, 0, 1],
        Some(Host::Ipv6(ip)) => ip.is_loopback(),
        None => false,
    }
}

/// Is this (valid) redirect URI an `http` loopback address?
pub fn is_loopback(uri: &str) -> bool {
    Url::parse(uri).is_ok_and(|u| u.scheme() == "http" && loopback_host(&u))
}

/// Does the requested redirect URI match one of the registered ones?
pub fn matches(registered: &[String], requested: &str) -> bool {
    if registered.iter().any(|r| r == requested) {
        return true;
    }
    // RFC 8252 7.3: loopback redirects may use any port.
    let Ok(req) = validate(requested) else {
        return false;
    };
    if !(req.scheme() == "http" && loopback_host(&req)) {
        return false;
    }
    registered.iter().any(|r| {
        validate(r).is_ok_and(|reg| {
            reg.scheme() == "http"
                && loopback_host(&reg)
                && reg.host_str().map(str::to_ascii_lowercase)
                    == req.host_str().map(str::to_ascii_lowercase)
                && reg.path() == req.path()
                && reg.query() == req.query()
        })
    })
}

/// `host` or `host:port` of a redirect URI: who receives the access. The port is left out when
/// it is the scheme's default.
pub fn host_label(uri: &str) -> String {
    match Url::parse(uri) {
        Ok(u) => match (u.host_str(), u.port()) {
            (Some(h), Some(p)) => format!("{h}:{p}"),
            (Some(h), None) => h.to_string(),
            _ => uri.chars().take(60).collect(),
        },
        Err(_) => uri.chars().take(60).collect(),
    }
}

/// Provider domains whose names an app may use for itself.
const KNOWN_PROVIDER_DOMAINS: [&str; 3] = ["claude.ai", "chatgpt.com", "openai.com"];

/// Is the redirect host one of the assistant providers' own (claude.ai, chatgpt.com, openai.com,
/// or a subdomain of them)?
pub fn trusted_host(uri: &str) -> bool {
    let Ok(u) = Url::parse(uri) else {
        return false;
    };
    if u.scheme() != "https" {
        return false;
    }
    let Some(Host::Domain(host)) = u.host() else {
        return false;
    };
    let host = host.to_ascii_lowercase();
    KNOWN_PROVIDER_DOMAINS
        .iter()
        .any(|d| host == *d || host.ends_with(&format!(".{d}")))
}

/// Letters an app might swap in to make a name look like another (digits and a few Cyrillic /
/// Greek look-alikes), mapped to the Latin letter they imitate.
fn skeleton_char(c: char) -> Option<char> {
    let mapped = match c {
        '0' => 'o',
        '1' | '!' | '|' => 'l',
        '3' => 'e',
        '4' | '@' => 'a',
        '5' | '$' => 's',
        '7' => 't',
        '\u{0430}' | '\u{03b1}' => 'a', // cyrillic а, greek α
        '\u{0435}' | '\u{03b5}' => 'e', // е, ε
        '\u{043e}' | '\u{03bf}' => 'o', // о, ο
        '\u{0441}' => 'c',              // с
        '\u{0440}' | '\u{03c1}' => 'p', // р, ρ
        '\u{0456}' | '\u{03b9}' => 'i', // і, ι
        '\u{0455}' => 's',              // ѕ
        '\u{0501}' => 'd',              // ԁ
        '\u{0261}' => 'g',              // ɡ
        '\u{03bd}' => 'v',              // ν
        '\u{0445}' => 'x',              // х
        '\u{0443}' => 'y',              // у
        c if c.is_ascii_alphabetic() => c.to_ascii_lowercase(),
        _ => return None,
    };
    Some(mapped)
}

/// If the app's `name` imitates a known assistant ("Claude", "ChatGPT") but the redirect URI is
/// not on that provider's own domain, the product it imitates. Case, spacing, punctuation, digit
/// substitutions and common look-alike letters are ignored.
pub fn impersonated_product(name: &str, redirect_uri: &str) -> Option<&'static str> {
    if trusted_host(redirect_uri) {
        return None;
    }
    let skeleton: String = name.chars().filter_map(skeleton_char).collect();
    [
        ("claude", "Claude"),
        ("anthropic", "Claude"),
        ("chatgpt", "ChatGPT"),
        ("openai", "ChatGPT"),
    ]
    .iter()
    .find(|(needle, _)| skeleton.contains(needle))
    .map(|(_, product)| *product)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_https_and_loopback_http() {
        for ok in [
            "https://claude.ai/api/mcp/auth_callback",
            "https://example.com/cb?x=1",
            "http://127.0.0.1:53124/callback",
            "http://127.0.0.1/cb",
            "http://[::1]:8000/cb",
            "http://localhost:3118/callback",
            "http://LOCALHOST/cb",
        ] {
            assert!(validate(ok).is_ok(), "{ok} should be valid");
        }
    }

    #[test]
    fn rejects_everything_else() {
        for bad in [
            "",
            "javascript:alert(1)",
            "data:text/html,hi",
            "file:///etc/passwd",
            "vscode://callback",
            "http://example.com/cb",
            "http://127.0.0.2/cb",
            "http://10.0.0.1/cb",
            "http://localhost.evil.com/cb",
            "https://example.com/cb#frag",
            "https://example.com/cb#",
            "https://user:pw@example.com/cb",
            "https://*.example.com/cb",
            "https://example.com/*",
            "https://exa mple.com/cb",
            "https://example.com/c\\b",
            "/relative/path",
            "https://",
        ] {
            assert!(validate(bad).is_err(), "{bad:?} should be rejected");
        }
        let long = format!("https://example.com/{}", "a".repeat(MAX_REDIRECT_URI_LEN));
        assert!(validate(&long).is_err());
    }

    #[test]
    fn requested_uri_must_match_exactly() {
        let reg = vec!["https://example.com/cb".to_string()];
        assert!(matches(&reg, "https://example.com/cb"));
        for no in [
            "https://example.com/cb/",
            "https://example.com/cb?x=1",
            "https://example.com/CB",
            "https://example.com/cb/../cb",
            "https://example.com:444/cb",
            "http://example.com/cb",
            "https://evil.com/cb",
            "https://example.com.evil.com/cb",
            "https://example.com/cb#x",
        ] {
            assert!(!matches(&reg, no), "{no} must not match");
        }
    }

    #[test]
    fn loopback_ports_are_flexible_but_nothing_else_is() {
        let reg = vec!["http://127.0.0.1:1234/callback".to_string()];
        assert!(matches(&reg, "http://127.0.0.1:1234/callback"));
        assert!(matches(&reg, "http://127.0.0.1:60000/callback"));
        assert!(matches(&reg, "http://127.0.0.1/callback"));
        assert!(!matches(&reg, "http://127.0.0.1:60000/other"));
        assert!(!matches(&reg, "http://127.0.0.1:60000/callback?x=1"));
        assert!(!matches(&reg, "http://localhost:60000/callback"));
        assert!(!matches(&reg, "https://127.0.0.1:60000/callback"));
        // A registered https URI never gets port flexibility.
        let https = vec!["https://example.com/cb".to_string()];
        assert!(!matches(&https, "https://example.com:8443/cb"));
        let v6 = vec!["http://[::1]:5/cb".to_string()];
        assert!(matches(&v6, "http://[::1]:9/cb"));
        let lh = vec!["http://localhost:5/cb".to_string()];
        assert!(matches(&lh, "http://localhost:6/cb"));
        assert!(!matches(&lh, "http://127.0.0.1:5/cb"));
    }

    #[test]
    fn labels_show_who_receives_the_access() {
        assert_eq!(
            host_label("https://claude.ai/api/mcp/auth_callback"),
            "claude.ai"
        );
        assert_eq!(host_label("http://127.0.0.1:53124/cb"), "127.0.0.1:53124");
        assert_eq!(
            host_label("https://example.com:8443/cb"),
            "example.com:8443"
        );
        assert!(is_loopback("http://[::1]:1/cb"));
        assert!(!is_loopback("https://example.com/cb"));
    }

    #[test]
    fn trusted_hosts_are_the_providers_own() {
        assert!(trusted_host("https://claude.ai/api/mcp/auth_callback"));
        assert!(trusted_host(
            "https://chatgpt.com/connector_platform_oauth_redirect"
        ));
        assert!(trusted_host(
            "https://chat.openai.com/aip/g-1/oauth/callback"
        ));
        assert!(!trusted_host("https://claude.ai.evil.com/cb"));
        assert!(!trusted_host("https://evilclaude.ai/cb"));
        assert!(!trusted_host("http://claude.ai/cb"));
        assert!(!trusted_host("http://127.0.0.1:1/cb"));
    }

    #[test]
    fn lookalike_names_are_flagged_unless_the_host_is_the_providers() {
        let evil = "https://evil.example/cb";
        for name in [
            "Claude",
            "Claude Code",
            "claude-desktop",
            "CLAUDE",
            "Cl4ude",
            "C1aude",
            "Claud\u{0435}",
            "Cl\u{0430}ude",
            "Official  C.l.a.u.d.e",
            "Anthropic Assistant",
        ] {
            assert_eq!(impersonated_product(name, evil), Some("Claude"), "{name}");
        }
        for name in ["ChatGPT", "chat-gpt connector", "OpenAI Tools", "Ch@tGPT"] {
            assert_eq!(impersonated_product(name, evil), Some("ChatGPT"), "{name}");
        }
        assert_eq!(impersonated_product("My Notes App", evil), None);
        assert_eq!(
            impersonated_product("Claude", "https://claude.ai/api/mcp/auth_callback"),
            None
        );
        assert_eq!(
            impersonated_product("ChatGPT", "https://chatgpt.com/connector/oauth/abc"),
            None
        );
        assert_eq!(
            impersonated_product("Claude Code", "http://127.0.0.1:5/cb"),
            Some("Claude")
        );
    }
}
