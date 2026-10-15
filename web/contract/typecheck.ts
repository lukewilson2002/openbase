/**
 * Runtime validation of API responses against the generated TypeScript bindings.
 *
 * TypeScript types are erased at runtime, so "this response has the generated type" cannot be
 * checked by the compiler once the data comes off the wire. Instead of duplicating every
 * DTO as a schema, this reads the ts-rs output itself (web/src/api/types/<Name>.ts) and checks
 * a JSON value against it: required keys present, optional keys absent or well-typed, no
 * unknown keys, primitives of the right type, `| null` honored. If a Rust DTO gains, loses or
 * retypes a field, the test fails with the JSON path of the difference.
 *
 * It understands exactly the subset of TypeScript that ts-rs emits for our DTOs (object
 * literals, unions, `Array<T>`, `{ [key in string]: T }`, string/number literals, references).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AdminCreatedUser,
  AdminUser,
  AggregationsResponse,
  Automation,
  AutomationRun,
  AttachmentRef,
  AuditPage,
  BackupInfo,
  BaseSchema,
  BaseSummary,
  Collaborator,
  Comment,
  ConsentOutcome,
  ConsentRequest,
  CreatedInvite,
  CreatedToken,
  DeleteFieldResponse,
  EmailSettings,
  EmailTestResult,
  EventEnvelope,
  Field,
  FormulaCheckResult,
  GrantInfo,
  HistoryEntry,
  ImportResult,
  InstanceStats,
  InviteInfo,
  InvitePreview,
  LinkCandidates,
  LoginResponse,
  Member,
  NotificationsResponse,
  OkResponse,
  PasskeyChallenge,
  PasskeyInfo,
  PasskeysRemoved,
  PublicForm,
  PublicQueryResponse,
  PublicView,
  QueryResponse,
  RecordsResponse,
  ResetLink,
  RestoreResponse,
  RunsPage,
  SearchResponse,
  SessionInfo,
  SetupStatus,
  ShareLink,
  Table,
  TableRecord,
  TestResult,
  TokenInfo,
  TrashListing,
  TwoFactorSetup,
  User,
  View,
  WebhookAccepted,
  WhoAmI,
  WorkspaceSummary,
} from "../src/api/types";

/** Names usable with {@link parse}, mapped to their generated type. */
export interface TypeMap {
  AdminCreatedUser: AdminCreatedUser;
  AdminUser: AdminUser;
  AggregationsResponse: AggregationsResponse;
  Automation: Automation;
  AutomationRun: AutomationRun;
  AttachmentRef: AttachmentRef;
  AuditPage: AuditPage;
  BackupInfo: BackupInfo;
  BaseSchema: BaseSchema;
  BaseSummary: BaseSummary;
  Collaborator: Collaborator;
  Comment: Comment;
  ConsentOutcome: ConsentOutcome;
  ConsentRequest: ConsentRequest;
  CreatedInvite: CreatedInvite;
  CreatedToken: CreatedToken;
  DeleteFieldResponse: DeleteFieldResponse;
  EmailSettings: EmailSettings;
  EmailTestResult: EmailTestResult;
  EventEnvelope: EventEnvelope;
  Field: Field;
  FormulaCheckResult: FormulaCheckResult;
  GrantInfo: GrantInfo;
  HistoryEntry: HistoryEntry;
  ImportResult: ImportResult;
  InstanceStats: InstanceStats;
  InviteInfo: InviteInfo;
  InvitePreview: InvitePreview;
  LinkCandidates: LinkCandidates;
  LoginResponse: LoginResponse;
  Member: Member;
  NotificationsResponse: NotificationsResponse;
  OkResponse: OkResponse;
  PasskeyChallenge: PasskeyChallenge;
  PasskeyInfo: PasskeyInfo;
  PasskeysRemoved: PasskeysRemoved;
  PublicForm: PublicForm;
  PublicQueryResponse: PublicQueryResponse;
  PublicView: PublicView;
  QueryResponse: QueryResponse;
  RecordsResponse: RecordsResponse;
  ResetLink: ResetLink;
  RestoreResponse: RestoreResponse;
  RunsPage: RunsPage;
  SearchResponse: SearchResponse;
  SessionInfo: SessionInfo;
  SetupStatus: SetupStatus;
  ShareLink: ShareLink;
  Table: Table;
  TableRecord: TableRecord;
  TestResult: TestResult;
  TokenInfo: TokenInfo;
  TrashListing: TrashListing;
  TwoFactorSetup: TwoFactorSetup;
  User: User;
  View: View;
  WebhookAccepted: WebhookAccepted;
  WhoAmI: WhoAmI;
  WorkspaceSummary: WorkspaceSummary;
}

