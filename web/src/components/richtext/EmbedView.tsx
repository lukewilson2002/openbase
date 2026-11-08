/**
 * How an embed block looks in the editor (REC-6): the embed itself, as a live table on a record's Page and as the
 * static box where the editor is used for anything else (a rich text cell, a comment). Editors get a Remove button
 * on the block; Backspace and Delete remove a selected block as for any other.
 */
import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { X } from "lucide-react";
import { EmbedBlock } from "@/components/embeds/EmbedBlock";
import { UnreadableEmbed } from "@/components/embeds/boxes";
import { IconButton } from "@/components/ui/icon-button";
import { Icon } from "@/components/ui/icon";
import { parseEmbed } from "@/lib/embeds";

export function EmbedView({ node, deleteNode, selected, editor }: NodeViewProps) {
  const embed = parseEmbed(String(node.attrs.source ?? ""));
  const editable = editor.isEditable;
  const remove = editable && (
    <IconButton label="Remove embed" size="sm" className="ob-embed-remove" onClick={() => deleteNode()}>
      <Icon icon={X} />
    </IconButton>
  );
  return (
    <NodeViewWrapper className="ob-embed-block" data-selected={selected && editable ? "true" : undefined} contentEditable={false}>
      {embed ? <EmbedBlock embed={embed} trailing={remove} /> : <UnreadableEmbed trailing={remove} />}
    </NodeViewWrapper>
  );
}
