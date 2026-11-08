import { describe, expect, it } from "vitest";
import type { BaseSummary } from "@/api/types";
import { foldersOf, topLevelOf } from "./topLevel";

const base = (id: string, over: Partial<BaseSummary> = {}): BaseSummary => ({ id, workspace_id: "wsp1", name: id, color: "blue", role: "owner", is_top_level: false, people: [], tables: [], ...over });

describe("topLevelOf and foldersOf", () => {
  const top = base("app1", { is_top_level: true });
  const crm = base("app2");
  const hiring = base("app3");

  it("splits the projects a person can open into the top level and the folders, in the workspace's order", () => {
    const ws = { bases: [crm, top, hiring], root_base_id: "app1" };
    expect(topLevelOf(ws)).toBe(top);
    expect(foldersOf(ws)).toEqual([crm, hiring]);
  });

  it("shows no top level to someone limited to some folders (NAV-10)", () => {
    // The server lists only openable projects and drops the pointer when the top level is not among them.
    const ws = { bases: [crm, hiring], root_base_id: null };
    expect(topLevelOf(ws)).toBeUndefined();
    expect(foldersOf(ws)).toEqual([crm, hiring]);
  });

  it("follows the pointer, not the flag, when both are there", () => {
    const ws = { bases: [base("app1", { is_top_level: true }), base("app2")], root_base_id: "app2" };
    expect(topLevelOf(ws)?.id).toBe("app2");
    // A project still flagged as the top level by an older cache is not a folder either.
    expect(foldersOf(ws)).toEqual([]);
  });

  it("falls back to the flag when the response has no pointer", () => {
    expect(topLevelOf({ bases: [crm, top] })?.id).toBe("app1");
    expect(topLevelOf({ bases: [crm] })).toBeUndefined();
  });

  it("has no folders in a workspace with only its top level", () => {
    expect(foldersOf({ bases: [top], root_base_id: "app1" })).toEqual([]);
    expect(foldersOf({ bases: [], root_base_id: null })).toEqual([]);
  });
});
