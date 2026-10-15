/** Test helpers for the view components: a small schema, a query-aware mock API and a renderer. */
import type { ComponentType } from "react";
import { MemoryRouter, useLocation } from "react-router";
import { render, type RenderResult } from "@testing-library/react";
import type { QueryClient } from "@tanstack/react-query";
import type { BaseSchema, Field, GroupHeader, QueryRequest, Table, TableRecord, View, ViewType } from "@/api/types";
import { keys } from "@/api/keys";
import { Providers, createQueryClient } from "@/providers";
import { ALL_FIELDS, field, makeRecord } from "@/test/fields";
import { USER, makeView, mockApi, type Handler, type MockApi, type RecordedCall } from "@/test/utils";
import type { ViewProps } from "../types";

export const F = {
  name: field("single_line_text", {}, { id: "f_name", name: "Name" }),
  status: field("single_select", { choices: [{ id: "s1", name: "Todo", color: "gray" }, { id: "s2", name: "Doing", color: "blue" }, { id: "s3", name: "Done", color: "green" }] }, { id: "f_status", name: "Status" }),
  start: field("date", { include_time: false, date_format: "iso", time_format: "h24", timezone: null }, { id: "f_start", name: "Start" }),
  end: field("date", { include_time: false, date_format: "iso", time_format: "h24", timezone: null }, { id: "f_end", name: "End" }),
  owner: field("user", { multiple: false, notify: false }, { id: "f_owner", name: "Owner" }),
  cover: field("attachment", {}, { id: "f_cover", name: "Cover" }),
  deps: field("link", { linked_table_id: "tbl1", inverse_field_id: "f_blocks", single: false }, { id: "f_deps", name: "Depends on" }),
  effort: ALL_FIELDS.number!,
} satisfies Record<string, Field>;

export const TABLE_FIELDS: Field[] = [F.name, F.status, F.start, F.end, F.owner, F.cover, F.deps, F.effort];

export function projectTable(views: View[]): Table {
  return { id: "tbl1", base_id: "app1", name: "Projects", description: null, primary_field_id: F.name.id, fields: TABLE_FIELDS, views };
}

export function projectSchema(role: string, views: View[]): BaseSchema {
  return { id: "app1", workspace_id: "wsp1", name: "Tracker", color: "green_dark", icon: null, role, tables: [projectTable(views)], people: [], workspace_name: "Acme" };
}

export function viewWithConfig(id: string, type: ViewType, patch: Partial<View["config"]>, over: Partial<View> = {}): View {
  const base = makeView({ id, type });
  return { ...base, ...over, config: { ...base.config, ...patch } };
}

export const rec = (id: string, values: Record<string, unknown>): TableRecord => makeRecord({ [F.name.id]: id.toUpperCase(), ...values }, id);

export interface QueryServer {
  /** Records the server holds (already in view order). */
  records: TableRecord[];
  groups?: GroupHeader[];
  colors?: Record<string, string>;
}

/** A `POST /api/views/{id}/query` handler that pages `server.records` and records what was asked. */
export function queryHandler(server: QueryServer, log?: QueryRequest[]): Handler {
  return (call: RecordedCall) => {
    const body = call.body as QueryRequest;
    log?.push(body);
    const offset = body.offset ?? 0;
    const limit = body.limit ?? 100;
    return { total: server.records.length, offset, records: server.records.slice(offset, offset + limit), groups: server.groups ?? [], colors: server.colors ?? {} };
  };
}

export interface RenderedView extends RenderResult {
  api: MockApi;
  client: QueryClient;
}

function Where() {
  const l = useLocation();
  return <output data-testid="where">{l.pathname + l.search}</output>;
}

export function renderView(Component: ComponentType<ViewProps>, opts: { schema: BaseSchema; viewId: string; routes?: Record<string, Handler>; route?: string; timeZone?: string }): RenderedView {
  const api = mockApi({
    "GET /api/auth/me": { ...USER, timezone: "UTC" },
    "GET /api/bases/app1/collaborators": [
      { id: "usr1", name: "Ada Lovelace", email: "ada@example.com" },
      { id: "usr2", name: "Grace Hopper", email: "grace@example.com" },
    ],
    ...opts.routes,
  });
  const table = opts.schema.tables[0]!;
  const view = table.views.find((v) => v.id === opts.viewId)!;
  const client = createQueryClient();
  client.setDefaultOptions({ queries: { retry: false, staleTime: 0, gcTime: 0 } });
  // The shell has loaded the user before any view renders; without this the time zone would change mid-test.
  client.setQueryData(keys.me, { ...USER, timezone: opts.timeZone ?? "UTC" });
  const result = render(
    <Providers client={client}>
      <MemoryRouter initialEntries={[opts.route ?? "/base/app1/tbl1/" + opts.viewId]}>
        <Component schema={opts.schema} table={table} view={view} role={opts.schema.role} />
        <Where />
      </MemoryRouter>
    </Providers>,
  );
  return Object.assign(result, { api, client });
}
