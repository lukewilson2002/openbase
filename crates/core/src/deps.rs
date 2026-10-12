//! Field dependency graph for computed fields.
//!
//! Nodes are fields (across all tables of a base). An edge `a -> b` means
//! "b's value depends on a". Edges come from:
//! - formula / button references to fields in the same table,
//! - lookup / rollup: the link field and the target field in the linked table,
//! - count: the link field,
//! - last-modified time/by: nothing (system columns), so no edges.
//!
//! Formula references are supplied by the caller (parsed elsewhere) so this
//! module stays independent of the formula engine.
//!
//! The recompute engine uses [`DepGraph::affected`] to find what to refresh
//! after edits, and schema changes use [`DepGraph::check_acyclic`].

use std::collections::{BTreeSet, HashMap, HashSet, VecDeque};

use crate::field::{Field, FieldKind};
use crate::ids::FieldId;

/// How a dependent field reads a changed field.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum EdgeKind {
    /// Same record (formula, button).
    SameRecord,
    /// Through link field `via` (lookup/rollup/count): when the source changes
    /// on record R, the dependent must refresh on the records linked to R
    /// through the inverse of `via`.
    ViaLink { via: FieldId },
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Edge {
    pub dependent: FieldId,
    pub kind: EdgeKind,
}

#[derive(Debug, Default, Clone)]
pub struct DepGraph {
    /// source field -> fields that depend on it
    dependents: HashMap<FieldId, BTreeSet<Edge>>,
    /// dependent field -> sources (for cycle checks and diagnostics)
    sources: HashMap<FieldId, BTreeSet<FieldId>>,
}

