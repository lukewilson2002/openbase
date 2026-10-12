//! Real-time events pushed to clients over Server-Sent Events
//! (`GET /api/bases/{base_id}/events`). Each SSE message has `event: <kind>`
//! and `data: <json of BaseEvent>`. Clients treat events as invalidation
//! hints and refetch what they display; events carry ids, not full data.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum BaseEvent {
    /// Records were created, updated or deleted (including recomputed
    /// dependents in other tables).
    RecordsChanged {
        table_id: String,
        #[serde(default)]
        created: Vec<String>,
        #[serde(default)]
        updated: Vec<String>,
        #[serde(default)]
        deleted: Vec<String>,
    },
    /// Tables, fields or views changed; refetch the base schema.
    SchemaChanged {
        #[serde(default)]
        table_id: Option<String>,
    },
    /// Comments on a record changed.
    CommentsChanged { record_id: String },
    /// Base membership or the base itself changed (rename, delete, access).
    BaseChanged,
}

/// Wrapper carrying who caused the event, so a client can skip echoes of its
/// own changes (it sends `X-Client-Id` with every request).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EventEnvelope {
    pub base_id: String,
    #[serde(default)]
    pub client_id: Option<String>,
    #[serde(default)]
    pub user_id: Option<String>,
    pub event: BaseEvent,
}
