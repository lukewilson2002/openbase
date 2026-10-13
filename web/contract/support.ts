/**
 * Shared helpers of the data-plane contract tests (workspaces, schema, records, collaboration,
 * automations, events). They run against the *seeded* server of globalSetup.ts, whose first
 * administrator already exists, so every test file can create its own workspace and users and
 * the files do not depend on each other.
 */
import { randomBytes } from "node:crypto";
import { expect, inject } from "vitest";
import { ApiError, setApiBase } from "../src/api/client";
import { api } from "../src/api/endpoints";
import type { BaseSchema, Field, Table, User } from "../src/api/types";
import { as, createCookieJar, type CookieJar } from "./cookieJar";
import { parse } from "./typecheck";

export const env = inject("contract");
export const seeded = env.seeded;

export const rand = () => randomBytes(6).toString("hex");

let nextIp = 10;

/** One browser profile: its own cookie jar and client address (rate-limit bucket). */
export class Profile {
  readonly jar: CookieJar;
  user: User | undefined;

  /** `X-Client-Id` of this profile's "browser tab" (a stable id so SSE echoes can be attributed). */
  readonly clientId: string;

  constructor(label = "profile") {
    nextIp++;
    this.clientId = `${label}-${rand()}`;
    this.jar = createCookieJar(`10.20.${Math.floor(nextIp / 250)}.${nextIp % 250}`, this.clientId);
  }

  /** Run `fn` (which calls the real API client) as this profile. */
  run<T>(fn: () => Promise<T>): Promise<T> {
    return as(this.jar, async () => {
      setApiBase(seeded.baseUrl);
      return fn();
    });
  }

  get status(): number {
    return this.jar.lastStatus;
  }

  get id(): string {
    if (!this.user) throw new Error("profile is not signed in");
    return this.user.id;
  }

  async login(email: string, password: string): Promise<this> {
    const res = parse("LoginResponse", await this.run(() => api.auth.login({ email, password })));
    if (!res.user) throw new Error("login did not return a user");
    this.user = res.user;
    return this;
  }
}

/** The seeded server's administrator. */
export async function adminProfile(): Promise<Profile> {
  return new Profile("admin").login(seeded.adminEmail, seeded.adminPassword);
}

/** A new regular user (created by the administrator), signed in. */
export async function newUser(admin: Profile, label = "user"): Promise<Profile> {
  const email = `${label}-${rand()}@example.test`;
  const password = `pw-${rand()}-${rand()}`;
  const created = parse("AdminCreatedUser", await admin.run(() => api.admin.createUser({ email, name: `${label} ${rand().slice(0, 4)}`, password })));
  expect(created.user.email).toBe(email);
  return new Profile(label).login(email, password);
}

/** Give `user` the `role` on a base by invitation (the only way to add someone to a base). */
export async function joinBase(owner: Profile, baseId: string, user: Profile, role: string): Promise<void> {
  const invite = parse("CreatedInvite", await owner.run(() => api.invites.createForBase(baseId, { role, email: null })));
  const token = invite.url.split("/invite/")[1]!;
  parse("InviteInfo", await user.run(() => api.invites.accept(token)));
}

/** Await a call that must fail with an ApiError and return it. */
export async function failure(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ApiError);
    return e as ApiError;
  }
  throw new Error("expected the request to fail, but it succeeded");
}

export function expectError(e: ApiError, status: number, code: string): void {
  expect({ status: e.status, code: e.code }).toEqual({ status, code });
  expect(e.message.length).toBeGreaterThan(0);
  expect(e.message).not.toMatch(/^(Bad Request|Unprocessable Entity|Forbidden|Unauthorized|Not Found)$/);
}

/** A workspace with an owner-created base, as the tests usually need. */
export interface World {
  owner: Profile;
  workspaceId: string;
  base: BaseSchema;
  baseId: string;
}

export async function createWorld(name = "World"): Promise<World> {
  const owner = await adminProfile();
  const ws = parse("WorkspaceSummary", await owner.run(() => api.workspaces.create(`${name} ${rand()}`)));
  const base = parse("BaseSchema", await owner.run(() => api.bases.create(ws.id, { name: `${name} base` })));
  return { owner, workspaceId: ws.id, base, baseId: base.id };
}

export async function refreshBase(p: Profile, baseId: string): Promise<BaseSchema> {
  return parse("BaseSchema", await p.run(() => api.bases.get(baseId)));
}

export async function tableOf(p: Profile, baseId: string, tableId: string): Promise<Table> {
  const base = await refreshBase(p, baseId);
  const t = base.tables.find((x) => x.id === tableId);
  if (!t) throw new Error(`table ${tableId} not in base`);
  return t;
}

export function fieldNamed(table: Table, name: string): Field {
  const f = table.fields.find((x) => x.name === name);
  if (!f) throw new Error(`no field named ${name}; have ${table.fields.map((x) => x.name).join(", ")}`);
  return f;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