impl DepGraph {
    /// Build the graph for all fields of a base. `formula_refs(field)` returns
    /// the field ids referenced by a formula/button/rollup expression of that
    /// field (for rollups, refs other than `values` are ignored by Airtable,
    /// so pass none).
    pub fn build<'a>(
        fields: impl IntoIterator<Item = &'a Field>,
        formula_refs: &dyn Fn(&Field) -> Vec<FieldId>,
    ) -> DepGraph {
        let mut g = DepGraph::default();
        for f in fields {
            match &f.kind {
                FieldKind::Formula(_) | FieldKind::Button(_) => {
                    for r in formula_refs(f) {
                        g.add(&r, &f.id, EdgeKind::SameRecord);
                    }
                }
                FieldKind::Lookup(o) => {
                    g.add(&o.link_field_id, &f.id, EdgeKind::SameRecord);
                    g.add(
                        &o.target_field_id,
                        &f.id,
                        EdgeKind::ViaLink {
                            via: o.link_field_id.clone(),
                        },
                    );
                }
                FieldKind::Rollup(o) => {
                    g.add(&o.link_field_id, &f.id, EdgeKind::SameRecord);
                    g.add(
                        &o.target_field_id,
                        &f.id,
                        EdgeKind::ViaLink {
                            via: o.link_field_id.clone(),
                        },
                    );
                }
                FieldKind::Count(o) => {
                    g.add(&o.link_field_id, &f.id, EdgeKind::SameRecord);
                }
                _ => {}
            }
        }
        g
    }

    fn add(&mut self, source: &str, dependent: &str, kind: EdgeKind) {
        self.dependents
            .entry(source.to_string())
            .or_default()
            .insert(Edge {
                dependent: dependent.to_string(),
                kind,
            });
        self.sources
            .entry(dependent.to_string())
            .or_default()
            .insert(source.to_string());
    }

    /// Direct dependents of `field`.
    pub fn dependents_of(&self, field: &str) -> impl Iterator<Item = &Edge> {
        self.dependents.get(field).into_iter().flatten()
    }

    /// Direct sources of `field`.
    pub fn sources_of(&self, field: &str) -> impl Iterator<Item = &FieldId> {
        self.sources.get(field).into_iter().flatten()
    }

    /// Every field that transitively depends on any of `changed` (excluding
    /// the changed fields themselves unless they are reachable from another).
    pub fn transitive_dependents(&self, changed: &[FieldId]) -> HashSet<FieldId> {
        let mut seen = HashSet::new();
        let mut queue: VecDeque<&str> = changed.iter().map(String::as_str).collect();
        while let Some(f) = queue.pop_front() {
            for e in self.dependents_of(f) {
                if seen.insert(e.dependent.clone()) {
                    queue.push_back(&e.dependent);
                }
            }
        }
        seen
    }

    /// Error with the cycle path if the graph has a cycle.
    pub fn check_acyclic(&self) -> Result<(), Vec<FieldId>> {
        // Iterative DFS with colours.
        #[derive(Clone, Copy, PartialEq)]
        enum C {
            White,
            Grey,
            Black,
        }
        let mut colour: HashMap<&str, C> = HashMap::new();
        let nodes: BTreeSet<&str> = self
            .dependents
            .keys()
            .map(String::as_str)
            .chain(self.sources.keys().map(String::as_str))
            .collect();
        for &start in &nodes {
            if colour.get(start).copied().unwrap_or(C::White) != C::White {
                continue;
            }
            // stack of (node, iterator index)
            let mut stack: Vec<(&str, Vec<&str>, usize)> = Vec::new();
            let next = |n: &str| -> Vec<&str> {
                self.dependents_of(n)
                    .map(|e| e.dependent.as_str())
                    .collect::<Vec<_>>()
            };
            colour.insert(start, C::Grey);
            stack.push((start, next(start), 0));
            while let Some((node, children, idx)) = stack.last_mut() {
                if *idx < children.len() {
                    let child = children[*idx];
                    *idx += 1;
                    match colour.get(child).copied().unwrap_or(C::White) {
                        C::White => {
                            colour.insert(child, C::Grey);
                            let ch = next(child);
                            stack.push((child, ch, 0));
                        }
                        C::Grey => {
                            // cycle: path from child to top of stack
                            let mut path: Vec<FieldId> = Vec::new();
                            let mut in_cycle = false;
                            for (n, _, _) in stack.iter() {
                                if *n == child {
                                    in_cycle = true;
                                }
                                if in_cycle {
                                    path.push(n.to_string());
                                }
                            }
                            path.push(child.to_string());
                            return Err(path);
                        }
                        C::Black => {}
                    }
                } else {
                    colour.insert(node, C::Black);
                    stack.pop();
                }
            }
        }
        Ok(())
    }

    /// Topological order of `subset` (sources before dependents). Fields not
    /// in the graph are included in input order. Assumes the graph is acyclic.
    pub fn topo_order(&self, subset: &HashSet<FieldId>) -> Vec<FieldId> {
        let mut indeg: HashMap<&str, usize> = subset.iter().map(|f| (f.as_str(), 0)).collect();
        for f in subset {
            for s in self.sources_of(f) {
                if subset.contains(s) {
                    *indeg.get_mut(f.as_str()).unwrap() += 1;
                }
            }
        }
        let mut ready: BTreeSet<&str> = indeg
            .iter()
            .filter(|(_, d)| **d == 0)
            .map(|(f, _)| *f)
            .collect();
        let mut out = Vec::with_capacity(subset.len());
        while let Some(f) = ready.pop_first() {
            out.push(f.to_string());
            for e in self.dependents_of(f) {
                if let Some(d) = indeg.get_mut(e.dependent.as_str()) {
                    *d -= 1;
                    if *d == 0 {
                        ready.insert(e.dependent.as_str());
                    }
                }
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::field::*;
    use crate::value::ResultType;

    fn field(id: &str, kind: FieldKind) -> Field {
        Field {
            id: id.into(),
            table_id: "tbl".into(),
            name: id.into(),
            description: None,
            kind,
        }
    }

    fn formula(id: &str) -> Field {
        field(
            id,
            FieldKind::Formula(FormulaOptions {
                expression: String::new(),
                format: None,
                result_type: ResultType::Text,
            }),
        )
    }

    fn refs_table(
        map: &'static [(&'static str, &'static [&'static str])],
    ) -> impl Fn(&Field) -> Vec<FieldId> {
        move |f: &Field| {
            map.iter()
                .find(|(id, _)| *id == f.id)
                .map(|(_, r)| r.iter().map(|s| s.to_string()).collect())
                .unwrap_or_default()
        }
    }

    #[test]
    fn transitive_and_topo() {
        // a -> b -> c, a -> c
        let fields = vec![
            field("a", FieldKind::Number(Default::default())),
            formula("b"),
            formula("c"),
        ];
        let refs = refs_table(&[("b", &["a"]), ("c", &["a", "b"])]);
        let g = DepGraph::build(&fields, &refs);
        let deps = g.transitive_dependents(&["a".into()]);
        assert_eq!(deps, HashSet::from(["b".to_string(), "c".to_string()]));
        assert_eq!(g.topo_order(&deps), vec!["b".to_string(), "c".to_string()]);
        assert!(g.check_acyclic().is_ok());
    }

    #[test]
    fn detects_cycles() {
        let fields = vec![formula("a"), formula("b"), formula("c")];
        let refs = refs_table(&[("a", &["c"]), ("b", &["a"]), ("c", &["b"])]);
        let g = DepGraph::build(&fields, &refs);
        let cycle = g.check_acyclic().unwrap_err();
        assert!(cycle.len() >= 3);
        assert_eq!(cycle.first(), cycle.last());
    }

    #[test]
    fn self_reference_is_a_cycle() {
        let fields = vec![formula("a")];
        let refs = refs_table(&[("a", &["a"])]);
        assert!(DepGraph::build(&fields, &refs).check_acyclic().is_err());
    }

    #[test]
    fn lookup_edges_go_through_link() {
        let fields = vec![
            field(
                "link",
                FieldKind::Link(LinkOptions {
                    linked_table_id: "t2".into(),
                    inverse_field_id: "inv".into(),
                    single: false,
                    picker_view_id: None,
                }),
            ),
            field(
                "lk",
                FieldKind::Lookup(LookupOptions {
                    link_field_id: "link".into(),
                    target_field_id: "price".into(),
                    result_type: ResultType::Text,
                }),
            ),
        ];
        let g = DepGraph::build(&fields, &|_| vec![]);
        let via: Vec<_> = g.dependents_of("price").collect();
        assert_eq!(via[0].kind, EdgeKind::ViaLink { via: "link".into() });
        let same: Vec<_> = g.dependents_of("link").collect();
        assert_eq!(same[0].kind, EdgeKind::SameRecord);
    }

    #[test]
    fn cross_table_cycle_through_lookups() {
        // t1.lk looks up t2.f; t2.f is a formula over t2.lk2; t2.lk2 looks up t1.lk
        let fields = vec![
            field(
                "lk",
                FieldKind::Lookup(LookupOptions {
                    link_field_id: "l1".into(),
                    target_field_id: "f".into(),
                    result_type: ResultType::Text,
                }),
            ),
            formula("f"),
            field(
                "lk2",
                FieldKind::Lookup(LookupOptions {
                    link_field_id: "l2".into(),
                    target_field_id: "lk".into(),
                    result_type: ResultType::Text,
                }),
            ),
        ];
        let refs = refs_table(&[("f", &["lk2"])]);
        assert!(DepGraph::build(&fields, &refs).check_acyclic().is_err());
    }
}
