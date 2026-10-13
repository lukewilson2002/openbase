// Hand-maintained companions to the ts-rs output (scripts/gen-types.sh never deletes this file).
//
// ts-rs cannot express a flattened *optional* enum, so Rust's `UpdateField`
// (`#[serde(flatten)] kind: Option<FieldKind>`) is exported as `UpdateFieldBase`
// (everything except `kind`) and combined here: either no type change, or a
// complete `{ type, options }` pair.
import type { FieldKind } from "./FieldKind";
import type { UpdateFieldBase } from "./UpdateFieldBase";

export type UpdateField = UpdateFieldBase & (FieldKind | { type?: undefined; options?: undefined });
