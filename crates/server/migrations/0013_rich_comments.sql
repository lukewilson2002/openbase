-- OpenBase schema v13: comment bodies are Markdown (the rich text of long text fields) instead of
-- plain text. The stored bodies are rewritten as Markdown that shows the same text; that needs a
-- Markdown escaper, so it runs in Rust right after this file (db::after_migration, then
-- store::comments::plain_to_markdown). Nothing else changes.
SELECT 1;
