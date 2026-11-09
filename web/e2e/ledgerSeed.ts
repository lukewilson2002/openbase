import type { APIRequestContext, Browser, TestInfo } from "@playwright/test";
import { createHash, randomBytes } from "node:crypto";
import { crc32, deflateSync } from "node:zlib";
import { expect, newClientContext, skipIntro } from "./fixtures";

/**
 * The workspace behind the ledger screenshots (ledger.spec.ts): the data a person who has used OpenBase for a few
 * months would have, so that a screenshot shows a real sidebar, real results and real dates instead of an empty
 * account. Everything goes through the REST API (the harness does not depend on how the screens create things).
 *
 *  - Northwind Studio: five collections at its top level, two folders (Marketing, Operations) with collections of
 *    their own and an empty folder (Archive 2025). Records carry dates around today, a checkbox and a choice.
 *  - Two more workspaces, so the switcher lists three.
 *  - A second person, limited to the Operations folder (NAV-10).
 *  - A record page in the Side projects workspace, which the other shots do not show: Accounts and Bills, with an
 *    account whose page has a heading, a list and both embeds (REC-5, REC-6), a Files property holding a picture, a PDF
 *    and a Word file (REC-3), two linked bills and a thread of comments.
 *  - What Phase 6's screens show: an inbox draft, an automation with runs and a second one that is off, a public form and
 *    a shared board, notifications, history, trash items of each kind, a pending invite, API tokens, a connected app, and
 *    the people who see the sign-in pages' other states (no workspace yet, an intro not yet seen, the instance's administrator).
 */

const PASSWORD = "correct horse battery staple 42";
const CSRF = { "X-OpenBase-CSRF": "1" };

/** What `BrowserContext.storageState()` returns; the sign-in of a seeded person. */
export type SignIn = Awaited<ReturnType<import("@playwright/test").BrowserContext["storageState"]>>;

export interface LedgerSeed {
  owner: SignIn;
  limited: SignIn;
  /** The instance's administrator (the journey's), who sees /admin. */
  admin: SignIn;
  /** Signed up with nothing made yet: the first-run screen. */
  fresh: SignIn;
  /** Has a workspace and has not seen the intro. */
  newcomer: SignIn;
  workspaceId: string;
  /** The other workspaces the owner belongs to. */
  otherWorkspaceIds: string[];
  rootId: string;
  /** Folder (project) ids by name, and the collection ids by name. */
  folders: { marketing: string; operations: string; archive: string };
  tables: Record<string, string>;
  /** The folder (project) id each collection lives in, by name. */
  bases: Record<string, string>;
  /** Each collection's first view, the default grid: a collection opens in the last view used, and a view added by the seed would take that over. */
  defaultViews: Record<string, string>;
  /** The saved views the seed adds, by "Collection / View name" (for example "Clients / Pipeline"). */
  views: Record<string, string>;
  /** A word that matches records, collections, a folder, a view and a workspace, for the command palette. */
  palette: string;
  /** A record with a page (REC-5, REC-6): a heading, a list, its linked bills and a view of the unpaid ones. */
  pageRecord: { baseId: string; tableId: string; viewId: string; recordId: string; title: string };
  /** The properties of the record page's collection (Accounts) that the property screens open, by name. */
  pageFields: { status: string; perYear: string; bills: string; files: string };
  /** A bill linked to the page record, which the linked-record peek shows. */
  peekedBill: string;
  /**
   * An account with exactly one linked bill. A property with several links can be reordered, so a finger that rests on one
   * of its cards drags it; with one link the same hold opens the peek, which is what a phone's shot needs.
   */
  soloLink: { recordId: string; billId: string; billTitle: string };
  /** The token of an open invite to the workspace (the invite page), and the address of the form and shared-view links. */
  inviteToken: string;
  links: { form: string; view: string };
  /** The two automations of the top level: one on with runs, one off. */
  automations: { research: string; welcome: string };
  /** The name of the app that is connected to the owner's account. */
  connectedApp: string;
}

const REDIRECT = "http://127.0.0.1:53682/callback";

/**
 * An app asking for access: registers a client and opens its authorization request as the signed-in person of `request`,
 * which leads to the consent page. Returns the page's address and what is needed to finish the flow.
 */
