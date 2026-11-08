/**
 * A bare JSON-RPC client for `POST /mcp`, shared by the contract tests that drive the MCP tools with
 * a personal access token. The OAuth tests use the official SDK client instead.
 */
import { expect } from "vitest";
import { seeded } from "./support";

export interface Rpc {
  status: number;
  headers: Headers;
  body: any;
}

let nextId = 1;

export async function rpc(token: string | null, method: string, params: Record<string, unknown> = {}, extraHeaders: Record<string, string> = {}): Promise<Rpc> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": "2025-06-18",
    ...extraHeaders,
  };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${seeded.baseUrl}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
}

/** A tool call that must succeed; returns its structured result. */
export async function call(token: string, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const res = await rpc(token, "tools/call", { name, arguments: args });
  expect(res.status).toBe(200);
  expect(res.body.error).toBeUndefined();
  const result = res.body.result;
  expect(result.isError, `${name}: ${result.content?.[0]?.text}`).toBe(false);
  return result.structuredContent;
}

/** A tool call that must come back as a tool error; returns the error text the agent reads. */
export async function fails(token: string, name: string, args: Record<string, unknown> = {}): Promise<string> {
  const res = await rpc(token, "tools/call", { name, arguments: args });
  expect(res.status).toBe(200);
  expect(res.body.error, `${name}: ${JSON.stringify(res.body.error)}`).toBeUndefined();
  expect(res.body.result.isError, `${name} should have failed: ${JSON.stringify(res.body.result.structuredContent)}`).toBe(true);
  return res.body.result.content[0].text as string;
}

/** The names of the tools a token is offered. */
export async function toolNames(token: string): Promise<string[]> {
  const res = await rpc(token, "tools/list");
  expect(res.status).toBe(200);
  return res.body.result.tools.map((t: { name: string }) => t.name);
}