const typesDir = join(dirname(fileURLToPath(import.meta.url)), "../src/api/types");

// ---- tokenizer -------------------------------------------------------------------------------

type Tok = { t: "str" | "num" | "id" | "p"; v: string };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) i++;
    else if (src.startsWith("/*", i)) i = src.indexOf("*/", i + 2) + 2;
    else if (src.startsWith("//", i)) i = src.indexOf("\n", i) < 0 ? src.length : src.indexOf("\n", i);
    else if (c === '"') {
      let j = i + 1;
      let v = "";
      while (src[j] !== '"') {
        if (src[j] === "\\") j++;
        v += src[j];
        j++;
      }
      out.push({ t: "str", v });
      i = j + 1;
    } else if (/[0-9-]/.test(c) && /[0-9]/.test(src[i + (c === "-" ? 1 : 0)] ?? "")) {
      const m = /^-?\d+(\.\d+)?/.exec(src.slice(i))!;
      out.push({ t: "num", v: m[0] });
      i += m[0].length;
    } else if (/[A-Za-z_$]/.test(c)) {
      const m = /^[A-Za-z0-9_$]+/.exec(src.slice(i))!;
      out.push({ t: "id", v: m[0] });
      i += m[0].length;
    } else {
      out.push({ t: "p", v: c });
      i++;
    }
  }
  return out;
}

// ---- parser ----------------------------------------------------------------------------------

type Ty =
  | { k: "prim"; n: string }
  | { k: "lit"; v: string | number }
  | { k: "ref"; n: string; args: Ty[] }
  | { k: "obj"; fields: { name: string; optional: boolean; type: Ty }[]; index?: Ty }
  | { k: "arr"; el: Ty }
  | { k: "tuple"; ts: Ty[] }
  | { k: "union"; ts: Ty[] }
  | { k: "inter"; ts: Ty[] };

const PRIMS = new Set(["string", "number", "boolean", "null", "undefined", "unknown", "never", "any"]);

class Parser {
  private pos = 0;
  constructor(private readonly toks: Tok[]) {}

  private peek(): Tok | undefined {
    return this.toks[this.pos];
  }
  private is(v: string): boolean {
    const t = this.peek();
    return t?.t === "p" && t.v === v;
  }
  private eat(v: string): void {
    if (!this.is(v)) throw new Error(`type parser: expected "${v}" but found ${JSON.stringify(this.peek())} at token ${this.pos}`);
    this.pos++;
  }

  /** Skip tokens up to and including `export type <name> =`; returns the name. */
  seekExport(): string {
    for (; this.pos < this.toks.length - 3; this.pos++) {
      const [a, b, c, d] = [this.toks[this.pos]!, this.toks[this.pos + 1]!, this.toks[this.pos + 2]!, this.toks[this.pos + 3]!];
      if (a.v === "export" && b.v === "type" && c.t === "id" && d.v === "=") {
        this.pos += 4;
        return c.v;
      }
    }
    throw new Error("type parser: no `export type X =` found");
  }

  type(): Ty {
    if (this.is("|")) this.pos++; // leading bar of a multi-line union
    const parts = [this.inter()];
    while (this.is("|")) {
      this.pos++;
      parts.push(this.inter());
    }
    return parts.length === 1 ? parts[0]! : { k: "union", ts: parts };
  }

  private inter(): Ty {
    const parts = [this.postfix()];
    while (this.is("&")) {
      this.pos++;
      parts.push(this.postfix());
    }
    return parts.length === 1 ? parts[0]! : { k: "inter", ts: parts };
  }

