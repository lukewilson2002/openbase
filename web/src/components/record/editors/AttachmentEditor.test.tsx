import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AttachmentRef } from "@/api/types";
import { ALL_FIELDS } from "@/test/fields";
import { FilePreview } from "../FilePreview";
import { AttachmentEditor, moveFile } from "./AttachmentEditor";
import { EditorEnvProvider, type EditorEnv } from "./env";

const env: EditorEnv = { baseId: "app1", tableId: "tbl1", collaborators: [], timeZone: "UTC", canCreateOptions: false, format: { timeZone: "UTC", userName: () => undefined }, currentUserId: null };
const field = { ...ALL_FIELDS.attachment, id: "fld_files", name: "Files" };
const file = (id: string, filename: string, mime: string): AttachmentRef => ({ id, filename, mime, size: 1024 });
const pdf = file("att1", "Pricing.pdf", "application/pdf");
const photo = file("att2", "photo.png", "image/png");
const sheet = file("att3", "Budget.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");

describe("moveFile", () => {
  it("moves a file to where another one is, keeping the rest in order", () => {
    expect(moveFile([pdf, photo, sheet], "att3", "att1")!.map((f) => f.id)).toEqual(["att3", "att1", "att2"]);
    expect(moveFile([pdf, photo, sheet], "att1", "att2")!.map((f) => f.id)).toEqual(["att2", "att1", "att3"]);
  });

  it("is null when nothing moves", () => {
    expect(moveFile([pdf, photo], "att1", "att1")).toBeNull();
    expect(moveFile([pdf, photo], "att1", null)).toBeNull();
    expect(moveFile([pdf, photo], "gone", "att1")).toBeNull();
  });
});

describe("FilePreview", () => {
  it("shows a PDF's first page, cropped from the top, and the type's tile when it has none", () => {
    const { container } = render(<FilePreview file={pdf} src="/api/attachments/att1/thumb" />);
    const img = container.querySelector("img")!;
    expect(img.getAttribute("src")).toBe("/api/attachments/att1/thumb");
    expect(img.className).toContain("object-top");
    fireEvent.error(img);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe("PDF");
  });

  it("marks a video's first frame with a play badge, and never asks for a preview of other files", () => {
    const { container, rerender } = render(<FilePreview file={file("att4", "demo.mp4", "video/mp4")} src="/api/attachments/att4/thumb" />);
    expect(container.querySelector("img")).not.toBeNull();
    expect(container.querySelector("svg")).not.toBeNull();
    rerender(<FilePreview file={sheet} src="/api/attachments/att3/thumb" />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe("XLSX");
  });
});

describe("AttachmentEditor", () => {
  it("shows each file as its preview, with a handle to reorder it when there is more than one", async () => {
    render(
      <EditorEnvProvider value={env}>
        <AttachmentEditor field={field} value={[pdf, photo]} variant="form" onChange={vi.fn()} onCommit={vi.fn()} onCancel={vi.fn()} />
      </EditorEnvProvider>,
    );
    await userEvent.click(screen.getByRole("button", { name: /Files/ }));
    const list = await screen.findByRole("list", { name: "Files in Files" });
    expect(list.querySelectorAll("img")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Drag Pricing.pdf to reorder" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Drag photo.png to reorder" })).toBeInTheDocument();
  });

  it("has no handle for a single file", async () => {
    render(
      <EditorEnvProvider value={env}>
        <AttachmentEditor field={field} value={[pdf]} variant="form" onChange={vi.fn()} onCommit={vi.fn()} onCancel={vi.fn()} />
      </EditorEnvProvider>,
    );
    await userEvent.click(screen.getByRole("button", { name: /Files/ }));
    await screen.findByRole("list", { name: "Files in Files" });
    expect(screen.queryByRole("button", { name: /to reorder/ })).toBeNull();
  });
});
