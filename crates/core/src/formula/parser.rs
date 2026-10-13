//! Hand-written Pratt parser.
//!
//! Precedence, lowest to highest (all binary operators are left-associative):
//! comparisons (`= != <> < > <= >=`), `&`, `+ -`, `* /`, unary minus.
//!
//! Two limits keep the parser and every later tree walk safe on hostile
//! input: nesting (parentheses, function arguments, unary minus) is capped at
//! [`MAX_FORMULA_DEPTH`], and the height of the resulting tree (which long
//! operator chains like `1+1+1+...` grow) is capped at [`MAX_EXPR_HEIGHT`].

use super::ast::{BinOp, Expr, Span};
use super::lexer::{Tok, Token, tokenize};
use super::{FormulaError, MAX_EXPR_HEIGHT};
use crate::limits::{MAX_FORMULA_DEPTH, MAX_FORMULA_LEN};

/// Binding power of unary minus: tighter than every binary operator.
const UNARY_BP: u8 = 5;

/// Parses a formula. Never panics; see the module docs for the limits.
pub fn parse(src: &str) -> Result<Expr, FormulaError> {
    if src.len() > MAX_FORMULA_LEN {
        return Err(FormulaError::at(
            MAX_FORMULA_LEN,
            format!("Formula is too long (maximum {MAX_FORMULA_LEN} characters)"),
        ));
    }
    let toks = tokenize(src)?;
    let mut p = Parser {
        toks,
        i: 0,
        depth: 0,
    };
    if matches!(p.peek().tok, Tok::Eof) {
        return Err(FormulaError::at(0, "Formula is empty"));
    }
    let (expr, _) = p.expr(0)?;
    let t = p.peek();
    if !matches!(t.tok, Tok::Eof) {
        return Err(FormulaError::at(
            t.start,
            format!(
                "Unexpected {} (expected an operator or the end of the formula)",
                t.tok.describe()
            ),
        ));
    }
    Ok(expr)
}

struct Parser {
    toks: Vec<Token>,
    i: usize,
    depth: usize,
}

fn binary_bp(tok: &Tok) -> Option<(BinOp, u8)> {
    Some(match tok {
        Tok::Eq => (BinOp::Eq, 1),
        Tok::Ne => (BinOp::Ne, 1),
        Tok::Lt => (BinOp::Lt, 1),
        Tok::Gt => (BinOp::Gt, 1),
        Tok::Le => (BinOp::Le, 1),
        Tok::Ge => (BinOp::Ge, 1),
        Tok::Amp => (BinOp::Concat, 2),
        Tok::Plus => (BinOp::Add, 3),
        Tok::Minus => (BinOp::Sub, 3),
        Tok::Star => (BinOp::Mul, 4),
        Tok::Slash => (BinOp::Div, 4),
        _ => return None,
    })
}

impl Parser {
    fn peek(&self) -> &Token {
        // tokenize always ends with Eof and we never advance past it.
        &self.toks[self.i.min(self.toks.len() - 1)]
    }

    fn peek_at(&self, offset: usize) -> &Tok {
        let idx = (self.i + offset).min(self.toks.len() - 1);
        &self.toks[idx].tok
    }

    fn bump(&mut self) -> Token {
        let t = self.peek().clone();
        if !matches!(t.tok, Tok::Eof) {
            self.i += 1;
        }
        t
    }

    fn enter(&mut self, pos: usize) -> Result<(), FormulaError> {
        self.depth += 1;
        if self.depth > MAX_FORMULA_DEPTH {
            return Err(FormulaError::at(
                pos,
                format!("Formula is nested too deeply (maximum {MAX_FORMULA_DEPTH} levels)"),
            ));
        }
        Ok(())
    }

    fn leave(&mut self) {
        self.depth -= 1;
    }

