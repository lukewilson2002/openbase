/**
 * Dev-only mock of the OpenBase HTTP API for building and checking the grid without a server.
 * Enabled with `VITE_MOCK=1 npm run dev` (see vite.config.ts); never part of a production build.
 *
 * It implements just enough of docs/plans §3.1 (auth, base schema, view queries with
 * filter/sort/group/search, record CRUD + restore + move, lookup, aggregations, comments, history,
 * attachments, fields, view config, SSE) to exercise every grid code path with realistic shapes.
 * Role is switchable with `?role=` on the base URL via the `ob-mock-role` cookie
 * (`/api/__mock/role/viewer`), and `/api/__mock/external-edit` simulates another client's write.
 *
 * The "Projects" table (tbl3, ~40 records) feeds the kanban, gallery, calendar, timeline and list
 * views; the trash and notification endpoints serve small fixtures.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";

type Json = unknown;
type Obj = Record<string, any>;

const BASE_ID = "app1";
const T_TASKS = "tbl1";
const T_PEOPLE = "tbl2";
const T_PROJECTS = "tbl3";
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

const PROJECT_STATUS = [
  { id: "pst1", name: "Backlog", color: "gray" },
  { id: "pst2", name: "Planned", color: "cyan" },
  { id: "pst3", name: "In progress", color: "blue" },
  { id: "pst4", name: "Review", color: "orange" },
  { id: "pst5", name: "Shipped", color: "green" },
];
const TEAMS = [
  { id: "pte1", name: "Platform", color: "purple" },
  { id: "pte2", name: "Growth", color: "teal" },
  { id: "pte3", name: "Design", color: "pink" },
];
const dateTimeOpts = { include_time: true, date_format: "friendly", time_format: "h12", timezone: "America/New_York" };

const projectFields: Obj[] = [
  field("fld_j_name", "Project", "single_line_text", {}, T_PROJECTS),
  field("fld_j_status", "Status", "single_select", { choices: PROJECT_STATUS }, T_PROJECTS),
  field("fld_j_team", "Team", "single_select", { choices: TEAMS }, T_PROJECTS),
  field("fld_j_owner", "Owner", "user", { multiple: false, notify: false }, T_PROJECTS),
  field("fld_j_start", "Start", "date", dateOpts, T_PROJECTS),
  field("fld_j_end", "End", "date", dateOpts, T_PROJECTS),
  field("fld_j_review", "Review meeting", "date", dateTimeOpts, T_PROJECTS),
  field("fld_j_budget", "Budget", "currency", { precision: 0, symbol: "$", allow_negative: false }, T_PROJECTS),
  field("fld_j_progress", "Progress", "percent", { precision: 0, allow_negative: false }, T_PROJECTS),
  field("fld_j_cover", "Cover", "attachment", {}, T_PROJECTS),
  field("fld_j_deps", "Depends on", "link", { linked_table_id: T_PROJECTS, inverse_field_id: "fld_j_blocks", single: false }, T_PROJECTS),
  field("fld_j_blocks", "Blocks", "link", { linked_table_id: T_PROJECTS, inverse_field_id: "fld_j_deps", single: false }, T_PROJECTS),
  field("fld_j_done", "Shipped", "checkbox", { icon: "check", color: "green" }, T_PROJECTS),
  field("fld_j_summary", "Summary", "long_text", { rich: false }, T_PROJECTS),
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
    description_field_id: null,
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
  { id: "viw10", table_id: T_PROJECTS, name: "All projects", type: "grid", config: emptyConfig(), personal: false, locked: false },
  {
    id: "viw11",
    table_id: T_PROJECTS,
    name: "Board",
    type: "kanban",
    config: { ...emptyConfig(), description_field_id: "fld_j_summary", hidden_fields: ["fld_j_deps", "fld_j_blocks", "fld_j_review", "fld_j_done"], kanban: { stack_field_id: "fld_j_status", cover_field_id: "fld_j_cover", hide_empty_stacks: false, stack_order: [] }, row_color: { mode: "by_select", field_id: "fld_j_team" } },
    personal: false,
    locked: false,
  },
  { id: "viw12", table_id: T_PROJECTS, name: "Board by team", type: "kanban", config: { ...emptyConfig(), kanban: { stack_field_id: "fld_j_team", cover_field_id: null, hide_empty_stacks: false, stack_order: [] }, sorts: [{ field_id: "fld_j_name", direction: "asc" }] }, personal: false, locked: false },
  { id: "viw13", table_id: T_PROJECTS, name: "Gallery", type: "gallery", config: { ...emptyConfig(), description_field_id: "fld_j_summary", hidden_fields: ["fld_j_deps", "fld_j_blocks"], gallery: { cover_field_id: "fld_j_cover", cover_crop: true } }, personal: false, locked: false },
  { id: "viw14", table_id: T_PROJECTS, name: "Calendar", type: "calendar", config: { ...emptyConfig(), description_field_id: "fld_j_summary", calendar: { date_field_id: "fld_j_start", end_field_id: "fld_j_end" }, row_color: { mode: "by_select", field_id: "fld_j_status" } }, personal: false, locked: false },
  { id: "viw15", table_id: T_PROJECTS, name: "Review calendar", type: "calendar", config: { ...emptyConfig(), calendar: { date_field_id: "fld_j_review", end_field_id: null } }, personal: false, locked: false },
  { id: "viw16", table_id: T_PROJECTS, name: "Timeline", type: "timeline", config: { ...emptyConfig(), description_field_id: "fld_j_summary", timeline: { start_field_id: "fld_j_start", end_field_id: "fld_j_end", group_field_id: "fld_j_team", dependency_field_id: "fld_j_deps", scale: "week" }, row_color: { mode: "by_select", field_id: "fld_j_status" } }, personal: false, locked: false },
  { id: "viw17", table_id: T_PROJECTS, name: "Outline", type: "list", config: { ...emptyConfig(), description_field_id: "fld_j_summary", groups: [{ field_id: "fld_j_status", direction: "asc" }, { field_id: "fld_j_team", direction: "asc" }], hidden_fields: ["fld_j_deps", "fld_j_blocks", "fld_j_review", "fld_j_cover"] }, personal: false, locked: false },
  { id: "viw18", table_id: T_PROJECTS, name: "Unconfigured board", type: "kanban", config: emptyConfig(), personal: false, locked: false },
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

const PROJECT_WORDS = ["Onboarding revamp", "Billing v2", "Search relevance", "Mobile beta", "Webhook retries", "Audit log", "SSO pilot", "Data export", "Dark mode", "Invoice templates", "Rate limiting", "Admin console", "Import wizard", "Usage dashboard", "Email digests", "Accessibility pass", "Perf budget", "Backup restore drill", "Docs site", "Partner API", "Notifications inbox", "Role editor", "Offline cache", "Release train", "Customer portal", "Referral program", "Pricing page", "Status page", "Load testing", "Security review", "Brand refresh", "Help center", "Roadmap board", "Churn survey", "Cohort reports", "Launch checklist", "Sandbox accounts", "Changelog", "Keyboard shortcuts", "Calendar sync"];

function seedProjects(): void {
  const DAY = 86_400_000;
  const todayMs = Math.floor(Date.now() / DAY) * DAY;
  const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const ids: string[] = [];
  const endAt: (number | null)[] = [];
  PROJECT_WORDS.forEach((name, i) => {
    let start = todayMs + (Math.floor(rnd() * 100) - 40) * DAY;
    const len = 2 + Math.floor(rnd() * 22);
    // About half depend on an earlier project; most start after it ends, a few overlap (shown red).
    const dep = i > 2 && rnd() > 0.5 ? Math.floor(rnd() * i) : -1;
    if (dep >= 0 && endAt[dep] != null && rnd() > 0.3) start = endAt[dep]! + (1 + Math.floor(rnd() * 4)) * DAY;
    const v: Obj = {
      fld_j_name: name,
      fld_j_status: PROJECT_STATUS[Math.min(4, Math.max(0, Math.floor((todayMs - start) / DAY / 12) + 1 + (rnd() > 0.7 ? 1 : 0)))]!.id,
      fld_j_team: pick(TEAMS).id,
      fld_j_budget: Math.round(rnd() * 90) * 1000 + 5000,
      fld_j_progress: Math.round(rnd() * 100) / 100,
    };
    if (rnd() > 0.25) v.fld_j_owner = [pick(USERS).id];
    // Most have a few lines of notes: the views read them as each project's description.
    if (i % 5 !== 2)
      v.fld_j_summary = `${name} for the ${TEAMS.find((t) => t.id === v.fld_j_team)!.name} team.\nScope: ship the first cut, then measure what people actually use before widening it.\n- Owner signs off on the plan\n- Weekly check-in until it ships`;
    // A handful have no dates (unscheduled), a few are milestones (start only).
    let end: number | null = null;
    if (i % 9 !== 4) {
      v.fld_j_start = ymd(start);
      if (i % 7 !== 3) {
        end = start + len * DAY;
        v.fld_j_end = ymd(end);
      }
    }
    endAt.push(end);
    if (i % 3 === 0) v.fld_j_review = new Date(start + (len > 8 ? 8 : 1) * DAY + 15 * 3_600_000).toISOString();
    if (i % 3 === 1) v.fld_j_cover = [{ id: newId("att"), filename: `cover-${i}.png`, mime: "image/png", size: 54321, width: 800, height: 600 }];
    if (v.fld_j_status === PROJECT_STATUS[4]!.id) v.fld_j_done = true;
    // Dependencies point at earlier projects; some start before their predecessor ends (violated).
    const deps: string[] = [];
    if (dep >= 0) deps.push(ids[dep]!);
    if (i > 5 && rnd() > 0.9) deps.push(ids[Math.floor(rnd() * i)]!);
    if (deps.length) v.fld_j_deps = [...new Set(deps)];
    ids.push(addRecord(T_PROJECTS, v).id);
  });
}
seedProjects();

// ---- notifications and trash fixtures -----------------------------------------------------------

/** Inbox drafts (`/api/inbox`), two to start with so the list is not empty. */
const inbox: Obj[] = [
  { id: "inb_demo1", title: "Ideas for the offsite", body: "- somewhere with a lake\n- no slides", attachments: [], created_at: Date.now() - 3 * 3_600_000, updated_at: Date.now() - 3 * 3_600_000 },
  { id: "inb_demo2", title: "", body: "Call the accountant about Q3", attachments: [{ id: "att_demo", filename: "receipts.pdf", mime: "application/pdf", size: 48_213 }], created_at: Date.now() - 2 * 86_400_000, updated_at: Date.now() - 2 * 86_400_000 },
];

