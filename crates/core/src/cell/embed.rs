//! Embed blocks in rich text.
//!
//! A page embeds a record's linked records or a saved view with a fenced code
//! block whose info string is `openbase` and whose body is one JSON object
//! (`{"embed":"linked","field":"fld..."}`, `{"embed":"view","view":"viw...","limit":10}`).
//! That JSON is configuration, not something a person wrote to be read, so
//! search leaves it out: searching for `linked` or a field id must not find
//! every page that has an embed.

use std::borrow::Cow;

/// The info string that marks an embed block.
pub const EMBED_INFO: &str = "openbase";

/// An opening or closing code fence on one line: its character, its length and
/// the rest of the line.
fn fence(line: &str) -> Option<(char, usize, &str)> {
    // A fence may sit in a block quote or a list item, so the indentation and
    // `>` markers in front of it do not count.
    let body = line.trim_start_matches([' ', '\t', '>']);
    let ch = body.chars().next().filter(|c| matches!(c, '`' | '~'))?;
    let len = body.chars().take_while(|c| *c == ch).count();
    (len >= 3).then(|| (ch, len, &body[len..]))
}

/// `markdown` without its embed blocks (the fences and the JSON between them).
/// Everything else is kept as written, so a code block with another info
/// string that merely shows an embed is not touched. A block that is never
/// closed runs to the end of the text, as in CommonMark.
pub fn without_embeds(markdown: &str) -> Cow<'_, str> {
    if !markdown.contains(EMBED_INFO) {
        return Cow::Borrowed(markdown);
    }
    let mut out = String::with_capacity(markdown.len());
    // The open fence's character and length, and whether it is an embed.
    let mut open: Option<(char, usize, bool)> = None;
    for line in markdown.split_inclusive('\n') {
        let text = line.trim_end_matches(['\n', '\r']);
        match open {
            None => match fence(text) {
                // A backtick fence's info string cannot hold a backtick.
                Some((ch, len, info)) if !(ch == '`' && info.contains('`')) => {
                    let embed = info.split_whitespace().next() == Some(EMBED_INFO);
                    open = Some((ch, len, embed));
                    if !embed {
                        out.push_str(line);
                    }
                }
                _ => out.push_str(line),
            },
            Some((ch, len, embed)) => {
                let closes = fence(text)
                    .is_some_and(|(c, n, rest)| c == ch && n >= len && rest.trim().is_empty());
                if closes {
                    open = None;
                }
                if !embed {
                    out.push_str(line);
                }
            }
        }
    }
    Cow::Owned(out)
}

#[cfg(test)]
mod tests {
    use super::without_embeds;

    #[test]
    fn text_without_an_embed_is_returned_as_is() {
        let md = "# Notes\n\nplain ```js\nlet x```\n";
        assert!(matches!(without_embeds(md), std::borrow::Cow::Borrowed(_)));
        assert_eq!(without_embeds(md), md);
        assert_eq!(
            without_embeds("mentions openbase in prose"),
            "mentions openbase in prose"
        );
    }

    #[test]
    fn an_embed_block_is_dropped_and_the_text_around_it_kept() {
        let md =
            "Before\n\n```openbase\n{\"embed\":\"linked\",\"field\":\"fldABC\"}\n```\n\nAfter\n";
        assert_eq!(without_embeds(md), "Before\n\n\nAfter\n");
    }

    #[test]
    fn fence_variants_are_embeds_too() {
        let json = "{\"embed\":\"view\",\"view\":\"viwX\",\"limit\":10}";
        for (open, close) in [
            ("```openbase", "```"),
            ("~~~openbase", "~~~"),
            ("````openbase", "````"),
            ("  ```openbase", "  ```"),
            ("```openbase  extra", "```"),
            ("> ```openbase", "> ```"),
        ] {
            let md = format!("a\n{open}\n{json}\n{close}\nb\n");
            assert_eq!(without_embeds(&md), "a\nb\n", "{open}");
        }
    }

    #[test]
    fn a_longer_fence_is_not_closed_by_a_shorter_one() {
        let md = "a\n````openbase\n```\n{\"embed\":\"x\"}\n````\nb\n";
        assert_eq!(without_embeds(md), "a\nb\n");
    }

    #[test]
    fn an_unclosed_embed_runs_to_the_end() {
        assert_eq!(without_embeds("a\n```openbase\n{\"embed\":\"x\"}\n"), "a\n");
    }

    #[test]
    fn other_code_blocks_are_kept_even_when_they_show_an_embed() {
        let md = "```text\n```openbase\n{\"embed\":\"linked\"}\n```\nafter\n";
        // A fence with an info string cannot close a block, so the second
        // line is still inside the text block.
        assert!(without_embeds(md).contains("embed"));
        let quoted = "````md\n```openbase\n{\"embed\":\"linked\"}\n```\n````\n";
        assert_eq!(without_embeds(quoted), quoted);
        let js = "```js\nconst a = 1;\n```\n";
        assert_eq!(without_embeds(js), js);
        // "openbase" is only the first word of the info string.
        let other = "```not-openbase\nx\n```\n";
        assert_eq!(without_embeds(other), other);
    }

    #[test]
    fn crlf_line_endings_work() {
        let md = "a\r\n```openbase\r\n{}\r\n```\r\nb\r\n";
        assert_eq!(without_embeds(md), "a\r\nb\r\n");
    }
}
