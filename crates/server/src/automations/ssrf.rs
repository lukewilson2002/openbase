//! SSRF guard for the `http_request` action.
//!
//! Automations let users make the server call arbitrary URLs, which is a
//! classic way to reach services that trust the server's network position
//! (cloud metadata endpoints, databases, admin panels on localhost). The
//! guard, applied to every request:
//!
//! 1. only `http` and `https` URLs, with a host and no embedded credentials;
//! 2. the host is resolved *by us* and every resulting address is checked
//!    against [`is_forbidden_ip`]: loopback, private (RFC 1918), link-local
//!    (including 169.254.169.254), CGNAT, unique-local IPv6, multicast,
//!    unspecified, reserved/documentation ranges, and IPv6 forms that embed an
//!    IPv4 address (IPv4-mapped, IPv4-compatible, NAT64, 6to4, Teredo);
//! 3. the request then connects to exactly the addresses that were checked
//!    (the caller pins them in the HTTP client), so a DNS record that changes
//!    between the check and the connection (DNS rebinding) is harmless;
//! 4. redirects are never followed (a redirect could point at an internal
//!    address), see `http.rs`.
//!
//! Operators who really need to call machines on their own network set
//! `allow_private_webhooks`, which turns the address check off.
//!
//! The URL crate normalizes numeric host spellings (`2130706433`, `0x7f.1`,
//! `127.1`) to dotted IPv4 before we look at them, so those are caught too.

use std::future::Future;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::pin::Pin;
use std::time::Duration;

use url::{Host, Url};

/// How long name resolution may take.
const DNS_TIMEOUT: Duration = Duration::from_secs(5);

/// Why a URL was refused.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SsrfError {
    #[error("invalid URL: {0}")]
    InvalidUrl(String),
    #[error("only http and https URLs are allowed")]
    Scheme,
    #[error(
        "URLs with a user name or password are not allowed; send an Authorization header instead"
    )]
    Credentials,
    #[error("requests to private, loopback or link-local addresses are not allowed ({0})")]
    Forbidden(IpAddr),
    #[error("could not resolve host {0}")]
    Resolve(String),
}

impl SsrfError {
    /// DNS hiccups may pass on retry; everything else never will.
    pub fn is_transient(&self) -> bool {
        matches!(self, SsrfError::Resolve(_))
    }
}

/// A URL that passed the guard, with the addresses to connect to.
#[derive(Debug, Clone)]
pub struct Vetted {
    pub url: Url,
    /// Set for domain hosts: the checked addresses to pin the connection to.
    pub pinned: Option<(String, Vec<SocketAddr>)>,
}

type ResolveFuture<'a> =
    Pin<Box<dyn Future<Output = std::io::Result<Vec<SocketAddr>>> + Send + 'a>>;

/// Name resolution, replaceable in tests.
pub trait Resolver: Send + Sync {
    fn resolve<'a>(&'a self, host: &'a str, port: u16) -> ResolveFuture<'a>;
}

/// The operating system resolver (`getaddrinfo` through tokio).
pub struct SystemResolver;

impl Resolver for SystemResolver {
    fn resolve<'a>(&'a self, host: &'a str, port: u16) -> ResolveFuture<'a> {
        Box::pin(async move {
            let addrs = tokio::net::lookup_host((host, port)).await?;
            Ok(addrs.collect())
        })
    }
}

/// Parse and vet `raw` using the system resolver.
pub async fn vet(raw: &str, allow_private: bool) -> Result<Vetted, SsrfError> {
    vet_with(raw, allow_private, &SystemResolver).await
}