export async function startConsent(request: APIRequestContext, baseURL: string, appName: string): Promise<{ path: string; requestId: string; clientId: string; verifier: string }> {
  const registered = await request.post("/oauth/register", { data: { client_name: appName, redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" } });
  expect(registered.status(), await registered.text()).toBe(201);
  const clientId = ((await registered.json()) as { client_id: string }).client_id;
  const verifier = randomBytes(48).toString("base64url");
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    state: randomBytes(8).toString("hex"),
    resource: `${baseURL}/mcp`,
    scope: "openbase:read openbase:write",
  });
  const res = await request.get(`/oauth/authorize?${query}`, { maxRedirects: 0, failOnStatusCode: false });
  const location = res.headers()["location"] ?? "";
  expect(location, `authorize answered ${res.status()} ${await res.text()}`).toContain("/oauth/consent?request=");
  const path = new URL(location, baseURL).pathname + new URL(location, baseURL).search;
  return { path, requestId: new URL(location, baseURL).searchParams.get("request")!, clientId, verifier };
}

async function call<T>(request: APIRequestContext, method: "post" | "patch" | "delete", path: string, data?: unknown): Promise<T> {
  const res = await request[method](path, { data, headers: CSRF });
  expect(res.ok(), `${method.toUpperCase()} ${path}: ${res.status()} ${await res.text()}`).toBeTruthy();
  return (res.status() === 204 ? undefined : await res.json()) as T;
}

/** Midday UTC `days` from today as `YYYY-MM-DD`: a date that reads the same in every time zone the machine may be in. */
function day(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The properties of a collection by name, for a view's settings. */
type FieldIds = Record<string, string>;

type FieldSpec = { name: string; type: "single_select"; choices: string[] } | { name: string; type: "date" | "checkbox" | "number" | "text" | "email" | "attachment" };

interface CollectionSpec {
  name: string;
  color: string;
  /** Properties after the title (the primary property, Name). */
  fields: FieldSpec[];
  /** One entry per record: the title, then a value per property in `fields` order. */
  rows: (string | number | boolean | null)[][];
  /** The property Home dates the collection by, and the checkbox that marks a record done. */
  homeDate?: string;
  done?: string;
  /** What the collection's records are called ("client"): the header's button and the empty states use it. */
  recordNoun?: string;
  /** Saved views besides the default grid. `config` gets the ids of the properties (and of the title as "Name"). */
  views?: { name: string; type: "kanban" | "grid" | "list" | "calendar" | "gallery" | "timeline" | "form"; config?: (ids: FieldIds) => unknown }[];
}

const DATE_OPTIONS = { include_time: false, date_format: "friendly", time_format: "h12", timezone: null };

async function collection(request: APIRequestContext, baseId: string, spec: CollectionSpec): Promise<{ id: string; viewId: string; views: Record<string, string> }> {
  const table = await call<{ id: string; primary_field_id: string; views: { id: string }[] }>(request, "post", `/api/bases/${baseId}/tables`, { name: spec.name, color: spec.color });
  const ids: string[] = [];
  for (const f of spec.fields) {
    const options =
      f.type === "single_select"
        ? { choices: f.choices.map((name, i) => ({ id: "", name, color: (["blue", "green", "orange", "purple", "gray"] as const)[i % 5] })) }
        : f.type === "date"
          ? DATE_OPTIONS
          : {};
    ids.push((await call<{ id: string }>(request, "post", `/api/tables/${table.id}/fields`, { name: f.name, type: f.type, options })).id);
  }
  const records = spec.rows.map(([title, ...rest]) => ({
    values: { [table.primary_field_id]: title, ...Object.fromEntries(rest.flatMap((v, i) => (v === null ? [] : [[ids[i]!, v]]))) },
  }));
  if (records.length) await call(request, "post", `/api/tables/${table.id}/records`, { records, typecast: true });
  const settings: Record<string, string> = {};
  if (spec.recordNoun) settings["record_noun"] = spec.recordNoun;
  if (spec.homeDate) settings["home_date_field_id"] = ids[spec.fields.findIndex((f) => f.name === spec.homeDate)]!;
  if (spec.done) settings["done_field_id"] = ids[spec.fields.findIndex((f) => f.name === spec.done)]!;
  if (Object.keys(settings).length) await call(request, "patch", `/api/tables/${table.id}`, settings);
  const propertyIds: FieldIds = { Name: table.primary_field_id, ...Object.fromEntries(spec.fields.map((f, i) => [f.name, ids[i]!])) };
  const views: Record<string, string> = {};
  for (const v of spec.views ?? []) {
    views[v.name] = (await call<{ id: string }>(request, "post", `/api/tables/${table.id}/views`, { name: v.name, type: v.type, config: v.config?.(propertyIds) ?? null })).id;
  }
  return { id: table.id, viewId: table.views[0]!.id, views };
}

/** A PNG of `width` x `height` pixels, each pixel from `paint`: no image library is needed for a picture to upload. */
function png(width: number, height: number, paint: (x: number, y: number) => [number, number, number]): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    for (let x = 0; x < width; x++) raw.set(paint(x, y), row + 1 + x * 3);
  }
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, "ascii");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8); // 8 bits, RGB
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** A shopfront in flat colours: an awning of stripes over a door and a window, so the tile's crop still reads as a picture. */
function shopfront(): Buffer {
  return png(720, 480, (x, y) => {
    if (y < 150) return [236, 242, 250];
    if (y < 230) return Math.floor(x / 60) % 2 === 0 ? [31, 90, 224] : [245, 247, 252];
    if (x > 90 && x < 330 && y > 270 && y < 420) return [170, 205, 235];
    if (x > 450 && x < 600 && y > 260) return [38, 70, 83];
    return y > 440 ? [120, 130, 145] : [250, 244, 232];
  });
}

