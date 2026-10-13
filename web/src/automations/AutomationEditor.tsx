/**
 * Editor for one automation: name, on/off, trigger, ordered actions, test, and the run history.
 * The draft lives here; Save sends `{name, trigger, actions}` (the server validates and answers a
 * 400 whose message names the action, `action 2: ...`, which is shown on that action's card).
 * On/off is saved on its own, so turning an automation on never sends half-edited actions.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Save, Undo2 } from "lucide-react";
import { errorMessage } from "@/api/client";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import type { Automation, Trigger } from "@/api/types";
import { Notice, Section } from "@/components/layouts";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/components/ui/toast";
import { ActionList } from "./ActionList";
import { useAutomationEnv } from "./context";
import {
  canonicalJson,
  draftFromAutomation,
  isDirty,
  newAction,
  newStepKey,
  parseSaveError,
  pruneConditions,
  toUpdate,
  triggerTable,
  type ActionType,
  type Draft,
} from "./model";
import { RunsTab } from "./RunsTab";
import { TestPanel } from "./TestPanel";
import { TriggerEditor } from "./TriggerEditor";

export type EditorTab = "editor" | "runs";

export interface AutomationEditorProps {
  automation: Automation;
  tab: EditorTab;
  onTabChange: (tab: EditorTab) => void;
  /** The webhook token revealed by the latest create / rotate response, if any. */
  webhookToken: string | null;
  onWebhookToken: (token: string) => void;
}

/** Replace one automation in the cached list so the list reflects a save without a refetch. */
export function useCacheAutomation(baseId: string) {
  const qc = useQueryClient();
  return (saved: Automation) => {
    qc.setQueryData<Automation[]>(keys.automations(baseId), (list) => (list ? list.map((a) => (a.id === saved.id ? { ...saved, webhook_token: null } : a)) : list));
    void qc.invalidateQueries({ queryKey: keys.automations(baseId) });
  };
}