  private postfix(): Ty {
    let t = this.primary();
    while (this.is("[") && this.toks[this.pos + 1]?.v === "]") {
      this.pos += 2;
      t = { k: "arr", el: t };
    }
    return t;
  }

  private primary(): Ty {
    const t = this.peek();
    if (!t) throw new Error("type parser: unexpected end");
    if (t.t === "str") {
      this.pos++;
      return { k: "lit", v: t.v };
    }
    if (t.t === "num") {
      this.pos++;
      return { k: "lit", v: Number(t.v) };
    }
    if (t.t === "id") {
      this.pos++;
      if (PRIMS.has(t.v)) return { k: "prim", n: t.v };
      const args: Ty[] = [];
      if (this.is("<")) {
        this.pos++;
        args.push(this.type());
        while (this.is(",")) {
          this.pos++;
          args.push(this.type());
        }
        this.eat(">");
      }
      return t.v === "Array" ? { k: "arr", el: args[0] ?? { k: "prim", n: "unknown" } } : { k: "ref", n: t.v, args };
    }
    if (this.is("(")) {
      this.pos++;
      const inner = this.type();
      this.eat(")");
      return inner;
    }
    if (this.is("[")) {
      this.pos++;
      const ts: Ty[] = [];
      while (!this.is("]")) {
        ts.push(this.type());
        if (this.is(",")) this.pos++;
      }
      this.eat("]");
      return { k: "tuple", ts };
    }
    if (this.is("{")) return this.object();
    throw new Error(`type parser: unexpected token ${JSON.stringify(t)}`);
  }

  private object(): Ty {
    this.eat("{");
    const fields: { name: string; optional: boolean; type: Ty }[] = [];
    let index: Ty | undefined;
    while (!this.is("}")) {
      if (this.is("[")) {
        // { [key in string]: T }
        this.pos++;
        this.pos += 3; // key in string
        this.eat("]");
        this.eat(":");
        index = this.type();
      } else {
        const k = this.peek()!;
        this.pos++;
        const optional = this.is("?");
        if (optional) this.pos++;
        this.eat(":");
        fields.push({ name: k.v, optional, type: this.type() });
      }
      if (this.is(",") || this.is(";")) this.pos++;
    }
    this.eat("}");
    return { k: "obj", fields, ...(index ? { index } : {}) };
  }
}

const cache = new Map<string, Ty>();

function load(name: string): Ty {
  let ty = cache.get(name);
  if (!ty) {
    const file = join(typesDir, `${name}.ts`);
    const p = new Parser(tokenize(readFileSync(file, "utf8")));
    p.seekExport();
    ty = p.type();
    cache.set(name, ty);
  }
  return ty;
}

/** Parse the generated `<name>.ts` (exposed for the validator's own tests). */
export function loadType(name: string): unknown {
  return load(name);
}

// ---- validator -------------------------------------------------------------------------------