/** A one-page PDF with a title and two lines, enough for the server to draw its first page as a preview. */
function agreement(): Buffer {
  const text = "BT /F1 26 Tf 60 720 Td (Service agreement) Tj /F1 13 Tf 0 -44 Td (Fernwood Dental and Northwind Studio) Tj 0 -22 Td (Website care plan, billed monthly.) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets = objects.map((o, i) => {
    const at = out.length;
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
    return at;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

interface UploadedFile {
  id: string;
  filename: string;
  mime: string;
  size: number;
  width?: number;
  height?: number;
}

async function upload(request: APIRequestContext, baseId: string, name: string, mimeType: string, buffer: Buffer): Promise<UploadedFile> {
  const res = await request.post(`/api/bases/${baseId}/attachments`, { multipart: { file: { name, mimeType, buffer } }, headers: CSRF });
  expect(res.ok(), `upload ${name}: ${res.status()} ${await res.text()}`).toBeTruthy();
  return (await res.json()) as UploadedFile;
}

/** A new account; it has seen the intro unless `intro` says the screen is to meet it. */
async function signUp(request: APIRequestContext, name: string, intro = false): Promise<void> {
  const email = `e2e-ledger-${randomBytes(4).toString("hex")}@example.com`;
  const res = await request.post("/api/auth/signup", { data: { email, name, password: PASSWORD }, headers: CSRF });
  expect(res.ok(), await res.text()).toBeTruthy();
  if (!intro) await skipIntro(request);
}

export async function seedLedger(browser: Browser, testInfo: TestInfo): Promise<LedgerSeed> {
  const baseURL = testInfo.project.use.baseURL;
  const ownerContext = await newClientContext(browser, testInfo, { baseURL }, "ledger-owner");
  const r = ownerContext.request;
  await signUp(r, "Mara Okafor");

  const ws = await call<{ id: string }>(r, "post", "/api/workspaces", { name: "Northwind Studio", color: "blue" });
  const others = [
    await call<{ id: string }>(r, "post", "/api/workspaces", { name: "Mark and Jo's household", color: "teal" }),
    await call<{ id: string }>(r, "post", "/api/workspaces", { name: "Side projects", color: "purple" }),
  ];
  const workspaces = await (await r.get("/api/workspaces")).json();
  const rootId = (workspaces as { id: string; root_base_id: string }[]).find((w) => w.id === ws.id)!.root_base_id;

  const t: Record<string, string> = {};
  const defaultViews: Record<string, string> = {};
  const savedViews: Record<string, string> = {};
  const bases: Record<string, string> = {};
  const make = async (baseId: string, spec: CollectionSpec) => {
    const made = await collection(r, baseId, spec);
    t[spec.name] = made.id;
    bases[spec.name] = baseId;
    defaultViews[spec.name] = made.viewId;
    for (const [name, id] of Object.entries(made.views)) savedViews[`${spec.name} / ${name}`] = id;
  };
  // The top level.
  await make(rootId, {
    name: "Clients",
    color: "blue",
    fields: [
      { name: "Status", type: "single_select", choices: ["Lead", "Active", "Paused"] },
      { name: "Next contact", type: "date" },
      { name: "Retainer", type: "number" },
    ],
    homeDate: "Next contact",
    recordNoun: "client",
    views: [
      { name: "Pipeline", type: "kanban", config: (f) => ({ kanban: { stack_field_id: f["Status"] } }) },
      { name: "Follow-ups", type: "calendar", config: (f) => ({ calendar: { date_field_id: f["Next contact"] } }) },
      { name: "By status", type: "list", config: (f) => ({ groups: [{ field_id: f["Status"], direction: "asc" }] }) },
      {
        name: "Intake",
        type: "form",
        config: (f) => ({
          form: {
            title: "Tell us about your studio",
            description: "A few questions so we can plan the first call.",
            fields: [
              { field_id: f["Name"], required: true, label: "Business name" },
              { field_id: f["Status"], required: false },
              { field_id: f["Next contact"], required: false, label: "When should we call?", help: "Any day that suits you." },
              { field_id: f["Retainer"], required: false },
            ],
            submit_label: "Send",
            success_message: "Thanks, we will be in touch.",
          },
        }),
      },
    ],
    rows: [
      ["Fernwood Dental", "Active", day(2), 2400],
      ["Marketing retainer, Halvorsen & Co", "Active", day(5), 3800],
      ["Oakline Cycles", "Lead", day(-1), null],
      ["Pemberton Legal", "Active", day(0), 1900],
      ["Studio Vesper", "Paused", null, 0],
      ["Tidewater Brewing", "Active", day(9), 2200],
      ["Larkspur Florists", "Lead", day(3), null],
      ["Northgate Physio", "Active", day(14), 1600],
      ["Quill & Co. Books", "Lead", day(-3), null],
      ["Redwood Nursery", "Paused", null, 900],
      ["Summit Climbing Gym", "Active", day(7), 2750],
      ["Alder Street Cafe", "Active", day(1), 1200],
      ["Bluebird Daycare", "Lead", day(21), null],
      ["Cobalt Analytics", "Active", day(4), 4100],
    ],
  });
  await make(rootId, {
    name: "Projects",
    color: "orange",
    fields: [
      { name: "Stage", type: "single_select", choices: ["Planning", "In progress", "Review", "Shipped"] },
      { name: "Due", type: "date" },
      { name: "Start", type: "date" },
    ],
    homeDate: "Due",
    views: [
      { name: "Cards", type: "gallery", config: () => ({ gallery: { cover_crop: true } }) },
      { name: "Schedule", type: "timeline", config: (f) => ({ timeline: { start_field_id: f["Start"], end_field_id: f["Due"], scale: "month" } }) },
    ],
    rows: [
      ["Fernwood website rebuild", "In progress", day(12), day(-20)],
      ["Product launch, Cobalt Analytics", "Planning", day(30), day(6)],
      ["Halvorsen brand refresh", "Review", day(4), day(-14)],
      ["Oakline shop migration", "In progress", day(18), day(-3)],
      ["Tidewater label redesign", "Shipped", day(-6), day(-30)],
      ["Summit membership flow", "Planning", day(45), day(14)],
      ["Pemberton intake forms", "In progress", day(8), day(-8)],
      ["Larkspur seasonal campaign", "Review", day(2), day(-10)],
      ["Quill & Co. catalogue", "Planning", day(60), day(20)],
    ],
  });
  await make(rootId, {
    name: "Tasks",
    color: "green",
    fields: [
      { name: "Due", type: "date" },
      { name: "Done", type: "checkbox" },
      { name: "Priority", type: "single_select", choices: ["Low", "Medium", "High"] },
    ],
    homeDate: "Due",
    done: "Done",
    rows: [
      ["Send Fernwood the revised quote", day(-2), false, "High"],
      ["Launch day checklist", day(0), false, "High"],
      ["Book photographer for Tidewater", day(0), false, "Medium"],
      ["Review Halvorsen homepage copy", day(1), false, "Medium"],
      ["Invoice Cobalt for October", day(1), false, "High"],
      ["Renew the studio domain", day(3), false, "Low"],
      ["Reply to Oakline about the shop", day(-1), false, "Medium"],
      ["Prepare Monday standup notes", day(2), false, "Low"],
      ["Order business cards", day(5), false, "Low"],
      ["Draft the November newsletter", day(6), false, "Medium"],
      ["Update the portfolio page", day(-4), true, "Low"],
      ["Back up the shared drive", day(-5), true, "Medium"],
      ["Call Pemberton about intake forms", day(4), false, "High"],
      ["Sort receipts for the accountant", day(10), false, "Low"],
      ["Collect testimonials", day(12), false, "Medium"],
      ["Plan the Q1 offsite", day(20), false, "Medium"],
      ["Fix the contact form redirect", day(-1), false, "High"],
      ["Archive finished 2025 projects", day(7), false, "Low"],
    ],
  });
  await make(rootId, {
    name: "Market research",
    color: "purple",
    fields: [{ name: "Source", type: "text" }, { name: "Read on", type: "date" }],
    rows: [
      ["Market sizing for independent studios", "Industry report", day(-12)],
      ["What small clinics pay for websites", "Survey", day(-9)],
      ["Pricing pages that convert", "Blog", day(-7)],
      ["Local SEO checklist 2026", "Newsletter", day(-3)],
      ["Retainer vs project pricing", "Podcast", day(-1)],
      ["Customer interviews, round two", "Notes", day(2)],
      ["Competitor teardown: three agencies", "Notes", day(6)],
    ],
  });
  await make(rootId, {
    name: "Quarterly planning and retrospectives",
    color: "pink",
    fields: [{ name: "Quarter", type: "text" }],
    rows: [
      ["Q4 planning", "Q4"],
      ["Q3 retrospective", "Q3"],
      ["Q2 retrospective", "Q2"],
      ["Q1 planning", "Q1"],
      ["Year in review", "All year"],
    ],
  });

  // Two folders and an empty one.
  const marketing = await call<{ id: string }>(r, "post", `/api/workspaces/${ws.id}/bases`, { name: "Marketing", color: "red", empty: true });
  await make(marketing.id, {
    name: "Campaigns",
    color: "red",
    fields: [
      { name: "Channel", type: "single_select", choices: ["Email", "Social", "Print", "Events"] },
      { name: "Launch", type: "date" },
    ],
    homeDate: "Launch",
    views: [{ name: "Marketing pipeline", type: "kanban" }],
    rows: [
      ["Spring launch campaign", "Email", day(16)],
      ["Tidewater taproom opening", "Events", day(11)],
      ["Fernwood new-patient offer", "Social", day(3)],
      ["Halvorsen quarterly mailer", "Print", day(25)],
      ["Summit open day", "Events", day(33)],
      ["Cobalt webinar series", "Email", day(19)],
      ["Larkspur Valentine promotion", "Social", day(70)],
      ["Redwood spring planting guide", "Email", day(40)],
    ],
  });
  await make(marketing.id, {
    name: "Launch calendar",
    color: "yellow",
    fields: [
      { name: "Publish", type: "date" },
      { name: "Status", type: "single_select", choices: ["Idea", "Drafting", "Scheduled", "Live"] },
    ],
    rows: [
      ["Behind the scenes at the studio", day(1), "Scheduled"],
      ["Five checks before a website launch", day(4), "Drafting"],
      ["Case study: Tidewater Brewing", day(8), "Drafting"],
      ["Newsletter, November", day(6), "Scheduled"],
      ["What a retainer includes", day(13), "Idea"],
      ["Holiday hours announcement", day(21), "Idea"],
      ["Meet the team: Mara", day(-2), "Live"],
      ["Our design process, step by step", day(-8), "Live"],
      ["Client spotlight: Pemberton Legal", day(10), "Drafting"],
      ["Year-end sale teaser", day(28), "Idea"],
      ["Podcast guest announcement", day(15), "Scheduled"],
      ["Winter workshop signup", day(23), "Idea"],
    ],
  });
  await make(marketing.id, {
    name: "Press contacts",
    color: "cyan",
    fields: [{ name: "Outlet", type: "text" }],
    rows: [
      ["Dana Whitfield", "Regional Business Weekly"],
      ["Ibrahim Sayed", "The Design Ledger"],
      ["Joanna Petrov", "Small Studio Radio"],
      ["Tom Achebe", "City Journal"],
      ["Greta Lindqvist", "Marketing Notes"],
    ],
  });
  const operations = await call<{ id: string }>(r, "post", `/api/workspaces/${ws.id}/bases`, { name: "Operations", color: "gray", empty: true });
  await make(operations.id, {
    name: "Vendors",
    color: "gray",
    fields: [{ name: "Category", type: "single_select", choices: ["Software", "Print", "Travel", "Legal"] }],
    rows: [
      ["Fieldnote Hosting", "Software"],
      ["Press & Paper", "Print"],
      ["Harbor Legal", "Legal"],
      ["Pixel Pantry Fonts", "Software"],
      ["Northline Rail", "Travel"],
      ["Cinder Accounting", "Legal"],
    ],
  });
  await make(operations.id, {
    name: "Invoices",
    color: "teal",
    fields: [
      { name: "Due", type: "date" },
      { name: "Paid", type: "checkbox" },
    ],
    homeDate: "Due",
    done: "Paid",
    rows: [
      ["INV-1041 Fernwood Dental", day(-9), true],
      ["INV-1042 Halvorsen & Co", day(-2), false],
      ["INV-1043 Cobalt Analytics", day(3), false],
      ["INV-1044 Tidewater Brewing", day(9), false],
      ["INV-1045 Pemberton Legal", day(-14), true],
      ["INV-1046 Summit Climbing Gym", day(12), false],
      ["INV-1047 Oakline Cycles", day(18), false],
      ["INV-1048 Alder Street Cafe", day(24), false],
      ["INV-1049 Northgate Physio", day(-20), true],
      ["INV-1050 Larkspur Florists", day(30), false],
    ],
  });
  const archive = await call<{ id: string }>(r, "post", `/api/workspaces/${ws.id}/bases`, { name: "Archive 2025", color: "orange", empty: true });

  // The other workspaces get a collection each, so their switcher rows are not empty places.
  for (const [other, name, color] of [
    [others[0]!, "Groceries", "green"],
    [others[1]!, "Reading list", "purple"],
  ] as const) {
    const top = (await (await r.get("/api/workspaces")).json()) as { id: string; root_base_id: string }[];
    await make(top.find((w) => w.id === other.id)!.root_base_id, { name, color, fields: [], rows: [["Oat milk"], ["Coffee beans"], ["Lemons"]] });
  }
  // A collection with no records at all, for COL-9's first empty state. It lives in a workspace the sidebar and palette
  // shots do not show, so the rows moved in earlier phases keep their pictures.
  const sideTop = ((await (await r.get("/api/workspaces")).json()) as { id: string; root_base_id: string }[]).find((w) => w.id === others[1]!.id)!.root_base_id;
  await make(sideTop, { name: "Ideas", color: "yellow", fields: [{ name: "Notes", type: "text" }], recordNoun: "idea", rows: [] });

  // A record with a page, in the same workspace (the other shots do not show it): an account with its bills linked
  // and a saved view of the unpaid ones embedded below a heading and a list.
  await make(sideTop, {
    name: "Bills",
    color: "teal",
    recordNoun: "bill",
    fields: [
      { name: "Amount", type: "number" },
      { name: "Due", type: "date" },
      { name: "Paid", type: "checkbox" },
    ],
    views: [{ name: "Unpaid bills", type: "grid", config: (f) => ({ filter: { conjunction: "and", items: [{ field_id: f["Paid"], op: "is", value: false }] } }) }],
    rows: [
      ["Hosting, October", 240, day(-6), true],
      ["Domain renewal", 18, day(9), false],
      ["Design software", 79, day(4), false],
      ["Accounting fees", 450, day(15), false],
      ["Photography", 320, day(-12), true],
    ],
  });
  await make(sideTop, {
    name: "Accounts",
    color: "blue",
    recordNoun: "account",
    fields: [
      { name: "Status", type: "single_select", choices: ["Active", "Paused", "Prospect"] },
      { name: "Renewal", type: "date" },
      { name: "Contact", type: "email" },
      { name: "Monthly", type: "number" },
      { name: "Files", type: "attachment" },
    ],
    rows: [
      ["Fernwood Dental", "Active", day(41), "dana@fernwood.example", 250, null],
      ["Oakline Cycles", "Active", day(75), "hello@oakline.example", 180, null],
      ["Studio Vesper", "Paused", null, null, null, null],
    ],
  });
  const rows = async (viewId: string) => ((await (await r.post(`/api/views/${viewId}/query`, { data: { limit: 50 }, headers: CSRF })).json()) as { records: { id: string; values: Record<string, unknown> }[] }).records;
  const billRows = await rows(defaultViews["Bills"]!);
  const accountRows = await rows(defaultViews["Accounts"]!);
  const billsLink = await call<{ id: string }>(r, "post", `/api/tables/${t["Accounts"]}/fields`, { name: "Bills", type: "link", options: { linked_table_id: t["Bills"], single: false } });
  const accountsSchema = await (await r.get(`/api/bases/${sideTop}`)).json();
  const accountsTable = (accountsSchema.tables as { id: string; body_field_id: string; fields: { id: string; name: string }[] }[]).find((x) => x.id === t["Accounts"])!;
  const pageField = accountsTable.body_field_id;
  const accountField = (name: string) => accountsTable.fields.find((f) => f.name === name)!.id;
  const fernwood = accountRows[0]!.id;
  // A computed property, for the formula editor's shot.
  const perYear = await call<{ id: string }>(r, "post", `/api/tables/${t["Accounts"]}/fields`, { name: "Per year", type: "formula", options: { expression: "{Monthly} * 12" } });
  // Three files of three kinds: a picture (it also fills the record's tile), a PDF drawn from its first page and a Word
  // file, which has no preview and shows its type.
  const storefront = await upload(r, sideTop, "fernwood-storefront.png", "image/png", shopfront());
  const files = [
    storefront,
    await upload(r, sideTop, "service-agreement.pdf", "application/pdf", agreement()),
    await upload(r, sideTop, "brand-guidelines.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", Buffer.from("PK\u0003\u0004 not a real document")),
  ];
  const pageText = [
    "## This quarter",
    "- Send the revised quote before the 12th",
    "- Move the hosting plan to the annual price",
    "Bills for this account:",
    "```openbase\n" + JSON.stringify({ embed: "linked", field: billsLink.id }) + "\n```",
    "Every bill still to be paid:",
    "```openbase\n" + JSON.stringify({ embed: "view", view: savedViews["Bills / Unpaid bills"], limit: 10 }) + "\n```",
  ].join("\n\n");
  await call(r, "patch", `/api/tables/${t["Accounts"]}/records`, {
    records: [{ id: fernwood, values: { [billsLink.id]: billRows.slice(0, 2).map((b) => b.id), [pageField]: pageText, [accountField("Files")]: files } }],
  });
  await call(r, "patch", `/api/tables/${t["Accounts"]}/records`, { records: [{ id: accountRows[1]!.id, values: { [billsLink.id]: [billRows[2]!.id] } }] });
  // A thread for the comments panel (REC-7); the changes above are its history.
  await call(r, "post", `/api/records/${fernwood}/comments`, { body: "Sent the revised quote. They want the annual price before the 12th." });
  await call(r, "post", `/api/records/${fernwood}/comments`, { body: `I will move the hosting plan to annual **today**.\n\n![The shopfront](/api/attachments/${storefront.id}/${storefront.filename})` });

  // ---- What Phase 6's screens show --------------------------------------------------------------
  const me = (await (await r.get("/api/auth/me")).json()) as { id: string };
  const rootSchema = (await (await r.get(`/api/bases/${rootId}`)).json()) as { tables: { id: string; primary_field_id: string }[] };
  const primary = (name: string) => rootSchema.tables.find((x) => x.id === t[name])!.primary_field_id;
  const viewRows = async (viewId: string) =>
    ((await (await r.post(`/api/views/${viewId}/query`, { data: { limit: 50 }, headers: CSRF })).json()) as { records: { id: string; values: Record<string, unknown> }[] }).records;

  // Drafts for the Inbox card, and API tokens of two kinds.
  await call(r, "post", "/api/inbox", { title: "Ask Dana about the annual hosting price", body: "Check October's invoice first." });
  await call(r, "post", "/api/inbox", { title: "Gift idea for the housewarming" });
  await call(r, "post", "/api/tokens", { name: "Nightly backup script", write: false, manage: false });
  await call(r, "post", "/api/tokens", { name: "Zapier sync", write: true, manage: false, expires_in_days: 90 });

  // An automation that runs (and tells the owner), and one that is off.
  const research = await call<{ id: string }>(r, "post", `/api/bases/${rootId}/automations`, {
    name: "Tell me about new research",
    enabled: true,
    trigger: { type: "record_created", table_id: t["Market research"] },
    actions: [{ type: "notify", user_ids: [me.id], message: "New research was added: {{trigger.record.fields.Name}}" }],
  });
  const welcome = await call<{ id: string }>(r, "post", `/api/bases/${rootId}/automations`, {
    name: "Add a hello task for each new client",
    enabled: false,
    trigger: { type: "record_created", table_id: t["Clients"] },
    actions: [{ type: "create_record", table_id: t["Tasks"], values: { [primary("Tasks")]: "Say hello to {{trigger.record.fields.Name}}" } }],
  });
  await call(r, "post", `/api/tables/${t["Market research"]}/records`, {
    records: [{ values: { [primary("Market research")]: "Tool pricing across five agencies" } }, { values: { [primary("Market research")]: "What clients ask in the first call" } }],
    typecast: true,
  });
  await expect
    .poll(async () => ((await (await r.get(`/api/automations/${research.id}/runs?limit=10`)).json()) as { runs: unknown[] }).runs.length, { message: "the automation's runs" })
    .toBeGreaterThanOrEqual(2);

  // A public form and a shared board.
  const formLink = await call<{ path: string }>(r, "post", `/api/views/${savedViews["Clients / Intake"]}/shares`, { kind: "form" });
  const viewLink = await call<{ path: string }>(r, "post", `/api/views/${savedViews["Clients / Pipeline"]}/shares`, { kind: "view" });

  // Open invites: one to the workspace for the invite page, one to a person for a folder (the member list shows it as pending).
  const open = await call<{ url: string }>(r, "post", `/api/workspaces/${ws.id}/invites`, { role: "editor", email: null, all_bases: true });
  await call(r, "post", `/api/workspaces/${ws.id}/invites`, { role: "editor", email: "priya.nair@example.com", all_bases: false, base_ids: [marketing.id] });

  // Edits for History, then things of each kind in the Trash.
  const marketingSchema = (await (await r.get(`/api/bases/${marketing.id}`)).json()) as { tables: { id: string; fields: { id: string; name: string }[] }[] };
  const press = marketingSchema.tables.find((x) => x.id === t["Press contacts"])!;
  const outlet = press.fields.find((f) => f.name === "Outlet")!.id;
  const contacts = await viewRows(defaultViews["Press contacts"]!);
  await call(r, "patch", `/api/tables/${press.id}/records`, {
    records: [
      { id: contacts[0]!.id, values: { [outlet]: "Regional Business Daily" } },
      { id: contacts[1]!.id, values: { [outlet]: "The Design Ledger, weekend desk" } },
    ],
  });
  await call(r, "delete", `/api/tables/${press.id}/records`, { ids: [contacts[3]!.id] });
  const fax = await call<{ id: string }>(r, "post", `/api/tables/${press.id}/fields`, { name: "Fax", type: "text", options: {} });
  await call(r, "delete", `/api/fields/${fax.id}`);
  const drafts = await call<{ id: string }>(r, "post", `/api/bases/${marketing.id}/tables`, { name: "Old drafts", color: "gray" });
  await call(r, "delete", `/api/tables/${drafts.id}`);
  const oldCampaigns = await call<{ id: string }>(r, "post", `/api/workspaces/${ws.id}/bases`, { name: "Old campaigns", color: "pink", empty: true });
  await call(r, "delete", `/api/bases/${oldCampaigns.id}`);
  const scratch = await call<{ id: string }>(r, "post", "/api/workspaces", { name: "Scratch notes", color: "gray" });
  await call(r, "delete", `/api/workspaces/${scratch.id}`);

  // A person limited to the Operations folder.
  const invite = await call<{ url: string }>(r, "post", `/api/bases/${operations.id}/invites`, { role: "editor", email: null });
  const limitedContext = await newClientContext(browser, testInfo, { baseURL, storageState: { cookies: [], origins: [] } }, "ledger-limited");
  await signUp(limitedContext.request, "Jonas Berg");
  const accept = await limitedContext.request.post(`/api/invites/by-token/${invite.url.split("/invite/")[1]}/accept`, { data: {}, headers: CSRF });
  expect(accept.ok(), await accept.text()).toBeTruthy();
  // Jonas asks the owner a question on an invoice: the owner's notifications get a mention besides the automation's.
  const invoice = (await viewRows(defaultViews["Invoices"]!))[1]!;
  await call(limitedContext.request, "post", `/api/records/${invoice.id}/comments`, { body: `@[Mara Okafor](${me.id}) the reminder went out and this invoice is still unpaid. Should I send a second one?` });

  // Apps connected to the owner's account (Account, AI assistants).
  const apps = [
    ["Claude Code", "write"],
    ["Cursor", "read"],
  ] as const;
  for (const [appName, access] of apps) {
    const consent = await startConsent(r, baseURL!, appName);
    const outcome = await call<{ redirect_to: string }>(r, "post", `/api/oauth/requests/${consent.requestId}/decision`, { decision: "approve", access });
    const code = new URL(outcome.redirect_to).searchParams.get("code")!;
    const exchanged = await r.post("/oauth/token", {
      form: { grant_type: "authorization_code", client_id: consent.clientId, code, redirect_uri: REDIRECT, code_verifier: consent.verifier, resource: `${baseURL}/mcp` },
    });
    expect(exchanged.ok(), await exchanged.text()).toBeTruthy();
  }

  // The people the sign-in pages' other states need: the administrator, one with nothing made yet, one who has not seen the intro.
  const adminContext = await newClientContext(browser, testInfo, { baseURL }, "ledger-admin");
  const login = await adminContext.request.post("/api/auth/login", { data: { email: "journey-admin@example.com", password: PASSWORD }, headers: CSRF });
  expect(login.ok(), `signing in as the journey's administrator: ${login.status()} ${await login.text()}`).toBeTruthy();
  const freshContext = await newClientContext(browser, testInfo, { baseURL }, "ledger-fresh");
  await signUp(freshContext.request, "Priya Nair");
  const newcomerContext = await newClientContext(browser, testInfo, { baseURL }, "ledger-newcomer");
  await signUp(newcomerContext.request, "Sam Whitlow", true);
  await call(newcomerContext.request, "post", "/api/workspaces", { name: "Harbor Studio", color: "teal" });

  const seed: LedgerSeed = {
    owner: await ownerContext.storageState(),
    limited: await limitedContext.storageState(),
    admin: await adminContext.storageState(),
    fresh: await freshContext.storageState(),
    newcomer: await newcomerContext.storageState(),
    workspaceId: ws.id,
    otherWorkspaceIds: others.map((o) => o.id),
    rootId,
    folders: { marketing: marketing.id, operations: operations.id, archive: archive.id },
    tables: t,
    bases,
    defaultViews,
    views: savedViews,
    palette: "mark",
    pageRecord: { baseId: sideTop, tableId: t["Accounts"]!, viewId: defaultViews["Accounts"]!, recordId: fernwood, title: "Fernwood Dental" },
    pageFields: { status: accountField("Status"), perYear: perYear.id, bills: billsLink.id, files: accountField("Files") },
    peekedBill: billRows[1]!.id,
    soloLink: { recordId: accountRows[1]!.id, billId: billRows[2]!.id, billTitle: "Design software" },
    inviteToken: open.url.split("/invite/")[1]!,
    links: { form: formLink.path, view: viewLink.path },
    automations: { research: research.id, welcome: welcome.id },
    connectedApp: "Claude Code",
  };
  await Promise.all([ownerContext, limitedContext, adminContext, freshContext, newcomerContext].map((c) => c.close()));
  return seed;
}
