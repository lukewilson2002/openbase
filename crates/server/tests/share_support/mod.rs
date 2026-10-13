//! Helpers for the sharing, public form, CSV and Airtable-API tests. Builds on
//! `query_support` (a `People` table) and adds raw multipart requests,
//! anonymous requests from chosen client addresses and share-link helpers.
#![allow(dead_code)]

use std::net::SocketAddr;

use axum::body::Body;
use axum::http::{Request, header};
use serde_json::{Value, json};

use crate::common::{Client, Response, TestApp};
pub use crate::query_support::*;

pub const BOUNDARY: &str = "----opengridw7boundary";

/// A multipart body: (field name, optional file name, bytes).
pub fn multipart_body(parts: &[(&str, Option<&str>, &[u8])]) -> Vec<u8> {
    let mut body = Vec::new();
    for (name, filename, data) in parts {
        body.extend_from_slice(format!("--{BOUNDARY}\r\n").as_bytes());
        match filename {
            Some(f) => body.extend_from_slice(
                format!(
                    "Content-Disposition: form-data; name=\"{name}\"; filename=\"{f}\"\r\n\
                     Content-Type: application/octet-stream\r\n\r\n"
                )
                .as_bytes(),
            ),
            None => body.extend_from_slice(
                format!("Content-Disposition: form-data; name=\"{name}\"\r\n\r\n").as_bytes(),
            ),
        }
        body.extend_from_slice(data);
        body.extend_from_slice(b"\r\n");
    }
    body.extend_from_slice(format!("--{BOUNDARY}--\r\n").as_bytes());
    body
}

pub fn auth(
    mut req: axum::http::request::Builder,
    client: &Client,
) -> axum::http::request::Builder {
    if let Some(c) = &client.cookie {
        req = req.header(
            header::COOKIE,
            format!("{}={}", opengrid::auth::SESSION_COOKIE, c),
        );
    }
    if let Some(t) = &client.bearer {
        req = req.header(header::AUTHORIZATION, format!("Bearer {t}"));
    }
    req.header(opengrid::http::CSRF_HEADER, "1")
}

/// POST a multipart body as `client`; `extra` are additional request headers.
pub async fn post_multipart(
    app: &TestApp,
    client: &Client,
    path: &str,
    parts: &[(&str, Option<&str>, &[u8])],
    extra: &[(&str, &str)],
) -> Response {
    let mut req = auth(Request::builder().method("POST").uri(path), client).header(
        header::CONTENT_TYPE,
        format!("multipart/form-data; boundary={BOUNDARY}"),
    );
    for (k, v) in extra {
        req = req.header(*k, *v);
    }
    app.send(req.body(Body::from(multipart_body(parts))).unwrap())
        .await
}

/// An anonymous request from client address `ip` (no cookie, no CSRF header).
pub async fn anon(
    app: &TestApp,
    method: &str,
    path: &str,
    body: Option<Value>,
    headers: &[(&str, &str)],
    ip: &str,
) -> Response {
    let peer: SocketAddr = format!("{ip}:4000").parse().unwrap();
    app.request_with(
        &Client::default(),
        method,
        path,
        body,
        headers,
        false,
        Some(peer),
    )
    .await
}

pub async fn pub_get(app: &TestApp, path: &str) -> Response {
    anon(app, "GET", path, None, &[], "10.0.0.1").await
}

pub async fn pub_get_pw(app: &TestApp, path: &str, password: &str) -> Response {
    anon(
        app,
        "GET",
        path,
        None,
        &[("x-share-password", password)],
        "10.0.0.1",
    )
    .await
}

pub async fn pub_post(app: &TestApp, path: &str, body: Value) -> Response {
    anon(app, "POST", path, Some(body), &[], "10.0.0.1").await
}

pub async fn pub_post_pw(app: &TestApp, path: &str, body: Value, password: &str) -> Response {
    anon(
        app,
        "POST",
        path,
        Some(body),
        &[("x-share-password", password)],
        "10.0.0.1",
    )
    .await
}

/// A tiny valid PNG.
pub fn png(width: u32, height: u32) -> Vec<u8> {
    let img = image::RgbImage::from_fn(width, height, |x, y| {
        image::Rgb([(x % 256) as u8, (y % 256) as u8, 128])
    });
    let mut out = std::io::Cursor::new(Vec::new());
    img.write_to(&mut out, image::ImageFormat::Png).unwrap();
    out.into_inner()
}

impl Fixture {
    /// Create a share link as the owner; asserts 201 and returns the DTO.
    pub async fn share(&self, view_id: &str, kind: &str, password: Option<&str>) -> Value {
        let r = self
            .app
            .post(
                &self.owner,
                &format!("/api/views/{view_id}/shares"),
                json!({ "kind": kind, "password": password }),
            )
            .await;
        r.assert_status(201);
        r.body.clone()
    }

    /// Create a view of `kind` (grid, form, ...) with `config`; returns its id.
    pub async fn view_of(&self, table_id: &str, name: &str, kind: &str, config: Value) -> String {
        let r = self
            .app
            .post(
                &self.owner,
                &format!("/api/tables/{table_id}/views"),
                json!({ "name": name, "type": kind, "config": config }),
            )
            .await;
        r.assert_status(201);
        id_of(&r.body)
    }

    /// Upload a file to the base as the owner; returns the `AttachmentRef`.
    pub async fn upload(&self, filename: &str, data: &[u8]) -> Value {
        let r = post_multipart(
            &self.app,
            &self.owner,
            &format!("/api/bases/{}/attachments", self.base_id),
            &[("file", Some(filename), data)],
            &[],
        )
        .await;
        r.assert_status(200);
        r.body.clone()
    }

    /// A multiple-attachments field.
    pub async fn attachment_field(&self, table_id: &str, name: &str) -> Value {
        self.add_field(
            table_id,
            json!({ "name": name, "type": "attachment", "options": {} }),
        )
        .await
    }
}
