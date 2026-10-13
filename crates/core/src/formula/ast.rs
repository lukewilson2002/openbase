//! Formula syntax tree.
//!
//! [`Expr`] is what [`super::parse`] produces and what the type checker and
//! evaluator consume. Its `Display` impl prints a canonical, fully
//! parenthesized formula that parses back to the same tree, which the tests
//! use to check precedence.

use std::fmt;

/// Byte range of a token in the formula source (`start..end`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Span {
    pub start: usize,
    pub end: usize,
}

/// Binary operators, from lowest to highest precedence group:
/// comparisons, `&`, `+ -`, `* /`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BinOp {
    Eq,
    Ne,
    Lt,
    Gt,
    Le,
    Ge,
    Concat,
    Add,
    Sub,
    Mul,
    Div,
}

impl BinOp {
    pub fn symbol(self) -> &'static str {
        match self {
            BinOp::Eq => "=",
            BinOp::Ne => "!=",
            BinOp::Lt => "<",
            BinOp::Gt => ">",
            BinOp::Le => "<=",
            BinOp::Ge => ">=",
            BinOp::Concat => "&",
            BinOp::Add => "+",
            BinOp::Sub => "-",
            BinOp::Mul => "*",
            BinOp::Div => "/",
        }
    }

    pub fn is_comparison(self) -> bool {
        matches!(
            self,
            BinOp::Eq | BinOp::Ne | BinOp::Lt | BinOp::Gt | BinOp::Le | BinOp::Ge
        )
    }
}

/// A parsed formula expression.
#[derive(Debug, Clone, PartialEq)]
pub enum Expr {
    Number(f64),
    Text(String),
    Bool(bool),
    /// A field reference: `{Field Name}`, a bare identifier, or (in stored
    /// formulas) `{fldXXXX}`. `name` is the unescaped text between the braces.
    /// `span` covers the whole reference in the source, braces included.
    Field {
        name: String,
        span: Span,
    },
    /// The rollup input array (`values`).
    Values,
    /// Unary minus.
    Neg(Box<Expr>),
    Binary {
        op: BinOp,
        lhs: Box<Expr>,
        rhs: Box<Expr>,
    },
    /// Function call. `name` is upper-cased; `pos` is the byte offset of the name.
    Call {
        name: String,
        args: Vec<Expr>,
        pos: usize,
    },
}

impl Expr {
    /// Calls `f` on this node and every descendant, parents first.
    pub fn walk(&self, f: &mut dyn FnMut(&Expr)) {
        f(self);
        match self {
            Expr::Neg(e) => e.walk(f),
            Expr::Binary { lhs, rhs, .. } => {
                lhs.walk(f);
                rhs.walk(f);
            }
            Expr::Call { args, .. } => {
                for a in args {
                    a.walk(f);
                }
            }
            _ => {}
        }
    }
}

/// Escapes a field name for use inside `{...}`: `\` becomes `\\`, `}` becomes `\}`.
pub fn escape_field_name(name: &str) -> String {
    let mut out = String::with_capacity(name.len() + 2);
    for c in name.chars() {
        if c == '\\' || c == '}' {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

fn escape_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\t' => out.push_str("\\t"),
            '\r' => out.push_str("\\r"),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

impl fmt::Display for Expr {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Expr::Number(n) => f.write_str(&super::format_number(*n)),
            Expr::Text(s) => f.write_str(&escape_string(s)),
            Expr::Bool(true) => f.write_str("TRUE"),
            Expr::Bool(false) => f.write_str("FALSE"),
            Expr::Field { name, .. } => write!(f, "{{{}}}", escape_field_name(name)),
            Expr::Values => f.write_str("values"),
            Expr::Neg(e) => write!(f, "-{e}"),
            Expr::Binary { op, lhs, rhs } => write!(f, "({lhs} {} {rhs})", op.symbol()),
            Expr::Call { name, args, .. } => {
                write!(f, "{name}(")?;
                for (i, a) in args.iter().enumerate() {
                    if i > 0 {
                        f.write_str(", ")?;
                    }
                    write!(f, "{a}")?;
                }
                f.write_str(")")
            }
        }
    }
}