const notifications: Obj[] = [];
function seedNotifications(): void {
  const firstTask = [...records.values()].find((r) => r.table_id === T_TASKS)!;
  const project = [...records.values()].find((r) => r.table_id === T_PROJECTS)!;
  const now = Date.now();
  notifications.push(
    { id: "ntf1", kind: "mention", payload: { base_id: BASE_ID, table_id: T_PROJECTS, record_id: project.id, base_name: "Project tracker", table_name: "Projects", record_name: String(project.values.fld_j_name), comment_id: "cmt_demo", snippet: "@Ada can you confirm the launch date?", author_id: "usr2", author_name: "Grace Hopper" }, read_at: null, created_at: now - 12 * 60_000 },
    { id: "ntf2", kind: "assigned", payload: { base_id: BASE_ID, table_id: T_TASKS, record_id: firstTask.id, base_name: "Project tracker", table_name: "Tasks", record_name: String(firstTask.values.fld_name), field_id: "fld_owner", field_name: "Owner", assigned_by: "usr3" }, read_at: null, created_at: now - 3 * 3_600_000 },
    { id: "ntf3", kind: "automation", payload: { automation_name: "Weekly digest", message: "Sent the digest to 4 people", base_id: BASE_ID }, read_at: null, created_at: now - 26 * 3_600_000 },
    { id: "ntf4", kind: "invite", payload: { actor_name: "Margaret Hamilton", base_name: "Roadmap", token: "demo-token" }, read_at: now - 86_400_000, created_at: now - 2 * 86_400_000 },
  );
}
seedNotifications();

