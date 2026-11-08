import type { FilterOp } from "@/api/types";

/** How each operator reads in a filter label ("Amount is over 500"), for suggestions and for the chips that follow them. */
export const OP_TEXT: Record<FilterOp, string> = {
  is: "is",
  is_not: "is not",
  is_empty: "is empty",
  is_not_empty: "is not empty",
  contains: "contains",
  does_not_contain: "doesn't contain",
  starts_with: "starts with",
  ends_with: "ends with",
  lt: "is under",
  lte: "is at most",
  gt: "is over",
  gte: "is at least",
  is_any_of: "is any of",
  is_none_of: "is none of",
  has_any_of: "has any of",
  has_all_of: "has all of",
  has_none_of: "has none of",
  is_exactly: "is exactly",
  is_before: "is before",
  is_after: "is after",
  is_on_or_before: "is on or before",
  is_on_or_after: "is on or after",
  is_within: "is",
};