/// Parse and vet `raw`, resolving names through `resolver`.
pub async fn vet_with(
    raw: &str,
    allow_private: bool,
    resolver: &dyn Resolver,
) -> Result<Vetted, SsrfError> {
    let url = Url::parse(raw).map_err(|e| SsrfError::InvalidUrl(e.to_string()))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(SsrfError::Scheme);
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(SsrfError::Credentials);
    }
    let port = url
        .port_or_known_default()
        .ok_or_else(|| SsrfError::InvalidUrl("missing port".into()))?;
    match url.host() {
        None => Err(SsrfError::InvalidUrl("missing host".into())),
        Some(Host::Ipv4(ip)) => {
            check_ip(IpAddr::V4(ip), allow_private).map(|_| Vetted { url, pinned: None })
        }
        Some(Host::Ipv6(ip)) => {
            check_ip(IpAddr::V6(ip), allow_private).map(|_| Vetted { url, pinned: None })
        }
        Some(Host::Domain(domain)) => {
            let domain = domain.to_string();
            let resolved = tokio::time::timeout(DNS_TIMEOUT, resolver.resolve(&domain, port))
                .await
                .map_err(|_| SsrfError::Resolve(domain.clone()))?
                .map_err(|_| SsrfError::Resolve(domain.clone()))?;
            if resolved.is_empty() {
                return Err(SsrfError::Resolve(domain));
            }
            // Refuse if *any* address is forbidden: a name that points at
            // both a public and a private address is suspicious, and the
            // client could otherwise pick the private one.
            for addr in &resolved {
                check_ip(addr.ip(), allow_private)?;
            }
            Ok(Vetted {
                url,
                pinned: Some((domain, resolved)),
            })
        }
    }
}

fn check_ip(ip: IpAddr, allow_private: bool) -> Result<(), SsrfError> {
    if !allow_private && is_forbidden_ip(ip) {
        Err(SsrfError::Forbidden(ip))
    } else {
        Ok(())
    }
}

/// Whether requests to this address must be refused.
pub fn is_forbidden_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => forbidden_v4(v4),
        IpAddr::V6(v6) => forbidden_v6(v6),
    }
}

fn forbidden_v4(ip: Ipv4Addr) -> bool {
    let o = ip.octets();
    ip.is_unspecified()
        || ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local()
        || ip.is_broadcast()
        || ip.is_multicast()
        || ip.is_documentation()
        || o[0] == 0 // 0.0.0.0/8 "this network"
        || (o[0] == 100 && (o[1] & 0xC0) == 64) // 100.64.0.0/10 CGNAT
        || (o[0] == 192 && o[1] == 0 && o[2] == 0) // 192.0.0.0/24 IETF protocol assignments
        || (o[0] == 198 && (o[1] & 0xFE) == 18) // 198.18.0.0/15 benchmarking
        || o[0] >= 240 // 240.0.0.0/4 reserved
}

