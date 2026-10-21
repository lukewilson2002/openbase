//! Catalogue of every REST endpoint of the internal API, for the MCP tools `api_reference` and
//! `api_request` (and for `api_request`'s up-front refusal of endpoints agents must not call).
//!
//! It is a static table on purpose: the parity test at the bottom scans the source for every
//! `.route("...")` registration and fails when a route is neither listed here nor in
//! [`EXCLUDED`], so a new endpoint cannot silently be missing from MCP. Another test
//! (`tests/token_capabilities.rs`) compares the `Access` column with what the server actually
//! enforces.

use serde_json::{Value, json};

/// What a caller needs to use an endpoint (the "required token capability").
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Access {
    /// No credentials at all (the URL token is the capability).
    Public,
    /// Any API token, including read-only ones (the role still applies).
    Read,
    /// A token with write access (not read-only).
    Write,
    /// A token with the `manage` permission (and write). Base-level actions: a token limited to
    /// specific bases manages those bases only.
    Manage,
    /// `manage`, and the token must not be limited to specific bases (workspace-level actions).
    ManageUnscoped,
    /// `manage` + not base-limited + the token's user must be an instance administrator.
    Admin,
    /// Never available to tokens: credentials, 2FA, sessions and token management.
    SessionOnly,
    /// Sign-in flows and streams that make no sense for an agent; `api_request` refuses them.
    Blocked,
}

impl Access {
    pub fn label(self) -> &'static str {
        match self {
            Access::Public => "public (no credentials)",
            Access::Read => "read",
            Access::Write => "write",
            Access::Manage => "manage",
            Access::ManageUnscoped => "manage (token not limited to specific bases)",
            Access::Admin => "admin (manage token of an instance administrator)",
            Access::SessionOnly => "session-only (never with a token)",
            Access::Blocked => "not available through MCP",
        }
    }

    /// `api_request` refuses these before sending anything.
    pub fn blocked_for_agents(self) -> bool {
        matches!(self, Access::SessionOnly | Access::Blocked)
    }
}

#[derive(Debug, Clone, Copy)]
pub struct Endpoint {
    pub method: &'static str,
    /// The route as registered, with `{param}` segments.
    pub path: &'static str,
    pub area: &'static str,
    pub summary: &'static str,
    /// Lowest role that can use it (`viewer` .. `owner`, on the base unless noted), `-` when no
    /// role applies.
    pub role: &'static str,
    pub access: Access,
    /// Request body / query summary.
    pub request: &'static str,
    /// Response summary.
    pub response: &'static str,
}

#[allow(clippy::too_many_arguments)]
const fn e(
    method: &'static str,
    path: &'static str,
    area: &'static str,
    role: &'static str,
    access: Access,
    summary: &'static str,
    request: &'static str,
    response: &'static str,
) -> Endpoint {
    Endpoint {
        method,
        path,
        area,
        summary,
        role,
        access,
        request,
        response,
    }
}

use Access::*;

const GET: &str = "GET";
const POST: &str = "POST";
const PATCH: &str = "PATCH";
const PUT: &str = "PUT";
const DELETE: &str = "DELETE";

/// Areas in display order, with a one-line description.
pub const AREAS: &[(&str, &str)] = &[
    ("workspaces", "workspaces, their members and trash"),
    (
        "bases",
        "bases (schema, rename, delete, duplicate, members)",
    ),
    ("tables", "tables"),
    ("fields", "fields (columns) and formula checks"),
    (
        "views",
        "views (grid, kanban, calendar, ...) and their config",
    ),
    (
        "records",
        "records: query, get, create, update, delete, restore, move, history",
    ),
    ("comments", "record comments"),
    (
        "search",
        "search names and record text across everything you can open",
    ),
    (
        "history",
        "the activity feed: recent changes and comments across all your projects",
    ),
    ("trash", "trash listings and restore"),
    ("csv", "CSV import and export"),
    ("attachments", "file uploads and downloads"),
    ("sharing", "share links and public forms"),
    ("automations", "automations, runs and webhooks"),
    ("invites", "invite links"),
    ("notifications", "in-app notifications"),
    (
        "inbox",
        "your private quick-capture drafts, filed into tables later",
    ),
    (
        "account",
        "the signed-in user's profile, tokens and sessions",
    ),
    ("admin", "instance administration"),
    ("airtable", "Airtable-compatible API (/api/v1)"),
    ("system", "health, setup and sign-in flows"),
];

const NO_BODY: &str = "no body";
const OK: &str = "{ok: true}";

