/**
 * How a media block looks in the editor: the file itself (image, video, audio or a file card, by the
 * extension of its name), centered, with its caption under it. Selecting the block (a click or tap,
 * or the arrow keys) shows what can be edited: the caption (an input, also shown when it has text),
 * the alt text (behind a small "Alt" button) and Remove. Backspace and Delete remove a selected
 * block, as for any other selected node. A read-only editor shows only the file and the caption.
 *
 * The markup and classes are those of Markdown.tsx's rendering (`.ob-media` in styles/index.css), so
 * a value looks the same being edited and being read.
 */
import { useEffect, useId, useState } from "react";
import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/cn";
import { embedFilename, mediaKind, mediaLabel, type MediaKind } from "@/lib/media";

const KIND_LABELS: Record<MediaKind, string> = { image: "Image", video: "Video", audio: "Audio", file: "File" };

// A grid cell editor closes on a click outside of it; the popover renders in a portal.
const KEEP_GRID_EDITOR = "click-outside-ignore";

const small =
  "inline-flex h-7 pointer-coarse:h-10 items-center gap-1 rounded-md border border-line bg-surface px-2 text-xs font-medium text-fg shadow-sm hover:bg-hover";

/** The file card: used for other files, and for an image that cannot be shown. */
function FileCard({ src, filename }: { src: string; filename: string }) {
  return (
    <div className="ob-file">
      <span className="ob-file-icon" aria-hidden />
      <span className="ob-file-name">{filename}</span>
      <a href={src} download={filename} target="_blank" rel="noopener noreferrer" className="ob-file-download">
        Download
      </a>
    </div>
  );
}

function MediaBody({ src, alt, filename }: { src: string; alt: string; filename: string }) {
  const [failed, setFailed] = useState(false);
  const kind = mediaKind(filename);
  if (kind === "image" && !failed) return <img src={src} alt={alt} loading="lazy" draggable={false} onError={() => setFailed(true)} />;
  if (kind === "video") return <video src={src} controls playsInline preload="metadata" aria-label={mediaLabel(src, alt)} />;
  if (kind === "audio") return <audio src={src} controls aria-label={mediaLabel(src, alt)} />;
  return <FileCard src={src} filename={filename} />;
}

function AltButton({ alt, onChange }: { alt: string; onChange: (alt: string) => void }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(alt);
  const id = useId();
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        if (o) setDraft(alt);
        setOpen(o);
      }}
    >
      <PopoverTrigger asChild>
        <button type="button" aria-label="Alt text" title="Alt text" className={small}>
          Alt
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className={cn("flex flex-col gap-2", KEEP_GRID_EDITOR)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onChange(draft.trim());
            setOpen(false);
          }
        }}
      >
        <label htmlFor={id} className="text-[0.8125rem] font-medium">
          Alt text
        </label>
        <input
          id={id}
          autoFocus
          autoComplete="off"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Describe it for people who cannot see it"
          className="h-9 w-full rounded-md border border-line-strong bg-surface px-2.5 focus-visible:border-ring"
        />
        <div className="flex justify-end">
          <Button
            onClick={() => {
              onChange(draft.trim());
              setOpen(false);
            }}
          >
            Done
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function MediaView({ node, updateAttributes, deleteNode, selected, editor }: NodeViewProps) {
  const src = String(node.attrs.src ?? "");
  const alt = String(node.attrs.alt ?? "");
  const title = String(node.attrs.title ?? "");
  const filename = embedFilename(src);
  const editable = editor.isEditable;
  // The caption is typed here and handed to the document with every keystroke; an edit that came
  // from elsewhere (undo) replaces what is shown.
  const [caption, setCaption] = useState(title);
  useEffect(() => setCaption(title), [title]);

  const kind = mediaKind(filename);
  const label = `${KIND_LABELS[kind]}: ${mediaLabel(src, alt)}`;
  const showCaptionInput = editable && (selected || caption !== "");

  return (
    <NodeViewWrapper as="figure" className="ob-media" data-kind={kind} data-selected={selected && editable ? "true" : undefined} data-drag-handle="" role="group" aria-label={label} contentEditable={false}>
      <MediaBody src={src} alt={alt} filename={filename} />
      {showCaptionInput ? (
        <input
          aria-label="Caption"
          value={caption}
          maxLength={500}
          autoComplete="off"
          placeholder="Add a caption"
          className="ob-media-caption-input"
          onChange={(e) => {
            setCaption(e.target.value);
            updateAttributes({ title: e.target.value });
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === "Escape") {
              e.preventDefault();
              editor.commands.focus();
            }
          }}
        />
      ) : (
        title && <figcaption>{title}</figcaption>
      )}
      {editable && selected && (
        <div className="ob-media-tools">
          <AltButton alt={alt} onChange={(next) => updateAttributes({ alt: next })} />
          <button type="button" aria-label="Remove" title="Remove" onClick={() => deleteNode()} className={small}>
            <Trash2 aria-hidden className="size-3.5" />
            Remove
          </button>
        </div>
      )}
    </NodeViewWrapper>
  );
}
