/**
 * Adding and removing a link in a rich text editor: the toolbar's popover and the page's selection bubble
 * (Ctrl+K) accept the same addresses and write the same marks.
 */
import type { Editor } from "@tiptap/core";

export type LinkAddress = { ok: true; href: string } | { ok: false; error: string };

/** "example.com" is an address, not a relative link; anything else must carry a scheme we allow. */
export function linkAddress(input: string): LinkAddress {
  let url = input.trim();
  if (!/^[a-z][a-z0-9+.-]*:/i.test(url) && !url.startsWith("/") && !url.startsWith("#")) url = `https://${url}`;
  if (!/^(?:https?:|mailto:|tel:|\/(?!\/)|#)/i.test(url)) return { ok: false, error: "Use a web address, an email address (mailto:) or a phone number (tel:)." };
  return { ok: true, href: url };
}

/** The address of the link the selection is in ("" when it is in none). */
export function currentLink(editor: Editor): string {
  return (editor.getAttributes("link").href as string | undefined) ?? "";
}

/** Links the selection; with only a caret and no link under it, the address itself is added as linked text. */
export function applyLink(editor: Editor, href: string): void {
  const { empty } = editor.state.selection;
  if (empty && !editor.isActive("link")) {
    editor.chain().focus().insertContent({ type: "text", text: href, marks: [{ type: "link", attrs: { href } }] }).run();
  } else {
    editor.chain().focus().extendMarkRange("link").setLink({ href }).run();
  }
}

export function removeLink(editor: Editor): void {
  editor.chain().focus().extendMarkRange("link").unsetLink().run();
}
