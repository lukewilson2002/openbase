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

/// The redirect addresses of the assistant providers themselves, the only ones that count as
/// "verified" and may carry the provider's name: the exact callback URLs they document for
/// custom connectors. A whole domain is not enough: `chat.openai.com/aip/g-<id>/oauth/callback`
/// belongs to a GPT that any ChatGPT user can write, and so does everything else under those
/// domains that is not a documented connector callback.
const KNOWN_PROVIDER_CALLBACKS: [&str; 4] = [
    // Claude (claude.ai and Claude Desktop connectors).
    "https://claude.ai/api/mcp/auth_callback",
    "https://claude.com/api/mcp/auth_callback",
    // ChatGPT (custom connectors, and the review flow of the apps platform).
    "https://chatgpt.com/connector_platform_oauth_redirect",
    "https://platform.openai.com/apps-manage/oauth",
];

/// Is the redirect address exactly one of the providers' documented callbacks (scheme, host and
/// path; no other port, no query, no fragment)?
pub fn trusted_host(uri: &str) -> bool {
    let Ok(u) = Url::parse(uri) else {
        return false;
    };
    if u.scheme() != "https"
        || u.query().is_some()
        || u.fragment().is_some()
        || !u.username().is_empty()
        || u.password().is_some()
        || u.port().is_some()
    {
        return false;
    }
    let Some(Host::Domain(host)) = u.host() else {
        return false;
    };
    let host = host.to_ascii_lowercase();
    KNOWN_PROVIDER_CALLBACKS.iter().any(|known| {
        Url::parse(known).is_ok_and(|k| k.host_str() == Some(host.as_str()) && k.path() == u.path())
    })
}

/// Characters an app name must not contain: controls, and the invisible and direction-changing
/// "format" characters (soft hyphen, zero-width characters, the bidirectional overrides and
/// isolates, word joiner, variation selectors, byte-order mark, tag characters, ...). They make
/// `\u{202E}edualC` render as "Claude", reorder the text around the name, or hide look-alike
/// padding. Ordinary whitespace is not in this set (it is collapsed separately).
pub fn is_hidden_char(c: char) -> bool {
    if c.is_whitespace() {
        return false;
    }
    c.is_control()
        || matches!(
            c,
            '\u{00AD}' // soft hyphen
            | '\u{034F}' // combining grapheme joiner
            | '\u{061C}' // arabic letter mark
            | '\u{115F}' | '\u{1160}' // hangul fillers
            | '\u{17B4}' | '\u{17B5}'
            | '\u{180B}'..='\u{180F}' // mongolian variation selectors
            | '\u{200B}'..='\u{200F}' // zero-width space/joiners, LRM, RLM
            | '\u{202A}'..='\u{202E}' // bidi embeddings and overrides
            | '\u{2060}'..='\u{206F}' // word joiner, invisible operators, bidi isolates
            | '\u{3164}' | '\u{FFA0}' // hangul fillers
            | '\u{FE00}'..='\u{FE0F}' // variation selectors
            | '\u{FEFF}' // byte-order mark
            | '\u{FFF0}'..='\u{FFFB}' // specials (interlinear annotations, object replacement)
            | '\u{1BCA0}'..='\u{1BCA3}'
            | '\u{1D173}'..='\u{1D17A}'
            | '\u{E0000}'..='\u{E0FFF}' // tag characters and variation selectors supplement
            | '\u{E000}'..='\u{F8FF}' // private use
        )
}

/// The name of an app as it may be shown: hidden and direction-changing characters removed,
/// whitespace collapsed, cut to [`MAX_DISPLAY_NAME_CHARS`]. Names are checked at registration
/// already; this covers rows stored before that check and keeps every place that shows a name
/// (consent page, connected apps, audit log) safe.
pub fn display_name(name: &str) -> String {
    let cleaned = name
        .chars()
        .filter(|c| !is_hidden_char(*c))
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    cleaned.chars().take(MAX_DISPLAY_NAME_CHARS).collect()
}

/// Longest app name shown anywhere.
pub const MAX_DISPLAY_NAME_CHARS: usize = 100;

