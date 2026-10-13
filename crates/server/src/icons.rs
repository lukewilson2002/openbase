//! The Lucide icon names OpenGrid knows: `data/lucide-icons.txt`, generated from the
//! `lucide-react` package by `scripts/gen-icons.sh` (the same package the web picker draws from).
//!
//! The REST API validates only the *format* of an icon name (lowercase letters, digits and `-`,
//! at most 64 characters), so an icon added by a newer client keeps working. MCP tools, whose
//! callers are language models that guess names, check a name against this list and answer an
//! unknown one with suggestions, so a typo does not silently store an icon that draws nothing.
//! A name that is an alias of a canonical icon ("home" for "house") is accepted and stored under
//! the canonical name, which is what the web picker shows as selected.

use std::collections::HashMap;
use std::sync::OnceLock;

const DATA: &str = include_str!("../data/lucide-icons.txt");

pub struct IconSet {
    /// Canonical names, sorted.
    names: Vec<&'static str>,
    /// Aliases of each canonical name (parallel to `names`).
    aliases: Vec<Vec<&'static str>>,
    /// Every accepted name (canonical or alias) -> index into `names`.
    index: HashMap<&'static str, usize>,
}

/// The icon set (parsed once).
pub fn icons() -> &'static IconSet {
    static SET: OnceLock<IconSet> = OnceLock::new();
    SET.get_or_init(|| IconSet::parse(DATA))
}

/// How an icon name given by an agent was understood.
#[derive(Debug, PartialEq, Eq)]
pub struct ResolvedIcon {
    /// The canonical name to store.
    pub name: &'static str,
    /// The name was an alias (or differently spelled) and was replaced by the canonical one.
    pub changed: bool,
}

impl IconSet {
    fn parse(text: &'static str) -> IconSet {
        let mut names = Vec::new();
        let mut aliases = Vec::new();
        let mut index = HashMap::new();
        for line in text
            .lines()
            .filter(|l| !l.is_empty() && !l.starts_with('#'))
        {
            let mut parts = line.split(' ');
            let Some(name) = parts.next() else { continue };
            let i = names.len();
            names.push(name);
            index.insert(name, i);
            let list: Vec<&'static str> = parts.collect();
            for a in &list {
                index.entry(*a).or_insert(i);
            }
            aliases.push(list);
        }
        IconSet {
            names,
            aliases,
            index,
        }
    }

    /// Number of canonical icons.
    pub fn len(&self) -> usize {
        self.names.len()
    }

    pub fn is_empty(&self) -> bool {
        self.names.is_empty()
    }

    /// Canonical names, sorted.
    pub fn names(&self) -> &[&'static str] {
        &self.names
    }

    /// Whether `name` is exactly a canonical icon name.
    pub fn contains(&self, name: &str) -> bool {
        self.index.get(name).is_some_and(|&i| self.names[i] == name)
    }

    /// The canonical icon for a name an agent wrote: exact canonical names and aliases, and
    /// leniently `Shopping Cart` / `shopping_cart` / ` Shopping-Cart `.
    pub fn resolve(&self, name: &str) -> Option<ResolvedIcon> {
        let tidy = normalize(name);
        let &i = self.index.get(tidy.as_str())?;
        let canonical = self.names[i];
        Some(ResolvedIcon {
            name: canonical,
            changed: canonical != name,
        })
    }

