/**
 * A record page against a mocked server that keeps its folder, record and default view, for the tests of the
 * page's head and properties: the folder is fetched as the route does (so a change to the default view's layout
 * comes back through it), and a save of the record or the layout is applied to what the server holds.
 */
import { render } from "@testing-library/react";
import { vi } from "vitest";
import { MemoryRouter } from "react-router";
import { useBaseSchema } from "@/base/useBaseSchema";
import type { BaseSchema, Table, TableRecord, View, ViewConfig } from "@/api/types";
import { RecordPage, type RecordPageProps } from "@/record/RecordPage";
import { Providers, createQueryClient } from "@/providers";
import { recordLayoutView } from "@/views/grid/useViewConfig";
import { PEOPLE } from "./fields";
import { makeSchema, mockApi, stubDesktop, stubPhone } from "./utils";

export const PATCH_RECORDS = "PATCH /api/tables/tbl1/records";
export const PATCH_VIEW = "PATCH /api/views/viw1";

export interface RecordPageSetup {
  table: Table;
  record: TableRecord;
  role?: string;
  /** The default view's layout: which properties it hides, and in what order. */
  layout?: Partial<Pick<ViewConfig, "field_order" | "hidden_fields">>;
  routes?: Record<string, unknown>;
  phone?: boolean;
  props?: Partial<RecordPageProps>;
}

function Page(props: Omit<RecordPageProps, "schema" | "table" | "layoutView">) {
  const base = useBaseSchema("app1");
  const schema = base.data;
  const table = schema?.tables.find((t) => t.id === "tbl1");
  if (!schema || !table) return null;
  return <RecordPage {...props} role={schema.role} schema={schema} table={table} layoutView={recordLayoutView(table)} />;
}

export function renderRecordPage({ table, record, role = "owner", layout = {}, routes = {}, phone = false, props = {} }: RecordPageSetup) {
  if (phone) stubPhone();
  else stubDesktop();
  const base = makeSchema(role);
  const view: View = { ...table.views[0]!, is_default: true, config: { ...table.views[0]!.config, ...layout } };
  let schema: BaseSchema = { ...base, tables: [{ ...table, views: [view] }, ...base.tables.filter((t) => t.id !== "tbl1")] };
  let current = record;
  const api = mockApi({
    "GET /api/bases/app1": () => schema,
    "GET /api/workspaces": [],
    "GET /api/tables/tbl1/records/rec1": () => current,
    "GET /api/records/rec1/comments": [],
    "GET /api/records/rec1/history": [],
    [PATCH_RECORDS]: (call: { body: unknown }) => {
      current = { ...current, values: { ...current.values, ...(call.body as { records: { values: object }[] }).records[0]!.values } };
      return { records: [current] };
    },
    [PATCH_VIEW]: (call: { body: unknown }) => {
      const config = (call.body as { config: ViewConfig }).config;
      schema = { ...schema, tables: schema.tables.map((t) => (t.id === "tbl1" ? { ...t, views: t.views.map((v) => (v.id === "viw1" ? { ...v, config } : v)) } : t)) };
      return schema.tables[0]!.views[0];
    },
    ...routes,
  } as never);
  const pageProps = {
    role,
    recordId: "rec1",
    prevId: null,
    nextId: null,
    onNavigate: vi.fn(),
    onClose: vi.fn(),
    collectionHref: "/base/app1/tbl1/viw1",
    onOpenLinked: vi.fn(),
    emails: new Map(PEOPLE.map((p) => [p.id, p.email])),
    timeZone: "UTC",
    currentUserId: "usr1",
    collaborators: PEOPLE,
    ...props,
  };
  const client = createQueryClient();
  const utils = render(
    <Providers client={client}>
      <MemoryRouter>
        <Page {...pageProps} />
      </MemoryRouter>
    </Providers>,
  );
  return { api, props: pageProps, client, ...utils, server: { schema: () => schema, record: () => current } };
}
