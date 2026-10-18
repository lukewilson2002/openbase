import { describe, expect, it } from "vitest";
import type { Notification } from "@/api/types";
import { describeNotification, notificationHref, notificationPlace } from "./describe";

const n = (kind: string, payload: unknown): Notification => ({ id: "ntf1", kind, payload: payload as Notification["payload"], read_at: null, created_at: 1 });

describe("describeNotification", () => {
  it("describes a mention with a link that opens the record", () => {
    const v = describeNotification(n("mention", { base_id: "app1", table_id: "tbl1", record_id: "rec1", record_name: "Launch plan", snippet: "can you check this?", author_name: "Grace", author_id: "usr2", comment_id: "cmt1" }));
    expect(v).toEqual({ kind: "mention", title: "Grace mentioned you in Launch plan", detail: "can you check this?", href: "/base/app1/tbl1?record=rec1" });
  });

  it("describes an assignment", () => {
    const v = describeNotification(n("assigned", { base_id: "app1", base_name: "Roadmap", table_id: "tbl1", table_name: "Tasks", record_id: "rec1", record_name: "Fix login", field_id: "fld1", field_name: "Owner", assigned_by: "usr2" }));
    expect(v.title).toBe("You were assigned to Fix login");
    expect(v.detail).toBe("In Owner");
    expect(v.href).toBe("/base/app1/tbl1?record=rec1");
  });

  it("names the base and table with the icons they had", () => {
    const place = notificationPlace(n("mention", { base_name: "Roadmap", base_icon: "store", table_name: "Tasks", table_icon: null }));
    expect(place).toEqual({ base: { name: "Roadmap", icon: "store" }, table: { name: "Tasks", icon: null } });
    expect(notificationPlace(n("mention", { table_name: "Tasks", table_icon: "truck" }))).toEqual({ base: null, table: { name: "Tasks", icon: "truck" } });
    expect(notificationPlace(n("mention", { record_name: "x" }))).toBeNull();
    expect(notificationPlace(n("assigned", null))).toBeNull();
  });

  it("tolerates missing keys and odd payloads", () => {
    expect(describeNotification(n("mention", {}))).toMatchObject({ title: "Someone mentioned you", detail: null, href: null });
    expect(describeNotification(n("assigned", null))).toMatchObject({ title: "You were assigned to a record", href: null });
    expect(describeNotification(n("mention", "weird"))).toMatchObject({ title: "Someone mentioned you" });
    expect(describeNotification(n("mention", { base_id: 5, record_name: ["x"] }))).toMatchObject({ title: "Someone mentioned you", href: null });
  });

  it("links to the base when only the base is known", () => {
    expect(describeNotification(n("mention", { base_id: "app 1" })).href).toBe("/base/app%201");
    expect(notificationHref({ base_id: "a", table_id: "t", record_id: "r" })).toBe("/base/a/t?record=r");
    // A record without its table cannot be opened, so only the base is linked.
    expect(notificationHref({ base_id: "a", record_id: "r" })).toBe("/base/a");
    expect(notificationHref({})).toBeNull();
  });

  it("describes invites (token link wins) and automations", () => {
    expect(describeNotification(n("invite", { actor_name: "Ada", base_name: "Roadmap", token: "tok" }))).toMatchObject({ title: "Ada invited you to Roadmap", href: "/invite/tok" });
    expect(describeNotification(n("invite", { base_id: "app1" }))).toMatchObject({ title: "Someone invited you to a project", href: "/base/app1" });
    expect(describeNotification(n("automation", { automation_name: "Weekly digest", message: "Sent 4 emails", base_id: "app1" }))).toMatchObject({
      kind: "automation",
      title: 'Automation "Weekly digest"',
      detail: "Sent 4 emails",
      href: "/base/app1",
    });
    expect(describeNotification(n("automation", {})).title).toBe("Automation notification");
  });

  it("falls back for kinds it does not know", () => {
    expect(describeNotification(n("something_new", { message: "Hello" }))).toMatchObject({ kind: "other", title: "Hello" });
    expect(describeNotification(n("something_new", {})).title).toBe("New notification");
  });
});
