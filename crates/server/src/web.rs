//! Serves the compiled web client (`web/dist`, built by `npm run build`), embedded
//! into the binary at build time.
//!
//! - `/assets/*` are content-hashed by Vite and cached forever (`immutable`).
//! - Brand images at the root (favicon.svg / favicon.ico, apple-touch-icon.png, the manifest icons)
//!   are cached for a day: they are requested on every page load, change only when the logo does,
//!   and carry an ETag, so a changed logo shows up within a day and an unchanged one answers 304.
//! - Everything else (index.html, manifest.webmanifest, theme-init.js) is `no-cache` with an
//!   ETag, so a new release is picked up on the next load but unchanged files answer 304.
//! - Unknown paths without a file extension fall back to `index.html` (client-side routing).
//! - `/api/*` is never answered by the SPA: unknown API paths get the JSON error format, and a
//!   missing asset (a stale hashed chunk, `/favicon.ico`) is a real 404, not HTML.
//!
//! The folder may be absent (a plain `cargo build` without Node): requests then get a
//! plain-text hint instead of the app, and the API keeps working.

use std::borrow::Cow;

use axum::Router;
use axum::body::Body;
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};

use crate::state::AppState;

#[derive(rust_embed::Embed)]
#[folder = "../../web/dist/"]
#[allow_missing = true]
struct Assets;

const IMMUTABLE: &str = "public, max-age=31536000, immutable";
const NO_CACHE: &str = "no-cache";
const IMAGE_ONE_DAY: &str = "public, max-age=86400";
const NOT_BUILT: &str =
    "OpenBase web client not built. Run `npm ci && npm run build` in web/ and rebuild the server.";

/// One embedded file.
pub struct Asset {
    pub data: Cow<'static, [u8]>,
    /// SHA-256 of the contents, used for the ETag.
    pub sha256: [u8; 32],
}

fn embedded(path: &str) -> Option<Asset> {
    Assets::get(path).map(|f| Asset {
        sha256: f.metadata.sha256_hash(),
        data: f.data,
    })
}

pub fn router() -> Router<AppState> {
    Router::new().fallback(serve)
}

async fn serve(method: Method, uri: Uri, headers: HeaderMap) -> Response {
    respond(&method, uri.path(), &headers, embedded)
}

/// Pure request -> response logic over an asset lookup (tests inject a fake one).
pub fn respond(
    method: &Method,
    uri_path: &str,
    req_headers: &HeaderMap,
    lookup: impl Fn(&str) -> Option<Asset>,
) -> Response {
    let path = uri_path.trim_start_matches('/');

    // The SPA never owns /api: keep the JSON error contract for unknown endpoints.
    if path == "api" || path.starts_with("api/") {
        // The Airtable-compatible API answers in Airtable's error format.
        if path == "api/v1" || path.starts_with("api/v1/") {
            return crate::v1::error::V1Error::not_found("Endpoint").into_response();
        }
        return crate::error::AppError::not_found("endpoint").into_response();
    }
    if method != Method::GET && method != Method::HEAD {
        let mut res = StatusCode::METHOD_NOT_ALLOWED.into_response();
        res.headers_mut()
            .insert(header::ALLOW, HeaderValue::from_static("GET, HEAD"));
        return res;
    }
    if path.split('/').any(|seg| seg == ".." || seg.contains('\\')) {
        return StatusCode::BAD_REQUEST.into_response();
    }

    // Exact file match (never for the empty path, which is the app shell).
    let exact = if path.is_empty() { None } else { lookup(path) };
    if let Some(asset) = exact {
        return file_response(method, req_headers, path, asset, cache_policy(path));
    }

    // Paths that look like files (have an extension) but do not exist are real 404s, so a stale
    // hashed chunk or a favicon probe never receives HTML that the browser would try to execute.
    let last = path.rsplit('/').next().unwrap_or("");
    if path.starts_with("assets/") || (last.contains('.') && !last.ends_with(".html")) {
        return StatusCode::NOT_FOUND.into_response();
    }

    // Client-side route: serve the app shell.
    match lookup("index.html") {
        Some(index) => file_response(method, req_headers, "index.html", index, NO_CACHE),
        None => (StatusCode::NOT_FOUND, NOT_BUILT).into_response(),
    }
}