function describe(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

/** Every object key a type mentions (through references, unions and intersections). */
function knownKeys(ty: Ty, seen = new Set<string>()): Set<string> {
  switch (ty.k) {
    case "obj":
      return new Set(ty.fields.map((f) => f.name));
    case "union":
    case "inter":
      return new Set(ty.ts.flatMap((t) => [...knownKeys(t, seen)]));
    case "ref": {
      if (ty.n === "JsonValue" || ty.n === "Record" || seen.has(ty.n)) return new Set();
      seen.add(ty.n);
      return knownKeys(load(ty.n), seen);
    }
    default:
      return new Set();
  }
}

/** Returns a list of problems (empty when `value` conforms to `ty`). */
function check(ty: Ty, value: unknown, path: string, extra?: ReadonlySet<string>): string[] {
  switch (ty.k) {
    case "prim":
      switch (ty.n) {
        case "string":
        case "boolean":
          return typeof value === ty.n ? [] : [`${path}: expected ${ty.n}, got ${describe(value)}`];
        case "number":
          return typeof value === "number" && Number.isFinite(value) ? [] : [`${path}: expected number, got ${describe(value)}`];
        case "null":
          return value === null ? [] : [`${path}: expected null, got ${describe(value)}`];
        case "undefined":
          return value === undefined ? [] : [`${path}: expected undefined, got ${describe(value)}`];
        default:
          return ty.n === "never" ? [`${path}: no value is allowed here`] : [];
      }
    case "lit":
      return value === ty.v ? [] : [`${path}: expected ${JSON.stringify(ty.v)}, got ${JSON.stringify(value)}`];
    case "arr": {
      if (!Array.isArray(value)) return [`${path}: expected array, got ${describe(value)}`];
      return value.flatMap((el, i) => check(ty.el, el, `${path}[${i}]`));
    }
    case "tuple": {
      if (!Array.isArray(value) || value.length !== ty.ts.length) return [`${path}: expected a ${ty.ts.length}-tuple`];
      return ty.ts.flatMap((t, i) => check(t, value[i], `${path}[${i}]`));
    }
    case "union": {
      const attempts = ty.ts.map((t) => check(t, value, path, extra));
      if (attempts.some((a) => a.length === 0)) return [];
      // Report the closest alternative (fewest problems) to keep the message readable.
      const best = attempts.reduce((a, b) => (b.length < a.length ? b : a));
      return [`${path}: matches no alternative of the union; closest: ${best.join("; ")}`];
    }
    case "inter": {
      // `A & (B | C)`: a key that any part knows is not "unknown" to the others.
      const all = ty.ts.map((t) => knownKeys(t));
      return ty.ts.flatMap((t, i) => {
        const siblings = new Set(extra);
        all.forEach((keys, j) => j !== i && keys.forEach((k) => siblings.add(k)));
        return check(t, value, path, siblings);
      });
    }
    case "ref": {
      if (ty.n === "JsonValue") return [];
      if (ty.n === "Record") return check({ k: "obj", fields: [], index: ty.args[1] ?? { k: "prim", n: "unknown" } }, value, path, extra);
      return check(load(ty.n), value, path, extra);
    }
    case "obj": {
      if (value === null || typeof value !== "object" || Array.isArray(value)) return [`${path}: expected object, got ${describe(value)}`];
      const rec = value as Record<string, unknown>;
      const problems: string[] = [];
      const known = new Set([...ty.fields.map((f) => f.name), ...(extra ?? [])]);
      for (const f of ty.fields) {
        const v = rec[f.name];
        if (v === undefined) {
          if (!f.optional) problems.push(`${path}.${f.name}: required field is missing`);
        } else {
          problems.push(...check(f.type, v, `${path}.${f.name}`));
        }
      }
      for (const [k, v] of Object.entries(rec)) {
        if (known.has(k)) continue;
        if (ty.index) problems.push(...check(ty.index, v, `${path}.${k}`));
        else problems.push(`${path}.${k}: unknown field (not in the generated type)`);
      }
      return problems;
    }
  }
}

/** Check `value` against the generated binding `name`; throws with every difference found. */
export function parse<K extends keyof TypeMap>(name: K, value: unknown): TypeMap[K] {
  const problems = check({ k: "ref", n: name, args: [] }, value, name);
  if (problems.length > 0) {
    throw new Error(`Response does not match generated type ${name}:\n  ${problems.join("\n  ")}\nvalue: ${JSON.stringify(value)}`);
  }
  return value as TypeMap[K];
}

/** Like {@link parse} for arrays of `name`. */
export function parseList<K extends keyof TypeMap>(name: K, value: unknown): TypeMap[K][] {
  if (!Array.isArray(value)) throw new Error(`Expected a JSON array of ${name}, got ${describe(value)}`);
  return value.map((v, i) => {
    try {
      return parse(name, v);
    } catch (e) {
      throw new Error(`item ${i}: ${(e as Error).message}`);
    }
  });
}

/** For the validator's own tests: check an arbitrary generated type by name. */
export function problemsFor(name: string, value: unknown): string[] {
  return check({ k: "ref", n: name, args: [] }, value, name);
}
