/**
 * One embed block as it shows, wherever it is (REC-6): a live table on a record page's Page, the static box
 * everywhere else. The block's meaning is already read and checked (lib/embeds.ts); what it may show is decided
 * here by the host and by the server.
 */
import type { ReactNode } from "react";
import type { Embed } from "@/lib/embeds";
import { StaticEmbed } from "./boxes";
import { useEmbedHost } from "./host";
import { LinkedEmbed } from "./LinkedEmbed";
import { ViewEmbed } from "./ViewEmbed";

/** `trailing` is what the editor puts at the end of the block's first row (its Remove button). */
export function EmbedBlock({ embed, trailing }: { embed: Embed; trailing?: ReactNode }) {
  const host = useEmbedHost();
  if (!host) return <StaticEmbed trailing={trailing} />;
  return embed.embed === "linked" ? <LinkedEmbed fieldId={embed.field} trailing={trailing} /> : <ViewEmbed viewId={embed.view} limit={embed.limit} trailing={trailing} />;
}
