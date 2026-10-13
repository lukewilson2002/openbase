//! Errors of the Airtable-compatible API: `{"error": {"type", "message"}}`
//! with Airtable's type names and status codes. Everything the rest of the
//! server reports as an [`AppError`] is translated by `From<AppError>`.

use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use ob_core::api::v1::{V1ErrorBody, V1ErrorDetail};

use crate::error::AppError;

pub type V1Result<T> = Result<T, V1Error>;

#[derive(Debug, Clone)]
pub struct V1Error {
    pub status: StatusCode,
    pub kind: &'static str,
    pub message: String,
    /// Seconds for the `Retry-After` header (rate limiting).
    pub retry_after: Option<u64>,
}

impl V1Error {
    pub fn new(status: StatusCode, kind: &'static str, message: impl Into<String>) -> V1Error {
        V1Error {
            status,
            kind,
            message: message.into(),
            retry_after: None,
        }
    }

    /// 422 `INVALID_REQUEST_UNKNOWN`: a malformed body or parameter.
    pub fn invalid(message: impl Into<String>) -> V1Error {
        V1Error::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "INVALID_REQUEST_UNKNOWN",
            message,
        )
    }

    /// 422 `UNKNOWN_FIELD_NAME`.
    pub fn unknown_field(name: &str) -> V1Error {
        V1Error::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "UNKNOWN_FIELD_NAME",
            format!("Unknown field name: \"{name}\""),
        )
    }

    /// 422 `INVALID_VALUE_FOR_COLUMN`.
    pub fn invalid_value(field: &str, why: impl std::fmt::Display) -> V1Error {
        V1Error::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "INVALID_VALUE_FOR_COLUMN",
            format!("Field \"{field}\" cannot accept the provided value: {why}"),
        )
    }

    pub fn auth_required(message: impl Into<String>) -> V1Error {
        V1Error::new(StatusCode::UNAUTHORIZED, "AUTHENTICATION_REQUIRED", message)
    }

    pub fn not_found(what: &str) -> V1Error {
        V1Error::new(
            StatusCode::NOT_FOUND,
            "NOT_FOUND",
            format!("{what} not found"),
        )
    }

    pub fn rate_limited() -> V1Error {
        V1Error {
            status: StatusCode::TOO_MANY_REQUESTS,
            kind: "RATE_LIMIT_REACHED",
            message: "Rate limit reached. Slow down and retry in a moment.".into(),
            retry_after: Some(1),
        }
    }
}

impl From<AppError> for V1Error {
    fn from(e: AppError) -> V1Error {
        match e {
            // The write engine reports cell problems as `field "Name": why`.
            AppError::BadRequest(m) if m.starts_with("field \"") => V1Error::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "INVALID_VALUE_FOR_COLUMN",
                m,
            ),
            AppError::BadRequest(m) => V1Error::invalid(m),
            AppError::Unauthorized => V1Error::auth_required("Authentication required"),
            AppError::Forbidden(_) => V1Error::new(
                StatusCode::FORBIDDEN,
                "INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND",
                "Invalid permissions, or the requested model was not found. Check that both \
                 your user and your token have the required permissions, and that the model \
                 names and/or ids are correct.",
            ),
            AppError::NotFound(what) => V1Error::not_found(&what),
            AppError::MethodNotAllowed => V1Error::new(
                StatusCode::METHOD_NOT_ALLOWED,
                "METHOD_NOT_ALLOWED",
                "This method is not allowed for this endpoint",
            ),
            AppError::Conflict(m) => V1Error::new(StatusCode::CONFLICT, "CONFLICT", m),
            AppError::PayloadTooLarge(m) => {
                V1Error::new(StatusCode::PAYLOAD_TOO_LARGE, "REQUEST_BODY_TOO_LARGE", m)
            }
            AppError::TooManyRequests => V1Error::rate_limited(),
            AppError::Internal(detail) => {
                tracing::error!(error = %detail, "internal error");
                V1Error::new(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "SERVER_ERROR",
                    "Something went wrong. The error has been logged.",
                )
            }
        }
    }
}

impl IntoResponse for V1Error {
    fn into_response(self) -> Response {
        let body = V1ErrorBody {
            error: V1ErrorDetail {
                error_type: self.kind.to_string(),
                message: self.message,
            },
        };
        let mut res = (self.status, axum::Json(body)).into_response();
        if let Some(secs) = self.retry_after
            && let Ok(v) = HeaderValue::from_str(&secs.to_string())
        {
            res.headers_mut().insert(header::RETRY_AFTER, v);
        }
        res
    }
}
