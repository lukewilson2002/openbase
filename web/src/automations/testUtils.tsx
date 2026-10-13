/** Fixtures and a renderer for the automation component tests. Not imported by app code. */
import type { ReactElement } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { render, type RenderResult } from "@testing-library/react";
import type { ActionStep, Automation, BaseSchema, Trigger } from "@/api/types";
import { Providers, createQueryClient } from "@/providers";
import { CHOICES, PEOPLE, field } from "@/test/fields";
import { makeSchema, makeView } from "@/test/utils";
import { AutomationEnvProvider, type AutomationEnv } from "./context";

/** Tasks (Name, Qty, Status, Done) with a grid and a form view, and People (Name, Score, Active). */
export function automationSchema(role = "creator"): BaseSchema {
  const schema = makeSchema(role);
  const tasks = schema.tables[0]!;
  tasks.fields = [
    field("single_line_text", {}, { id: "fld1", name: "Name" }),
    field("number", { precision: 0, allow_negative: true }, { id: "fld2", name: "Qty" }),
    field("single_select", { choices: CHOICES }, { id: "fld3", name: "Status" }),
    field("checkbox", { icon: "check", color: "green" }, { id: "fld4", name: "Done" }),
    field("formula", { expression: "{Qty}*2", result_type: "number", format: { kind: "number", precision: 0 } }, { id: "fld8", name: "Double" }),
  ];
  tasks.primary_field_id = "fld1";
  tasks.views = [makeView({ id: "viw1", name: "All tasks" }), makeView({ id: "viw9", name: "Signup form", type: "form" })];
  const people = schema.tables[1]!;
  people.fields = [
    { ...field("single_line_text", {}, { id: "fld5", name: "Name" }), table_id: "tbl2" },
    { ...field("number", { precision: 0, allow_negative: true }, { id: "fld6", name: "Score" }), table_id: "tbl2" },
    { ...field("checkbox", { icon: "check", color: "green" }, { id: "fld7", name: "Active" }), table_id: "tbl2" },
  ];
  people.primary_field_id = "fld5";
  return schema;
}

export function makeAutomation(over: Partial<Automation> & { trigger?: Trigger; actions?: ActionStep[] } = {}): Automation {
  return {
    id: "aut1",
    base_id: "app1",
    name: "Flow",
    enabled: false,
    trigger: { type: "record_created", table_id: "tbl1" },
    actions: [],
    next_run_at: null,
    webhook_token: null,
    created_by: "usr1",
    created_at: 1_700_000_000_000,
    updated_at: 1_700_000_100_000,
    ...over,
  };
}

export function makeEnv(over: Partial<AutomationEnv> = {}): AutomationEnv {
  return { schema: automationSchema(), collaborators: PEOPLE, emailEnabled: true, timeZone: "UTC", currentUserId: "usr1", ...over };
}

/** Render with query, toast and automation environments. */
export function renderWithEnv(ui: ReactElement, env: AutomationEnv = makeEnv(), route = "/"): RenderResult {
  const client = createQueryClient();
  client.setDefaultOptions({ queries: { retry: false, staleTime: 0, gcTime: 0 } });
  return render(
    <Providers client={client}>
      <MemoryRouter initialEntries={[route]}>
        <AutomationEnvProvider value={env}>{ui}</AutomationEnvProvider>
      </MemoryRouter>
    </Providers>,
  );
}

/** The page under its real route, for navigation tests. */
export function renderRoutes(element: ReactElement, route: string, env: AutomationEnv = makeEnv()): RenderResult {
  const client = createQueryClient();
  client.setDefaultOptions({ queries: { retry: false, staleTime: 0, gcTime: 0 } });
  return render(
    <Providers client={client}>
      <MemoryRouter initialEntries={[route]}>
        <Routes>
          <Route path="/base/:baseId/automations/:automationId?/:tab?" element={<AutomationEnvProvider value={env}>{element}</AutomationEnvProvider>} />
        </Routes>
      </MemoryRouter>
    </Providers>,
  );
}
