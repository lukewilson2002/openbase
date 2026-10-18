# Media Embeds Plan
**Goal:** Rich long text can embed uploaded images, video, audio and files as private, centered blocks with optional alt text and caption.
**Approach:** Embeds stay plain Markdown image syntax pointing at the existing access-checked download route, so every view of the file is authorised on each request. The server enforces that embedded files belong to the record's project and serves video/audio inline; the web editor gets a media block with upload, and the renderer refuses anything that is not an OpenBase file.
**Stack:** Rust (axum, rusqlite), React + Tiptap 3, marked + DOMPurify.

## Agreed behaviour

1. **Format (the contract).** An embed is Markdown image syntax on a line of its own:
   `![Alt text](/api/attachments/{att_id}/{url-encoded filename} "Caption")`. Alt and caption are optional (`![](…)` with no title is valid). The address is relative (no host). Nothing else is an embed.
2. **Kinds by file name extension** (the reference carries no mime; the server re-checks content when serving): images `jpg jpeg png gif webp avif` → `<img>`; video `mp4 m4v webm mov` → `<video controls>`; audio `mp3 m4a aac wav ogg oga opus flac` → `<audio controls>`; anything else → a file card (icon, name, "Download") that links to the same address. All are blocks: full width up to the content column, centered, caption under it in small muted text; alt text is the `alt` of an image and the accessible name of the others.
3. **No external media.** `![…](https://anything)` (or any address not starting with `/api/attachments/`) is never fetched by the browser: the renderer and the editor show it as an ordinary link (`alt` or the address as its text). The editor never creates one: pasting an image URL inserts a link. People upload a file, or link out.
4. **Privacy.** The download route already allows: Viewers of the file's project (session or token), holders of an enabled view-share link of that project (`?share=<token>`, plus the share password header), and for inbox uploads only their uploader. On public share pages the renderer appends the share token to embed addresses so they load there and nowhere else.
5. **Ownership on save.** Every `/api/attachments/{id}/` reference (embed or link) inside a long text value written to a record must name a file of the record's project, exactly like attachment cells; otherwise the write fails with 400 ("…is not a file of this project"). The inbox owner's unattached uploads referenced in what is being filed are moved into the project first (see 7).
6. **Inline video and audio.** Downloads keep today's safety (nosniff, sandbox CSP, everything non-media is an `application/octet-stream` attachment, SVG never inline). Sniffed raster images stay inline; additionally sniffed video (mp4/quicktime, webm, ogg) and audio (mpeg, mp4 audio, ogg, wav, flac, webm audio) are served inline with their real type and support `Range` requests (206, `Accept-Ranges: bytes`) so seeking works.
7. **Inbox.** A draft's note may embed the user's inbox uploads (same address format). Filing moves every inbox upload referenced in the filed values (any long text, and the note when `note_as_comment`) into the table's project, in the same transaction, then writes the record. The cleanup job counts references in draft text as well as in draft attachment lists.
8. **Cleanup.** Files referenced only from long text stay alive (the existing scan of record data already finds `att…` ids anywhere in the JSON; confirm and test it, and add inbox draft text).
9. **Agents.** `upload_attachment` (MCP) also returns `markdown`: the embed line for that file, ready to put into a long text field. Tool and docs text say how to embed and that external media is not shown.

## Tasks (parallel)

**S. Server** (this worktree, shared Rust target): behaviours 5, 6, 7, 8, 9; docs/api.md and docs/mcp.md; tests in `crates/server/tests/`.

**W. Web** (own worktree, no cargo): behaviours 1–4 and 7 (web side): a Tiptap media node (block, atom) with NodeView (image / video / audio / file card, caption and alt editing, remove, keyboard reachable), upload by toolbar button, paste and drop with an uploading placeholder, `RichTextEditor` `upload?: (file: File) => Promise<AttachmentRef>` prop (record forms use the project upload, the Inbox uses the inbox upload; without it there is no media button), Markdown round-trip, `Markdown.tsx` rendering with the same kinds and the share token on public pages, external images as links in both.

**Checkpoint:** merge both, full `scripts/check.sh` with e2e, try it in the browser.