pub static ENDPOINTS: &[Endpoint] = &[
    // ----------------------------------------------------------------- workspaces
    e(
        GET,
        "/api/workspaces",
        "workspaces",
        "-",
        Read,
        "Workspaces the user belongs to, in the user's own order (POST /api/workspaces/reorder), each with the bases they can open in their shared order (POST /api/workspaces/{id}/bases/reorder) and who can open each (a base-limited token sees only its bases).",
        NO_BODY,
        "WorkspaceSummary[] {id, name, icon, color, role, member_count, pending_invite_count, bases: [{id, name, role, workspace_id, color, icon, people, tables: [{id, name, icon}]}]}",
    ),
    e(
        POST,
        "/api/workspaces",
        "workspaces",
        "-",
        ManageUnscoped,
        "Create a workspace; the caller becomes its owner. icon: a Lucide icon name in kebab-case (the REST API checks the format only; the MCP tool create_workspace checks the name and list_icons searches them). color: a palette colour like a base's (default: the next one the caller's workspaces don't use yet).",
        "{name, icon?, color?}",
        "201 WorkspaceSummary",
    ),
    e(
        POST,
        "/api/workspaces/reorder",
        "workspaces",
        "viewer (workspace)",
        Write,
        "Set the caller's own order of their workspaces (personal: other members keep theirs). The listed workspaces take the places they hold now, in the order given; every other workspace of the caller keeps its place; a workspace joined or created later comes last. ids: at least one, none twice, each a workspace the token can see. Listing the same ids again changes nothing. Use this instead of a raw position.",
        "{ids: [workspace id, ...]}",
        OK,
    ),
    e(
        PATCH,
        "/api/workspaces/{id}",
        "workspaces",
        "owner (workspace)",
        ManageUnscoped,
        "Rename a workspace or change its icon (absent = unchanged, null = clear) or colour.",
        "{name?, icon?, color?}",
        "WorkspaceSummary",
    ),
    e(
        DELETE,
        "/api/workspaces/{id}",
        "workspaces",
        "owner (workspace)",
        ManageUnscoped,
        "Delete a workspace and its bases (to the trash; restorable for 30 days).",
        NO_BODY,
        OK,
    ),
    e(
        GET,
        "/api/workspaces/{id}/members",
        "workspaces",
        "viewer (workspace)",
        ManageUnscoped,
        "List workspace members, their roles and the bases each can open.",
        NO_BODY,
        "Member[] {user_id, name, email, role, all_bases, base_ids}",
    ),
    e(
        PATCH,
        "/api/workspaces/{id}/members/{user_id}",
        "workspaces",
        "owner (workspace)",
        ManageUnscoped,
        "Change a member's role (viewer, commenter, editor, creator, owner; one role for every base they can open) and/or their bases: all_bases true for every base including later ones, or base_ids for a picked list (at least one). Owners always have all bases. A workspace always keeps an owner.",
        "{role?, all_bases?, base_ids?}",
        OK,
    ),
    e(
        DELETE,
        "/api/workspaces/{id}/members/{user_id}",
        "workspaces",
        "owner (workspace); anyone for themself",
        ManageUnscoped,
        "Remove a member (or leave); they lose every base of the workspace.",
        NO_BODY,
        OK,
    ),
    e(
        GET,
        "/api/workspaces/{id}/trash",
        "workspaces",
        "owner (workspace)",
        ManageUnscoped,
        "Deleted bases of a workspace.",
        NO_BODY,
        "TrashListing {items: [{kind, id, name, deleted_at}]}",
    ),
    e(
        GET,
        "/api/trash/workspaces",
        "workspaces",
        "-",
        ManageUnscoped,
        "The caller's own deleted workspaces (they must be an owner).",
        NO_BODY,
        "TrashListing",
    ),
    // ---------------------------------------------------------------------- bases
    e(
        POST,
        "/api/workspaces/{id}/bases",
        "bases",
        "creator (workspace)",
        Write,
        "Create a base in a workspace, with a starter table \"Table 1\" unless empty is true (a token must not be limited to specific bases). A member limited to some bases gets the new base on their list.",
        "{name, color?, icon?, empty?}",
        "201 BaseSchema",
    ),
    e(
        POST,
        "/api/workspaces/{id}/bases/reorder",
        "bases",
        "creator (every listed base)",
        Write,
        "Set the order of a workspace's bases (shared by everyone in the workspace). The listed bases take the places they hold now, in the order given; every other base keeps its place (a member limited to some bases can list only theirs). ids: at least one, none twice, each a live base of the workspace the caller can open as creator. Listing the same ids again changes nothing. Use this instead of a raw position.",
        "{ids: [base id, ...]}",
        OK,
    ),
    e(
        GET,
        "/api/bases/{id}",
        "bases",
        "viewer",
        Read,
        "The full schema of a base: tables, fields (with types and options), views, the caller's role and who can open the base.",
        NO_BODY,
        "BaseSchema {id, name, color, icon, role, workspace_name, workspace_color, people: [{user_id, name, email, pending, role}], tables: [{id, name, icon, primary_field_id, fields, views}]}",
    ),
    e(
        PATCH,
        "/api/bases/{id}",
        "bases",
        "creator",
        Write,
        "Rename a base or change its color or icon (absent = unchanged, null = clear). To change its place among the workspace's bases use POST /api/workspaces/{id}/bases/reorder.",
        "{name?, color?, icon?}",
        "BaseSchema",
    ),
    e(
        DELETE,
        "/api/bases/{id}",
        "bases",
        "owner",
        Manage,
        "Delete a base (to the trash; restorable for 30 days).",
        NO_BODY,
        OK,
    ),
    e(
        POST,
        "/api/bases/{id}/duplicate",
        "bases",
        "creator (base and workspace)",
        ManageUnscoped,
        "Copy a base, optionally with its records.",
        "{name?, include_records?}",
        "201 BaseSchema (the copy)",
    ),
    e(
        GET,
        "/api/bases/{id}/collaborators",
        "bases",
        "viewer",
        Read,
        "People with access to the base (id, name, email), for user fields and @mentions in comments and rich text.",
        NO_BODY,
        "Collaborator[] {id, name, email}",
    ),
    e(
        GET,
        "/api/bases/{id}/members",
        "bases",
        "viewer",
        Manage,
        "The workspace members who can open this base.",
        NO_BODY,
        "Member[]",
    ),
    e(
        DELETE,
        "/api/bases/{id}/members/{user_id}",
        "bases",
        "owner; viewer for removing yourself",
        Manage,
        "Take this base off the list of a member who was given only some bases (not their last one; change all-bases members on the workspace).",
        NO_BODY,
        OK,
    ),
    // --------------------------------------------------------------------- tables
    e(
        POST,
        "/api/bases/{id}/tables",
        "tables",
        "creator",
        Write,
        "Create a table with just a primary text field \"Name\" and a default grid view (like a new base's first table), optionally with a Lucide icon name and `fields`: the field definitions to create after Name, each as for POST /api/tables/{id}/fields (options may be left out). All or nothing: if one is invalid no table is created and the error names it (fields[2] 'Status').",
        "{name, icon?, fields?: [{name, type, options?, description?, inverse_name?}]}",
        "201 Table",
    ),
    e(
        POST,
        "/api/bases/{id}/tables/reorder",
        "tables",
        "creator",
        Write,
        "Set the order of a base's tables. The listed tables take the places they hold now, in the order given; every other table keeps its place. ids: at least one, none twice, each a live table of the base. Listing the same ids again changes nothing. Use this instead of a raw position.",
        "{ids: [table id, ...]}",
        OK,
    ),
    e(
        PATCH,
        "/api/tables/{id}",
        "tables",
        "creator",
        Write,
        "Rename a table or change its description or icon (absent = unchanged, null = clear). To change its place among the base's tables use POST /api/bases/{id}/tables/reorder.",
        "{name?, icon?, description?}",
        "Table",
    ),
    e(
        DELETE,
        "/api/tables/{id}",
        "tables",
        "creator",
        Write,
        "Delete a table (to the trash).",
        NO_BODY,
        OK,
    ),
    e(
        POST,
        "/api/tables/{id}/duplicate",
        "tables",
        "creator",
        Write,
        "Copy a table, optionally with its records.",
        "{name?, include_records?}",
        "201 Table",
    ),
    // --------------------------------------------------------------------- fields
    e(
        POST,
        "/api/tables/{id}/fields",
        "fields",
        "creator",
        Write,
        "Add a field. `type` and `options` choose the kind, e.g. {\"name\": \"Age\", \"type\": \"number\", \"options\": {}}; copy the shape of an existing field of that type from GET /api/bases/{id}.",
        "{name, type, options, description?, inverse_name? (link fields: name of the field created in the linked table)}",
        "201 Field",
    ),
    e(
        PATCH,
        "/api/fields/{id}",
        "fields",
        "creator",
        Write,
        "Rename a field, change its description, position or type (data is converted).",
        "{name?, description?, type? + options? (changes the type, converting data), position?}",
        "Field",
    ),
    e(
        DELETE,
        "/api/fields/{id}",
        "fields",
        "creator",
        Write,
        "Delete a field (to the trash; restorable).",
        NO_BODY,
        "{ok, deleted_field_ids}",
    ),
    e(
        POST,
        "/api/tables/{id}/primary-field",
        "fields",
        "creator",
        Write,
        "Make another field the table's primary field.",
        "{field_id}",
        "Table",
    ),
    e(
        POST,
        "/api/tables/{id}/formula/check",
        "fields",
        "editor",
        Write,
        "Check a formula and preview it on a record without saving anything.",
        "{expression, record_id?}",
        "{ok, error?: {message, pos}, result_type?, preview?}",
    ),
    // ---------------------------------------------------------------------- views
    e(
        POST,
        "/api/tables/{id}/views",
        "views",
        "viewer for personal views, creator for shared ones",
        Write,
        "Create a view (grid, form, gallery, kanban, calendar, timeline, list).",
        "{name, type: grid|form|gallery|kanban|calendar|timeline|list, personal?, config?}",
        "201 View",
    ),
    e(
        POST,
        "/api/tables/{id}/views/reorder",
        "views",
        "creator when any listed view is shared; editor for a list of only the caller's own personal views",
        Write,
        "Set the order of a table's views as the caller sees them (shared views and their own personal views; other people's personal views are invisible and keep their places). The listed views take the places they hold now, in the order given; every other view keeps its place. ids: at least one, none twice, each a live view of the table the caller can see. The table's default grid (is_default) has no place and is refused with 400. Listing the same ids again changes nothing. Use this instead of a raw position.",
        "{ids: [view id, ...]}",
        OK,
    ),
    e(
        PATCH,
        "/api/views/{id}",
        "views",
        "creator (shared) / owner of a personal view",
        Write,
        "Change a view's name, config (filter, sorts, groups, hidden fields, ...) or lock. To change its place among the table's views use POST /api/tables/{id}/views/reorder.",
        "{name?, config?, locked?}",
        "View",
    ),
    e(
        DELETE,
        "/api/views/{id}",
        "views",
        "creator (shared) / owner of a personal view",
        Write,
        "Delete a view.",
        NO_BODY,
        OK,
    ),
    e(
        POST,
        "/api/views/{id}/duplicate",
        "views",
        "viewer (personal copy) / creator",
        Write,
        "Copy a view.",
        "{name?, personal}",
        "201 View",
    ),
    // -------------------------------------------------------------------- records
    e(
        POST,
        "/api/views/{id}/query",
        "records",
        "viewer",
        Read,
        "Records of a view with its filter, sorts and groups applied, plus optional search and per-request overrides. A POST that only reads.",
        "{offset?, limit? (default 100; 0 = count only), search?, range?, timezone?, transient?: {filter?, sorts?, groups?}}",
        "QueryResponse {total, offset, records: [{id, values: {field_id: value}, ...}], groups, colors}",
    ),
    e(
        POST,
        "/api/tables/{id}/aggregate",
        "records",
        "viewer",
        Read,
        "Group a table's records and compute aggregates per group in the database (no paging through records): count, sum, avg, min, max. Narrow with a view and/or an Airtable formula. A POST that only reads.",
        "{group_by?: [field name or id] (at most 3), aggregates?: [{function: count|sum|avg|min|max, field? (name or id; not for plain count), alias?}] (default one count), view?, filter_by_formula?, sort?: [{by: alias or group_by field, direction?: asc|desc}], limit? (default 1000, max 10000), timezone?}",
        "{group_by: [name], groups: [{group: {field name: value (select/link/user as names, dates as YYYY-MM-DD, empty = null)}, aggregates: {alias: value}}], total_groups, truncated, record_count}",
    ),
    e(
        GET,
        "/api/views/{id}/aggregations",
        "records",
        "viewer",
        Read,
        "The summary-bar aggregations configured on a view.",
        "query: timezone?, search?, transient? (JSON)",
        "{values: {field_id: value}}",
    ),
    e(
        GET,
        "/api/tables/{id}/records/{rid}",
        "records",
        "viewer",
        Read,
        "One record, values keyed by field id.",
        NO_BODY,
        "Record",
    ),
    e(
        POST,
        "/api/tables/{id}/records",
        "records",
        "editor",
        Write,
        "Create records (batch, all or nothing). Values are keyed by field id; link values are record ids.",
        "{records: [{values: {field_id: value}}], typecast?, after_record_id?, before_record_id?}",
        "201 {records: Record[]}",
    ),
    e(
        PATCH,
        "/api/tables/{id}/records",
        "records",
        "editor",
        Write,
        "Update records (merge the given values).",
        "{records: [{id, values}], typecast?}",
        "{records: Record[]}",
    ),
    e(
        DELETE,
        "/api/tables/{id}/records",
        "records",
        "editor",
        Write,
        "Delete records (to the trash; restorable). A batch is all or nothing.",
        "{ids: string[]}",
        "204",
    ),
    e(
        POST,
        "/api/tables/{id}/records/restore",
        "records",
        "editor",
        Write,
        "Restore deleted records.",
        "{ids}",
        "{records: Record[]}",
    ),
    e(
        POST,
        "/api/tables/{id}/records/move",
        "records",
        "editor",
        Write,
        "Reorder records in manual order.",
        "{ids, before_id? | after_id?}",
        "{records: Record[]}",
    ),
    e(
        GET,
        "/api/tables/{id}/records/lookup",
        "records",
        "viewer",
        Read,
        "Find records by primary-field text (link picker); `fields` adds other fields whose text q also matches.",
        "query: q?, limit? (default 20, max 100), view_id?, fields? (comma-separated field ids)",
        "{records: [{id, name}]}",
    ),
    e(
        POST,
        "/api/tables/{id}/records/get",
        "records",
        "viewer",
        Read,
        "Several records of the table by id, in the order asked (e.g. the records a link field points to); ids that are not live records are left out.",
        "{ids} (at most 100)",
        "{records: Record[]}",
    ),
    e(
        GET,
        "/api/records/{id}/history",
        "records",
        "viewer",
        Read,
        "Revision history of a record, newest first.",
        "query: before? (entry id), limit? (default 50, max 200)",
        "HistoryEntry[] {id, user_name, kind, changes: {field_id: {old, new}}, created_at}",
    ),
    // ------------------------------------------------------------------- comments
    e(
        GET,
        "/api/records/{id}/comments",
        "comments",
        "viewer",
        Read,
        "Comments on a record, oldest first.",
        NO_BODY,
        "Comment[] {id, user_name, body, created_at}",
    ),
    e(
        POST,
        "/api/records/{id}/comments",
        "comments",
        "commenter",
        Write,
        "Comment on a record. The body is Markdown (as rich text); mention people as @[Name](usrXXXX).",
        "{body}",
        "201 Comment",
    ),
    e(
        PATCH,
        "/api/comments/{id}",
        "comments",
        "commenter (author)",
        Write,
        "Edit your own comment (Markdown); people mentioned for the first time are notified.",
        "{body}",
        "Comment",
    ),
    e(
        DELETE,
        "/api/comments/{id}",
        "comments",
        "author, or owner of the base",
        Write,
        "Delete a comment.",
        NO_BODY,
        "204",
    ),
    // --------------------------------------------------------------------- search
    e(
        GET,
        "/api/search",
        "search",
        "viewer",
        Read,
        "Search everything you can open, or only what is inside one workspace or base: workspace, base, table and view names, the text of records (primary field and text, rich text, email, URL and phone fields) and comments. Case-insensitive, anywhere in a word. Names come before records, records before comments (newest first), text that starts with q before text that contains it. Each result says where q matched: name_matches in name; for a record found by another field, or a comment, a plain-text snippet around the match (no Markdown; a mention reads @Name; … where cut) with snippet_matches, and the field. Ranges are [start, end) in code points. A workspace or base you cannot open finds nothing. Large instances: records are read up to a budget per request, so very many or very large tables may not all be searched. The MCP tool search_everything wraps it.",
        "query: q (1-200 characters), limit? (default 20, max 50), workspace? (id), base? (id)",
        "SearchResponse {results: [{kind: workspace|base|table|view|record|comment, id, name, name_matches: [{start, end}], workspace_id, workspace_name, workspace_color, base_id, base_name, base_icon, base_color, table_id, table_name, view_id, view_type, record_id, snippet, snippet_matches: [{start, end}], field_id, field_name, author_name}]} (a comment: name is its record's, snippet its text around the match)",
    ),
    // -------------------------------------------------------------------- history
    e(
        GET,
        "/api/history",
        "history",
        "viewer",
        Read,
        "The activity feed: what changed and who commented recently on records in every project you can open (all your workspaces), newest first unless order=oldest. One item per history entry (create, update, delete, restore: the old and new value of each changed field) or comment. Trashed workspaces, projects and tables are left out; so are projects a token does not reach. Page with before = the previous page's next (null at the end).",
        "query: workspace?, base?, table? (ids), user? (the author's user id), kind? (create|update|delete|restore|comment), order? (newest|oldest), before?, limit? (default 50, max 200)",
        "ActivityPage {items: [{id, kind, created_at, author: {id, name}|null, record: {id, name, deleted}, place: {workspace_id, workspace_name, workspace_color, base_id, base_name, base_icon, base_color, table_id, table_name}, changes: {field_id: {old, new}}, comment: text|null}], next: cursor|null, fields: {field_id: Field}}",
    ),
    // ---------------------------------------------------------------------- trash
    e(
        GET,
        "/api/trash",
        "trash",
        "-",
        Read,
        "Everything you could restore, from every workspace you belong to, newest first: records, fields, tables and shared views of bases where you are a creator, your own personal views, and (with the manage permission) bases and workspaces you own. Each item says where it was (workspace, base, table), who deleted it and when it is removed for good (expires_at).",
        "query: workspace_id?, base_id?, kind? (workspace|base|table|field|view|record)",
        "TrashListing {items: [{kind, id, name, icon, table_id, deleted_at, workspace_id, workspace_name, workspace_color, base_id, base_name, base_icon, base_color, table_name, deleted_by_id, deleted_by_name, expires_at}]}",
    ),
    e(
        GET,
        "/api/bases/{id}/trash",
        "trash",
        "creator",
        Read,
        "Deleted records, fields, tables and views of a base.",
        NO_BODY,
        "TrashListing",
    ),
    e(
        POST,
        "/api/trash/restore",
        "trash",
        "creator for items in a base; owner for bases and workspaces (those need the manage permission)",
        Write,
        "Restore a deleted item.",
        "{kind: record|field|table|view|base|workspace, id}",
        "{ok, restored_field_ids}",
    ),
    // ------------------------------------------------------------------------ csv
    e(
        GET,
        "/api/views/{id}/export.csv",
        "csv",
        "viewer",
        Read,
        "Export a view as CSV (its filter, sorts and visible fields apply).",
        NO_BODY,
        "text/csv",
    ),
    e(
        POST,
        "/api/tables/{id}/import",
        "csv",
        "editor",
        Write,
        "Import a CSV into an existing table. All or nothing. With api_request use body {\"multipart\": {\"file\": {\"filename\": \"x.csv\", \"text\": \"Name,Age\\nAda,36\"}}}.",
        "multipart: file (CSV), mapping? (JSON text {\"Column\": \"fldId\" | null}; default: match columns to fields by name), has_header? (default true)",
        "ImportResult {table_id, created}",
    ),
    e(
        POST,
        "/api/bases/{id}/import",
        "csv",
        "creator",
        Write,
        "Import a CSV as a new table (fields inferred; multipart: file, name, has_header).",
        "multipart: file (CSV), name? (new table name), has_header? (default true)",
        "ImportResult {table_id, created, fields}",
    ),
    // ---------------------------------------------------------------- attachments
    e(
        POST,
        "/api/bases/{id}/attachments",
        "attachments",
        "editor",
        Write,
        "Upload a file to a base (multipart field `file`); put the returned reference in an attachment field. With api_request use {\"multipart\": {\"file\": {\"filename\": \"a.png\", \"content_base64\": \"...\"}}}.",
        "multipart: file",
        "AttachmentRef {id, filename, mime, size}",
    ),
    e(
        GET,
        "/api/attachments/{id}/thumb",
        "attachments",
        "viewer",
        Read,
        "Thumbnail of an image attachment (binary).",
        NO_BODY,
        "image bytes",
    ),
    e(
        GET,
        "/api/attachments/{id}/{filename}",
        "attachments",
        "viewer",
        Read,
        "Download an attachment (binary; api_request returns small files base64-encoded).",
        NO_BODY,
        "file bytes",
    ),
    // -------------------------------------------------------------------- sharing
    e(
        GET,
        "/api/views/{id}/shares",
        "sharing",
        "creator",
        Read,
        "Share links of a view.",
        NO_BODY,
        "ShareLink[] {id, kind, token, url, enabled, has_password}",
    ),
    e(
        POST,
        "/api/views/{id}/shares",
        "sharing",
        "creator",
        Write,
        "Create a read-only share link or a public form link for a view.",
        "{kind: view|form, password?}",
        "201 ShareLink",
    ),
    e(
        PATCH,
        "/api/shares/{id}",
        "sharing",
        "creator",
        Write,
        "Enable/disable a share link or set/remove its password.",
        "{enabled?, password? (string | null)}",
        "ShareLink",
    ),
    e(
        DELETE,
        "/api/shares/{id}",
        "sharing",
        "creator",
        Write,
        "Delete a share link.",
        NO_BODY,
        "204",
    ),
    e(
        GET,
        "/api/public/shares/{token}",
        "sharing",
        "-",
        Public,
        "A shared view: visible fields and layout (header X-Share-Password if protected).",
        NO_BODY,
        "PublicView",
    ),
    e(
        POST,
        "/api/public/shares/{token}/query",
        "sharing",
        "-",
        Public,
        "Records of a shared view.",
        "QueryRequest",
        "PublicQueryResponse",
    ),
    e(
        GET,
        "/api/public/forms/{token}",
        "sharing",
        "-",
        Public,
        "A public form definition.",
        NO_BODY,
        "PublicForm",
    ),
    e(
        POST,
        "/api/public/forms/{token}/submit",
        "sharing",
        "-",
        Public,
        "Submit a public form (creates one record anonymously).",
        "{values: {field_id: value}}",
        "OK",
    ),
    e(
        POST,
        "/api/public/forms/{token}/attachments",
        "sharing",
        "-",
        Public,
        "Upload a file for an attachment field of a public form (multipart `file`).",
        "multipart: file",
        "AttachmentRef",
    ),
    // ---------------------------------------------------------------- automations
    e(
        GET,
        "/api/bases/{id}/automations",
        "automations",
        "creator",
        Read,
        "Automations of a base.",
        NO_BODY,
        "Automation[]",
    ),
    e(
        POST,
        "/api/bases/{id}/automations",
        "automations",
        "creator",
        Write,
        "Create an automation. See docs/automations.md for triggers and actions.",
        "{name, enabled?, trigger, actions}",
        "201 Automation (a webhook token is shown once)",
    ),
    e(
        GET,
        "/api/automations/{id}",
        "automations",
        "creator",
        Read,
        "One automation.",
        NO_BODY,
        "Automation",
    ),
    e(
        PATCH,
        "/api/automations/{id}",
        "automations",
        "creator",
        Write,
        "Update an automation (or rotate its webhook token).",
        "UpdateAutomation {name?, enabled?, trigger?, actions?, rotate_webhook_token?}",
        "Automation",
    ),
    e(
        DELETE,
        "/api/automations/{id}",
        "automations",
        "creator",
        Write,
        "Delete an automation.",
        NO_BODY,
        OK,
    ),
    e(
        POST,
        "/api/automations/{id}/test",
        "automations",
        "creator",
        Write,
        "Test an automation (dry run by default: sends and writes nothing).",
        "{record_id?, body?, dry_run? (default true)}",
        "TestResult {dry_run, status, log, error?}",
    ),
    e(
        GET,
        "/api/automations/{id}/runs",
        "automations",
        "editor",
        Read,
        "Run history, newest first.",
        "query: limit? (default 50), before? (run id)",
        "RunsPage {runs, total, next_before}",
    ),
    e(
        POST,
        "/api/hooks/{token}",
        "automations",
        "-",
        Public,
        "Incoming webhook of an automation (JSON body up to 1 MB).",
        "any JSON",
        "202 {ok, run_id}",
    ),
    // -------------------------------------------------------------------- invites
    e(
        GET,
        "/api/workspaces/{id}/invites",
        "invites",
        "owner (workspace)",
        ManageUnscoped,
        "Invites to a workspace (accepted and expired included), with the bases each gives.",
        NO_BODY,
        "InviteInfo[]",
    ),
    e(
        POST,
        "/api/workspaces/{id}/invites",
        "invites",
        "owner (workspace)",
        ManageUnscoped,
        "Create an invite link to a workspace (optionally bound to an email, which is also sent the link when SMTP is configured). Gives every base (default) or only base_ids; owner invites always give every base.",
        "{role, email?, all_bases?, base_ids?}",
        "201 {url, info}",
    ),
    e(
        GET,
        "/api/bases/{id}/invites",
        "invites",
        "creator",
        Manage,
        "Pending invites that give access to this base.",
        NO_BODY,
        "InviteInfo[]",
    ),
    e(
        POST,
        "/api/bases/{id}/invites",
        "invites",
        "creator (never a role above your own)",
        Manage,
        "Create an invite link to the base's workspace, giving this base (default) or base_ids you can open yourself; all_bases and the owner role only for workspace owners, and not with a token limited to specific bases.",
        "{role, email?, all_bases?, base_ids?}",
        "201 {url, info}",
    ),
    e(
        DELETE,
        "/api/invites/{id}",
        "invites",
        "owner (workspace) / creator of every base the invite gives",
        Manage,
        "Revoke a pending invite.",
        NO_BODY,
        "204",
    ),
    e(
        PATCH,
        "/api/invites/{id}",
        "invites",
        "owner (workspace) / creator of every base the invite gives, before and after",
        Manage,
        "Change a pending invite's role and bases; the link stays the same. The new terms follow the rules for creating an invite: all_bases and the owner role only for workspace owners, and not with a token limited to specific bases.",
        "{role?, all_bases?, base_ids?}",
        "InviteInfo",
    ),
    e(
        GET,
        "/api/invites/by-token/{token}",
        "invites",
        "-",
        Public,
        "Preview an invite by its link token.",
        NO_BODY,
        "InvitePreview",
    ),
    e(
        POST,
        "/api/invites/by-token/{token}/accept",
        "invites",
        "-",
        ManageUnscoped,
        "Accept an invite as the caller (cannot accept your own).",
        NO_BODY,
        "InviteInfo",
    ),
    // -------------------------------------------------------------- notifications
    e(
        GET,
        "/api/notifications",
        "notifications",
        "-",
        Read,
        "The caller's 50 newest notifications and the unread count (a base-limited token sees its bases' only).",
        NO_BODY,
        "{notifications, unread}",
    ),
    e(
        POST,
        "/api/notifications/read",
        "notifications",
        "-",
        Write,
        "Mark notifications read (no ids = all).",
        "{ids?}",
        "OkResponse",
    ),
    // ------------------------------------------------------------------- inbox
    e(
        GET,
        "/api/inbox",
        "inbox",
        "-",
        Read,
        "The caller's inbox drafts, most recently changed first (only ever the caller's own). Not available to tokens limited to specific bases (403), like every inbox route.",
        NO_BODY,
        "InboxItem[] {id, body (Markdown), attachments (AttachmentRef[]), created_at, updated_at}",
    ),
    e(
        POST,
        "/api/inbox",
        "inbox",
        "-",
        Write,
        "Add a draft. Files are uploaded first (POST /api/inbox/attachments) and referenced here: at most 20 per draft, each in one draft only.",
        "{body, attachments?: AttachmentRef[]}",
        "InboxItem (201)",
    ),
    e(
        POST,
        "/api/inbox/attachments",
        "inbox",
        "-",
        Write,
        "Upload a file for an inbox draft (multipart field `file`); only you can download it until the draft is filed. At most 60 uploads per minute; your unfiled files add up to at most 200 MB (413). With api_request use {\"multipart\": {\"file\": {\"filename\": \"a.png\", \"content_base64\": \"...\"}}}.",
        "multipart: file",
        "AttachmentRef {id, filename, mime, size}",
    ),
    e(
        PATCH,
        "/api/inbox/{id}",
        "inbox",
        "-",
        Write,
        "Change a draft's text and/or replace its list of files.",
        "{body?, attachments?}",
        "InboxItem",
    ),
    e(
        DELETE,
        "/api/inbox/{id}",
        "inbox",
        "-",
        Write,
        "Delete a draft (permanently; drafts have no trash).",
        NO_BODY,
        "204",
    ),
    e(
        POST,
        "/api/inbox/{id}/file",
        "inbox",
        "editor",
        Write,
        "File a draft: create a record in a table (editor role there) and delete the draft. To keep the draft's files put them ({\"id\": \"att...\"}) in an attachment field.",
        "{table_id, fields: {field name or id: value}}",
        "TableRecord (201)",
    ),
    // -------------------------------------------------------------------- account
    e(
        GET,
        "/api/auth/me",
        "account",
        "-",
        Read,
        "The signed-in user's profile.",
        NO_BODY,
        "User {id, email, name, is_admin, timezone, totp_enabled, intro_seen, accent}",
    ),
    e(
        PATCH,
        "/api/auth/me",
        "account",
        "-",
        Manage,
        "Change the display name, time zone or accent colour (the app's primary colour: blue, cyan, teal, green, yellow, orange, red, pink, purple or gray; \"\" for the default, blue), or mark the introduction as seen.",
        "{name?, timezone?, accent?, intro_seen?}",
        "User",
    ),
    e(
        GET,
        "/api/tokens/whoami",
        "account",
        "-",
        Read,
        "What the calling token can do: user, write, manage and base limits.",
        NO_BODY,
        "WhoAmI {user_id, email, name, via_token, write, manage, base_ids}",
    ),
    e(
        GET,
        "/api/tokens",
        "account",
        "-",
        SessionOnly,
        "List the user's tokens.",
        NO_BODY,
        "TokenInfo[]",
    ),
    e(
        POST,
        "/api/tokens",
        "account",
        "-",
        SessionOnly,
        "Create a token.",
        "{name, write, manage?, base_ids?, expires_in_days?}",
        "201 CreatedToken",
    ),
    e(
        DELETE,
        "/api/tokens/{id}",
        "account",
        "-",
        SessionOnly,
        "Delete a token.",
        NO_BODY,
        "204",
    ),
    e(
        GET,
        "/api/oauth/requests/{id}",
        "account",
        "-",
        SessionOnly,
        "A pending OAuth authorization request, as the consent page shows it.",
        NO_BODY,
        "ConsentRequest",
    ),
    e(
        POST,
        "/api/oauth/requests/{id}/decision",
        "account",
        "-",
        SessionOnly,
        "Approve or deny an app's OAuth authorization request.",
        "{decision: approve|deny, access?: read|write|manage, base_ids?}",
        "ConsentOutcome {redirect_to}",
    ),
    e(
        GET,
        "/api/oauth/grants",
        "account",
        "-",
        SessionOnly,
        "List the user's connected apps (OAuth grants).",
        NO_BODY,
        "GrantInfo[]",
    ),
    e(
        DELETE,
        "/api/oauth/grants/{id}",
        "account",
        "-",
        SessionOnly,
        "Revoke a connected app.",
        NO_BODY,
        "204",
    ),
    e(
        POST,
        "/api/auth/password",
        "account",
        "-",
        SessionOnly,
        "Change the password.",
        "{current_password, new_password}",
        OK,
    ),
    e(
        POST,
        "/api/auth/2fa/setup",
        "account",
        "-",
        SessionOnly,
        "Start two-factor setup.",
        NO_BODY,
        "TwoFactorSetup",
    ),
    e(
        POST,
        "/api/auth/2fa/enable",
        "account",
        "-",
        SessionOnly,
        "Turn two-factor authentication on.",
        "{code}",
        "User",
    ),
    e(
        POST,
        "/api/auth/2fa/disable",
        "account",
        "-",
        SessionOnly,
        "Turn two-factor authentication off.",
        "{password, code}",
        "User",
    ),
    e(
        GET,
        "/api/auth/sessions",
        "account",
        "-",
        SessionOnly,
        "List the user's sessions.",
        NO_BODY,
        "SessionInfo[]",
    ),
    e(
        POST,
        "/api/auth/sessions/revoke-others",
        "account",
        "-",
        SessionOnly,
        "Sign out all other sessions.",
        NO_BODY,
        OK,
    ),
    e(
        DELETE,
        "/api/auth/sessions/{id}",
        "account",
        "-",
        SessionOnly,
        "Sign out one session.",
        NO_BODY,
        OK,
    ),
    e(
        GET,
        "/api/auth/passkeys",
        "account",
        "-",
        SessionOnly,
        "List the user's passkeys (name, created, last used; never the key).",
        NO_BODY,
        "PasskeyInfo[]",
    ),
    e(
        POST,
        "/api/auth/passkeys/register/start",
        "account",
        "-",
        SessionOnly,
        "Start registering a passkey. Needs the password unless the session signed in within 10 minutes (403 reauth_required).",
        "{password?}",
        "PasskeyChallenge {challenge_id, options}",
    ),
    e(
        POST,
        "/api/auth/passkeys/register/finish",
        "account",
        "-",
        SessionOnly,
        "Finish registering a passkey with the browser's answer.",
        "{challenge_id, name?, credential}",
        "201 PasskeyInfo",
    ),
    e(
        PATCH,
        "/api/auth/passkeys/{id}",
        "account",
        "-",
        SessionOnly,
        "Rename a passkey.",
        "{name}",
        "PasskeyInfo",
    ),
    e(
        DELETE,
        "/api/auth/passkeys/{id}",
        "account",
        "-",
        SessionOnly,
        "Remove a passkey.",
        NO_BODY,
        "204",
    ),
    // ---------------------------------------------------------------------- admin
    e(
        GET,
        "/api/admin/users",
        "admin",
        "instance admin",
        Admin,
        "All users.",
        NO_BODY,
        "AdminUser[]",
    ),
    e(
        POST,
        "/api/admin/users",
        "admin",
        "instance admin",
        Admin,
        "Create a user. Signed in: with a password, or get a reset link to hand over. With an API token the account is created without a usable password: `password` is refused (403) and no reset link is returned, because whoever holds one can take the account over; an administrator sends the invitation from the web app.",
        "{email, name, password? (session only), is_admin}",
        "201 AdminCreatedUser {user, reset_link? (session only)}",
    ),
    e(
        PATCH,
        "/api/admin/users/{id}",
        "admin",
        "instance admin",
        Admin,
        "Rename, (de)activate or (de)promote a user. `disable_2fa` is session-only: with an API token it is refused (403).",
        "{name?, is_active?, is_admin?, disable_2fa? (session only)}",
        "AdminUser",
    ),
    e(
        POST,
        "/api/admin/users/{id}/reset-link",
        "admin",
        "instance admin",
        SessionOnly,
        "Create a 24-hour password-reset link for a user (whoever holds it can set that user's password, so it is never available to a token).",
        NO_BODY,
        "{url, expires_at}",
    ),
    e(
        DELETE,
        "/api/admin/users/{id}/passkeys",
        "admin",
        "instance admin",
        SessionOnly,
        "Remove every passkey of a user (lost device). Credentials are session-only, even for an administrator's manage token.",
        NO_BODY,
        "PasskeysRemoved {removed}",
    ),
    e(
        GET,
        "/api/admin/email",
        "admin",
        "instance admin",
        Admin,
        "The outgoing-email (SMTP) settings: whether email is on, host, port, security, username, sender, whether a password is stored (never the password), where each setting comes from (environment | settings | default | unset) and the read-only email budgets.",
        NO_BODY,
        "EmailSettings {enabled, source, host?, port, security, username?, from, password_set, sources, budgets}",
    ),
    e(
        PATCH,
        "/api/admin/email",
        "admin",
        "instance admin",
        Admin,
        "Change the SMTP settings; effective at once. A field left out keeps its value; null or \"\" clears host/username. Settings fixed by an OPENBASE_SMTP_* environment variable cannot be changed. With an API token: `password` (set, remove) is refused (403, session-only), and so is changing host, port, security or username while a password is in use (it would redirect the password).",
        "{host?, port?, security? (starttls|tls|none), username?, from?, password? (session only: string sets, null removes, \"\" keeps)}",
        "EmailSettings",
    ),
    e(
        POST,
        "/api/admin/email/test",
        "admin",
        "instance admin",
        Admin,
        "Send a test email through the current settings (to the caller's own address unless `to` is given). A delivery failure is a normal answer with the real SMTP error. Counts against the email budgets.",
        "{to?}",
        "EmailTestResult {ok, to, error?}",
    ),
    e(
        GET,
        "/api/admin/oauth/grants",
        "admin",
        "instance admin",
        SessionOnly,
        "Every user's connected apps (OAuth grants).",
        NO_BODY,
        "GrantInfo[] (with user_email, user_name)",
    ),
    e(
        DELETE,
        "/api/admin/oauth/grants/{id}",
        "admin",
        "instance admin",
        SessionOnly,
        "Revoke any user's connected app.",
        NO_BODY,
        "204",
    ),
    e(
        GET,
        "/api/admin/audit",
        "admin",
        "instance admin",
        Admin,
        "The audit log, newest first.",
        "query: before? (entry id), limit? (default 50, max 200)",
        "AuditPage {entries, next_before}",
    ),
    e(
        GET,
        "/api/admin/stats",
        "admin",
        "instance admin",
        Admin,
        "Instance statistics.",
        NO_BODY,
        "InstanceStats",
    ),
    e(
        GET,
        "/api/admin/backups",
        "admin",
        "instance admin",
        Admin,
        "List backups.",
        NO_BODY,
        "BackupInfo[]",
    ),
    e(
        POST,
        "/api/admin/backups",
        "admin",
        "instance admin",
        Admin,
        "Create a backup now.",
        NO_BODY,
        "BackupInfo",
    ),
    e(
        GET,
        "/api/admin/backups/{name}",
        "admin",
        "instance admin",
        SessionOnly,
        "Download a backup archive. It holds password hashes, two-factor secrets and the SMTP password, so only a signed-in administrator can fetch it in the web app.",
        NO_BODY,
        "archive bytes",
    ),
    // ------------------------------------------------------------------- airtable
    e(
        GET,
        "/api/v1/meta/bases",
        "airtable",
        "viewer",
        Read,
        "Airtable-style list of bases the token reaches. Own rate limit (OPENBASE_V1_RATE_PER_TOKEN).",
        NO_BODY,
        "{bases: [{id, name, permissionLevel}]}",
    ),
    e(
        GET,
        "/api/v1/meta/bases/{base_id}/tables",
        "airtable",
        "viewer",
        Read,
        "Airtable-style tables with fields and views.",
        NO_BODY,
        "{tables: [...]}",
    ),
    e(
        GET,
        "/api/v1/{base_id}/{table}",
        "airtable",
        "viewer",
        Read,
        "List records, Airtable style: query pageSize, maxRecords, offset, view, fields[], sort[0][field], filterByFormula. See docs/api.md.",
        "query (Airtable)",
        "{records: [{id, createdTime, fields}], offset?}",
    ),
    e(
        POST,
        "/api/v1/{base_id}/{table}",
        "airtable",
        "editor",
        Write,
        "Create 1-10 records: {records: [{fields}], typecast?} or {fields}.",
        "Airtable body",
        "{records: [...]}",
    ),
    e(
        PATCH,
        "/api/v1/{base_id}/{table}",
        "airtable",
        "editor",
        Write,
        "Update up to 10 records (merge): {records: [{id, fields}], typecast?}.",
        "Airtable body",
        "{records: [...]}",
    ),
    e(
        PUT,
        "/api/v1/{base_id}/{table}",
        "airtable",
        "editor",
        Write,
        "Replace up to 10 records (clears fields not given).",
        "Airtable body",
        "{records: [...]}",
    ),
    e(
        DELETE,
        "/api/v1/{base_id}/{table}",
        "airtable",
        "editor",
        Write,
        "Delete up to 10 records: query records[]=recId.",
        "query records[]",
        "{records: [{id, deleted}]}",
    ),
    e(
        GET,
        "/api/v1/{base_id}/{table}/{record_id}",
        "airtable",
        "viewer",
        Read,
        "One record, Airtable style.",
        NO_BODY,
        "{id, createdTime, fields}",
    ),
    e(
        PATCH,
        "/api/v1/{base_id}/{table}/{record_id}",
        "airtable",
        "editor",
        Write,
        "Update one record (merge): {fields, typecast?}.",
        "Airtable body",
        "record",
    ),
    e(
        PUT,
        "/api/v1/{base_id}/{table}/{record_id}",
        "airtable",
        "editor",
        Write,
        "Replace one record.",
        "Airtable body",
        "record",
    ),
    e(
        DELETE,
        "/api/v1/{base_id}/{table}/{record_id}",
        "airtable",
        "editor",
        Write,
        "Delete one record.",
        NO_BODY,
        "{id, deleted}",
    ),
    // --------------------------------------------------------------------- system
    e(
        GET,
        "/api/health",
        "system",
        "-",
        Public,
        "Liveness check.",
        NO_BODY,
        "{status, version}",
    ),
    e(
        GET,
        "/api/setup",
        "system",
        "-",
        Blocked,
        "First-run setup status (sign-in flow).",
        NO_BODY,
        "SetupStatus",
    ),
    e(
        POST,
        "/api/auth/signup",
        "system",
        "-",
        Blocked,
        "Create an account (sign-in flow; agents do not create accounts).",
        "SignupRequest",
        "User",
    ),
    e(
        POST,
        "/api/auth/login",
        "system",
        "-",
        Blocked,
        "Sign in with a password (agents authenticate with their token instead).",
        "LoginRequest",
        "LoginResponse",
    ),
    e(
        POST,
        "/api/auth/login/2fa",
        "system",
        "-",
        Blocked,
        "Second step of sign-in.",
        "{code}",
        "LoginResponse",
    ),
    e(
        POST,
        "/api/auth/passkey-login/start",
        "system",
        "-",
        Blocked,
        "Start a sign-in with a passkey (agents authenticate with their token instead).",
        NO_BODY,
        "PasskeyChallenge",
    ),
    e(
        POST,
        "/api/auth/passkey-login/finish",
        "system",
        "-",
        Blocked,
        "Finish a sign-in with a passkey.",
        "{challenge_id, credential}",
        "LoginResponse",
    ),
    e(
        POST,
        "/api/auth/logout",
        "system",
        "-",
        Blocked,
        "Sign out the current session.",
        NO_BODY,
        OK,
    ),
    e(
        POST,
        "/api/auth/password-reset/request",
        "system",
        "-",
        Blocked,
        "Ask for a password-reset email.",
        "{email}",
        OK,
    ),
    e(
        POST,
        "/api/auth/password-reset/confirm",
        "system",
        "-",
        Blocked,
        "Finish a password reset.",
        "{token, new_password}",
        OK,
    ),
    e(
        GET,
        "/api/bases/{id}/presence",
        "bases",
        "viewer",
        Read,
        "Who has the base open right now: the user ids with a live-update stream on it, in arrival order (several tabs of one person count once).",
        NO_BODY,
        "Presence {viewers: user id[]}",
    ),
    e(
        GET,
        "/api/bases/{id}/events",
        "system",
        "viewer",
        Blocked,
        "Server-sent live-update stream: it never ends, so it cannot be returned through a tool call.",
        NO_BODY,
        "text/event-stream",
    ),
];