/// Cache-Control for an existing file: hashed build output forever, root-level brand images for
/// a day, everything else revalidated on each use.
fn cache_policy(path: &str) -> &'static str {
    let is_image = matches!(
        path.rsplit_once('.').map(|(_, ext)| ext),
        Some("svg" | "ico" | "png")
    );
    if path.starts_with("assets/") {
        IMMUTABLE
    } else if is_image && !path.contains('/') {
        IMAGE_ONE_DAY
    } else {
        NO_CACHE
    }
}

fn file_response(
    method: &Method,
    req_headers: &HeaderMap,
    path: &str,
    asset: Asset,
    cache: &'static str,
) -> Response {
    let etag = format!("\"{}\"", hex_prefix(&asset.sha256));
    let not_modified = req_headers
        .get(header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| {
            v.split(',')
                .any(|t| t.trim().trim_start_matches("W/") == etag)
        });

    let mime = mime_guess::from_path(path).first_or_octet_stream();
    let content_type = if mime.type_() == mime_guess::mime::TEXT {
        format!("{mime}; charset=utf-8")
    } else {
        mime.to_string()
    };

    let builder = Response::builder()
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CACHE_CONTROL, cache)
        .header(header::ETAG, &etag);
    if not_modified {
        return builder
            .status(StatusCode::NOT_MODIFIED)
            .body(Body::empty())
            .unwrap();
    }
    let body = if method == Method::HEAD {
        Body::empty()
    } else {
        Body::from(asset.data.into_owned())
    };
    builder.body(body).unwrap()
}

