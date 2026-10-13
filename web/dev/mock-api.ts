/**
 * Dev-only mock of the OpenGrid HTTP API for building and checking the grid without a server.
 * Enabled with `VITE_MOCK=1 npm run dev` (see vite.config.ts); never part of a production build.
 *
 * It implements just enough of docs/plans §3.1 (auth, base schema, view queries with
 * filter/sort/group/search, record CRUD + restore + move, lookup, aggregations, comments, history,
 * attachments, fields, view config, SSE) to exercise every grid code path with realistic shapes.
 * Role is switchable with `?role=` on the base URL via the `og-mock-role` cookie
 * (`/api/__mock/role/viewer`), and `/api/__mock/external-edit` simulates another client's write.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";

type Json = unknown;
type Obj = Record<string, any>;

const BASE_ID = "app1";
const T_TASKS = "tbl1";
const T_PEOPLE = "tbl2";
const ME = "usr1";
const USERS = [
  { id: "usr1", name: "Ada Lovelace", email: "ada@example.com" },
  { id: "usr2", name: "Grace Hopper", email: "grace@example.com" },
  { id: "usr3", name: "Alan Turing", email: "alan@example.com" },
];

let seed = 42;
function rnd(): number {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
}
const pick = <T,>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)]!;

const STATUS = [
  { id: "chs1", name: "Todo", color: "gray" },
  { id: "chs2", name: "In progress", color: "blue" },
  { id: "chs3", name: "Done", color: "green" },
  { id: "chs4", name: "Blocked", color: "red_dark" },
];
const TAGS = [
  { id: "cht1", name: "frontend", color: "cyan" },
  { id: "cht2", name: "backend", color: "purple" },
  { id: "cht3", name: "design", color: "pink" },
  { id: "cht4", name: "urgent", color: "orange" },
];

const dateOpts = { include_time: false, date_format: "us", time_format: "h12", timezone: null };

function field(id: string, name: string, type: string, options: Obj = {}, table = T_TASKS): Obj {
  return { id, table_id: table, name, type, options };
}

const taskFields: Obj[] = [
  field("fld_name", "Name", "single_line_text"),
  field("fld_notes", "Notes", "long_text", { rich: true }),
  field("fld_status", "Status", "single_select", { choices: STATUS }),
  field("fld_tags", "Tags", "multiple_select", { choices: TAGS }),
  field("fld_due", "Due", "date", dateOpts),
  field("fld_start", "Starts", "date", { include_time: true, date_format: "friendly", time_format: "h12", timezone: "America/New_York" }),
  field("fld_effort", "Effort", "number", { precision: 1, allow_negative: false }),
  field("fld_budget", "Budget", "currency", { precision: 2, symbol: "$", allow_negative: true }),
  field("fld_progress", "Progress", "percent", { precision: 0, allow_negative: false }),
  field("fld_time", "Time spent", "duration", { format: "h_mm" }),
  field("fld_rating", "Priority", "rating", { max: 5, icon: "star", color: "yellow" }),
  field("fld_done", "Done", "checkbox", { icon: "check", color: "green" }),
  field("fld_email", "Contact", "email"),
  field("fld_url", "Link", "url"),
  field("fld_phone", "Phone", "phone"),
  field("fld_files", "Files", "attachment"),
  field("fld_owner", "Owner", "link", { linked_table_id: T_PEOPLE, inverse_field_id: "fld_p_tasks", single: false }),
  field("fld_assignee", "Assignee", "user", { multiple: false, notify: false }),
  field("fld_score", "Score", "formula", { expression: "{Effort} * 2", format: { kind: "number", precision: 1 }, result_type: "number" }),
  field("fld_label", "Label", "formula", { expression: "{Name} & '!'", result_type: "text" }),
  field("fld_owner_email", "Owner email", "lookup", { link_field_id: "fld_owner", target_field_id: "fld_p_email", result_type: { array: "text" } }),
  field("fld_owner_count", "Owners", "count", { link_field_id: "fld_owner" }),
  field("fld_created", "Created", "created_time", { include_time: true, date_format: "iso", time_format: "h24", timezone: null }),
  field("fld_modified", "Modified", "last_modified_time", { fields: [], date: { include_time: true, date_format: "us", time_format: "h12", timezone: null } }),
  field("fld_creator", "Created by", "created_by"),
  field("fld_modifier", "Modified by", "last_modified_by", { fields: [], date: dateOpts }),
  field("fld_auto", "ID", "autonumber"),
  field("fld_barcode", "Barcode", "barcode"),
  field("fld_btn", "Open", "button", { label: "Open link", url_formula: "{Link}" }),
];

const peopleFields: Obj[] = [
  field("fld_p_name", "Name", "single_line_text", {}, T_PEOPLE),
  field("fld_p_email", "Email", "email", {}, T_PEOPLE),
  field("fld_p_tasks", "Tasks", "link", { linked_table_id: T_TASKS, inverse_field_id: "fld_owner", single: false }, T_PEOPLE),
];

function emptyConfig(): Obj {
  return {
    filter: null,
    sorts: [],
    groups: [],
    hidden_fields: [],
    field_order: [],
    field_widths: {},
    frozen_columns: 0,
    row_height: "short",
    row_color: null,
    summaries: {},
    wrap_headers: false,
    kanban: { stack_field_id: null, cover_field_id: null, hide_empty_stacks: false, stack_order: [] },
    calendar: { date_field_id: null, end_field_id: null },
    gallery: { cover_field_id: null, cover_crop: false },
    timeline: { start_field_id: null, end_field_id: null, group_field_id: null, dependency_field_id: null, scale: "week" },
    form: { title: "", description: "", fields: [], submit_label: "", success_message: "", redirect_url: null, show_submit_another: false },
  };
}

const views: Obj[] = [
  { id: "viw1", table_id: T_TASKS, name: "All tasks", type: "grid", config: emptyConfig(), personal: false, locked: false },
  { id: "viw2", table_id: T_TASKS, name: "By status", type: "grid", config: { ...emptyConfig(), groups: [{ field_id: "fld_status", direction: "asc" }], row_color: { mode: "by_select", field_id: "fld_status" } }, personal: false, locked: false },
  { id: "viw3", table_id: T_PEOPLE, name: "Everyone", type: "grid", config: emptyConfig(), personal: false, locked: false },
];

interface Rec {
  id: string;
  table_id: string;
  created_at: number;
  updated_at: number;
  created_by: string | null;
  updated_by: string | null;
  autonumber: number;
  values: Obj;
  deleted: boolean;
  order: number;
}

const records = new Map<string, Rec>();
let autonumber = 0;
let order = 0;
let idCounter = 1000;
const newId = (prefix: string) => `${prefix}${(idCounter++).toString(36)}`;

function addRecord(table: string, values: Obj): Rec {
  const now = Date.now() - Math.floor(rnd() * 86_400_000 * 30);
  const rec: Rec = { id: newId("rec"), table_id: table, created_at: now, updated_at: now, created_by: ME, updated_by: pick(USERS).id, autonumber: ++autonumber, values, deleted: false, order: order++ };
  records.set(rec.id, rec);
  return rec;
}

const WORDS = ["Plan", "Design", "Build", "Review", "Ship", "Test", "Refactor", "Document", "Migrate", "Audit", "Prototype", "Launch"];
const OBJECTS = ["login page", "billing", "search index", "onboarding", "API docs", "dashboard", "exports", "settings", "mobile app", "webhooks"];

function seedData(): void {
  const peopleIds: string[] = [];
  for (const u of USERS.concat([{ id: "x1", name: "Linus Torvalds", email: "linus@example.com" }, { id: "x2", name: "Margaret Hamilton", email: "margaret@example.com" }])) {
    peopleIds.push(addRecord(T_PEOPLE, { fld_p_name: u.name, fld_p_email: u.email }).id);
  }
  for (let i = 0; i < 3000; i++) {
    const effort = Math.round(rnd() * 80) / 10;
    const v: Obj = {
      fld_name: `${pick(WORDS)} ${pick(OBJECTS)} ${i + 1}`,
      fld_status: pick(STATUS).id,
      fld_effort: effort,
      fld_budget: Math.round(rnd() * 500000) / 100,
      fld_progress: Math.round(rnd() * 100) / 100,
      fld_time: Math.floor(rnd() * 40 * 3600),
      fld_assignee: [pick(USERS).id],
      fld_owner: [pick(peopleIds)],
    };
    if (rnd() > 0.3) v.fld_notes = "**Heads up:** this is a _markdown_ note with [a link](https://example.com).\n\n- first\n- second";
    if (rnd() > 0.5) v.fld_tags = [pick(TAGS).id, pick(TAGS).id].filter((x, k, a) => a.indexOf(x) === k);
    if (rnd() > 0.2) v.fld_due = `2026-${String(1 + Math.floor(rnd() * 12)).padStart(2, "0")}-${String(1 + Math.floor(rnd() * 28)).padStart(2, "0")}`;
    if (rnd() > 0.5) v.fld_start = new Date(Date.UTC(2026, Math.floor(rnd() * 12), 1 + Math.floor(rnd() * 28), Math.floor(rnd() * 24), 0)).toISOString();
    if (rnd() > 0.4) v.fld_rating = 1 + Math.floor(rnd() * 5);
    if (rnd() > 0.6) v.fld_done = true;
    if (rnd() > 0.7) v.fld_email = `person${i}@example.com`;
    if (rnd() > 0.7) v.fld_url = `https://example.com/item/${i}`;
    if (rnd() > 0.8) v.fld_phone = "+1 (555) 010-" + String(1000 + i).slice(-4);
    if (rnd() > 0.9) v.fld_files = [{ id: newId("att"), filename: `spec-${i}.png`, mime: "image/png", size: 12345, width: 800, height: 600 }];
    if (rnd() > 0.85) v.fld_barcode = String(Math.floor(rnd() * 1e12));
    addRecord(T_TASKS, v);
  }
}
seedData();

// ---- schema -----------------------------------------------------------------------------------

function tableDto(id: string): Obj {
  return {
    id,
    base_id: BASE_ID,
    name: id === T_TASKS ? "Tasks" : "People",
    description: null,
    primary_field_id: id === T_TASKS ? "fld_name" : "fld_p_name",
    fields: id === T_TASKS ? taskFields : peopleFields,
    views: views.filter((v) => v.table_id === id),
  };
}

let roleOverride: string | null = null;

function baseDto(req: IncomingMessage): Obj {
  const cookie = /og-mock-role=(\w+)/.exec(req.headers.cookie ?? "")?.[1];
  return { id: BASE_ID, workspace_id: "wsp1", name: "Project tracker", color: "green_dark", icon: null, role: roleOverride ?? cookie ?? "owner", tables: [tableDto(T_TASKS), tableDto(T_PEOPLE)] };
}

function fieldsOf(table: string): Obj[] {
  return table === T_TASKS ? taskFields : peopleFields;
}

// ---- record shaping ---------------------------------------------------------------------------

function nameOf(recId: string): string {
  const r = records.get(recId);
  return r ? String(r.values[r.table_id === T_TASKS ? "fld_name" : "fld_p_name"] ?? "") : "";
}

function shape(rec: Rec): Obj {
  const values: Obj = {};
  for (const [k, v] of Object.entries(rec.values)) values[k] = v;
  if (rec.table_id === T_TASKS) {
    const ids: string[] = rec.values.fld_owner ?? [];
    values.fld_owner = ids.map((id) => ({ id, name: nameOf(id) }));
    values.fld_owner_count = ids.length;
    values.fld_owner_email = ids.map((id) => records.get(id)?.values.fld_p_email).filter(Boolean);
    const effort = rec.values.fld_effort;
    if (typeof effort === "number") values.fld_score = effort * 2;
    values.fld_label = String(rec.values.fld_name ?? "").includes("7") ? { error: "#ERROR! division by zero" } : `${rec.values.fld_name ?? ""}!`;
    values.fld_created = new Date(rec.created_at).toISOString();
    values.fld_modified = new Date(rec.updated_at).toISOString();
    values.fld_creator = rec.created_by;
    values.fld_modifier = rec.updated_by;
    values.fld_auto = rec.autonumber;
    if (rec.values.fld_url) values.fld_btn = rec.values.fld_url;
  } else {
    const tasks = [...records.values()].filter((r) => !r.deleted && r.table_id === T_TASKS && (r.values.fld_owner ?? []).includes(rec.id));
    values.fld_p_tasks = tasks.slice(0, 20).map((t) => ({ id: t.id, name: String(t.values.fld_name ?? "") }));
  }
  return { id: rec.id, table_id: rec.table_id, created_at: rec.created_at, updated_at: rec.updated_at, created_by: rec.created_by, updated_by: rec.updated_by, autonumber: rec.autonumber, values };
}

function textOf(f: Obj, v: any): string {
  if (v === null || v === undefined) return "";
  if (f.type === "single_select") return f.options.choices.find((c: Obj) => c.id === v)?.name ?? "";
  if (f.type === "multiple_select") return (v as string[]).map((id) => f.options.choices.find((c: Obj) => c.id === id)?.name ?? "").join(", ");
  if (f.type === "link") return (v as Obj[]).map((x) => x.name).join(", ");
  if (f.type === "user") return (v as string[]).map((id) => USERS.find((u) => u.id === id)?.name ?? id).join(", ");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function matchCond(f: Obj, op: string, operand: any, v: any, text: string): boolean {
  const empty = v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0) || v === false;
  switch (op) {
    case "is_empty":
      return empty;
    case "is_not_empty":
      return !empty;
    case "contains":
      return text.toLowerCase().includes(String(operand).toLowerCase());
    case "does_not_contain":
      return !text.toLowerCase().includes(String(operand).toLowerCase());
    case "starts_with":
      return text.toLowerCase().startsWith(String(operand).toLowerCase());
    case "ends_with":
      return text.toLowerCase().endsWith(String(operand).toLowerCase());
    case "is":
      if (f.type === "checkbox") return Boolean(v) === Boolean(operand);
      if (typeof v === "number") return v === Number(operand);
      return text === String(operand) || v === operand;
    case "is_not":
      return typeof v === "number" ? v !== Number(operand) : !(text === String(operand) || v === operand);
    case "lt":
      return typeof v === "number" && v < Number(operand);
    case "lte":
      return typeof v === "number" && v <= Number(operand);
    case "gt":
      return typeof v === "number" && v > Number(operand);
    case "gte":
      return typeof v === "number" && v >= Number(operand);
    case "is_any_of":
      return (operand as string[]).includes(v);
    case "is_none_of":
      return !(operand as string[]).includes(v);
    case "has_any_of":
      return (Array.isArray(v) ? v : []).some((x: any) => (operand as string[]).includes(x?.id ?? x));
    case "has_all_of":
      return (operand as string[]).every((o) => (Array.isArray(v) ? v : []).some((x: any) => (x?.id ?? x) === o));
    case "has_none_of":
      return !(Array.isArray(v) ? v : []).some((x: any) => (operand as string[]).includes(x?.id ?? x));
    case "is_before":
      return typeof v === "string" && v.slice(0, 10) < String(operand?.date ?? "9999");
    case "is_after":
      return typeof v === "string" && v.slice(0, 10) > String(operand?.date ?? "0000");
    default:
      return true;
  }
}

function matchFilter(filter: Obj | null, rec: Obj, fields: Obj[]): boolean {
  if (!filter || !filter.items?.length) return true;
  const results = filter.items.map((it: Obj) => {
    if ("items" in it) return matchFilter(it, rec, fields);
    const f = fields.find((x) => x.id === it.field_id);
    if (!f) return true;
    return matchCond(f, it.op, it.value, rec.values[f.id], textOf(f, rec.values[f.id]));
  });
  return filter.conjunction === "or" ? results.some(Boolean) : results.every(Boolean);
}

function cmp(f: Obj, a: any, b: any): number {
  const ea = a === null || a === undefined || a === "";
  const eb = b === null || b === undefined || b === "";
  if (ea || eb) return ea === eb ? 0 : ea ? -1 : 1;
  if (f.type === "single_select") return f.options.choices.findIndex((c: Obj) => c.id === a) - f.options.choices.findIndex((c: Obj) => c.id === b);
  if (typeof a === "number" && typeof b === "number") return a - b;
  return textOf(f, a).localeCompare(textOf(f, b), undefined, { numeric: true });
}

function runQuery(view: Obj, body: Obj): Obj {
  const fields = fieldsOf(view.table_id);
  const cfg = view.config;
  let rows = [...records.values()].filter((r) => !r.deleted && r.table_id === view.table_id).sort((a, b) => a.order - b.order).map(shape);
  rows = rows.filter((r) => matchFilter(cfg.filter, r, fields));
  const search = String(body.search ?? "").trim().toLowerCase();
  if (search) {
    const visible = fields.filter((f) => !cfg.hidden_fields.includes(f.id));
    rows = rows.filter((r) => visible.some((f) => textOf(f, r.values[f.id]).toLowerCase().includes(search)));
  }
  const keys = [...cfg.groups, ...cfg.sorts];
  if (keys.length) {
    rows.sort((a, b) => {
      for (const k of keys) {
        const f = fields.find((x) => x.id === k.field_id);
        if (!f) continue;
        const c = cmp(f, a.values[f.id], b.values[f.id]);
        if (c) return k.direction === "desc" ? -c : c;
      }
      return 0;
    });
  }
  const groups: Obj[] = [];
  if (cfg.groups.length) {
    const open: Obj[] = [];
    rows.forEach((r, i) => {
      cfg.groups.forEach((g: Obj, depth: number) => {
        const f = fields.find((x) => x.id === g.field_id)!;
        const raw = r.values[f.id];
        const key = Array.isArray(raw) ? raw.map((x: any) => x?.id ?? x).join(",") : String(raw ?? "");
        const cur = open[depth];
        const parentChanged = depth > 0 && open[depth - 1]?.start === i;
        if (!cur || cur.key !== key || parentChanged) {
          for (let d = depth; d < open.length; d++) open[d] = undefined as any;
          const h = { depth, field_id: f.id, key, label: textOf(f, raw) || "(Empty)", value: raw ?? null, start: i, count: 0 };
          open[depth] = h;
          groups.push(h);
        }
      });
      for (const h of open) if (h) h.count++;
    });
  }
  const colors: Obj = {};
  if (cfg.row_color?.mode === "by_select") {
    const f = fields.find((x) => x.id === cfg.row_color.field_id);
    for (const r of rows) {
      const c = f?.options.choices?.find((x: Obj) => x.id === r.values[f.id]);
      if (c) colors[r.id] = c.color;
    }
  }
  const offset = Number(body.offset ?? 0);
  const limit = Math.min(Number(body.limit ?? 100), 1000);
  return { total: rows.length, offset, records: rows.slice(offset, offset + limit), groups, colors };
}

function aggregate(view: Obj): Obj {
  const all = runQuery(view, { offset: 0, limit: 1000 });
  const rows = [...records.values()].filter((r) => !r.deleted && r.table_id === view.table_id).map(shape);
  void all;
  const values: Obj = {};
  for (const [fid, agg] of Object.entries<string>(view.config.summaries)) {
    const col = rows.map((r) => r.values[fid]);
    const nums = col.filter((x) => typeof x === "number") as number[];
    const filled = col.filter((x) => x !== undefined && x !== null && x !== "" && x !== false && !(Array.isArray(x) && !x.length));
    const n = rows.length;
    values[fid] =
      { filled: filled.length, empty: n - filled.length, percent_filled: n ? filled.length / n : 0, percent_empty: n ? (n - filled.length) / n : 0, sum: nums.reduce((a, b) => a + b, 0), average: nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null, min: nums.length ? Math.min(...nums) : null, max: nums.length ? Math.max(...nums) : null, unique: new Set(filled.map((x) => JSON.stringify(x))).size, checked: col.filter(Boolean).length }[agg] ?? null;
  }
  return { values };
}

// ---- http plumbing ----------------------------------------------------------------------------

const sseClients = new Set<ServerResponse>();

function emit(envelope: Obj): void {
  const data = JSON.stringify({ base_id: BASE_ID, client_id: null, user_id: ME, ...envelope });
  for (const res of sseClients) res.write(`event: ${envelope.event.kind}\ndata: ${data}\n\n`);
}

function send(res: ServerResponse, status: number, body?: Json, headers: Record<string, string> = {}): void {
  if (body === undefined) {
    res.writeHead(status, headers);
    res.end();
    return;
  }
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

const err = (res: ServerResponse, status: number, code: string, message: string) => send(res, status, { error: { code, message } });

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

const comments: Obj[] = [];
const history = new Map<string, Obj[]>();

function logHistory(rec: Rec, kind: string, changes: Obj): void {
  const list = history.get(rec.id) ?? [];
  list.unshift({ id: list.length + 1, user_id: ME, user_name: "Ada Lovelace", kind, changes, created_at: Date.now() });
  history.set(rec.id, list);
}

function applyValues(rec: Rec, patch: Obj, clientId: string | undefined, kind = "update"): void {
  const changes: Obj = {};
  const fields = fieldsOf(rec.table_id);
  for (const [fid, value] of Object.entries(patch)) {
    const f = fields.find((x) => x.id === fid);
    if (!f) continue;
    const old = rec.values[fid] ?? null;
    if (value === null || value === "" || value === false || (Array.isArray(value) && value.length === 0)) delete rec.values[fid];
    else rec.values[fid] = f.type === "link" ? (value as any[]).map((x) => x?.id ?? x) : value;
    changes[fid] = { old, new: rec.values[fid] ?? null };
  }
  rec.updated_at = Date.now();
  rec.updated_by = ME;
  logHistory(rec, kind, changes);
  void clientId;
}

function route(req: IncomingMessage, res: ServerResponse, url: URL, body: Obj): boolean {
  const m = req.method ?? "GET";
  const p = url.pathname;
  const clientId = String(req.headers["x-client-id"] ?? "");
  let g: RegExpExecArray | null;

  if (p === "/api/setup") return send(res, 200, { needs_setup: false, open_signup: false, email_enabled: false }), true;
  if (p === "/api/auth/me") return send(res, 200, { id: ME, email: "ada@example.com", name: "Ada Lovelace", is_admin: true, timezone: "America/Chicago", totp_enabled: false }), true;
  if (p === "/api/workspaces" && m === "GET") return send(res, 200, [{ id: "wsp1", name: "Acme", role: "owner", bases: [{ id: BASE_ID, workspace_id: "wsp1", name: "Project tracker", color: "green_dark", icon: null, role: "owner" }] }]), true;
  if ((g = /^\/api\/__mock\/role\/(\w+)$/.exec(p))) {
    roleOverride = g[1] === "reset" ? null : g[1]!;
    return send(res, 200, { role: roleOverride }), true;
  }
  if (p === "/api/__mock/external-edit" && m === "POST") {
    const rec = records.get(body.recordId);
    if (!rec) return err(res, 404, "not_found", "no record"), true;
    applyValues(rec, { [body.fieldId]: body.value }, "other-client");
    emit({ client_id: "other-client", event: { kind: "records_changed", table_id: rec.table_id, created: [], updated: [rec.id], deleted: [] } });
    return send(res, 200, { ok: true }), true;
  }
  if (p === `/api/bases/${BASE_ID}` && m === "GET") return send(res, 200, baseDto(req)), true;
  if (p === `/api/bases/${BASE_ID}/collaborators`) return send(res, 200, USERS), true;
  if (p === `/api/bases/${BASE_ID}/events`) {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.write(": hello\n\n");
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
    return true;
  }
  if (p === `/api/bases/${BASE_ID}/attachments` && m === "POST") {
    const text = String(body.__raw ?? "");
    const filename = /filename="([^"]+)"/.exec(text)?.[1] ?? "upload.bin";
    const mime = /Content-Type: ([^\r\n]+)/i.exec(text)?.[1] ?? "application/octet-stream";
    return send(res, 201, { id: newId("att"), filename, mime, size: text.length, width: null, height: null }), true;
  }
  if ((g = /^\/api\/attachments\/([^/]+)\/thumb$/.exec(p))) {
    res.writeHead(200, { "Content-Type": "image/svg+xml" });
    const hue = [...g[1]!].reduce((a, c) => a + c.charCodeAt(0), 0) % 360;
    res.end(`<svg xmlns="http://www.w3.org/2000/svg" width="64" height="48"><rect width="64" height="48" fill="hsl(${hue} 60% 70%)"/><circle cx="32" cy="24" r="12" fill="hsl(${hue} 60% 40%)"/></svg>`);
    return true;
  }
  if ((g = /^\/api\/views\/([^/]+)\/query$/.exec(p)) && m === "POST") {
    const v = views.find((x) => x.id === g![1]);
    if (!v) return err(res, 404, "not_found", "view not found"), true;
    return send(res, 200, runQuery(v, body)), true;
  }
  if ((g = /^\/api\/views\/([^/]+)\/aggregations$/.exec(p))) {
    const v = views.find((x) => x.id === g![1]);
    return v ? (send(res, 200, aggregate(v)), true) : (err(res, 404, "not_found", "view not found"), true);
  }
  if ((g = /^\/api\/views\/([^/]+)$/.exec(p)) && m === "PATCH") {
    const v = views.find((x) => x.id === g![1]);
    if (!v) return err(res, 404, "not_found", "view not found"), true;
    if (v.locked && baseDto(req).role !== "owner") return err(res, 403, "forbidden", "This view is locked"), true;
    if (body.name !== undefined) v.name = body.name;
    if (body.config) v.config = body.config;
    if (body.locked !== undefined) v.locked = body.locked;
    emit({ client_id: clientId, event: { kind: "schema_changed", table_id: v.table_id } });
    return send(res, 200, v), true;
  }
  if ((g = /^\/api\/tables\/([^/]+)\/records$/.exec(p))) {
    const table = g[1]!;
    if (m === "POST") {
      const out: Obj[] = [];
      const after = body.after_record_id ? records.get(body.after_record_id) : null;
      let o = after ? after.order + 0.001 : order++;
      for (const nr of body.records ?? []) {
        const rec = addRecord(table, {});
        rec.created_at = rec.updated_at = Date.now();
        rec.order = o;
        o += 0.0001;
        applyValues(rec, nr.values ?? {}, clientId, "create");
        out.push(shape(rec));
      }
      emit({ client_id: clientId, event: { kind: "records_changed", table_id: table, created: out.map((r) => r.id), updated: [], deleted: [] } });
      return send(res, 201, { records: out }), true;
    }
    if (m === "PATCH") {
      const out: Obj[] = [];
      for (const patch of body.records ?? []) {
        const rec = records.get(patch.id);
        if (!rec || rec.deleted) return err(res, 404, "not_found", "record not found"), true;
        for (const [fid, val] of Object.entries<any>(patch.values)) {
          const f = fieldsOf(table).find((x) => x.id === fid);
          if (f && ["formula", "created_time", "autonumber"].includes(f.type)) return err(res, 400, "computed_field", `${f.name} is computed`), true;
          if (f?.type === "single_select" && typeof val === "string" && !f.options.choices.some((c: Obj) => c.id === val)) {
            const choice = { id: newId("chs"), name: val, color: "gray" };
            f.options.choices.push(choice);
            patch.values[fid] = choice.id;
          }
        }
        applyValues(rec, patch.values, clientId);
        out.push(shape(rec));
      }
      emit({ client_id: clientId, event: { kind: "records_changed", table_id: table, created: [], updated: out.map((r) => r.id), deleted: [] } });
      return send(res, 200, { records: out }), true;
    }
    if (m === "DELETE") {
      for (const id of body.ids ?? []) {
        const r = records.get(id);
        if (r) r.deleted = true;
      }
      emit({ client_id: clientId, event: { kind: "records_changed", table_id: table, created: [], updated: [], deleted: body.ids } });
      return send(res, 200, { ok: true }), true;
    }
  }
  if ((g = /^\/api\/tables\/([^/]+)\/records\/restore$/.exec(p))) {
    const out: Obj[] = [];
    for (const id of body.ids ?? []) {
      const r = records.get(id);
      if (r) {
        r.deleted = false;
        out.push(shape(r));
      }
    }
    emit({ client_id: clientId, event: { kind: "records_changed", table_id: g[1], created: body.ids, updated: [], deleted: [] } });
    return send(res, 200, { records: out }), true;
  }
  if ((g = /^\/api\/tables\/([^/]+)\/records\/move$/.exec(p))) {
    const anchor = records.get(body.before_id ?? body.after_id);
    if (anchor) {
      const delta = body.before_id ? -0.0005 : 0.0005;
      (body.ids as string[]).forEach((id, i) => {
        const r = records.get(id);
        if (r) r.order = anchor.order + delta + i * 0.00001;
      });
    }
    emit({ client_id: clientId, event: { kind: "records_changed", table_id: g[1], created: [], updated: body.ids, deleted: [] } });
    return send(res, 200, { ok: true }), true;
  }
  if ((g = /^\/api\/tables\/([^/]+)\/records\/lookup$/.exec(p))) {
    const q = (url.searchParams.get("q") ?? "").toLowerCase();
    const list = [...records.values()].filter((r) => !r.deleted && r.table_id === g![1] && nameOf(r.id).toLowerCase().includes(q)).slice(0, Number(url.searchParams.get("limit") ?? 30));
    return send(res, 200, { records: list.map((r) => ({ id: r.id, name: nameOf(r.id) })) }), true;
  }
  if ((g = /^\/api\/tables\/([^/]+)\/records\/([^/]+)$/.exec(p)) && m === "GET") {
    const r = records.get(g[2]!);
    return r && !r.deleted ? (send(res, 200, shape(r)), true) : (err(res, 404, "not_found", "record not found"), true);
  }
  if ((g = /^\/api\/tables\/([^/]+)\/fields$/.exec(p)) && m === "POST") {
    const f = { id: newId("fld"), table_id: g[1], name: body.name, description: body.description ?? null, type: body.type, options: body.options ?? {} };
    if (f.type === "single_select" || f.type === "multiple_select") f.options.choices = (f.options.choices ?? []).map((c: Obj) => ({ id: c.id || newId("cho"), ...c }));
    fieldsOf(g[1]!).push(f);
    emit({ client_id: clientId, event: { kind: "schema_changed", table_id: g[1] } });
    return send(res, 201, f), true;
  }
  if ((g = /^\/api\/fields\/([^/]+)$/.exec(p))) {
    const all = [...taskFields, ...peopleFields];
    const f = all.find((x) => x.id === g![1]);
    if (!f) return err(res, 404, "not_found", "field not found"), true;
    if (m === "PATCH") {
      if (body.name !== undefined) f.name = body.name;
      if (body.description !== undefined) f.description = body.description;
      if (body.type) {
        f.type = body.type;
        f.options = body.options ?? {};
        if (f.type === "single_select" || f.type === "multiple_select") f.options.choices = (f.options.choices ?? []).map((c: Obj) => ({ ...c, id: c.id || newId("cho") }));
      }
      emit({ client_id: clientId, event: { kind: "schema_changed", table_id: f.table_id } });
      return send(res, 200, f), true;
    }
    if (m === "DELETE") {
      const list = fieldsOf(f.table_id);
      list.splice(list.indexOf(f), 1);
      emit({ client_id: clientId, event: { kind: "schema_changed", table_id: f.table_id } });
      return send(res, 200, { ok: true, deleted_field_ids: [f.id] }), true;
    }
  }
  if ((g = /^\/api\/tables\/([^/]+)\/formula\/check$/.exec(p))) {
    const expr = String(body.expression ?? "");
    return send(res, 200, expr.includes("(") && !expr.includes(")") ? { ok: false, error: "Unbalanced parentheses" } : { ok: true, result_type: "text", preview: "42" }), true;
  }
  if ((g = /^\/api\/records\/([^/]+)\/history$/.exec(p))) return send(res, 200, history.get(g[1]!) ?? []), true;
  if ((g = /^\/api\/records\/([^/]+)\/comments$/.exec(p))) {
    if (m === "GET") return send(res, 200, comments.filter((c) => c.record_id === g![1])), true;
    const c = { id: newId("cmt"), record_id: g[1], user_id: ME, user_name: "Ada Lovelace", body: body.body, created_at: Date.now(), updated_at: Date.now() };
    comments.push(c);
    emit({ client_id: clientId, event: { kind: "comments_changed", record_id: g[1] } });
    return send(res, 201, c), true;
  }
  if ((g = /^\/api\/comments\/([^/]+)$/.exec(p))) {
    const i = comments.findIndex((c) => c.id === g![1]);
    if (i < 0) return err(res, 404, "not_found", "comment not found"), true;
    if (m === "PATCH") {
      comments[i]!.body = body.body;
      comments[i]!.updated_at = Date.now();
      return send(res, 200, comments[i]), true;
    }
    if (m === "DELETE") {
      const [c] = comments.splice(i, 1);
      emit({ client_id: clientId, event: { kind: "comments_changed", record_id: c!.record_id } });
      return send(res, 200, { ok: true }), true;
    }
  }
  return false;
}

export function mockApi(): Plugin {
  return {
    name: "opengrid-mock-api",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        if (!url.pathname.startsWith("/api/")) return next();
        void (async () => {
          let body: Obj = {};
          if (req.method !== "GET" && req.method !== "HEAD") {
            const buf = await readBody(req);
            const type = String(req.headers["content-type"] ?? "");
            if (type.includes("json") && buf.length) {
              try {
                body = JSON.parse(buf.toString("utf8"));
              } catch {
                return err(res, 400, "bad_json", "invalid JSON");
              }
            } else if (buf.length) body = { __raw: buf.toString("latin1").slice(0, 2000) };
          }
          await new Promise((r) => setTimeout(r, 25 + Math.floor(Math.random() * 40)));
          if (!route(req, res, url, body)) err(res, 404, "not_found", `mock: no route for ${req.method} ${url.pathname}`);
        })().catch((e: unknown) => err(res, 500, "mock_error", String(e)));
      });
    },
  };
}