/// Routes that exist in the server but are deliberately not endpoints of the internal API
/// catalogue. Each entry is (method, path, reason); the parity test only accepts these.
pub const EXCLUDED: &[(&str, &str, &str)] = &[
    (
        "POST",
        "/mcp",
        "the MCP endpoint itself: api_request refuses to call it (no recursion)",
    ),
    (
        "GET",
        "/mcp",
        "the MCP endpoint itself (answers 405: no server-initiated stream)",
    ),
    (
        "DELETE",
        "/mcp",
        "the MCP endpoint itself (answers 405: no sessions to end)",
    ),
    (
        "GET",
        "/.well-known/oauth-protected-resource",
        "OAuth discovery document (RFC 9728), not part of the internal API",
    ),
    (
        "GET",
        "/.well-known/oauth-protected-resource/mcp",
        "OAuth discovery document (RFC 9728), not part of the internal API",
    ),
    (
        "GET",
        "/.well-known/oauth-authorization-server",
        "OAuth discovery document (RFC 8414), not part of the internal API",
    ),
    (
        "GET",
        "/oauth/authorize",
        "OAuth protocol endpoint for browsers and OAuth clients; api_request only forwards /api/ paths",
    ),
    (
        "POST",
        "/oauth/register",
        "OAuth dynamic client registration (RFC 7591); api_request only forwards /api/ paths",
    ),
    (
        "POST",
        "/oauth/token",
        "OAuth token endpoint; api_request only forwards /api/ paths",
    ),
    (
        "POST",
        "/oauth/revoke",
        "OAuth revocation endpoint (RFC 7009); api_request only forwards /api/ paths",
    ),
];

