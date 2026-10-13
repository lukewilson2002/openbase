/**
 * The `icon` part of a PATCH body: nothing when the icon did not change (the server leaves it
 * alone), the new name when it was set, `null` when it was removed (the server clears it).
 */
export function iconPatch(before: string | null | undefined, after: string | null): { icon?: string | null } {
  return (before ?? null) === after ? {} : { icon: after };
}
