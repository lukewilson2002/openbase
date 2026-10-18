import { skipToken, useQuery } from "@tanstack/react-query";
import { keys } from "@/api/keys";

const NOBODY: readonly string[] = [];

/**
 * The ids of the people with a base open right now, you included. The base's event stream
 * (`useBaseEvents`) sends the list first thing and again whenever someone arrives or leaves, and
 * writes it into the query cache; this reads it from there, so it is empty until the stream has
 * connected and again once the base is left. There is nothing to fetch: a stream that reconnects
 * starts with the list anew.
 */
export function usePresence(baseId: string | undefined): readonly string[] {
  const { data } = useQuery({ queryKey: keys.presence(baseId ?? ""), queryFn: skipToken, initialData: NOBODY });
  return baseId ? (data ?? NOBODY) : NOBODY;
}