    /// Icons matching `query`, best first: every word has to match a name or an alias ("cart
    /// shop" finds "shopping-cart", "home" finds "house"). An empty query lists everything in
    /// alphabetical order. The ranking is the web picker's (`web/src/components/icons/search.ts`).
    pub fn search(&self, query: &str, limit: usize) -> Vec<&'static str> {
        let words: Vec<String> = query
            .to_lowercase()
            .split(|c: char| c.is_whitespace() || c == '_' || c == '-')
            .filter(|w| !w.is_empty())
            .map(str::to_string)
            .collect();
        if words.is_empty() {
            return self.names.iter().copied().take(limit).collect();
        }
        let mut hits: Vec<(u32, &'static str)> = Vec::new();
        'icons: for (i, name) in self.names.iter().enumerate() {
            let mut total = 0;
            for w in &words {
                match word_score(w, name, &self.aliases[i]) {
                    Some(s) => total += s,
                    None => continue 'icons,
                }
            }
            hits.push((total, name));
        }
        hits.sort_by(|a, b| {
            a.0.cmp(&b.0)
                .then(a.1.len().cmp(&b.1.len()))
                .then(a.1.cmp(b.1))
        });
        hits.into_iter().take(limit).map(|(_, n)| n).collect()
    }

    /// Up to `n` icon names that could have been meant by the unknown `name`: search hits for
    /// its words first, then the nearest by edit distance.
    pub fn suggest(&self, name: &str, n: usize) -> Vec<&'static str> {
        let tidy = normalize(name);
        let mut out: Vec<&'static str> = Vec::new();
        if !tidy.is_empty() {
            out.extend(self.search(&tidy, n));
        }
        if out.len() < n && !tidy.is_empty() {
            let limit = (tidy.len() / 3).max(2);
            let mut near: Vec<(usize, &'static str)> = self
                .names
                .iter()
                .filter_map(|c| {
                    let d = edit_distance(&tidy, c);
                    (d <= limit).then_some((d, *c))
                })
                .collect();
            near.sort();
            for (_, c) in near {
                if out.len() >= n {
                    break;
                }
                if !out.contains(&c) {
                    out.push(c);
                }
            }
        }
        out.truncate(n);
        out
    }

    /// A tool-facing result for an icon name an agent wrote: the canonical name, or an error
    /// message with suggestions.
    pub fn check(&self, name: &str) -> Result<ResolvedIcon, String> {
        if let Some(r) = self.resolve(name) {
            return Ok(r);
        }
        let hints = self.suggest(name, 5);
        let did_you_mean = if hints.is_empty() {
            String::new()
        } else {
            format!(" Did you mean: {}?", hints.join(", "))
        };
        Err(format!(
            "'{name}' is not a known icon name.{did_you_mean} Icons are Lucide names in kebab-case \
             (for example 'briefcase' or 'chart-column'); call list_icons with a `query` to search \
             all {} of them. To remove an icon, pass null.",
            self.len()
        ))
    }
}

/// `" Shopping_Cart "` -> `"shopping-cart"`.
fn normalize(name: &str) -> String {
    name.trim()
        .to_lowercase()
        .split(|c: char| c.is_whitespace() || c == '_' || c == '-')
        .filter(|w| !w.is_empty())
        .collect::<Vec<_>>()
        .join("-")
}

/// Rank of how well one search word matches an icon name or one of its aliases (lower is
/// better; `None` = no match).
fn word_score(word: &str, name: &str, aliases: &[&str]) -> Option<u32> {
    if name == word {
        return Some(0);
    }
    if name.starts_with(word) {
        return Some(1);
    }
    if name.split('-').any(|p| p.starts_with(word)) {
        return Some(2);
    }
    if name.contains(word) {
        return Some(3);
    }
    aliases
        .iter()
        .filter_map(|alias| {
            if *alias == word {
                Some(4)
            } else if alias.starts_with(word) {
                Some(5)
            } else if alias.split('-').any(|p| p.starts_with(word)) {
                Some(6)
            } else if alias.contains(word) {
                Some(7)
            } else {
                None
            }
        })
        .min()
}