fn hex_prefix(hash: &[u8; 32]) -> String {
    use std::fmt::Write;
    hash.iter().take(16).fold(String::new(), |mut s, b| {
        let _ = write!(s, "{b:02x}");
        s
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fake(path: &str) -> Option<Asset> {
        let body: &'static [u8] = match path {
            "index.html" => b"<!doctype html><div id=root></div>",
            "assets/index-abc123.js" => b"console.log(1)",
            "assets/index-abc123.css" => b"body{}",
            "theme-init.js" => b"/* theme */",
            "favicon.svg" => b"<svg/>",
            "favicon.ico" => b"\x00\x00\x01\x00",
            "apple-touch-icon.png" => b"\x89PNG",
            "manifest.webmanifest" => b"{}",
            _ => return None,
        };
        let mut sha256 = [0u8; 32];
        sha256[0] = body.len() as u8;
        Some(Asset {
            data: Cow::Borrowed(body),
            sha256,
        })
    }

    fn get(path: &str) -> Response {
        respond(&Method::GET, path, &HeaderMap::new(), fake)
    }

    fn header_of(res: &Response, name: header::HeaderName) -> &str {
        res.headers().get(name).unwrap().to_str().unwrap()
    }

    #[test]
    fn hashed_assets_are_immutable() {
        let res = get("/assets/index-abc123.js");
        assert_eq!(res.status(), 200);
        assert_eq!(header_of(&res, header::CACHE_CONTROL), IMMUTABLE);
        assert!(header_of(&res, header::CONTENT_TYPE).contains("javascript"));
        let css = get("/assets/index-abc123.css");
        assert_eq!(
            header_of(&css, header::CONTENT_TYPE),
            "text/css; charset=utf-8"
        );
    }

    #[test]
    fn unhashed_files_and_the_shell_are_no_cache() {
        for p in [
            "/theme-init.js",
            "/manifest.webmanifest",
            "/",
            "/index.html",
        ] {
            let res = get(p);
            assert_eq!(res.status(), 200, "{p}");
            assert_eq!(header_of(&res, header::CACHE_CONTROL), NO_CACHE, "{p}");
        }
        assert_eq!(
            header_of(&get("/"), header::CONTENT_TYPE),
            "text/html; charset=utf-8"
        );
    }

    #[test]
    fn brand_files_have_the_right_types_and_a_short_cache() {
        for (p, types) in [
            ("/favicon.svg", &["image/svg+xml"][..]),
            ("/apple-touch-icon.png", &["image/png"][..]),
            // Both are registered names for .ico; browsers accept either.
            (
                "/favicon.ico",
                &["image/x-icon", "image/vnd.microsoft.icon"][..],
            ),
        ] {
            let res = get(p);
            assert_eq!(res.status(), 200, "{p}");
            assert_eq!(header_of(&res, header::CACHE_CONTROL), IMAGE_ONE_DAY, "{p}");
            assert!(header_of(&res, header::ETAG).starts_with('"'), "{p}");
            let ct = header_of(&res, header::CONTENT_TYPE);
            assert!(types.contains(&ct), "{p}: {ct}");
        }
        let manifest = get("/manifest.webmanifest");
        assert_eq!(manifest.status(), 200);
        assert_eq!(
            header_of(&manifest, header::CONTENT_TYPE),
            "application/manifest+json"
        );
        assert_eq!(header_of(&manifest, header::CACHE_CONTROL), NO_CACHE);
    }

    #[test]
    fn spa_routes_fall_back_to_index_html() {
        for p in [
            "/base/app1/tbl1/viw1",
            "/login",
            "/invite/abc",
            "/account",
            "/some/deep/unknown/route",
        ] {
            let res = get(p);
            assert_eq!(res.status(), 200, "{p}");
            assert_eq!(
                header_of(&res, header::CONTENT_TYPE),
                "text/html; charset=utf-8",
                "{p}"
            );
            assert_eq!(header_of(&res, header::CACHE_CONTROL), NO_CACHE, "{p}");
        }
    }

    #[test]
    fn missing_files_are_404_not_html() {
        for p in [
            "/assets/index-deadbeef.js",
            "/assets/",
            "/robots.txt",
            "/apple-touch-icon-precomposed.png",
            "/x/y.map",
        ] {
            assert_eq!(get(p).status(), 404, "{p}");
        }
    }

    #[test]
    fn api_paths_are_never_swallowed() {
        for p in ["/api", "/api/", "/api/nope", "/api/bases/x/events"] {
            let res = get(p);
            assert_eq!(res.status(), 404, "{p}");
            assert_eq!(
                header_of(&res, header::CONTENT_TYPE),
                "application/json",
                "{p}"
            );
        }
        let post = respond(&Method::POST, "/api/nope", &HeaderMap::new(), fake);
        assert_eq!(post.status(), 404);
    }

    #[test]
    fn etag_enables_304_and_head_has_no_body() {
        let first = get("/theme-init.js");
        let etag = header_of(&first, header::ETAG).to_string();
        let mut headers = HeaderMap::new();
        headers.insert(header::IF_NONE_MATCH, etag.parse().unwrap());
        let res = respond(&Method::GET, "/theme-init.js", &headers, fake);
        assert_eq!(res.status(), 304);
        // A different tag still gets the file.
        headers.insert(header::IF_NONE_MATCH, "\"other\"".parse().unwrap());
        assert_eq!(
            respond(&Method::GET, "/theme-init.js", &headers, fake).status(),
            200
        );
        let head = respond(&Method::HEAD, "/", &HeaderMap::new(), fake);
        assert_eq!(head.status(), 200);
    }

    #[test]
    fn unsafe_methods_and_traversal_are_rejected() {
        let post = respond(&Method::POST, "/login", &HeaderMap::new(), fake);
        assert_eq!(post.status(), 405);
        assert_eq!(header_of(&post, header::ALLOW), "GET, HEAD");
        assert_eq!(get("/assets/../secret").status(), 400);
        assert_eq!(get("/..%5Csecret").status(), 404); // encoded; no file by that name
    }

    #[test]
    fn without_a_build_the_app_shell_is_a_helpful_404() {
        let res = respond(&Method::GET, "/login", &HeaderMap::new(), |_| None);
        assert_eq!(res.status(), 404);
    }
}
