/** Webhook trigger: the private URL (shown once, when created or rotated) and a rotate button. */
import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { Notice } from "@/components/layouts";
import { CopyField } from "@/components/CopyField";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { webhookUrl } from "./model";

export interface WebhookPanelProps {
  /** The automation is saved with a webhook trigger (so it has a token). */
  saved: boolean;
  /** The token from the response that created or rotated it; only held until the page is left. */
  token: string | null;
  enabled: boolean;
  onRotate: () => Promise<unknown>;
  /** Rotating needs the saved automation and no pending edits being lost; the editor says when it cannot. */
  canRotate: boolean;
}

export function WebhookPanel({ saved, token, enabled, onRotate, canRotate }: WebhookPanelProps) {
  const [confirming, setConfirming] = useState(false);
  const origin = window.location.origin;
  return (
    <div className="flex flex-col gap-3">
      {token ? (
        <>
          <Notice tone="warning">
            <strong>Copy this URL now.</strong> It contains the secret token, which is shown only once; the server keeps just a hash of it. Anyone with the URL can trigger this automation.
          </Notice>
          <CopyField label="Webhook URL" value={webhookUrl(token, origin)} />
          <p className="text-xs text-muted">
            Send a JSON <code>POST</code> (up to 1 MB). Use the body in actions with <code>{"{{trigger.body.some.path}}"}</code>.
          </p>
          <pre className="overflow-x-auto rounded-md bg-subtle p-2 text-xs">{`curl -X POST ${webhookUrl(token, origin)} \\\n  -H 'Content-Type: application/json' \\\n  -d '{"hello": "world"}'`}</pre>
        </>
      ) : saved ? (
        <p className="text-[0.8125rem] text-muted">
          The webhook URL looks like <code>{origin}/api/hooks/&lt;token&gt;</code>. The token was shown once when it was created and cannot be shown again. If you lost it, rotate the token to get a new URL.
        </p>
      ) : (
        <p className="text-[0.8125rem] text-muted">Save the automation to get its private webhook URL.</p>
      )}
      {!enabled && saved && <p className="text-xs text-muted">The automation is off, so calls to its webhook answer 404 until you turn it on.</p>}
      {saved && (
        <div>
          <Button size="sm" disabled={!canRotate} onClick={() => setConfirming(true)}>
            <RefreshCw aria-hidden className="size-3.5" /> Rotate token
          </Button>
          {!canRotate && <p className="mt-1 text-xs text-muted">Save or discard your changes first.</p>}
        </div>
      )}
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Rotate the webhook token?"
        description="You get a new URL, shown once. The old URL stops working immediately, so update whatever calls it."
        confirmLabel="Rotate token"
        destructive
        onConfirm={onRotate}
      />
    </div>
  );
}