/// Levenshtein distance (icon names are short ASCII).
fn edit_distance(a: &str, b: &str) -> usize {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len().abs_diff(b.len()) > 8 {
        return usize::MAX / 2;
    }
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    for (i, &ca) in a.iter().enumerate() {
        let mut cur = vec![i + 1];
        for (j, &cb) in b.iter().enumerate() {
            let cost = usize::from(ca != cb);
            cur.push((prev[j] + cost).min(prev[j + 1] + 1).min(cur[j] + 1));
        }
        prev = cur;
    }
    prev[b.len()]
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The 20 icons the web picker offers first, read from its source so that the two lists
    /// cannot drift apart.
    fn popular_in_web_picker() -> Vec<String> {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../web/src/components/icons/popular.ts");
        let src = std::fs::read_to_string(&path).expect("web/src/components/icons/popular.ts");
        let start = src
            .find("POPULAR_ICONS")
            .and_then(|i| src[i..].find("= [").map(|j| i + j))
            .expect("POPULAR_ICONS list");
        let list = &src[start..src[start..].find("];").map(|e| start + e).unwrap()];
        let mut names = Vec::new();
        let mut rest = list;
        while let Some(i) = rest.find("{ name: \"") {
            rest = &rest[i + "{ name: \"".len()..];
            let end = rest.find('"').unwrap();
            names.push(rest[..end].to_string());
        }
        names
    }

    #[test]
    fn the_data_file_parses_into_a_big_sorted_set() {
        let set = icons();
        assert!(set.len() > 1500, "{} icons", set.len());
        assert!(
            set.names().windows(2).all(|w| w[0] < w[1]),
            "sorted, unique"
        );
        for n in set.names() {
            assert!(
                n.bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
                    && n.len() <= 64,
                "{n}"
            );
        }
    }

    #[test]
    fn every_popular_web_picker_icon_is_known() {
        let popular = popular_in_web_picker();
        assert_eq!(popular.len(), 20, "{popular:?}");
        for name in &popular {
            assert!(
                icons().contains(name),
                "{name} is missing from the icon list"
            );
            let r = icons().resolve(name).unwrap();
            assert_eq!(r.name, name.as_str());
            assert!(!r.changed, "{name} is canonical");
        }
    }

    #[test]
    fn resolves_canonical_alias_and_loosely_written_names() {
        let set = icons();
        assert_eq!(set.resolve("briefcase").unwrap().name, "briefcase");
        assert!(!set.resolve("briefcase").unwrap().changed);
        // "home" is an alias of "house"
        let home = set.resolve("home").unwrap();
        assert_eq!((home.name, home.changed), ("house", true));
        let loose = set.resolve(" Shopping_Cart ").unwrap();
        assert_eq!((loose.name, loose.changed), ("shopping-cart", true));
        assert!(set.resolve("").is_none());
        assert!(set.resolve("no-such-icon").is_none());
        assert!(set.contains("house") && !set.contains("home"));
    }

    #[test]
    fn search_ranks_like_the_picker() {
        let set = icons();
        assert_eq!(set.search("shopping cart", 5)[0], "shopping-cart");
        assert_eq!(set.search("home", 5)[0], "house");
        assert_eq!(set.search("truck", 5)[0], "truck");
        assert!(set.search("zzzzqqq", 5).is_empty());
        assert_eq!(set.search("", 3), set.names()[..3].to_vec());
        assert_eq!(set.search("star", 100).len(), set.search("STAR", 100).len());
        assert_eq!(set.search("star", 2).len(), 2);
    }

    #[test]
    fn did_you_mean_covers_typos_and_word_guesses() {
        let set = icons();
        let err = set.check("shoping-cart").unwrap_err();
        assert!(
            err.contains("Did you mean:") && err.contains("shopping-cart"),
            "{err}"
        );
        assert!(err.contains("list_icons") && err.contains("null"), "{err}");
        // a description instead of a name
        let hints = set.suggest("money", 5);
        assert!(!hints.is_empty());
        assert!(set.suggest("zzzzqqqqzzzz", 5).is_empty());
        let err = set.check("zzzzqqqqzzzz").unwrap_err();
        assert!(!err.contains("Did you mean"), "{err}");
    }
}