fn forbidden_v6(ip: Ipv6Addr) -> bool {
    if let Some(v4) = ip.to_ipv4_mapped() {
        return forbidden_v4(v4);
    }
    let s = ip.segments();
    let embedded = |hi: u16, lo: u16| {
        let [a, b] = hi.to_be_bytes();
        let [c, d] = lo.to_be_bytes();
        Ipv4Addr::new(a, b, c, d)
    };
    ip.is_unspecified()
        || ip.is_loopback()
        || ip.is_multicast()
        || (s[0] & 0xfe00) == 0xfc00 // fc00::/7 unique local
        || (s[0] & 0xffc0) == 0xfe80 // fe80::/10 link-local
        || (s[0] & 0xffc0) == 0xfec0 // fec0::/10 site-local (deprecated)
        || s[..6].iter().all(|x| *x == 0) // ::/96 IPv4-compatible (deprecated)
        || (s[0] == 0x64 && s[1] == 0xff9b && s[2] == 0 && s[3] == 0 && s[4] == 0 && s[5] == 0
            && forbidden_v4(embedded(s[6], s[7]))) // 64:ff9b::/96 NAT64
        || (s[0] == 0x64 && s[1] == 0xff9b && s[2] == 1) // 64:ff9b:1::/48 local-use NAT64
        || (s[0] == 0x2002 && forbidden_v4(embedded(s[1], s[2]))) // 6to4
        || (s[0] == 0x2001 && s[1] == 0) // 2001::/32 Teredo
        || (s[0] == 0x2001 && s[1] == 0x0db8) // documentation
        || (s[0] == 0x0100 && s[1] == 0 && s[2] == 0 && s[3] == 0) // 100::/64 discard
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    struct Fake(Vec<IpAddr>);
    impl Resolver for Fake {
        fn resolve<'a>(&'a self, _host: &'a str, port: u16) -> ResolveFuture<'a> {
            let addrs = self.0.iter().map(|i| SocketAddr::new(*i, port)).collect();
            Box::pin(async move { Ok(addrs) })
        }
    }

    #[test]
    fn forbidden_addresses() {
        for s in [
            "127.0.0.1",
            "127.255.255.254",
            "10.0.0.1",
            "10.255.255.255",
            "172.16.0.1",
            "172.31.255.255",
            "192.168.1.1",
            "169.254.169.254",
            "169.254.0.1",
            "100.64.0.1",
            "100.127.255.255",
            "0.0.0.0",
            "0.1.2.3",
            "224.0.0.1",
            "239.255.255.255",
            "255.255.255.255",
            "240.0.0.1",
            "192.0.2.1",
            "198.51.100.1",
            "203.0.113.1",
            "198.18.0.1",
            "198.19.255.255",
            "192.0.0.8",
            "::1",
            "::",
            "fe80::1",
            "fd00::1",
            "fc00::1",
            "fdff:ffff::1",
            "ff02::1",
            "fec0::1",
            "::ffff:127.0.0.1",
            "::ffff:10.1.2.3",
            "::ffff:169.254.169.254",
            "::ffff:7f00:1",
            "::127.0.0.1",
            "::8.8.8.8",
            "64:ff9b::7f00:1",
            "64:ff9b::a00:1",
            "64:ff9b:1::1",
            "2002:7f00:1::1",
            "2002:0a00:0001::1",
            "2001::1",
            "2001:db8::1",
            "100::1",
        ] {
            assert!(is_forbidden_ip(ip(s)), "{s} must be forbidden");
        }
    }

    #[test]
    fn public_addresses_are_allowed() {
        for s in [
            "8.8.8.8",
            "1.1.1.1",
            "93.184.216.34",
            "172.15.255.255",
            "172.32.0.1",
            "100.63.255.255",
            "100.128.0.1",
            "198.17.255.255",
            "198.20.0.1",
            "2606:4700:4700::1111",
            "2001:4860:4860::8888",
            "::ffff:8.8.8.8",
            "64:ff9b::808:808",
            "2002:0808:0808::1",
        ] {
            assert!(!is_forbidden_ip(ip(s)), "{s} must be allowed");
        }
    }

    #[tokio::test]
    async fn literal_hosts_are_checked() {
        for url in [
            "http://127.0.0.1/",
            "http://127.0.0.1:8080/x",
            "http://10.0.0.5/",
            "http://169.254.169.254/latest/meta-data/",
            "http://[::1]/",
            "http://[::1]:3000/",
            "http://[::ffff:127.0.0.1]/",
            "http://[::ffff:7f00:1]/",
            "http://[fd00::1]/",
            "http://[fe80::1]/",
            "http://0.0.0.0/",
            "http://100.64.0.1/",
            // Numeric spellings the URL parser normalizes to 127.0.0.1.
            "http://2130706433/",
            "http://0x7f.0.0.1/",
            "http://127.1/",
            "http://0177.0.0.1/",
            "https://127.0.0.1:443/",
        ] {
            let r = vet_with(url, false, &Fake(vec![])).await;
            assert!(
                matches!(r, Err(SsrfError::Forbidden(_))),
                "{url} must be rejected, got {r:?}"
            );
        }
    }

    #[tokio::test]
    async fn rejects_other_schemes_and_credentials() {
        let f = Fake(vec![ip("8.8.8.8")]);
        for url in [
            "ftp://example.com/",
            "file:///etc/passwd",
            "gopher://example.com/",
            "javascript:alert(1)",
            "data:text/plain,hi",
            "ws://example.com/",
        ] {
            assert_eq!(
                vet_with(url, false, &f).await.unwrap_err(),
                SsrfError::Scheme,
                "{url}"
            );
        }
        assert_eq!(
            vet_with("http://user:pw@example.com/", false, &f)
                .await
                .unwrap_err(),
            SsrfError::Credentials
        );
        assert_eq!(
            vet_with("http://user@example.com/", false, &f)
                .await
                .unwrap_err(),
            SsrfError::Credentials
        );
        assert!(matches!(
            vet_with("not a url", false, &f).await,
            Err(SsrfError::InvalidUrl(_))
        ));
        assert!(matches!(
            vet_with("http://", false, &f).await,
            Err(SsrfError::InvalidUrl(_))
        ));
    }

    #[tokio::test]
    async fn domains_are_resolved_checked_and_pinned() {
        let ok = vet_with(
            "https://api.example.com/hook?a=1",
            false,
            &Fake(vec![ip("93.184.216.34")]),
        )
        .await
        .unwrap();
        let (domain, addrs) = ok.pinned.unwrap();
        assert_eq!(domain, "api.example.com");
        assert_eq!(
            addrs,
            vec!["93.184.216.34:443".parse::<SocketAddr>().unwrap()]
        );

        // Resolves to loopback / metadata / private: refused.
        for bad in [
            "127.0.0.1",
            "169.254.169.254",
            "10.1.1.1",
            "::1",
            "::ffff:127.0.0.1",
        ] {
            let r = vet_with("http://evil.example.com/", false, &Fake(vec![ip(bad)])).await;
            assert!(matches!(r, Err(SsrfError::Forbidden(_))), "{bad}: {r:?}");
        }
        // One bad address among good ones poisons the lot.
        let r = vet_with(
            "http://mixed.example.com/",
            false,
            &Fake(vec![ip("8.8.8.8"), ip("10.0.0.5")]),
        )
        .await;
        assert!(matches!(r, Err(SsrfError::Forbidden(_))));
        // No addresses at all.
        assert!(matches!(
            vet_with("http://nx.example.com/", false, &Fake(vec![])).await,
            Err(SsrfError::Resolve(_))
        ));
    }

    #[tokio::test]
    async fn allow_private_turns_the_address_check_off() {
        let v = vet_with("http://127.0.0.1:9/", true, &Fake(vec![]))
            .await
            .unwrap();
        assert!(v.pinned.is_none());
        assert!(
            vet_with("http://[::1]:9/", true, &Fake(vec![]))
                .await
                .is_ok()
        );
        assert!(
            vet_with("http://internal.lan/", true, &Fake(vec![ip("10.0.0.5")]))
                .await
                .is_ok()
        );
        // The scheme rules still apply.
        assert_eq!(
            vet_with("file:///etc/passwd", true, &Fake(vec![]))
                .await
                .unwrap_err(),
            SsrfError::Scheme
        );
    }

    #[tokio::test]
    async fn localhost_by_name_resolves_to_loopback_and_is_refused() {
        for url in [
            "http://localhost/",
            "http://localhost:8080/",
            "http://LOCALHOST/",
        ] {
            let r = vet(url, false).await;
            assert!(
                matches!(r, Err(SsrfError::Forbidden(_))),
                "{url} must be refused, got {r:?}"
            );
        }
    }

    #[test]
    fn only_dns_failures_are_transient() {
        assert!(SsrfError::Resolve("x".into()).is_transient());
        assert!(!SsrfError::Scheme.is_transient());
        assert!(!SsrfError::Forbidden(ip("10.0.0.1")).is_transient());
    }
}
