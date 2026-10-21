/**
 * A multiline text field opened across the whole screen: a title (the field's name), a Done button, and
 * the editor filling the rest. It is a Radix dialog, so Escape and Done both close it and focus
 * returns to the field. The editor inside owns its scrolling (one scroll container), the dialog
 * pads for the notch and the home indicator.
 */
import type { ReactNode } from "react";
import { Dialog as D } from "radix-ui";
import { Button } from "@/components/ui/button";

/** The plain text field's full-screen editor: one text area filling the view. */
export function FullScreenTextarea({ value, onChange, label }: { value: string; onChange: (text: string) => void; label: string }) {
  return (
    <textarea
      autoFocus
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      spellCheck
      className="min-h-0 w-full flex-1 resize-none bg-transparent px-4 py-3 text-[0.8125rem] outline-none"
    />
  );
}

export function FullScreen({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <D.Root open onOpenChange={(o) => !o && onClose()}>
      <D.Portal>
        {/* `click-outside-ignore`: a grid cell editor underneath must not read a click in here as a click outside of it. */}
        <D.Overlay className="click-outside-ignore ob-fade-in fixed inset-0 z-50 bg-overlay" />
        <D.Content
          aria-describedby={undefined}
          // Keys typed here are not for the cell editor or the record that host this one (Escape is Radix's own).
          onKeyDown={(e) => e.stopPropagation()}
          // An Escape that closes something inside first (the people list of a rich text editor) keeps it open.
          onEscapeKeyDown={(e) => {
            if (e.target instanceof Element && e.target.closest("[data-escape-cancels]")) e.preventDefault();
          }}
          onOpenAutoFocus={(e) => e.preventDefault()}
          className="click-outside-ignore fixed inset-0 z-50 flex h-dvh flex-col bg-surface pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] pt-[env(safe-area-inset-top)]"
        >
          <header className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
            <D.Title className="min-w-0 flex-1 truncate text-base font-semibold">{title}</D.Title>
            <D.Close asChild>
              <Button variant="primary">Done</Button>
            </D.Close>
          </header>
          <div className="mx-auto flex min-h-0 w-full max-w-4xl flex-1 flex-col">{children}</div>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
