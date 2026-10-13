//! Request extractors that fail with the API's JSON error envelope.
//!
//! The plan (docs/plans §3, "Error format") says every error answers
//! `{"error": {"code": "...", "message": "..."}}`. axum's own `Json` and
//! `Query` extractors reject malformed input with a plain-text 400/415/422
//! body, which breaks that contract and makes the web client show the status
//! text instead of a useful message.
//!
//! **All handlers must use [`ApiJson`] and [`ApiQuery`] instead of
//! `axum::Json` / `axum::extract::Query` as request extractors** (`axum::Json`
//! is still the right type for *responses*). A rejection becomes
//! [`AppError::BadRequest`] (HTTP 400, code `bad_request`) with the parser's
//! explanation, for example ``missing field `email` at line 1 column 17``.
//! An oversized body keeps its own status (413, `payload_too_large`), because
//! telling the client to fix its syntax would be wrong.
//!
//! The pair is a drop-in replacement: `ApiJson(req): ApiJson<T>` and
//! `ApiQuery(q): ApiQuery<T>` destructure exactly like the axum originals.

use axum::Json;
use axum::extract::rejection::{JsonRejection, QueryRejection};
use axum::extract::{FromRequest, FromRequestParts, Query, Request};
use axum::http::StatusCode;
use axum::http::request::Parts;
use serde::de::DeserializeOwned;

use crate::error::AppError;

/// JSON request body. Rejections render as the standard error envelope.
#[derive(Debug, Clone, Copy, Default)]
pub struct ApiJson<T>(pub T);

impl<S, T> FromRequest<S> for ApiJson<T>
where
    T: DeserializeOwned,
    S: Send + Sync,
{
    type Rejection = AppError;

    async fn from_request(req: Request, state: &S) -> Result<Self, Self::Rejection> {
        match Json::<T>::from_request(req, state).await {
            Ok(Json(value)) => Ok(ApiJson(value)),
            Err(rejection) => Err(json_error(rejection)),
        }
    }
}

/// Query-string parameters. Rejections render as the standard error envelope.
#[derive(Debug, Clone, Copy, Default)]
pub struct ApiQuery<T>(pub T);

impl<S, T> FromRequestParts<S> for ApiQuery<T>
where
    T: DeserializeOwned,
    S: Send + Sync,
{
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        match Query::<T>::from_request_parts(parts, state).await {
            Ok(Query(value)) => Ok(ApiQuery(value)),
            Err(rejection) => Err(query_error(rejection)),
        }
    }
}

fn json_error(rejection: JsonRejection) -> AppError {
    if rejection.status() == StatusCode::PAYLOAD_TOO_LARGE {
        return AppError::PayloadTooLarge("request body is too large".into());
    }
    let detail = match &rejection {
        JsonRejection::MissingJsonContentType(_) => {
            "expected a JSON body with the header Content-Type: application/json".to_string()
        }
        other => format!(
            "invalid JSON request body: {}",
            strip_prefix(&other.body_text())
        ),
    };
    AppError::BadRequest(detail)
}

fn query_error(rejection: QueryRejection) -> AppError {
    AppError::BadRequest(format!(
        "invalid query string: {}",
        strip_prefix(&rejection.body_text())
    ))
}

/// axum's rejection texts start with a generic "Failed to ...: " sentence;
/// keep only the specific part ("missing field `x` at line 1 column 2").
fn strip_prefix(text: &str) -> &str {
    match text.split_once(": ") {
        Some((head, rest)) if head.starts_with("Failed to") => rest,
        _ => text,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::Router;
    use axum::body::Body;
    use axum::http::{Request as HttpRequest, header};
    use axum::routing::{get, post};
    use http_body_util::BodyExt;
    use serde::Deserialize;
    use serde_json::Value;
    use tower::ServiceExt;

    #[derive(Debug, Deserialize)]
    struct Item {
        name: String,
    }

    #[derive(Debug, Deserialize)]
    struct Page {
        limit: u32,
    }

    fn app() -> Router {
        Router::new()
            .route(
                "/json",
                post(|ApiJson(i): ApiJson<Item>| async move { Json(i.name) }),
            )
            .route(
                "/query",
                get(|ApiQuery(p): ApiQuery<Page>| async move { Json(p.limit) }),
            )
    }

    async fn call(req: HttpRequest<Body>) -> (StatusCode, Value) {
        let res = app().oneshot(req).await.unwrap();
        let status = res.status();
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    fn post_json(body: &str) -> HttpRequest<Body> {
        HttpRequest::post("/json")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body.to_string()))
            .unwrap()
    }

    #[tokio::test]
    async fn valid_input_passes_through() {
        let (s, v) = call(post_json(r#"{"name":"x"}"#)).await;
        assert_eq!((s, v), (StatusCode::OK, Value::from("x")));
        let (s, v) = call(
            HttpRequest::get("/query?limit=5")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
        assert_eq!((s, v), (StatusCode::OK, Value::from(5)));
    }

    #[tokio::test]
    async fn malformed_json_is_an_enveloped_400() {
        for body in ["{", "not json", r#"{"name": }"#, ""] {
            let (s, v) = call(post_json(body)).await;
            assert_eq!(s, StatusCode::BAD_REQUEST, "body {body:?}");
            assert_eq!(v["error"]["code"], "bad_request");
            assert!(
                v["error"]["message"]
                    .as_str()
                    .unwrap()
                    .starts_with("invalid JSON request body: ")
            );
        }
    }

    #[tokio::test]
    async fn wrong_shape_names_the_problem() {
        let (s, v) = call(post_json(r#"{"nme":"x"}"#)).await;
        assert_eq!(s, StatusCode::BAD_REQUEST);
        assert!(
            v["error"]["message"]
                .as_str()
                .unwrap()
                .contains("missing field `name`")
        );
        let (s, v) = call(post_json(r#"{"name":5}"#)).await;
        assert_eq!(s, StatusCode::BAD_REQUEST);
        assert!(
            v["error"]["message"]
                .as_str()
                .unwrap()
                .contains("invalid type")
        );
    }

    #[tokio::test]
    async fn missing_content_type_is_an_enveloped_400() {
        let req = HttpRequest::post("/json")
            .body(Body::from(r#"{"name":"x"}"#))
            .unwrap();
        let (s, v) = call(req).await;
        assert_eq!(s, StatusCode::BAD_REQUEST);
        assert_eq!(v["error"]["code"], "bad_request");
        assert!(
            v["error"]["message"]
                .as_str()
                .unwrap()
                .contains("Content-Type")
        );
    }

    #[tokio::test]
    async fn bad_query_is_an_enveloped_400() {
        for uri in ["/query", "/query?limit=abc", "/query?limit=-1"] {
            let (s, v) = call(HttpRequest::get(uri).body(Body::empty()).unwrap()).await;
            assert_eq!(s, StatusCode::BAD_REQUEST, "uri {uri}");
            assert_eq!(v["error"]["code"], "bad_request");
            assert!(
                v["error"]["message"]
                    .as_str()
                    .unwrap()
                    .starts_with("invalid query string: ")
            );
        }
    }
}