/// Does the route template `template` (with `{param}` segments) match the concrete `path`?
pub fn matches(template: &str, path: &str) -> bool {
    let (mut t, mut p) = (template.split('/'), path.split('/'));
    loop {
        match (t.next(), p.next()) {
            (None, None) => return true,
            (Some(ts), Some(ps)) => {
                let param = ts.starts_with('{') && ts.ends_with('}');
                if param {
                    if ps.is_empty() {
                        return false;
                    }
                } else if ts != ps {
                    return false;
                }
            }
            _ => return false,
        }
    }
}

/// How specific a match is: the number of literal segments (the router prefers literals over
/// `{param}` segments, and so does [`find`]).
fn specificity(template: &str) -> usize {
    template
        .split('/')
        .filter(|s| !(s.starts_with('{') && s.ends_with('}')))
        .count()
}

/// The catalogue entry the router would dispatch `method path` to, if any.
pub fn find(method: &str, path: &str) -> Option<&'static Endpoint> {
    ENDPOINTS
        .iter()
        .filter(|ep| ep.method == method && matches(ep.path, path))
        .max_by_key(|ep| specificity(ep.path))
}

/// Does any entry with this path exist for a different method (so the router would answer 405)?
pub fn path_exists(path: &str) -> bool {
    ENDPOINTS.iter().any(|ep| matches(ep.path, path))
}

