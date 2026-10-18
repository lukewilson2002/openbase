import { ColorField } from "@/components/ColorField";
import { Dialog } from "@/components/ui/dialog";
import type { ChoiceColor } from "@/lib/colors";

/**
 * "Change color…" from a menu: the palette in a dialog (a popover cannot hang off a closing menu).
 * A tap on a swatch applies it and closes, like the icon picker.
 */
export function ColorDialog({ open, onOpenChange, title, value, onChange }: { open: boolean; onOpenChange: (open: boolean) => void; title: string; value?: string | null; onChange: (color: ChoiceColor) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={title} size="sm">
      <ColorField
        value={value}
        onChange={(color) => {
          onOpenChange(false);
          onChange(color);
        }}
      />
    </Dialog>
  );
}
