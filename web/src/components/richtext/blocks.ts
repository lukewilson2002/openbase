/**
 * The blocks the page's `/` menu adds (REC-5), and how each one is inserted. The menu lists them in this order.
 *
 * Linked records and View write an embed (REC-6): a fenced code block with the info string `openbase` holding one
 * JSON object, which is how it is stored in the Markdown. Rendering it as a live table is the embed's own step;
 * here the block is written, and until then it shows as the code it is.
 */
import type { Editor, JSONContent } from "@tiptap/core";
import { Heading1, Heading2, Heading3, ImagePlus, Info, Link2, List, ListChecks, ListOrdered, Minus, Plus, Quote, SquareCode, Table2, LayoutList, type LucideIcon } from "lucide-react";

export type BlockId = "h1" | "h2" | "h3" | "bullet" | "numbered" | "checklist" | "quote" | "callout" | "code" | "table" | "divider" | "file" | "linked" | "view" | "property";

export interface BlockDef {
  id: BlockId;
  label: string;
  /** The Markdown that makes the block by hand, shown at the row's right end so the shortcut is learned. */
  shortcut?: string;
  /** Other words that find the block. */
  keywords: string;
  icon: LucideIcon;
}

export const BLOCKS: readonly BlockDef[] = [
  { id: "h1", label: "Heading 1", shortcut: "#", keywords: "h1 title large", icon: Heading1 },
  { id: "h2", label: "Heading 2", shortcut: "##", keywords: "h2 subtitle medium", icon: Heading2 },
  { id: "h3", label: "Heading 3", shortcut: "###", keywords: "h3 subheading small", icon: Heading3 },
  { id: "bullet", label: "Bulleted list", shortcut: "-", keywords: "unordered ul points", icon: List },
  { id: "numbered", label: "Numbered list", shortcut: "1.", keywords: "ordered ol steps", icon: ListOrdered },
  { id: "checklist", label: "Checklist", shortcut: "[ ]", keywords: "task todo checkbox", icon: ListChecks },
  { id: "quote", label: "Quote", shortcut: ">", keywords: "blockquote citation", icon: Quote },
  { id: "callout", label: "Callout", shortcut: "[!NOTE]", keywords: "note tip warning alert", icon: Info },
  { id: "code", label: "Code block", shortcut: "```", keywords: "snippet pre", icon: SquareCode },
  { id: "table", label: "Table", keywords: "grid rows columns", icon: Table2 },
  { id: "divider", label: "Divider", shortcut: "---", keywords: "rule line separator hr", icon: Minus },
  { id: "file", label: "Image or file", keywords: "upload photo picture attachment media", icon: ImagePlus },
  { id: "linked", label: "Linked records", keywords: "embed relation links table", icon: Link2 },
  { id: "view", label: "View", keywords: "embed grid board saved", icon: LayoutList },
  { id: "property", label: "Property", keywords: "field add column", icon: Plus },
];

const words = (text: string) => text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/** The blocks whose name or keywords start with every word typed, those whose name does first. */
export function matchBlocks(blocks: readonly BlockDef[], query: string): BlockDef[] {
  const typed = words(query);
  if (typed.length === 0) return [...blocks];
  const scored: { block: BlockDef; named: boolean; at: number }[] = [];
  blocks.forEach((block, at) => {
    const name = words(block.label);
    const all = [...name, ...words(block.keywords)];
    if (!typed.every((t) => all.some((w) => w.startsWith(t)))) return;
    scored.push({ block, named: typed.every((t) => name.some((w) => w.startsWith(t))), at });
  });
  return scored.sort((a, b) => Number(b.named) - Number(a.named) || a.at - b.at).map((s) => s.block);
}

export interface Range {
  from: number;
  to: number;
}

/** The embeds REC-6 renders. Ids are written exactly as the server made them. */
export type Embed = { embed: "linked"; field: string } | { embed: "view"; view: string; limit: number };

export const EMBED_LANGUAGE = "openbase";

/** The block that stores an embed: the info string, then one JSON object (the key order is the documented one). */
export function embedBlock(embed: Embed): JSONContent[] {
  // The paragraph after it is where typing goes on; it is not stored when it is the last thing (the value is trimmed).
  return [{ type: "codeBlock", attrs: { language: EMBED_LANGUAGE }, content: [{ type: "text", text: JSON.stringify(embed) }] }, { type: "paragraph" }];
}

/** Makes the block `id` where `range` is (the typed `/query`, which goes). Blocks that need more than the editor are the caller's. */
export function runBlock(editor: Editor, id: Exclude<BlockId, "file" | "linked" | "view" | "property">, range: Range): void {
  const chain = editor.chain().focus().deleteRange(range);
  switch (id) {
    case "h1":
    case "h2":
    case "h3":
      chain.setHeading({ level: Number(id.slice(1)) as 1 | 2 | 3 }).run();
      break;
    case "bullet":
      chain.toggleBulletList().run();
      break;
    case "numbered":
      chain.toggleOrderedList().run();
      break;
    case "checklist":
      chain.toggleTaskList().run();
      break;
    case "quote":
      chain.toggleBlockquote().run();
      break;
    case "callout":
      chain.setCallout("note").run();
      break;
    case "code":
      chain.setCodeBlock().run();
      break;
    case "table":
      chain.insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
      break;
    case "divider":
      chain.setHorizontalRule().run();
      break;
  }
}

export function insertEmbed(editor: Editor, embed: Embed, range: Range): void {
  editor.chain().focus().deleteRange(range).insertContent(embedBlock(embed)).run();
}
