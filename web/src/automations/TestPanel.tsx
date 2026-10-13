/**
 * Test an automation: a dry run renders every template and evaluates conditions but sends and
 * writes nothing; "run for real" executes the actions once (after a confirmation) and records the
 * run. `POST /api/automations/{id}/test` runs the *saved* automation, so unsaved edits block it.
 */
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { FlaskConical, Play } from "lucide-react";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import type { JsonValue, TestAutomation, TestResult, Trigger } from "@/api/types";
import { Notice } from "@/components/layouts";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Field, Input, Textarea } from "@/components/ui/input";
import { errorMessage } from "@/api/client";
import { triggerShape } from "./model";
import { StatusBadge, StepLogView } from "./StepLogView";

export interface TestPanelProps {
  automationId: string;
  trigger: Trigger;
  /** Unsaved changes: the server would test the stored version. */
  dirty: boolean;
}

/** The request body for a test: dry by default, plus the record id or webhook body when given. Throws a readable error for bad JSON. */
export function buildTestRequest(shape: ReturnType<typeof triggerShape>, opts: { real: boolean; recordId: string; body: string }): TestAutomation {
  const req: TestAutomation = { dry_run: !opts.real };
  if (shape === "record" && opts.recordId.trim()) req.record_id = opts.recordId.trim();
  if (shape === "webhook" && opts.body.trim()) {
    try {
      req.body = JSON.parse(opts.body) as JsonValue;
    } catch (e) {
      throw new Error(`The sample body is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return req;
}

export function TestPanel({ automationId, trigger, dirty }: TestPanelProps) {
  const qc = useQueryClient();
  const shape = triggerShape(trigger);
  const [real, setReal] = useState(false);
  const [recordId, setRecordId] = useState("");
  const [body, setBody] = useState("{\n  \n}");
  const [confirming, setConfirming] = useState(false);
  const [inputError, setInputError] = useState<string | null>(null);
  const [result, setResult] = useState<TestResult | null>(null);

  const run = useMutation({
    mutationFn: (req: TestAutomation) => api.automations.test(automationId, req),
    onSuccess: (res) => {
      setResult(res);
      if (!res.dry_run) {
        // A real run is in the history and may have written records.
        void qc.invalidateQueries({ queryKey: keys.automationRuns(automationId) });
        void qc.invalidateQueries({ queryKey: ["records"] });
      }
    },
  });

  const start = async () => {
    let req: TestAutomation;
    try {
      req = buildTestRequest(shape, { real, recordId, body });
    } catch (e) {
      setInputError(errorMessage(e));
      return;
    }
    setInputError(null);
    setResult(null);
    await run.mutateAsync(req).catch(() => undefined);
  };

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[0.8125rem] text-muted">
        A test runs the saved automation once against {shape === "record" ? "a record of the trigger table" : shape === "webhook" ? "a sample webhook body" : "the current time"}. A dry run shows what each action would do and changes nothing.
      </p>
      {shape === "record" && (
        <Field label="Record id (optional)" hint="Leave empty to use the first record of the trigger table." className="max-w-sm">
          {(ctl) => <Input {...ctl} value={recordId} onChange={(e) => setRecordId(e.target.value)} placeholder="rec…" className="font-mono text-xs" />}
        </Field>
      )}
      {shape === "webhook" && (
        <Field label="Sample webhook body (JSON)" hint="What the placeholders {{trigger.body…}} will see.">
          {(ctl) => <Textarea {...ctl} value={body} onChange={(e) => setBody(e.target.value)} rows={4} className="font-mono text-xs" spellCheck={false} />}
        </Field>
      )}
      <Checkbox checked={real} onCheckedChange={setReal} label="Run for real: write records, send emails and make requests" />
      {dirty && <Notice tone="info">Save your changes first: a test runs the saved version.</Notice>}
      {inputError && <Notice tone="error">{inputError}</Notice>}
      {run.isError && <Notice tone="error">{errorMessage(run.error)}</Notice>}
      <div>
        <Button
          variant={real ? "danger" : "primary"}
          disabled={dirty}
          loading={run.isPending}
          onClick={() => {
            if (real) setConfirming(true);
            else void start();
          }}
        >
          {real ? <Play aria-hidden className="size-4" /> : <FlaskConical aria-hidden className="size-4" />}
          {real ? "Run for real" : "Test (dry run)"}
        </Button>
      </div>

      {result && (
        <section aria-label="Test result" className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={result.status} />
            <span className="text-[0.8125rem]">
              {result.dry_run ? "Dry run: nothing was written, sent or requested." : `Real run${result.run_id ? `, recorded as run #${result.run_id}` : ""}.`}
            </span>
          </div>
          {result.error && <Notice tone="error">{result.error}</Notice>}
          <StepLogView log={result.log} empty="No actions ran." />
        </section>
      )}

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Run this automation for real?"
        description="Every action runs once: records are created or changed, emails are sent and HTTP requests are made. The run is added to the history."
        confirmLabel="Run for real"
        destructive
        onConfirm={start}
      />
    </div>
  );
}
