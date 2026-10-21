//! Rich text (Markdown) read as plain text, for a Rich text field whose type
//! changes (`fields_engine::convert_column`). The other way, plain text
//! becoming Rich text, is [`crate::store::comments::plain_to_markdown`].

use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};

/// The text of `md` without its markup, keeping its lines: paragraphs and
/// headings are separated by a blank line, list items start with `- ` (or
/// their number) on lines of their own, a task shows `[x]` or `[ ]`, table
/// cells are separated by ` | `. A mention reads `@Name`, a link its text and
/// an embedded file its caption, or its file name when it has none. Raw HTML
/// is left out.
pub fn to_plain(md: &str) -> String {
    let options = Options::ENABLE_TABLES
        | Options::ENABLE_STRIKETHROUGH
        | Options::ENABLE_TASKLISTS
        | Options::ENABLE_GFM;
    let mut out = String::new();
    // The next number of each list being read (None for a bulleted list).
    let mut lists: Vec<Option<u64>> = Vec::new();
    // Where the text of the image being read starts, and its address.
    let mut image: Option<(usize, String)> = None;
    for event in Parser::new_ext(md, options) {
        match event {
            Event::Text(t) | Event::Code(t) => out.push_str(&t),
            Event::SoftBreak | Event::HardBreak => out.push('\n'),
            Event::TaskListMarker(done) => out.push_str(if done { "[x] " } else { "[ ] " }),
            Event::Rule => out.push_str("\n\n"),
            Event::Start(Tag::List(first)) => {
                if lists.is_empty() {
                    block_break(&mut out);
                } else {
                    line_break(&mut out);
                }
                lists.push(first);
            }
            Event::End(TagEnd::List(_)) => {
                lists.pop();
                if lists.is_empty() {
                    out.push_str("\n\n");
                }
            }
            Event::Start(Tag::Item) => {
                line_break(&mut out);
                out.push_str(&"  ".repeat(lists.len().saturating_sub(1)));
                match lists.last_mut() {
                    Some(Some(n)) => {
                        out.push_str(&format!("{n}. "));
                        *n += 1;
                    }
                    _ => out.push_str("- "),
                }
            }
            Event::End(TagEnd::Item | TagEnd::TableRow | TagEnd::TableHead) => out.push('\n'),
            Event::End(TagEnd::TableCell) => out.push_str(" | "),
            Event::End(TagEnd::Paragraph) if !lists.is_empty() => out.push('\n'),
            Event::End(
                TagEnd::Paragraph
                | TagEnd::Heading(_)
                | TagEnd::CodeBlock
                | TagEnd::BlockQuote(_)
                | TagEnd::Table,
            ) => out.push_str("\n\n"),
            Event::Start(Tag::Image { dest_url, .. }) => {
                image = Some((out.len(), dest_url.to_string()));
            }
            Event::End(TagEnd::Image) => {
                if let Some((start, url)) = image.take()
                    && out.len() == start
                {
                    let name = url.rsplit('/').next().unwrap_or_default();
                    out.push_str(&percent_decoded(name));
                }
            }
            _ => {}
        }
    }
    tidy(&out)
}

/// End the current line, unless it is already ended.
fn line_break(out: &mut String) {
    if !out.is_empty() && !out.ends_with('\n') {
        out.push('\n');
    }
}

/// Leave a blank line after what came before, if anything did.
fn block_break(out: &mut String) {
    if !out.is_empty() && !out.ends_with("\n\n") {
        line_break(out);
        out.push('\n');
    }
}

/// Lines without trailing spaces (or table separators), at most one blank
/// line in a row, and no blank lines at the start or end.
fn tidy(text: &str) -> String {
    let mut lines: Vec<&str> = Vec::new();
    for line in text.lines() {
        let line = line.trim_end().trim_end_matches(" |").trim_end();
        if line.is_empty() && lines.last().is_none_or(|l| l.is_empty()) {
            continue;
        }
        lines.push(line);
    }
    while lines.last().is_some_and(|l| l.is_empty()) {
        lines.pop();
    }
    lines.join("\n")
}

/// `%20` and the like in a file name, decoded when it is valid UTF-8.
fn percent_decoded(name: &str) -> String {
    let bytes = name.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && let Some(b) = name
                .get(i + 1..i + 3)
                .and_then(|h| u8::from_str_radix(h, 16).ok())
        {
            out.push(b);
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| name.to_string())
}

#[cfg(test)]
mod tests {
    use super::to_plain;

    #[test]
    fn paragraphs_and_headings_keep_their_lines() {
        assert_eq!(
            to_plain("# Plan\n\nBuy **milk** and _eggs_.\nThen `cook`."),
            "Plan\n\nBuy milk and eggs.\nThen cook."
        );
    }

    #[test]
    fn lists_tasks_and_nesting() {
        assert_eq!(
            to_plain("Shopping:\n\n- milk\n- eggs\n  1. brown\n  2. white\n\nDone."),
            "Shopping:\n\n- milk\n- eggs\n  1. brown\n  2. white\n\nDone."
        );
        assert_eq!(
            to_plain("- [x] call\n- [ ] write"),
            "- [x] call\n- [ ] write"
        );
        assert_eq!(to_plain("3. three\n4. four"), "3. three\n4. four");
    }

    #[test]
    fn mentions_links_files_and_escapes() {
        assert_eq!(
            to_plain("Ask @[Ann Lee](usrA1) about [the spec](https://example.com)"),
            "Ask @Ann Lee about the spec"
        );
        assert_eq!(
            to_plain("![Floor plan](/api/attachments/attX/plan.pdf)"),
            "Floor plan"
        );
        assert_eq!(
            to_plain("![](/api/attachments/attX/floor%20plan.pdf)"),
            "floor plan.pdf"
        );
        assert_eq!(
            to_plain("5 \\* 3 \\# not a heading"),
            "5 * 3 # not a heading"
        );
        assert_eq!(to_plain("a <b>bold</b> word"), "a bold word");
    }

    #[test]
    fn quotes_rules_and_tables() {
        assert_eq!(to_plain("> quoted\n\n---\n\nafter"), "quoted\n\nafter");
        assert_eq!(to_plain("| A | B |\n|---|---|\n| 1 | 2 |"), "A | B\n1 | 2");
    }

    #[test]
    fn plain_text_round_trips_through_the_escaper() {
        for text in [
            "5 * 3 = 15",
            "# not a heading\n- not a list\n1. not numbered",
            "snake_case and [brackets]",
            "line one\nline two",
        ] {
            let md = crate::store::comments::plain_to_markdown(text);
            assert_eq!(to_plain(&md), text, "{md}");
        }
    }
}
