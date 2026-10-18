/**
 * The Tiptap extension set of the rich text editor, and the Markdown layer built on it. Everything
 * the editor can express round-trips through plain Markdown (`@tiptap/markdown`, GitHub flavoured
 * plus the alert syntax of `callout.ts`); there is no underline, colour or alignment because
 * Markdown cannot store them.
 *
 * Three small departures from the library's own Markdown writer, each covered in markdown.test.ts:
 * a table is written without the blank lines it pads itself with, a line break is a plain newline
 * (Markdown.tsx and the parser both treat a single newline as a break, so `a\nb` stays as typed
 * instead of becoming `a  \nb`), and text is escaped only where it could be read as markup
 * (`snake_case` and `2 * 3` stay as typed, where the library writes `snake\_case` and `2 \* 3`).
 */
import { Editor, Extension, type AnyExtension } from "@tiptap/core";
import { Markdown } from "@tiptap/markdown";
import { Table, TableCell, TableHeader, TableRow, renderTableToMarkdown } from "@tiptap/extension-table";
import { HardBreak } from "@tiptap/extension-hard-break";
import { Paragraph } from "@tiptap/extension-paragraph";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { Placeholder } from "@tiptap/extensions";
import StarterKit from "@tiptap/starter-kit";
import { Callout, QuoteOrCallout } from "./callout";

const ASCII_PUNCT = /[!-/:-@[-`{-~]/;
const isSpace = (c: string | undefined) => c !== undefined && /\s/.test(c);
const isWord = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}]/u.test(c);

/** Escape the characters of plain text that Markdown would otherwise read as formatting. */
export function escapeMarkdownText(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    const prev = text[i - 1];
    const next = text[i + 1];
    if (c === "\\") out += next !== undefined && ASCII_PUNCT.test(next) ? "\\\\" : "\\";
    else if (c === "`" || c === "[" || c === "]" || c === "~") out += `\\${c}`;
    else if (c === "*") out += isSpace(prev) && isSpace(next) ? c : "\\*";
    else if (c === "_") out += (isWord(prev) && isWord(next)) || (isSpace(prev) && isSpace(next)) ? c : "\\_";
    else if (c === "<") out += next !== undefined && /[A-Za-z/!?]/.test(next) ? "&lt;" : c;
    else if (c === "&") out += /^&(?:#\d+|#x[\da-f]+|[a-z][\da-z]*);/i.test(text.slice(i)) ? "&amp;" : c;
    else out += c;
  }
  return out;
}

const LINE_START = /^(\s*)(?:(#{1,6})(?=\s|$)|([-+*])(?=\s)|(\d{1,9})([.)])(?=\s|$)|(>)|(`{3,}|~{3,})|([-=])([-=\s]*)$)/;

/**
 * Escape the lines of a paragraph that would turn into a heading, a list, a quote, a code fence or a
 * rule if they came back from the file as they are written ("## not a heading" typed as text).
 */
export function escapeLineStarts(text: string): string {
  return text
    .split("\n")
    .map((line) =>
      line.replace(LINE_START, (_m, indent: string, hashes?: string, bullet?: string, num?: string, delim?: string, quote?: string, fence?: string, rule?: string, restOfRule?: string) => {
        if (hashes) return `${indent}\\${hashes}`;
        if (bullet) return `${indent}\\${bullet}`;
        if (num) return `${indent}${num}\\${delim}`;
        if (quote) return `${indent}\\>`;
        if (fence) return `${indent}\\${fence}`;
        return `${indent}\\${rule}${restOfRule}`;
      }),
    )
    .join("\n");
}

/** Swap the library's text escaping (a private method of its manager) for `escapeMarkdownText`. */
const GentleEscaping = Extension.create({
  name: "gentleEscaping",
  // After the Markdown extension (priority 100) has made its manager, before anything is written.
  priority: 10,
  onBeforeCreate() {
    type Manager = { codeTypes: Set<string>; encodeTextForMarkdown: (text: string, node: { marks?: { type: string }[] }, parent?: { type?: string }) => string };
    const manager = (this.editor.storage as unknown as { markdown?: { manager?: Manager } }).markdown?.manager;
    if (!manager || !(manager.codeTypes instanceof Set) || typeof manager.encodeTextForMarkdown !== "function") return;
    // The library HTML-encodes and then backslash-escapes; `escapeMarkdownText` does both, sparingly.
    manager.encodeTextForMarkdown = (text, node, parent) => {
      const inCode = (parent?.type != null && manager.codeTypes.has(parent.type)) || (node.marks ?? []).some((m) => manager.codeTypes.has(m.type));
      return inCode ? text : escapeMarkdownText(text);
    };
  },
});

/**
 * Tab and Shift+Tab in a list indent and outdent its item (the list items' own shortcuts). Where the
 * item cannot move (the first item has nothing to nest under), the key still stays in the editor:
 * the browser would otherwise move the focus away mid-sentence. Outside lists Tab is left alone, so
 * the keyboard can still leave the editor. A lower priority runs after the list items' shortcuts.
 */
const ListTabStays = Extension.create({
  name: "listTabStays",
  priority: 50,
  addKeyboardShortcuts() {
    const inList = () => this.editor.isActive("listItem") || this.editor.isActive("taskItem");
    return { Tab: inList, "Shift-Tab": inList };
  },
});

export function richTextExtensions(placeholder?: string): AnyExtension[] {
  return [
    StarterKit.configure({
      blockquote: false,
      hardBreak: false,
      paragraph: false,
      underline: false,
      trailingNode: false,
      link: { openOnClick: false, autolink: true, linkOnPaste: true, HTMLAttributes: { rel: "noopener noreferrer nofollow", target: "_blank" } },
    }),
    HardBreak.extend({ renderMarkdown: () => "\n" }),
    Paragraph.extend({ renderMarkdown: (node, h, ctx) => escapeLineStarts(Paragraph.config.renderMarkdown?.(node, h, ctx) ?? "") }),
    QuoteOrCallout,
    Callout,
    TaskList,
    TaskItem.configure({ nested: true }),
    ListTabStays,
    Table.extend({ renderMarkdown: (node, h) => renderTableToMarkdown(node, h).trim() }).configure({ resizable: false }),
    TableRow,
    TableHeader,
    TableCell,
    // A single newline is a line break, as in Markdown.tsx (values typed in the plain text area rely on it).
    Markdown.configure({ markedOptions: { gfm: true, breaks: true } }),
    GentleEscaping,
    ...(placeholder ? [Placeholder.configure({ placeholder })] : []),
  ];
}

/** `md` as the Markdown the editor would store for it: parsed into the document model and written back. */
export function normalizeMarkdown(md: string): string {
  const editor = new Editor({ element: null, extensions: richTextExtensions(), content: md, contentType: "markdown" });
  try {
    return editor.getMarkdown().trim();
  } finally {
    editor.destroy();
  }
}