/// Latin letters (and digits) that other scripts, or punctuation, imitate, keyed by the lookalike.
/// A small, hand-picked subset of the Unicode confusables table (UTS #39) covering the Cyrillic,
/// Greek and Armenian look-alikes of the Latin letters, plus the usual digit and symbol
/// substitutions. Compatibility forms (fullwidth, mathematical alphanumerics, ligatures, circled
/// letters, ...) are folded by NFKC before this table is consulted, and combining marks are
/// dropped, so neither needs entries here.
fn confusable_latin(c: char) -> Option<char> {
    Some(match c {
        '0' => 'o',
        '1' | '!' | '|' | '\u{0131}' => 'l', // dotless i is deliberately close to l and i
        '3' => 'e',
        '4' | '@' => 'a',
        '5' | '$' => 's',
        '7' => 't',
        // Cyrillic (lower case; capitals are lower-cased first).
        '\u{0430}' => 'a',              // а
        '\u{0432}' => 'b',              // в
        '\u{0435}' | '\u{0454}' => 'e', // е, є
        '\u{0433}' => 'r',              // г
        '\u{0456}' | '\u{0457}' => 'i', // і, ї
        '\u{0458}' => 'j',              // ј
        '\u{043a}' | '\u{049b}' => 'k', // к, қ
        '\u{04cf}' | '\u{04c0}' => 'l', // ӏ, Ӏ palochka
        '\u{043c}' => 'm',              // м
        '\u{043d}' | '\u{04bb}' => 'h', // н, һ
        '\u{043e}' | '\u{04e9}' => 'o', // о, ө
        '\u{0440}' => 'p',              // р
        '\u{0441}' | '\u{04ab}' => 'c', // с, ҫ
        '\u{0442}' => 't',              // т
        '\u{0443}' | '\u{04af}' => 'y', // у, ү
        '\u{0445}' | '\u{04b3}' => 'x', // х, ҳ
        '\u{0455}' => 's',              // ѕ
        '\u{0448}' => 'w',              // ш
        '\u{0501}' => 'd',              // ԁ
        '\u{051b}' => 'q',              // ԛ
        '\u{051d}' => 'w',              // ԝ
        // Greek.
        '\u{03b1}' => 'a',              // α
        '\u{03b2}' => 'b',              // β
        '\u{03b3}' => 'y',              // γ
        '\u{03b5}' | '\u{03f5}' => 'e', // ε, ϵ
        '\u{03b7}' => 'n',              // η
        '\u{03b9}' | '\u{0399}' => 'i', // ι
        '\u{03ba}' | '\u{03f0}' => 'k', // κ
        '\u{03bd}' => 'v',              // ν
        '\u{03bf}' => 'o',              // ο
        '\u{03c1}' | '\u{03f1}' => 'p', // ρ
        '\u{03c3}' => 'o',              // σ
        '\u{03c4}' => 't',              // τ
        '\u{03c5}' => 'u',              // υ
        '\u{03c7}' => 'x',              // χ
        '\u{03c9}' => 'w',              // ω
        '\u{03f2}' => 'c',              // ϲ
        '\u{03f3}' => 'j',              // ϳ
        // Armenian and other look-alikes of single Latin letters.
        '\u{0570}' => 'h', // հ
        '\u{0578}' => 'n', // ո
        '\u{057c}' => 'n', // ռ
        '\u{057d}' => 'u', // ս
        '\u{0261}' => 'g', // ɡ latin small script g
        '\u{0251}' => 'a', // ɑ
        '\u{0237}' => 'j', // ȷ
        '\u{026a}' => 'i', // ɪ
        '\u{1d00}' => 'a', // ᴀ small capitals
        '\u{1d04}' => 'c',
        '\u{1d07}' => 'e',
        '\u{1d0f}' => 'o',
        '\u{1d1c}' => 'u',
        c if c.is_ascii_alphabetic() => c.to_ascii_lowercase(),
        _ => return None,
    })
}

/// A comparison form of a name that ignores what an impersonator varies: compatibility forms
/// (NFKC: fullwidth, mathematical, ligatures), case, accents and other combining marks, hidden
/// characters, digit and symbol substitutions, and look-alike letters of other scripts. Anything
/// that does not map to a Latin letter is dropped (spaces, dots, hyphens, other scripts).
pub fn skeleton(name: &str) -> String {
    use unicode_normalization::UnicodeNormalization;
    name.nfkc()
        .nfd()
        .filter(|c| !unicode_normalization::char::is_combining_mark(*c))
        .flat_map(char::to_lowercase)
        .filter_map(confusable_latin)
        .collect()
}