export function AutomationEditor({ automation, tab, onTabChange, webhookToken, onWebhookToken }: AutomationEditorProps) {
  const env = useAutomationEnv();
  const toast = useToast();
  const cache = useCacheAutomation(automation.base_id);

  const [draft, setDraft] = useState<Draft>(() => draftFromAutomation(automation));
  const [version, setVersion] = useState(0);
  const [errors, setErrors] = useState<{ general: string | null; actions: Record<number, string> }>({ general: null, actions: {} });
  const baseline = useRef(automation);

  const dirty = useMemo(() => isDirty(draft, automation), [draft, automation]);

  // Adopt a newer saved version (a save, a toggle, another person's edit) unless there are unsaved edits.
  useEffect(() => {
    if (baseline.current === automation) return;
    const before = baseline.current;
    baseline.current = automation;
    setDraft((d) => (isDirty(d, before) ? d : keepKeys(d, draftFromAutomation(automation))));
  }, [automation]);

  const edit = (fn: (d: Draft) => Draft) => {
    setDraft(fn);
    setErrors({ general: null, actions: {} });
  };

  const save = useMutation({
    mutationFn: () => api.automations.update(automation.id, toUpdate(draft)),
    onSuccess: (saved) => {
      if (saved.webhook_token) onWebhookToken(saved.webhook_token);
      baseline.current = saved;
      setDraft((d) => keepKeys(d, draftFromAutomation(saved)));
      setErrors({ general: null, actions: {} });
      cache(saved);
      toast.toast({ title: "Automation saved", variant: "success" });
    },
    onError: (e) => {
      const parsed = parseSaveError(errorMessage(e));
      if (parsed.action !== null) setErrors({ general: null, actions: { [parsed.action]: parsed.text } });
      else setErrors({ general: parsed.text, actions: {} });
    },
  });

  const toggle = useMutation({
    mutationFn: (enabled: boolean) => api.automations.update(automation.id, { enabled }),
    onSuccess: (saved) => cache(saved),
    onError: (e, enabled) => toast.error(e, enabled ? "Could not turn the automation on" : "Could not turn the automation off"),
  });

  const rotate = async () => {
    const saved = await api.automations.update(automation.id, { rotate_webhook_token: true });
    if (saved.webhook_token) onWebhookToken(saved.webhook_token);
    cache(saved);
  };

  const setTrigger = (next: Trigger) =>
    edit((d) => {
      const before = triggerTable(d.trigger, env.schema)?.id;
      const after = triggerTable(next, env.schema)?.id;
      // Conditions refer to fields of the trigger's table; keep them only while that table is the same.
      return { ...d, trigger: next, steps: before === after ? d.steps : pruneConditions(d.steps, after ? triggerTable(next, env.schema) : null) };
    });

  const addAction = (type: ActionType) => edit((d) => ({ ...d, steps: [...d.steps, { key: newStepKey(), step: newAction(type, env.schema, d.trigger) }] }));

  const discard = () => {
    setDraft(draftFromAutomation(automation));
    setVersion((v) => v + 1);
    setErrors({ general: null, actions: {} });
  };

  const savedTrigger = canonicalJson(automation.trigger) === canonicalJson(draft.trigger);
  const nextRunNote = !automation.enabled ? "turn the automation on to schedule runs" : !savedTrigger ? "save to see the next run" : undefined;
  const webhookSaved = automation.trigger.type === "webhook" && draft.trigger.type === "webhook";

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-48 flex-1">
          <label htmlFor="automation-name" className="mb-1 block text-[0.8125rem] font-medium">
            Name
          </label>
          <Input id="automation-name" value={draft.name} maxLength={255} onChange={(e) => edit((d) => ({ ...d, name: e.target.value }))} />
        </div>
        <Switch checked={automation.enabled} disabled={toggle.isPending} onCheckedChange={(on) => toggle.mutate(on)} label={automation.enabled ? "On" : "Off"} className="pb-1.5" />
        <div className="flex items-center gap-2">
          {dirty && <span className="text-xs text-muted">Unsaved changes</span>}
          <Button onClick={discard} disabled={!dirty || save.isPending}>
            <Undo2 aria-hidden className="size-4" /> Discard
          </Button>
          <Button variant="primary" onClick={() => save.mutate()} loading={save.isPending} disabled={!dirty || !draft.name.trim()}>
            <Save aria-hidden className="size-4" /> Save
          </Button>
        </div>
      </div>

      {errors.general && <Notice tone="error">{errors.general}</Notice>}
      {Object.keys(errors.actions).length > 0 && <Notice tone="error">The server rejected one of the actions. The message is shown on that action.</Notice>}

      <Tabs value={tab} onValueChange={(v) => onTabChange(v === "runs" ? "runs" : "editor")}>
        <TabsList aria-label="Automation sections">
          <TabsTrigger value="editor">Editor</TabsTrigger>
          <TabsTrigger value="runs">Runs</TabsTrigger>
        </TabsList>
        <TabsContent value="editor" className="flex flex-col gap-4">
          <Section title="1. Trigger" description="What starts the automation.">
            <TriggerEditor
              key={`trigger-${version}`}
              trigger={draft.trigger}
              onChange={setTrigger}
              nextRunAt={savedTrigger && automation.enabled ? automation.next_run_at : null}
              nextRunNote={nextRunNote}
              webhook={{ saved: webhookSaved, token: webhookSaved ? webhookToken : null, enabled: automation.enabled, onRotate: rotate, canRotate: !dirty }}
            />
          </Section>
          <Section title="2. Actions" description="What happens, in order. Each action can use data from the trigger and from earlier actions.">
            <ActionList key={`actions-${version}`} trigger={draft.trigger} steps={draft.steps} errors={errors.actions} onChange={(steps) => edit((d) => ({ ...d, steps }))} onAdd={addAction} />
          </Section>
          <Section title="3. Test" description="Try the saved automation without waiting for the trigger.">
            <TestPanel automationId={automation.id} trigger={automation.trigger} dirty={dirty} />
          </Section>
        </TabsContent>
        <TabsContent value="runs">
          <RunsTab automation={automation} timeZone={env.timeZone} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/** A new draft that keeps the step keys of `old` by position, so cards keep their local state across a save. */
function keepKeys(old: Draft, next: Draft): Draft {
  return { ...next, steps: next.steps.map((s, i) => ({ ...s, key: old.steps[i]?.key ?? s.key })) };
}
