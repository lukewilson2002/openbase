import type { ReactElement } from "react";
import { MemoryRouter } from "react-router";
import { render, type RenderResult } from "@testing-library/react";
import { vi } from "vitest";
import { AppRoutes } from "@/App";
import { setUnauthorizedHandler } from "@/api/client";
import { Providers, createQueryClient } from "@/providers";
import type { AdminUser, BaseSchema, User, View, WorkspaceSummary } from "@/api/types";

export interface RecordedCall {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
  headers: Headers;
}

export type Reply = unknown;
// Not `unknown`: that would absorb the function member and lose contextual typing of `call`.
export type Handler = ((call: RecordedCall) => unknown) | object | string | number | boolean | null;

export interface MockApi {
  calls: RecordedCall[];
  /** Calls whose "METHOD /path" matches. */
  callsTo: (key: string) => RecordedCall[];
  /** Replace or add a route at runtime. */
  set: (key: string, handler: Handler) => void;
}

function isReplyObject(v: unknown): v is { status?: number; json?: unknown; text?: string } {
  return !!v && typeof v === "object" && !Array.isArray(v) && ("status" in v || "json" in v || "text" in v) && Object.keys(v).every((k) => ["status", "json", "text"].includes(k));
}

/**
 * Stub `fetch` with a route table keyed by "METHOD /path" (query string ignored).
 * A handler is a JSON value, a `{status, json}` reply, or a function returning either.
 * Unmatched requests answer 404 `{"error": {"code": "not_found"}}` and are recorded.
 */
export function mockApi(routes: Record<string, Handler>): MockApi {
  const table = new Map(Object.entries(routes));
  const calls: RecordedCall[] = [];
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost");
    const method = (init?.method ?? "GET").toUpperCase();
    let body: unknown;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const call: RecordedCall = { method, path: url.pathname, query: url.searchParams, body, headers: new Headers(init?.headers) };
    calls.push(call);
    const handler = table.get(`${method} ${url.pathname}`);
    if (handler === undefined) {
      return new Response(JSON.stringify({ error: { code: "not_found", message: `no mock for ${method} ${url.pathname}` } }), { status: 404 });
    }
    const out: unknown = typeof handler === "function" ? await handler(call) : handler;
    const reply = isReplyObject(out) ? out : { json: out };
    const status = reply.status ?? 200;
    if (status === 204 || (reply.json === undefined && reply.text === undefined)) return new Response(null, { status });
    return new Response(reply.text ?? JSON.stringify(reply.json), { status, headers: { "Content-Type": "application/json" } });
  };
  vi.stubGlobal("fetch", vi.fn(impl));
  return {
    calls,
    callsTo: (key) => calls.filter((c) => `${c.method} ${c.path}` === key),
    set: (key, handler) => void table.set(key, handler),
  };
}

export function apiError(status: number, code: string, message: string): { status: number; json: unknown } {
  return { status, json: { error: { code, message } } };
}

export interface RenderAppOptions {
  route?: string;
}

/** Render the real route table at `route` with all providers; the unauthorized handler is a spy. */
export function renderApp(opts: RenderAppOptions = {}): RenderResult & { onUnauthorized: ReturnType<typeof vi.fn> } {
  const onUnauthorized = vi.fn();
  setUnauthorizedHandler(onUnauthorized);
  const client = createQueryClient();
  client.setDefaultOptions({ queries: { retry: false, staleTime: 0, gcTime: 0 } });
  const result = render(
    <Providers client={client}>
      <MemoryRouter initialEntries={[opts.route ?? "/"]}>
        <AppRoutes />
      </MemoryRouter>
    </Providers>,
  );
  return Object.assign(result, { onUnauthorized });
}

export function renderWithProviders(ui: ReactElement, route = "/"): RenderResult {
  const client = createQueryClient();
  client.setDefaultOptions({ queries: { retry: false, staleTime: 0, gcTime: 0 } });
  return render(
    <Providers client={client}>
      <MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>
    </Providers>,
  );
}

// ---- fixtures -------------------------------------------------------------------------------


export const USER: User = { id: "usr1", email: "ada@example.com", name: "Ada Lovelace", is_admin: false, timezone: null, totp_enabled: false };
export const ADMIN: User = { ...USER, id: "usr0", email: "root@example.com", name: "Root Admin", is_admin: true };

export function makeView(over: Partial<View> & { id: string; type?: View["type"] }): View {
  const { id, type = "grid", ...rest } = over;
  return {
    id,
    table_id: "tbl1",
    name: `${type} ${id}`,
    type,
    config: {
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
    },
    personal: false,
    locked: false,
    ...rest,
  };
}

export function makeSchema(role: string, over: Partial<BaseSchema> = {}): BaseSchema {
  return {
    id: "app1",
    workspace_id: "wsp1",
    name: "Project tracker",
    color: "green_dark",
    icon: null,
    role,
    tables: [
      {
        id: "tbl1",
        base_id: "app1",
        name: "Tasks",
        description: null,
        primary_field_id: "fld1",
        fields: [{ id: "fld1", table_id: "tbl1", name: "Name", type: "single_line_text", options: {} }],
        views: [makeView({ id: "viw1", name: "All tasks" }), makeView({ id: "viw2", name: "Board", type: "kanban" }), makeView({ id: "viw3", name: "My tasks", personal: true })],
      },
      { id: "tbl2", base_id: "app1", name: "People", description: null, primary_field_id: "fld2", fields: [], views: [makeView({ id: "viw4", name: "Everyone" })] },
    ],
    ...over,
  };
}

export function makeWorkspace(role: string | null, bases: WorkspaceSummary["bases"] = []): WorkspaceSummary {
  return { id: "wsp1", name: "Acme", role, bases };
}

export const ADMIN_USER_ROW: AdminUser = {
  id: "usr1",
  email: "ada@example.com",
  name: "Ada Lovelace",
  is_admin: false,
  is_active: true,
  totp_enabled: true,
  created_at: 1_700_000_000_000,
  last_login_at: null,
};