/// If the app's `name` imitates a known assistant ("Claude", "ChatGPT") but the redirect URI is
/// not one of that provider's own callbacks, the product it imitates. See [`skeleton`] for what
/// is ignored.
pub fn impersonated_product(name: &str, redirect_uri: &str) -> Option<&'static str> {
    if trusted_host(redirect_uri) {
        return None;
    }
    let skeleton = skeleton(name);
    // A name written backwards under a direction override reads as the product too.
    let reversed: String = skeleton.chars().rev().collect();
    [
        ("claude", "Claude"),
        ("anthropic", "Claude"),
        ("chatgpt", "ChatGPT"),
        ("openai", "ChatGPT"),
    ]
    .iter()
    .find(|(needle, _)| skeleton.contains(needle) || reversed.contains(needle))
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
    fn only_the_providers_documented_callbacks_are_trusted() {
        assert!(trusted_host("https://claude.ai/api/mcp/auth_callback"));
        assert!(trusted_host("https://claude.com/api/mcp/auth_callback"));
        assert!(trusted_host("https://CLAUDE.AI/api/mcp/auth_callback"));
        assert!(trusted_host(
            "https://chatgpt.com/connector_platform_oauth_redirect"
        ));
        // Other paths on the providers' domains belong to third parties: a GPT's action
        // callback, a connector somebody else created, anything under the domain.
        for not in [
            "https://chat.openai.com/aip/g-1/oauth/callback",
            "https://chatgpt.com/aip/g-123/oauth/callback",
            "https://chatgpt.com/connector/oauth/abc",
            "https://chatgpt.com/",
            "https://claude.ai/anything",
            "https://claude.ai/api/mcp/auth_callback/extra",
            "https://claude.ai/api/mcp/auth_callback?x=1",
            "https://claude.ai/api/mcp/auth_callback#f",
            "https://claude.ai:8443/api/mcp/auth_callback",
            "https://sub.claude.ai/api/mcp/auth_callback",
            "https://openai.com/x",
            "https://claude.ai.evil.com/api/mcp/auth_callback",
            "https://evilclaude.ai/api/mcp/auth_callback",
            "http://claude.ai/api/mcp/auth_callback",
            "http://127.0.0.1:1/cb",
            "https://u:p@claude.ai/api/mcp/auth_callback",
        ] {
            assert!(!trusted_host(not), "{not}");
        }
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
            impersonated_product(
                "ChatGPT",
                "https://chatgpt.com/connector_platform_oauth_redirect"
            ),
            None
        );
        assert_eq!(
            impersonated_product("Claude Code", "http://127.0.0.1:5/cb"),
            Some("Claude")
        );
        // A GPT's callback on the provider's domain is not the provider.
        assert_eq!(
            impersonated_product("ChatGPT", "https://chat.openai.com/aip/g-1/oauth/callback"),
            Some("ChatGPT")
        );
    }

    #[test]
    fn capitals_other_scripts_fullwidth_and_marks_do_not_hide_a_name() {
        let evil = "https://evil.example/cb";
        for name in [
            "\u{0421}laude",                                          // Cyrillic capital Es
            "Cl\u{0410}ude",                                          // Cyrillic capital A
            "\u{0421}\u{04cf}\u{0430}ud\u{0435}", // Cyrillic C, palochka, a, (u), d, e
            "\u{FF23}\u{FF4C}\u{FF41}\u{FF55}\u{FF44}\u{FF45}", // fullwidth Claude
            "\u{1D402}\u{1D425}\u{1D41A}\u{1D42E}\u{1D41D}\u{1D41E}", // mathematical bold
            "Cl\u{03B1}ud\u{03B5}",               // Greek alpha, epsilon
            "Cl\u{00E0}\u{00FA}d\u{00E9}",        // accents: Clàúdé
            "Cla\u{0075}\u{0308}de",              // combining diaeresis
            "C\u{200B}laude",                     // zero-width space
            "Cl\u{00AD}aude",                     // soft hyphen
            "\u{202E}edualC",                     // right-to-left override, reversed
            "\u{FB01}lm Claude",                  // ligature fi plus Claude
            "\u{24B8}laude",                      // circled C
            "Anthr\u{043E}pic",                   // Cyrillic o
            "\u{0421}hatGPT",
            "Ch\u{0430}tGPT",
            "Op\u{0435}nAI",
        ] {
            assert!(
                impersonated_product(name, evil).is_some(),
                "{name:?} (skeleton {:?}) must be flagged",
                skeleton(name)
            );
        }
        // Ordinary names stay unflagged, including ones in other scripts.
        for name in [
            "Notes",
            "\u{041f}\u{0440}\u{0438}\u{0432}\u{0435}\u{0442}",
            "Cloud Tools",
            "Claud",
        ] {
            assert_eq!(impersonated_product(name, evil), None, "{name}");
        }
    }

    #[test]
    fn hidden_characters_are_found_and_removed() {
        for c in [
            '\u{202E}',
            '\u{202D}',
            '\u{2066}',
            '\u{2069}',
            '\u{200B}',
            '\u{200E}',
            '\u{FEFF}',
            '\u{00AD}',
            '\u{0007}',
            '\u{FE0F}',
            '\u{E0041}',
        ] {
            assert!(is_hidden_char(c), "{c:?}");
        }
        for c in ['a', 'Z', ' ', '\t', '\u{00E9}', '\u{0421}', '\u{4E2D}', '-'] {
            assert!(!is_hidden_char(c), "{c:?}");
        }
        assert_eq!(display_name("\u{202E}edualC"), "edualC");
        assert_eq!(display_name("  A \u{200B}  B\n C "), "A B C");
        assert_eq!(display_name(&"x".repeat(500)).chars().count(), 100);
    }
}
