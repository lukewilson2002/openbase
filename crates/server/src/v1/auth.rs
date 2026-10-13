//! Authentication, rate limiting and request extractors of `/api/v1`.
//!
//! Only `Authorization: Bearer <api token>` is accepted. A session cookie is
//! never looked at, so a browser that is signed in to OpenBase cannot be made
//! to call this API by a malicious page (no ambient credentials, hence no CSRF
//! surface either).

use std::time::Duration;

use axum::extract::{FromRequest, FromRequestParts, Request};
use axum::http::request::Parts;
use serde::de::DeserializeOwned;

use crate::auth::{Actor, bearer, lookup_api_token, stamp_token_use};
use crate::extract::{ApiJson, ApiQuery};
use crate::ids::hash_token;
use crate::state::AppState;
use crate::v1::error::V1Error;

const SECOND: Duration = Duration::from_secs(1);

/// The caller of a `/api/v1` request: an API-token actor within its rate
/// limits.
pub struct V1Auth(pub Actor);

impl FromRequestParts<AppState> for V1Auth {
    type Rejection = V1Error;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let Some(token) = bearer(parts).map(str::to_string) else {
            return Err(V1Error::auth_required(
                "This API needs an API token: send the header \"Authorization: Bearer <token>\". \
                 Session cookies are not accepted.",
            ));
        };
        let lookup = token.clone();
        let Some((actor, last_used_at)) =
            state.db.read(move |c| lookup_api_token(c, &lookup)).await?
        else {
            return Err(V1Error::auth_required(
                "The API token is invalid or expired",
            ));
        };
        // Limits apply to valid tokens only, which keeps the limiter's memory
        // bounded by the number of tokens.
        let token_hash = hash_token(&token);
        state.limiter.check(
            "v1_token",
            &token_hash,
            state.config.v1_rate_per_token,
            SECOND,
        )?;
        state.limiter.check(
            "v1_user",
            &actor.user_id,
            state.config.v1_rate_per_user,
            SECOND,
        )?;
        stamp_token_use(state, &actor, last_used_at).await;
        Ok(V1Auth(actor))
    }
}

/// JSON request body; every rejection is an Airtable-style error.
pub struct V1Json<T>(pub T);

impl<S, T> FromRequest<S> for V1Json<T>
where
    T: DeserializeOwned,
    S: Send + Sync,
{
    type Rejection = V1Error;

    async fn from_request(req: Request, state: &S) -> Result<Self, Self::Rejection> {
        let ApiJson(value) = ApiJson::<T>::from_request(req, state).await?;
        Ok(V1Json(value))
    }
}

/// The query string as ordered `(key, value)` pairs, so bracketed Airtable
/// keys (`fields[]`, `sort[0][field]`, `records[]`) can be read.
pub struct V1Pairs(pub Vec<(String, String)>);

impl<S: Send + Sync> FromRequestParts<S> for V1Pairs {
    type Rejection = V1Error;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        let ApiQuery(pairs) =
            ApiQuery::<Vec<(String, String)>>::from_request_parts(parts, state).await?;
        Ok(V1Pairs(pairs))
    }
}