/** Trashed schema items the records map does not model (records come from the soft-deleted flag). */
const trashedExtras: Obj[] = [
  { kind: "table", id: "tbl_old", name: "Old budget", table_id: null, deleted_at: Date.now() - 5 * 86_400_000 },
  { kind: "field", id: "fld_old", name: "Legacy notes", table_id: T_TASKS, deleted_at: Date.now() - 3_600_000 },
  { kind: "view", id: "viw_old", name: "Archive board", table_id: T_PROJECTS, deleted_at: Date.now() - 20 * 86_400_000 },
];

// ---- schema -----------------------------------------------------------------------------------

const PRIMARY: Record<string, string> = { [T_TASKS]: "fld_name", [T_PEOPLE]: "fld_p_name", [T_PROJECTS]: "fld_j_name" };

function tableDto(id: string): Obj {
  return {
    id,
    base_id: BASE_ID,
    name: id === T_TASKS ? "Tasks" : id === T_PROJECTS ? "Projects" : "People",
    description: null,
    primary_field_id: PRIMARY[id]!,
    fields: fieldsOf(id),
    views: views.filter((v) => v.table_id === id),
  };
}

let introSeen = true;
let roleOverride: string | null = null;

function baseDto(req: IncomingMessage): Obj {
  const cookie = /ob-mock-role=(\w+)/.exec(req.headers.cookie ?? "")?.[1];
  const b = ws.bases.find((x) => x.id === BASE_ID) ?? { id: BASE_ID, workspace_id: "wsp1", name: "Project tracker", color: "green_dark", icon: null };
  return { ...b, role: roleOverride ?? cookie ?? "owner", tables: [tableDto(T_TASKS), tableDto(T_PEOPLE), tableDto(T_PROJECTS)], people: basePeople(b), workspace_name: ws.workspaces.find((w) => w.id === b.workspace_id)?.name ?? "Acme" };
}

function fieldsOf(table: string): Obj[] {
  return table === T_TASKS ? taskFields : table === T_PROJECTS ? projectFields : peopleFields;
}

// ---- record shaping ---------------------------------------------------------------------------