    /// Parses an expression whose operators bind tighter than `min_bp`.
    /// Returns the expression and its tree height.
    fn expr(&mut self, min_bp: u8) -> Result<(Expr, usize), FormulaError> {
        let (mut lhs, mut height) = self.prefix()?;
        loop {
            let t = self.peek();
            let Some((op, bp)) = binary_bp(&t.tok) else {
                break;
            };
            if bp <= min_bp {
                break;
            }
            let op_pos = t.start;
            self.bump();
            let (rhs, rh) = self.expr(bp)?;
            height = height.max(rh) + 1;
            if height > MAX_EXPR_HEIGHT {
                return Err(FormulaError::at(
                    op_pos,
                    format!(
                        "Formula is too complex (more than {MAX_EXPR_HEIGHT} chained operators)"
                    ),
                ));
            }
            lhs = Expr::Binary {
                op,
                lhs: Box::new(lhs),
                rhs: Box::new(rhs),
            };
        }
        Ok((lhs, height))
    }

    fn prefix(&mut self) -> Result<(Expr, usize), FormulaError> {
        let t = self.bump();
        match t.tok {
            Tok::Number(n) => Ok((Expr::Number(n), 1)),
            Tok::Str(s) => Ok((Expr::Text(s), 1)),
            Tok::Field(name) => Ok((
                Expr::Field {
                    name,
                    span: Span {
                        start: t.start,
                        end: t.end,
                    },
                },
                1,
            )),
            Tok::Minus => {
                self.enter(t.start)?;
                let (e, h) = self.expr(UNARY_BP)?;
                self.leave();
                Ok((Expr::Neg(Box::new(e)), h + 1))
            }
            Tok::LParen => {
                self.enter(t.start)?;
                let (e, h) = self.expr(0)?;
                self.expect_close(t.start, "'('")?;
                self.leave();
                Ok((e, h))
            }
            Tok::Ident(name) => {
                if matches!(self.peek_at(0), Tok::LParen) {
                    return self.call(name, t.start);
                }
                let e = if name.eq_ignore_ascii_case("true") {
                    Expr::Bool(true)
                } else if name.eq_ignore_ascii_case("false") {
                    Expr::Bool(false)
                } else if name == "values" {
                    Expr::Values
                } else {
                    Expr::Field {
                        name,
                        span: Span {
                            start: t.start,
                            end: t.end,
                        },
                    }
                };
                Ok((e, 1))
            }
            Tok::Eof => Err(FormulaError::at(
                t.start,
                "Unexpected end of formula (expected a value)",
            )),
            other => Err(FormulaError::at(
                t.start,
                format!("Unexpected {} (expected a value)", other.describe()),
            )),
        }
    }

    fn expect_close(&mut self, open_pos: usize, what: &str) -> Result<(), FormulaError> {
        let t = self.peek();
        if matches!(t.tok, Tok::RParen) {
            self.bump();
            return Ok(());
        }
        Err(FormulaError::at(
            t.start,
            format!(
                "Expected ')' to close {what} at position {open_pos}, found {}",
                t.tok.describe()
            ),
        ))
    }

    fn call(&mut self, name: String, pos: usize) -> Result<(Expr, usize), FormulaError> {
        let open = self.bump(); // '('
        self.enter(open.start)?;
        let mut args = Vec::new();
        let mut height = 0;
        if matches!(self.peek().tok, Tok::RParen) {
            self.bump();
        } else {
            loop {
                let (arg, h) = self.expr(0)?;
                height = height.max(h);
                args.push(arg);
                let t = self.peek();
                match t.tok {
                    Tok::Comma => {
                        self.bump();
                    }
                    Tok::RParen => {
                        self.bump();
                        break;
                    }
                    _ => {
                        return Err(FormulaError::at(
                            t.start,
                            format!(
                                "Expected ',' or ')' in the arguments of {} (opened at position {}), found {}",
                                name.to_uppercase(),
                                open.start,
                                t.tok.describe()
                            ),
                        ));
                    }
                }
            }
        }
        self.leave();
        Ok((
            Expr::Call {
                name: name.to_uppercase(),
                args,
                pos,
            },
            height + 1,
        ))
    }
}
