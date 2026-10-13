//! Helpers shared by the schema-plane handlers (workspaces, bases, tables,
//! fields, views, trash): a JSON body extractor that fails with the API error
//! format, the `X-Client-Id` header, event publishing and a few responses.

use axum::body::Bytes;
use axum::extract::{FromRequest, Request};
use axum::http::{HeaderMap, StatusCode};
use og_core::api::events::BaseEvent;
use serde::de::DeserializeOwned;
use serde_json::{Value as Json, json};

use crate::auth::Actor;
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use crate::store::schema::Touched;

/// Header clients send so SSE echoes of their own changes can be skipped.
pub const CLIENT_ID_HEADER: &str = "x-client-id";

/// JSON request body. Unlike `axum::Json`, malformed bodies produce the
/// standard `{"error": {...}}` response.
pub struct ApiJson<T>(pub T);

impl<S, T> FromRequest<S> for ApiJson<T>
where
    T: DeserializeOwned,
    S: Send + Sync,
{
    type Rejection = AppError;

    async fn from_request(req: Request, state: &S) -> Result<Self, Self::Rejection> {
        match axum::Json::<T>::from_request(req, state).await {
            Ok(axum::Json(v)) => Ok(ApiJson(v)),
            Err(rej) => Err(json_rejection(rej)),
        }
    }
}

/// JSON request body that may be omitted entirely (empty body = defaults).
pub struct OptionalJson<T>(pub T);

impl<S, T> FromRequest<S> for OptionalJson<T>
where
    T: DeserializeOwned + Default,
    S: Send + Sync,
{
    type Rejection = AppError;

    async fn from_request(req: Request, state: &S) -> Result<Self, Self::Rejection> {
        let bytes = Bytes::from_request(req, state)
            .await
            .map_err(|e| AppError::bad_request(e.body_text()))?;
        if bytes.iter().all(u8::is_ascii_whitespace) {
            return Ok(OptionalJson(T::default()));
        }
        serde_json::from_slice(&bytes)
            .map(OptionalJson)
            .map_err(|e| AppError::bad_request(format!("invalid JSON body: {e}")))
    }
}

fn json_rejection(rej: axum::extract::rejection::JsonRejection) -> AppError {
    match rej.status() {
        StatusCode::PAYLOAD_TOO_LARGE => {
            AppError::PayloadTooLarge("request body is too large".into())
        }
        StatusCode::UNSUPPORTED_MEDIA_TYPE => {
            AppError::bad_request("expected a JSON body with Content-Type: application/json")
        }
        _ => AppError::bad_request(rej.body_text()),
    }
}

/// The caller's `X-Client-Id`, if it looks sane.
pub fn client_id(headers: &HeaderMap) -> Option<String> {
    let v = headers.get(CLIENT_ID_HEADER)?.to_str().ok()?.trim();
    (!v.is_empty() && v.len() <= 64 && v.chars().all(|c| c.is_ascii_graphic()))
        .then(|| v.to_string())
}

/// Workspace administration, base sharing and similar actions are for people
/// in the web app, never for API tokens.
pub fn require_session(actor: &Actor) -> AppResult<()> {
    if actor.token_scope.is_some() {
        return Err(AppError::forbidden("API tokens cannot do this"));
    }
    Ok(())
}

/// Publish an event on a base's channel on behalf of the actor.
pub fn publish(
    state: &AppState,
    headers: &HeaderMap,
    actor: &Actor,
    base_id: &str,
    event: BaseEvent,
) {
    state.events.publish(
        base_id,
        client_id(headers),
        Some(actor.user_id.clone()),
        event,
    );
}

/// Tell subscribers that tables/fields/views of `base_id` changed.
pub fn publish_schema(
    state: &AppState,
    headers: &HeaderMap,
    actor: &Actor,
    base_id: &str,
    touched: &Touched,
) {
    publish(
        state,
        headers,
        actor,
        base_id,
        BaseEvent::SchemaChanged {
            table_id: touched.event_table(),
        },
    );
}

/// `{"ok": true}`, the body of successful deletes and other actions.
pub fn ok() -> axum::Json<Json> {
    axum::Json(json!({ "ok": true }))
}