function nameOf(recId: string): string {
  const r = records.get(recId);
  return r ? String(r.values[PRIMARY[r.table_id]!] ?? "") : "";
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
  } else if (rec.table_id === T_PROJECTS) {
    const deps: string[] = rec.values.fld_j_deps ?? [];
    if (deps.length) values.fld_j_deps = deps.filter((id) => records.get(id) && !records.get(id)!.deleted).map((id) => ({ id, name: nameOf(id) }));
    const blocks = [...records.values()].filter((r) => !r.deleted && r.table_id === T_PROJECTS && (r.values.fld_j_deps ?? []).includes(rec.id));
    if (blocks.length) values.fld_j_blocks = blocks.map((r) => ({ id: r.id, name: nameOf(r.id) }));
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
  // A transient override replaces the saved filter / sorts / groups for this request only.
  const transient = (body.transient ?? {}) as Obj;
  const filter = transient.filter ?? cfg.filter;
  const sorts: Obj[] = transient.sorts ?? cfg.sorts;
  const groupBy: Obj[] = transient.groups ?? cfg.groups;
  rows = rows.filter((r) => matchFilter(filter, r, fields));
  if (body.range) {
    // Records whose [start, end] (end defaults to start) overlaps [from, to]; records without a start are left out.
    const { field_id, end_field_id, from, to } = body.range as Obj;
    rows = rows.filter((r) => {
      const a = typeof r.values[field_id] === "string" ? (r.values[field_id] as string).slice(0, 10) : null;
      if (!a) return false;
      const b = end_field_id && typeof r.values[end_field_id] === "string" ? (r.values[end_field_id] as string).slice(0, 10) : a;
      return a <= to && (b < a ? a : b) >= from;
    });
  }
  const search = String(body.search ?? "").trim().toLowerCase();
  if (search) {
    const visible = fields.filter((f) => !cfg.hidden_fields.includes(f.id));
    rows = rows.filter((r) => visible.some((f) => textOf(f, r.values[f.id]).toLowerCase().includes(search)));
  }
  const keys = [...groupBy, ...sorts];
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
  if (groupBy.length) {
    const open: Obj[] = [];
    rows.forEach((r, i) => {
      groupBy.forEach((g: Obj, depth: number) => {
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


// ---- workspaces, members and invites ----------------------------------------------------------
// `/api/__mock/workspaces/none` empties the list (the "Create your first workspace" page);
// `/api/__mock/workspaces/reset` brings the fixtures back.

function workspaceFixtures() {
  const now = Date.now();
  return {
    workspaces: [
      { id: "wsp1", name: "Acme", icon: "briefcase", role: "owner" },
      { id: "wsp2", name: "Household", icon: "house", role: "owner" },
    ] as Obj[],
    bases: [
      { id: BASE_ID, workspace_id: "wsp1", name: "Project tracker", color: "green_dark", icon: null },
      { id: "app2", workspace_id: "wsp1", name: "Customer relationships", color: "blue", icon: "users" },
      { id: "app3", workspace_id: "wsp1", name: "Content calendar", color: "purple_dark", icon: null },
      { id: "app4", workspace_id: "wsp1", name: "Hiring", color: "orange", icon: null },
      { id: "app5", workspace_id: "wsp2", name: "Chores", color: "teal", icon: null },
    ] as Obj[],
    members: {
      wsp1: [
        { user_id: "usr1", name: "Ada Lovelace", email: "ada@example.com", role: "owner", all_bases: true, base_ids: [] },
        { user_id: "usr2", name: "Grace Hopper", email: "grace@example.com", role: "editor", all_bases: false, base_ids: [BASE_ID, "app2"] },
        { user_id: "usr3", name: "Alan Turing", email: "alan@example.com", role: "viewer", all_bases: true, base_ids: [] },
        { user_id: "usr4", name: "Katherine Johnson", email: "katherine@example.com", role: "creator", all_bases: false, base_ids: [BASE_ID] },
      ],
      wsp2: [{ user_id: "usr1", name: "Ada Lovelace", email: "ada@example.com", role: "owner", all_bases: true, base_ids: [] }],
    } as Record<string, Obj[]>,
    invites: [
      { id: "inv1", workspace_id: "wsp1", base_id: null, email: "jordan@example.com", role: "editor", created_at: now - 86_400_000, expires_at: now + 6 * 86_400_000, accepted_at: null, all_bases: false, base_ids: [BASE_ID, "app3"] },
    ] as Obj[],
    deleted: [{ kind: "workspace", id: "wspOld", name: "Old clients", icon: "archive", table_id: null, deleted_at: now - 3 * 86_400_000 }] as Obj[],
  };
}
let ws = workspaceFixtures();
const shares: Obj[] = [];

function canOpen(m: Obj, baseId: string): boolean {
  return m.role === "owner" || m.all_bases || m.base_ids.includes(baseId);
}

function basePeople(b: Obj): Obj[] {
  const members = (ws.members[b.workspace_id] ?? []).filter((m) => canOpen(m, b.id)).map((m) => ({ user_id: m.user_id, name: m.name, email: m.email, pending: false, role: m.role }));
  const invited = ws.invites
    .filter((i) => i.workspace_id === b.workspace_id && !i.accepted_at && (i.role === "owner" || i.all_bases || i.base_ids.includes(b.id)))
    .map((i) => ({ user_id: null, name: i.email ?? "", email: i.email ?? "", pending: true, role: i.role }));
  return [...members, ...invited];
}

function baseSummary(b: Obj, role: string): Obj {
  // Every mock base serves the same three tables (see baseDto).
  const tables = [T_TASKS, T_PEOPLE, T_PROJECTS].map((id) => ({ id, name: tableDto(id).name, icon: null }));
  return { ...b, role, people: basePeople(b), tables };
}

function workspaceList(): Obj[] {
  return ws.workspaces.map((w) => {
    const me = (ws.members[w.id] ?? []).find((m) => m.user_id === ME);
    return {
      ...w,
      role: me?.role ?? w.role,
      bases: ws.bases.filter((b) => b.workspace_id === w.id && (!me || canOpen(me, b.id))).map((b) => baseSummary(b, me?.role ?? w.role)),
      member_count: (ws.members[w.id] ?? []).length,
      pending_invite_count: ws.invites.filter((i) => i.workspace_id === w.id && !i.accepted_at).length,
    };
  });
}

function createInvite(workspaceId: string, body: Obj, fromBase: string | null): Obj {
  const all = body.role === "owner" || (body.all_bases ?? !fromBase);
  const info = {
    id: newId("inv"),
    workspace_id: workspaceId,
    base_id: null,
    email: body.email || null,
    role: body.role,
    created_at: Date.now(),
    expires_at: Date.now() + 7 * 86_400_000,
    accepted_at: null,
    all_bases: all,
    base_ids: all ? [] : (body.base_ids ?? (fromBase ? [fromBase] : [])),
  };
  ws.invites.push(info);
  return { url: `https://openbase.example.com/invite/${newId("tok")}${newId("x")}`, info };
}

function workspaceRoutes(m: string, p: string, body: Obj, res: ServerResponse, url: URL): boolean {
  let g: RegExpExecArray | null;
  if ((g = /^\/api\/__mock\/workspaces\/(none|reset)$/.exec(p))) {
    ws = workspaceFixtures();
    if (g[1] === "none") {
      ws.workspaces = [];
      ws.bases = ws.bases.filter((b) => b.id === BASE_ID);
    }
    return send(res, 200, { ok: true }), true;
  }
  if (p === "/api/workspaces" && m === "GET") return send(res, 200, workspaceList()), true;
  if (p === "/api/workspaces" && m === "POST") {
    const w = { id: newId("wsp"), name: body.name, icon: body.icon ?? null, ...(body.color ? { color: body.color } : {}), role: "owner" };
    ws.workspaces.push(w);
    ws.members[w.id] = [{ user_id: ME, name: "Ada Lovelace", email: "ada@example.com", role: "owner", all_bases: true, base_ids: [] }];
    return send(res, 201, workspaceList().find((x) => x.id === w.id)), true;
  }
  if ((g = /^\/api\/workspaces\/([^/]+)$/.exec(p))) {
    const w = ws.workspaces.find((x) => x.id === g![1]);
    if (!w) return err(res, 404, "not_found", "workspace not found"), true;
    if (m === "PATCH") {
      if (body.name !== undefined) w.name = body.name;
      if (body.icon !== undefined) w.icon = body.icon;
      if (body.color) w.color = body.color;
      return send(res, 200, workspaceList().find((x) => x.id === w.id)), true;
    }
    if (m === "DELETE") {
      ws.workspaces.splice(ws.workspaces.indexOf(w), 1);
      ws.deleted.push({ kind: "workspace", id: w.id, name: w.name, icon: w.icon, table_id: null, deleted_at: Date.now() });
      return send(res, 200, { ok: true }), true;
    }
  }
  if ((g = /^\/api\/workspaces\/([^/]+)\/members$/.exec(p)) && m === "GET") return send(res, 200, ws.members[g[1]!] ?? []), true;
  if ((g = /^\/api\/workspaces\/([^/]+)\/members\/([^/]+)$/.exec(p))) {
    const list = ws.members[g[1]!] ?? [];
    const member = list.find((x) => x.user_id === g![2]);
    if (!member) return err(res, 404, "not_found", "member not found"), true;
    if (m === "PATCH") {
      if (body.role) member.role = body.role;
      if (body.base_ids) {
        member.base_ids = body.base_ids;
        member.all_bases = body.all_bases === true;
      } else if (typeof body.all_bases === "boolean") member.all_bases = body.all_bases;
      if (member.role === "owner") member.all_bases = true;
      return send(res, 200, { ok: true }), true;
    }
    if (m === "DELETE") {
      list.splice(list.indexOf(member), 1);
      return send(res, 200, { ok: true }), true;
    }
  }
  if ((g = /^\/api\/workspaces\/([^/]+)\/invites$/.exec(p))) {
    if (m === "GET") return send(res, 200, ws.invites.filter((i) => i.workspace_id === g![1])), true;
    if (m === "POST") return send(res, 201, createInvite(g[1]!, body, null)), true;
  }
  if ((g = /^\/api\/bases\/([^/]+)\/invites$/.exec(p)) && m === "POST") {
    const b = ws.bases.find((x) => x.id === g![1]);
    if (!b) return err(res, 404, "not_found", "base not found"), true;
    if (body.all_bases) return err(res, 403, "forbidden", "Only owners can invite to every base"), true;
    return send(res, 201, createInvite(b.workspace_id, body, b.id)), true;
  }
  if ((g = /^\/api\/invites\/([^/]+)$/.exec(p)) && m === "DELETE") {
    ws.invites = ws.invites.filter((i) => i.id !== g![1]);
    return send(res, 204), true;
  }
  if ((g = /^\/api\/invites\/([^/]+)$/.exec(p)) && m === "PATCH") {
    const inv = ws.invites.find((i) => i.id === g![1]);
    if (!inv) return err(res, 404, "not_found", "invite not found"), true;
    if (body.role) inv.role = body.role;
    if (body.all_bases === true || inv.role === "owner") Object.assign(inv, { all_bases: true, base_ids: [] });
    else if (body.base_ids) Object.assign(inv, { all_bases: false, base_ids: body.base_ids });
    return send(res, 200, inv), true;
  }
  if ((g = /^\/api\/workspaces\/([^/]+)\/bases$/.exec(p)) && m === "POST") {
    const b = { id: newId("app"), workspace_id: g[1], name: body.name, color: body.color ?? "blue_dark", icon: body.icon ?? null };
    ws.bases.push(b);
    return send(res, 201, { ...baseSummary(b, "owner"), tables: [], workspace_name: ws.workspaces.find((w) => w.id === g![1])?.name ?? "" }), true;
  }
  if ((g = /^\/api\/bases\/([^/]+)$/.exec(p)) && (g[1] !== BASE_ID || m === "PATCH") && (m === "PATCH" || m === "DELETE")) {
    const b = ws.bases.find((x) => x.id === g![1]);
    if (!b) return err(res, 404, "not_found", "base not found"), true;
    if (m === "DELETE") ws.bases.splice(ws.bases.indexOf(b), 1);
    else Object.assign(b, Object.fromEntries(Object.entries(body).filter(([k]) => ["name", "color", "icon"].includes(k))));
    return send(res, 200, { ok: true }), true;
  }
  if (p === "/api/trash/workspaces" && m === "GET") return send(res, 200, { items: ws.deleted }), true;
  if (p === "/api/trash" && m === "GET") {
    const q = url.searchParams;
    const project = ws.bases.find((b) => b.id === BASE_ID)!;
    const home = ws.workspaces.find((w) => w.id === project.workspace_id)!;
    const tableName = (id: string | null) => (id ? (tableDto(id).name as string) : null);
    const inBase = [...records.values()]
      .filter((r) => r.deleted)
      .map((r) => ({ kind: "record", id: r.id, name: String(r.values[PRIMARY[r.table_id]!] ?? ""), table_id: r.table_id, deleted_at: r.updated_at }))
      .concat(trashedExtras as never[])
      .map((i: Obj) => ({ ...i, workspace_id: home.id, workspace_name: home.name, workspace_color: "green", base_id: BASE_ID, base_name: project.name, base_color: project.color, table_name: i.kind === "table" ? null : tableName(i.table_id), deleted_by_id: ME, deleted_by_name: "Ada Lovelace" }));
    const workspaces = ws.deleted.map((d) => ({ ...d, workspace_id: d.id, workspace_name: d.name, workspace_color: "teal" }));
    const items = [...inBase, ...workspaces]
      .map((i: Obj) => ({ ...i, expires_at: i.deleted_at + 30 * 86_400_000 }))
      .filter((i: Obj) => (!q.get("workspace_id") || i.workspace_id === q.get("workspace_id")) && (!q.get("base_id") || i.base_id === q.get("base_id")) && (!q.get("kind") || i.kind === q.get("kind")))
      .sort((a: Obj, b: Obj) => b.deleted_at - a.deleted_at);
    return send(res, 200, { items }), true;
  }
  if (p === "/api/trash/restore" && m === "POST" && body.kind === "workspace") {
    const item = ws.deleted.find((d) => d.id === body.id);
    if (!item) return err(res, 404, "not_found", "nothing to restore"), true;
    ws.deleted = ws.deleted.filter((d) => d !== item);
    ws.workspaces.push({ id: item.id, name: item.name, icon: item.icon, role: "owner" });
    ws.members[item.id] = [{ user_id: ME, name: "Ada Lovelace", email: "ada@example.com", role: "owner", all_bases: true, base_ids: [] }];
    return send(res, 200, { ok: true, restored_field_ids: [] }), true;
  }
  if ((g = /^\/api\/views\/([^/]+)\/shares$/.exec(p))) {
    if (m === "GET") return send(res, 200, shares.filter((x) => x.view_id === g![1])), true;
    if (m === "POST") {
      const token = newId("shr") + newId("t");
      const kind = body.kind ?? "view";
      const link = { id: newId("shl"), view_id: g[1], kind, token, path: `/${kind === "form" ? "f" : "s"}/${token}`, url: `https://openbase.example.com/${kind === "form" ? "f" : "s"}/${token}`, enabled: true, has_password: !!body.password, created_by: ME, created_at: Date.now() };
      shares.push(link);
      return send(res, 201, link), true;
    }
  }
  if ((g = /^\/api\/shares\/([^/]+)$/.exec(p)) && m === "PATCH") {
    const link = shares.find((x) => x.id === g![1]);
    if (!link) return err(res, 404, "not_found", "share not found"), true;
    if (body.enabled !== undefined) link.enabled = body.enabled;
    if (body.password !== undefined) link.has_password = body.password !== null;
    return send(res, 200, link), true;
  }
  return false;
}

function route(req: IncomingMessage, res: ServerResponse, url: URL, body: Obj): boolean {
  const m = req.method ?? "GET";
  const p = url.pathname;
  const clientId = String(req.headers["x-client-id"] ?? "");
  let g: RegExpExecArray | null;

  if (p === "/api/setup") return send(res, 200, { needs_setup: false, open_signup: false, email_enabled: false, public_url: "https://openbase.example.com" }), true;
  if (p === "/api/auth/me") {
    if (m === "PATCH" && typeof body.intro_seen === "boolean") introSeen = body.intro_seen;
    return send(res, 200, { id: ME, email: "ada@example.com", name: "Ada Lovelace", is_admin: true, timezone: "America/Chicago", totp_enabled: false, intro_seen: introSeen }), true;
  }
  // GET /api/__mock/intro/unseen brings the first-run intro back on the next page load.
  if ((g = /^\/api\/__mock\/intro\/(seen|unseen)$/.exec(p))) {
    introSeen = g[1] === "seen";
    return send(res, 200, { intro_seen: introSeen }), true;
  }
  if (workspaceRoutes(m, p, body, res, url)) return true;
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
  // Only the main base has tables in the mock; every other one opens as an empty base (the page a
  // new base starts on), with the role cookie applied like the main one.
  if ((g = /^\/api\/bases\/([^/]+)$/.exec(p)) && m === "GET") {
    const b = ws.bases.find((x) => x.id === g![1]);
    if (!b) return err(res, 404, "not_found", "base not found"), true;
    const role = roleOverride ?? /ob-mock-role=(\w+)/.exec(req.headers.cookie ?? "")?.[1] ?? "owner";
    return send(res, 200, { ...baseSummary(b, role), tables: [], workspace_name: ws.workspaces.find((w) => w.id === b.workspace_id)?.name ?? "" }), true;
  }
  if (p === `/api/bases/${BASE_ID}/collaborators`) return send(res, 200, USERS), true;
  if (p === `/api/bases/${BASE_ID}/events`) {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.write(": hello\n\n");
    // Like the real server: the first frame says who is viewing (you included). Grace is in the
    // project already; Alan drops in and out every few seconds so the top bar's faces move.
    const presence = (viewers: string[]) =>
      res.write(`event: presence_changed\ndata: ${JSON.stringify({ base_id: BASE_ID, client_id: null, user_id: null, event: { kind: "presence_changed", viewers } })}\n\n`);
    presence([ME, "usr2"]);
    let alanIn = false;
    const timer = setInterval(() => {
      alanIn = !alanIn;
      presence(alanIn ? [ME, "usr2", "usr3"] : [ME, "usr2"]);
    }, 6000);
    sseClients.add(res);
    req.on("close", () => {
      clearInterval(timer);
      sseClients.delete(res);
    });
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
      const before = body.before_record_id ? records.get(body.before_record_id) : null;
      if (body.after_record_id && body.before_record_id) return err(res, 400, "bad_request", "give after_record_id or before_record_id, not both"), true;
      if ((body.after_record_id && !after) || (body.before_record_id && !before)) return err(res, 400, "bad_request", "anchor is not a record of this table"), true;
      let o = after ? after.order + 0.001 : before ? before.order - 0.001 : order++;
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
        if (r) {
          r.deleted = true;
          r.updated_at = Date.now(); // doubles as the deletion time shown in the trash
        }
      }
      emit({ client_id: clientId, event: { kind: "records_changed", table_id: table, created: [], updated: [], deleted: body.ids } });
      return send(res, 204), true;
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
    return send(res, 200, { records: (body.ids as string[]).map((id) => records.get(id)).filter((r): r is Rec => !!r).map(shape) }), true;
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
    const all = [...taskFields, ...peopleFields, ...projectFields];
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
  // The inbox: private drafts (text and uploaded files), filed into a table as a record.
  if (p === "/api/inbox" && m === "GET") return send(res, 200, [...inbox].sort((a, b) => b.updated_at - a.updated_at)), true;
  if (p === "/api/inbox" && m === "POST") {
    const now = Date.now();
    const title = String(body.title ?? "").replace(/[\r\n]+/g, " ").trim();
    const draft: Obj = { id: newId("inb"), title, body: String(body.body ?? ""), attachments: body.attachments ?? [], created_at: now, updated_at: now };
    inbox.push(draft);
    return send(res, 201, draft), true;
  }
  if (p === "/api/inbox/attachments" && m === "POST") {
    const text = String(body.__raw ?? "");
    const filename = /filename="([^"]+)"/.exec(text)?.[1] ?? "upload.bin";
    const mime = /Content-Type: ([^\r\n]+)/i.exec(text)?.[1] ?? "application/octet-stream";
    return send(res, 201, { id: newId("att"), filename, mime, size: text.length, width: null, height: null }), true;
  }
  if ((g = /^\/api\/inbox\/([^/]+)$/.exec(p))) {
    const draft = inbox.find((d) => d.id === g![1]);
    if (!draft) return err(res, 404, "not_found", "draft not found"), true;
    if (m === "PATCH") {
      if (typeof body.title === "string") draft.title = body.title.replace(/[\r\n]+/g, " ").trim();
      if (typeof body.body === "string") draft.body = body.body;
      if (Array.isArray(body.attachments)) draft.attachments = body.attachments;
      draft.updated_at = Date.now();
      return send(res, 200, draft), true;
    }
    if (m === "DELETE") {
      inbox.splice(inbox.indexOf(draft), 1);
      return send(res, 204), true;
    }
  }
  if ((g = /^\/api\/inbox\/([^/]+)\/file$/.exec(p)) && m === "POST") {
    const draft = inbox.find((d) => d.id === g![1]);
    if (!draft) return err(res, 404, "not_found", "draft not found"), true;
    if (!PRIMARY[body.table_id]) return err(res, 404, "not_found", "table not found"), true;
    const rec = addRecord(body.table_id, body.fields ?? {});
    if (body.note_as_comment && String(draft.body).trim()) {
      comments.push({ id: newId("cmt"), record_id: rec.id, user_id: ME, user_name: "Ada Lovelace", body: draft.body, created_at: Date.now(), updated_at: Date.now() });
    }
    inbox.splice(inbox.indexOf(draft), 1);
    return send(res, 201, shape(rec)), true;
  }
  if (p === "/api/notifications" && m === "GET") {
    const list = [...notifications].sort((a, b) => b.created_at - a.created_at);
    return send(res, 200, { notifications: list, unread: list.filter((n) => n.read_at == null).length }), true;
  }
  if (p === "/api/notifications/read" && m === "POST") {
    const ids: string[] = body.ids ?? [];
    for (const n of notifications) if (n.read_at == null && (ids.length === 0 || ids.includes(n.id))) n.read_at = Date.now();
    return send(res, 200, { ok: true }), true;
  }
  if (p === `/api/bases/${BASE_ID}/trash` && m === "GET") {
    if (!["creator", "owner"].includes(baseDto(req).role)) return err(res, 403, "forbidden", "Only creators can see the trash"), true;
    const deleted = [...records.values()].filter((r) => r.deleted).map((r) => ({ kind: "record", id: r.id, name: String(r.values[PRIMARY[r.table_id]!] ?? ""), table_id: r.table_id, deleted_at: r.updated_at }));
    return send(res, 200, { items: [...deleted, ...trashedExtras].sort((a, b) => b.deleted_at - a.deleted_at) }), true;
  }
  if (p === "/api/trash/restore" && m === "POST") {
    const rec = records.get(body.id);
    if (body.kind === "record" && rec?.deleted) {
      rec.deleted = false;
      emit({ client_id: clientId, event: { kind: "records_changed", table_id: rec.table_id, created: [rec.id], updated: [], deleted: [] } });
      return send(res, 200, { ok: true, restored_field_ids: [] }), true;
    }
    const i = trashedExtras.findIndex((x) => x.kind === body.kind && x.id === body.id);
    if (i < 0) return err(res, 404, "not_found", "nothing to restore"), true;
    trashedExtras.splice(i, 1);
    emit({ client_id: clientId, event: { kind: "schema_changed", table_id: T_TASKS } });
    return send(res, 200, { ok: true, restored_field_ids: [] }), true;
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
    name: "openbase-mock-api",
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