fn endpoint_json(ep: &Endpoint, detailed: bool) -> Value {
    if detailed {
        json!({
            "method": ep.method,
            "path": ep.path,
            "summary": ep.summary,
            "min_role": ep.role,
            "token_capability": ep.access.label(),
            "request": ep.request,
            "response": ep.response,
        })
    } else {
        json!(format!(
            "{} {} - {} [role: {}; token: {}]",
            ep.method,
            ep.path,
            ep.summary,
            ep.role,
            ep.access.label()
        ))
    }
}

/// What `api_reference` shows as the capability of an `/api/v1` endpoint to a caller that is an
/// OAuth grant: those endpoints exist, but not for such a caller.
const AIRTABLE_UNAVAILABLE_FOR_OAUTH: &str =
    "not available to apps connected through OAuth sign-in (needs a personal access token)";

/// The text of `api_reference`. Without an area: the list of areas with their endpoint lines
/// would be long, so only the areas are listed; with one, every endpoint of the area in detail.
/// `oauth` is true for a caller that is an OAuth grant: it cannot use `/api/v1` (the
/// Airtable-compatible API takes a personal access token only), so those endpoints are marked
/// unavailable instead of being offered as if they worked.
pub fn reference(area: Option<&str>, oauth: bool) -> Result<Value, String> {
    match area {
        None => {
            let areas: Vec<Value> = AREAS
                .iter()
                .map(|(name, what)| {
                    let n = ENDPOINTS.iter().filter(|e| e.area == *name).count();
                    if oauth && *name == "airtable" {
                        return json!({
                            "area": name,
                            "endpoints": n,
                            "about": what,
                            "available": false,
                            "note": AIRTABLE_UNAVAILABLE_FOR_OAUTH,
                        });
                    }
                    json!({"area": name, "endpoints": n, "about": what})
                })
                .collect();
            Ok(json!({
                "usage": "Call api_reference with an area for its endpoints, then api_request with a method and a path from the list. Paths contain ids you get from list_projects / get_project_schema / earlier responses. Errors use {\"error\": {\"code\", \"message\"}}; 404 can also mean \"you have no access\".",
                "conventions": [
                    "Record values are keyed by field id in the internal API (use get_project_schema for ids); the curated tools and /api/v1 use field names.",
                    "A token's role per base is the owner's role, capped at viewer for read-only tokens; some endpoints need the 'manage' permission (see token_capability).",
                    "Deleting things moves them to the trash for 30 days; restore with POST /api/trash/restore.",
                    "Multipart endpoints: send body {\"multipart\": {\"file\": {\"filename\": \"x.csv\", \"text\": \"...\"}, \"field\": \"value\"}} (use content_base64 for binary files)."
                ],
                "areas": areas,
            }))
        }
        Some(name) => {
            let name = name.trim().to_ascii_lowercase();
            let list: Vec<Value> = ENDPOINTS
                .iter()
                .filter(|e| e.area == name)
                .map(|e| {
                    let mut v = endpoint_json(e, true);
                    if oauth && crate::mcp::api::is_airtable_api(e.path) {
                        v["token_capability"] = json!(AIRTABLE_UNAVAILABLE_FOR_OAUTH);
                        v["available"] = json!(false);
                    }
                    v
                })
                .collect();
            if list.is_empty() {
                let known: Vec<&str> = AREAS.iter().map(|(n, _)| *n).collect();
                return Err(format!(
                    "unknown area '{name}'. Areas: {}",
                    known.join(", ")
                ));
            }
            Ok(json!({"area": name, "endpoints": list}))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;
    use std::path::Path;

    #[test]
    fn matching_prefers_literals_and_respects_methods() {
        assert!(matches("/api/bases/{id}", "/api/bases/appX"));
        assert!(!matches("/api/bases/{id}", "/api/bases/appX/tables"));
        assert!(!matches("/api/bases/{id}", "/api/bases/"));
        assert_eq!(
            find("GET", "/api/tokens/whoami").unwrap().access,
            Access::Read
        );
        assert_eq!(
            find("DELETE", "/api/tokens/patX").unwrap().access,
            Access::SessionOnly
        );
        assert_eq!(
            find("GET", "/api/attachments/attX/thumb").unwrap().path,
            "/api/attachments/{id}/thumb"
        );
        assert_eq!(
            find("GET", "/api/attachments/attX/photo.png").unwrap().path,
            "/api/attachments/{id}/{filename}"
        );
        assert_eq!(
            find("POST", "/api/invites/by-token/xyz/accept")
                .unwrap()
                .path,
            "/api/invites/by-token/{token}/accept"
        );
        assert!(find("PATCH", "/api/health").is_none());
        assert!(path_exists("/api/health"));
        assert!(!path_exists("/api/nope"));
    }

    #[test]
    fn entries_are_unique_and_well_formed() {
        let mut seen = BTreeSet::new();
        for ep in ENDPOINTS {
            assert!(
                seen.insert((ep.method, ep.path)),
                "duplicate {} {}",
                ep.method,
                ep.path
            );
            assert!(ep.path.starts_with("/api/"), "{}", ep.path);
            assert!(
                AREAS.iter().any(|(a, _)| *a == ep.area),
                "{} {}: unknown area {}",
                ep.method,
                ep.path,
                ep.area
            );
            assert!(!ep.summary.is_empty());
        }
        for (name, _) in AREAS {
            assert!(
                ENDPOINTS.iter().any(|e| e.area == *name),
                "area {name} has no endpoints"
            );
        }
    }

    #[test]
    fn reference_lists_areas_and_endpoints() {
        let all = reference(None, false).unwrap();
        assert_eq!(all["areas"].as_array().unwrap().len(), AREAS.len());
        let records = reference(Some("Records"), false).unwrap();
        let list = records["endpoints"].as_array().unwrap();
        assert!(list.iter().any(|e| e["path"] == "/api/views/{id}/query"));
        assert!(
            list.iter()
                .all(|e| e["token_capability"].as_str().is_some() && e["min_role"].is_string())
        );
        let err = reference(Some("nope"), false).unwrap_err();
        assert!(err.contains("records"), "{err}");
    }

    /// `.route("path", <handlers>)` registrations in `source`, as (method, path) pairs. The
    /// methods are the `get(`/`post(`/... calls in the handler chain.
    fn routes_in(source: &str) -> Vec<(String, String)> {
        let mut out = Vec::new();
        let mut rest = source;
        while let Some(i) = rest.find(".route(") {
            rest = &rest[i + ".route(".len()..];
            let mut depth = 1usize;
            let mut end = 0;
            for (n, c) in rest.char_indices() {
                match c {
                    '(' => depth += 1,
                    ')' => {
                        depth -= 1;
                        if depth == 0 {
                            end = n;
                            break;
                        }
                    }
                    _ => {}
                }
            }
            let call = &rest[..end];
            let Some(q1) = call.find('"') else { continue };
            let Some(q2) = call[q1 + 1..].find('"') else {
                continue;
            };
            let path = &call[q1 + 1..q1 + 1 + q2];
            if !path.starts_with('/') {
                continue;
            }
            let handlers = &call[q1 + 1 + q2 + 1..];
            for m in ["get", "post", "put", "patch", "delete"] {
                let needle = format!("{m}(");
                let mut from = 0;
                while let Some(p) = handlers[from..].find(&needle) {
                    let at = from + p;
                    let prev = handlers[..at].chars().next_back();
                    if !prev.is_some_and(|c| c.is_alphanumeric() || c == '_') {
                        out.push((m.to_ascii_uppercase(), path.to_string()));
                        break;
                    }
                    from = at + needle.len();
                }
            }
            rest = &rest[end..];
        }
        out
    }

    fn rust_files(dir: &Path, out: &mut Vec<std::path::PathBuf>) {
        for entry in std::fs::read_dir(dir).unwrap().flatten() {
            let path = entry.path();
            if path.is_dir() {
                rust_files(&path, out);
            } else if path.extension().is_some_and(|e| e == "rs") {
                out.push(path);
            }
        }
    }

    /// Strip `#[cfg(test)] mod tests { ... }` blocks, whose router fixtures are not routes of the
    /// server. (Our test modules sit at the end of each file.)
    fn without_tests(src: &str) -> &str {
        match src.find("#[cfg(test)]") {
            Some(i) => &src[..i],
            None => src,
        }
    }

    #[test]
    fn scanner_finds_methods_in_handler_chains() {
        let src = r#"
            Router::new()
                .route("/a", get(x).post(y))
                .route(
                    "/b/{id}",
                    post(upload).layer(DefaultBodyLimit::disable()),
                )
                .route("/c", delete(z).fallback(not_allowed))
        "#;
        let mut found = routes_in(src);
        found.sort();
        assert_eq!(
            found,
            vec![
                ("DELETE".to_string(), "/c".to_string()),
                ("GET".to_string(), "/a".to_string()),
                ("POST".to_string(), "/a".to_string()),
                ("POST".to_string(), "/b/{id}".to_string()),
            ]
        );
    }

    /// Every route the server registers is in the catalogue (or justified in `EXCLUDED`), and
    /// the catalogue lists nothing the server does not serve. A new endpoint therefore cannot be
    /// merged without an entry here, which is also what keeps MCP at parity with the web UI.
    #[test]
    fn every_registered_route_is_catalogued() {
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut files = Vec::new();
        rust_files(&src, &mut files);
        let mut registered: BTreeSet<(String, String)> = BTreeSet::new();
        for f in &files {
            let text = std::fs::read_to_string(f).unwrap();
            for r in routes_in(without_tests(&text)) {
                registered.insert(r);
            }
        }
        assert!(
            registered.len() > 80,
            "the scanner found only {} routes: did the router code move?",
            registered.len()
        );
        let catalogued: BTreeSet<(String, String)> = ENDPOINTS
            .iter()
            .map(|e| (e.method.to_string(), e.path.to_string()))
            .collect();
        let excluded: BTreeSet<(String, String)> = EXCLUDED
            .iter()
            .map(|(m, p, _)| (m.to_string(), p.to_string()))
            .collect();

        let missing: Vec<_> = registered
            .iter()
            .filter(|r| !catalogued.contains(*r) && !excluded.contains(*r))
            .collect();
        assert!(
            missing.is_empty(),
            "routes registered in the server but missing from mcp::catalogue::ENDPOINTS \
             (add them, or justify them in EXCLUDED): {missing:?}"
        );
        let stale: Vec<_> = catalogued.difference(&registered).collect();
        assert!(
            stale.is_empty(),
            "catalogue entries without a matching route registration: {stale:?}"
        );
        // Exclusions must be real routes and must not shadow catalogue entries.
        for (m, p, why) in EXCLUDED {
            assert!(!why.is_empty());
            assert!(
                registered.contains(&(m.to_string(), p.to_string())),
                "excluded route {m} {p} is not registered"
            );
            assert!(!catalogued.contains(&(m.to_string(), p.to_string())));
        }
    }
}
