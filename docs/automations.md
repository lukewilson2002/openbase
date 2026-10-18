# Automations

An automation is one **trigger** and an ordered list of up to 25 **actions**.
Only creators (and owners) of a project can create, edit, test and delete them;
editors and above can read the run history. Everything below is enforced when
an automation is saved, so mistakes show up as a `400` with a precise message
instead of as failed runs later.

## Triggers

| type | fires when |
|---|---|
| `record_created` `{table_id}` | a record is created (UI, API, import or form; never by an automation) |
| `record_updated` `{table_id, field_ids}` | an editable field changed; `field_ids` empty = any, otherwise at least one of them |
| `record_matches` `{table_id, filter}` | a record starts matching `filter`: created matching, or an update turned "not matching" into "matching" |
| `form_submitted` `{view_id}` | the form view is submitted (the new record also fires `record_created`) |
| `schedule` `{cron, timezone}` | cron time in an IANA zone (5 fields, or 6 with seconds); at most every 5 minutes |
| `webhook` `{}` | `POST /api/hooks/{token}` with a JSON body of at most 1 MB |

The webhook token is returned once, in the response that creates the
automation (or that rotates the token with `rotate_webhook_token: true`); only
its SHA-256 hash is stored. Unknown tokens and disabled automations both
answer `404`. Calls are limited to 60 per minute per automation, and 30 calls
per minute with unknown tokens per client address.

## Actions

`create_record`, `update_record`, `send_email` (only when SMTP is configured),
`http_request` (GET, POST, PUT, PATCH, DELETE) and `notify`. Each may carry a
`condition` (a view filter) evaluated against the record that fired the
trigger; when it does not match the action is skipped.

Values of `create_record` / `update_record` are keyed by field id or field
name (names are replaced by ids when saved) and written like Airtable's
`typecast`: `"12"` for a number field, a choice name for a select (a name that
does not exist yet becomes a new choice).

These two actions go through the same record write engine as the API
(`engine::write`, source `automation`): values are validated the same way,
link cells keep both sides in sync, computed fields are recomputed, record
history is written (as the automation's creator) and the usual events are
published after the write commits, so grids that are on screen update and cached view
queries are invalidated. A record trigger only fires for writes that do not
come from an automation. The record trigger's `record_matches` check compares
the record's data before and after the write, so an edit that merely changes a
value inside the filter, or a recompute that makes a computed field match,
is judged exactly.

## Templates

Strings in actions may contain `{{...}}` placeholders that are replaced by
plain text before the action runs. There is no code execution and substituted
text is never interpreted again.

| placeholder | value |
|---|---|
| `{{trigger.type}}`, `{{trigger.time}}` | trigger kind; event time (RFC 3339) |
| `{{trigger.record.id}}`, `{{trigger.record.table_id}}` | the record that fired the trigger |
| `{{trigger.record.fields.<field>}}` | a field's display text (id or name; names match case-insensitively) |
| `{{trigger.body.a.b.0}}` | webhook body path (objects by key, arrays by index) |
| `{{steps.<n>.<key>}}` | output of the n-th action (1-based) of the same run |

Step outputs: `create_record` / `update_record` give `record_id` and
`table_id`; `http_request` gives `status`, `body`, `json` (when the body is
JSON) and `truncated`; `send_email` gives `sent_to`; `notify` gives `notified`.
A missing value renders as an empty string. A value that is exactly one
`{{trigger.body...}}` or `{{steps...}}` placeholder keeps its JSON type in
record values (numbers stay numbers, arrays stay arrays).

Substituted text is escaped for where it lands: percent-encoded in URLs,
JSON-string-escaped in JSON request bodies (explicit JSON `Content-Type`, or a
body starting with `{` or `[`), form-encoded for
`application/x-www-form-urlencoded`.

## Runs

Triggers only insert a `queued` row into `automation_runs` (inside the
caller's transaction, so a rolled-back write queues nothing). The runner
claims runs, executes the actions one after another outside the database lock
and writes a step log after every step.

* **Retries.** Network errors, timeouts, HTTP 5xx / 408 / 429 and SMTP trouble
  are transient: the run is re-queued (5 s, then 30 s) and resumes at the
  failed action; finished actions are not repeated. Three attempts in total.
  Everything else (validation errors, refused URLs, other 4xx) fails the run.
* **Crashes.** Runs left `running` by a crash are re-queued once at startup
  (resuming after their last logged step); a second interruption fails them.
* **No loops.** Records written by an automation do not fire record triggers.
* **Disabled automations never run**; turning one off cancels its queued runs.
* **Retention.** Finished runs older than 30 days are deleted. A finished
  webhook run keeps at most the first 16,384 characters of its request body
  (`trigger_data.body` becomes `{"truncated": true, "preview": "..."}`). At most 5,000
  runs (200 for webhooks) wait in the queue per automation; further events are
  dropped with a log warning.

## HTTP requests and SSRF

Only `http` / `https` URLs without credentials. The host is resolved by the
server and every address must be public: loopback, RFC 1918, link-local
(including 169.254.169.254), CGNAT, multicast, unspecified, reserved and
unique-local IPv6 ranges, and IPv6 forms embedding an IPv4 address are
refused. The connection is pinned to the vetted address (DNS rebinding cannot
swap it), redirects are not followed, the system proxy is ignored, requests
time out after 10 s and only the first 256 KB of a response is kept. The user
agent is `OpenBase-Automations`. `OPENBASE_ALLOW_PRIVATE_WEBHOOKS=true`
switches the address check off for installations that need to call their LAN.

## API

```
GET|POST   /api/bases/{id}/automations
GET|PATCH|DELETE /api/automations/{id}
POST       /api/automations/{id}/test      {record_id?, body?, dry_run=true}
GET        /api/automations/{id}/runs      ?limit=50&before=<run id>
POST       /api/hooks/{token}              public
```

`test` renders templates and evaluates conditions but sends and writes
nothing unless `dry_run` is `false`; it returns the step log. Real test runs
are recorded in the run history (`trigger_data.test = true`).

## In the web app

Creators open **Automations** in the project's sidebar, below its tables (`/base/<id>/automations`). Each automation has an editor
(trigger, actions, optional per-action conditions, an "Insert data" menu for the `{{...}}` placeholders), a **Test** panel (a dry run
by default; running for real asks for confirmation) and a **Runs** tab with the step log of every run. A webhook's URL is shown once,
when the automation is created or its token is rotated.
