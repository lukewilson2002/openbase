//! Formula tokenizer.
//!
//! Produces tokens with byte spans. Never panics: every malformed input is a
//! [`FormulaError`] carrying the byte position of the problem.

use super::FormulaError;

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Tok {
    Number(f64),
    Str(String),
    /// `{...}` field reference, unescaped.
    Field(String),
    Ident(String),
    LParen,
    RParen,
    Comma,
    Plus,
    Minus,
    Star,
    Slash,
    Amp,
    Eq,
    Ne,
    Lt,
    Gt,
    Le,
    Ge,
    Eof,
}

impl Tok {
    /// Short human description used in error messages.
    pub(crate) fn describe(&self) -> String {
        match self {
            Tok::Number(n) => format!("number {}", super::format_number(*n)),
            Tok::Str(_) => "text".to_string(),
            Tok::Field(name) => format!("field {{{name}}}"),
            Tok::Ident(name) => format!("'{name}'"),
            Tok::LParen => "'('".into(),
            Tok::RParen => "')'".into(),
            Tok::Comma => "','".into(),
            Tok::Plus => "'+'".into(),
            Tok::Minus => "'-'".into(),
            Tok::Star => "'*'".into(),
            Tok::Slash => "'/'".into(),
            Tok::Amp => "'&'".into(),
            Tok::Eq => "'='".into(),
            Tok::Ne => "'!='".into(),
            Tok::Lt => "'<'".into(),
            Tok::Gt => "'>'".into(),
            Tok::Le => "'<='".into(),
            Tok::Ge => "'>='".into(),
            Tok::Eof => "end of formula".into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Token {
    pub tok: Tok,
    pub start: usize,
    pub end: usize,
}

/// Splits `src` into tokens. The last token is always [`Tok::Eof`].
pub(crate) fn tokenize(src: &str) -> Result<Vec<Token>, FormulaError> {
    let mut lx = Lexer {
        src,
        chars: src.char_indices().peekable(),
        out: Vec::new(),
    };
    lx.run()?;
    Ok(lx.out)
}

struct Lexer<'a> {
    src: &'a str,
    chars: std::iter::Peekable<std::str::CharIndices<'a>>,
    out: Vec<Token>,
}

impl Lexer<'_> {
    fn push(&mut self, tok: Tok, start: usize, end: usize) {
        self.out.push(Token { tok, start, end });
    }

    fn pos(&mut self) -> usize {
        self.chars.peek().map(|(i, _)| *i).unwrap_or(self.src.len())
    }

    fn run(&mut self) -> Result<(), FormulaError> {
        while let Some(&(start, c)) = self.chars.peek() {
            if c.is_whitespace() {
                self.chars.next();
                continue;
            }
            let single = match c {
                '(' => Some(Tok::LParen),
                ')' => Some(Tok::RParen),
                ',' => Some(Tok::Comma),
                '+' => Some(Tok::Plus),
                '-' => Some(Tok::Minus),
                '*' => Some(Tok::Star),
                '/' => Some(Tok::Slash),
                '&' => Some(Tok::Amp),
                _ => None,
            };
            if let Some(tok) = single {
                self.chars.next();
                self.push(tok, start, start + 1);
                continue;
            }
            match c {
                '=' => {
                    self.chars.next();
                    // Accept `==` as a friendly alias for `=`.
                    let end = if self.eat('=') { start + 2 } else { start + 1 };
                    self.push(Tok::Eq, start, end);
                }
                '!' => {
                    self.chars.next();
                    if self.eat('=') {
                        self.push(Tok::Ne, start, start + 2);
                    } else {
                        return Err(FormulaError::at(
                            start,
                            "Unexpected '!' (did you mean '!=' ?)",
                        ));
                    }
                }
                '<' => {
                    self.chars.next();
                    if self.eat('=') {
                        self.push(Tok::Le, start, start + 2);
                    } else if self.eat('>') {
                        self.push(Tok::Ne, start, start + 2);
                    } else {
                        self.push(Tok::Lt, start, start + 1);
                    }
                }
                '>' => {
                    self.chars.next();
                    if self.eat('=') {
                        self.push(Tok::Ge, start, start + 2);
                    } else {
                        self.push(Tok::Gt, start, start + 1);
                    }
                }
                '"' | '\'' => self.string(start, c)?,
                '{' => self.field(start)?,
                c if c.is_ascii_digit() || c == '.' => self.number(start)?,
                c if c.is_alphabetic() || c == '_' => self.ident(start),
                '\u{201C}' | '\u{201D}' | '\u{2018}' | '\u{2019}' => {
                    return Err(FormulaError::at(
                        start,
                        format!(
                            "Unexpected character '{c}': use straight quotes (\" or ') around text"
                        ),
                    ));
                }
                c => {
                    return Err(FormulaError::at(
                        start,
                        format!("Unexpected character '{c}'"),
                    ));
                }
            }
        }
        let end = self.src.len();
        self.push(Tok::Eof, end, end);
        Ok(())
    }

    fn eat(&mut self, want: char) -> bool {
        if let Some(&(_, c)) = self.chars.peek()
            && c == want
        {
            self.chars.next();
            return true;
        }
        false
    }

    fn eat_digits(&mut self) -> usize {
        let mut n = 0;
        while let Some(&(_, c)) = self.chars.peek() {
            if !c.is_ascii_digit() {
                break;
            }
            self.chars.next();
            n += 1;
        }
        n
    }

    fn number(&mut self, start: usize) -> Result<(), FormulaError> {
        let int_digits = self.eat_digits();
        let mut frac_digits = 0;
        if self.eat('.') {
            frac_digits = self.eat_digits();
        }
        if int_digits == 0 && frac_digits == 0 {
            return Err(FormulaError::at(start, "Unexpected '.'"));
        }
        // Exponent only when followed by digits (optionally signed), so `1e`
        // is left for the parser to reject rather than silently accepted.
        let save = self.chars.clone();
        if let Some(&(_, 'e' | 'E')) = self.chars.peek() {
            self.chars.next();
            if !self.eat('+') {
                self.eat('-');
            }
            if self.eat_digits() == 0 {
                self.chars = save;
            }
        }
        let end = self.pos();
        let text = &self.src[start..end];
        match text.parse::<f64>() {
            Ok(n) if n.is_finite() => {
                self.push(Tok::Number(n), start, end);
                Ok(())
            }
            _ => Err(FormulaError::at(
                start,
                format!("Number '{text}' is too large"),
            )),
        }
    }

    fn ident(&mut self, start: usize) {
        while let Some(&(_, c)) = self.chars.peek() {
            if !(c.is_alphanumeric() || c == '_') {
                break;
            }
            self.chars.next();
        }
        let end = self.pos();
        self.push(Tok::Ident(self.src[start..end].to_string()), start, end);
    }

    fn string(&mut self, start: usize, quote: char) -> Result<(), FormulaError> {
        self.chars.next();
        let mut s = String::new();
        loop {
            let Some((_, c)) = self.chars.next() else {
                return Err(FormulaError::at(
                    start,
                    format!("Text starting here is missing its closing {quote}"),
                ));
            };
            if c == quote {
                break;
            }
            if c == '\\' {
                match self.chars.next() {
                    Some((_, 'n')) => s.push('\n'),
                    Some((_, 't')) => s.push('\t'),
                    Some((_, 'r')) => s.push('\r'),
                    Some((_, e @ ('"' | '\'' | '\\'))) => s.push(e),
                    // Unknown escapes keep the backslash so regex patterns
                    // like "\d+" work as written.
                    Some((_, other)) => {
                        s.push('\\');
                        s.push(other);
                    }
                    None => {
                        return Err(FormulaError::at(
                            start,
                            format!("Text starting here is missing its closing {quote}"),
                        ));
                    }
                }
            } else {
                s.push(c);
            }
        }
        let end = self.pos();
        self.push(Tok::Str(s), start, end);
        Ok(())
    }

    fn field(&mut self, start: usize) -> Result<(), FormulaError> {
        self.chars.next();
        let mut name = String::new();
        loop {
            let Some((_, c)) = self.chars.next() else {
                return Err(FormulaError::at(
                    start,
                    "Field reference starting here is missing its closing '}'",
                ));
            };
            match c {
                '}' => break,
                '\\' => match self.chars.peek() {
                    Some(&(_, e @ ('}' | '\\'))) => {
                        self.chars.next();
                        name.push(e);
                    }
                    _ => name.push('\\'),
                },
                c => name.push(c),
            }
        }
        if name.is_empty() {
            return Err(FormulaError::at(start, "Empty field reference '{}'"));
        }
        let end = self.pos();
        self.push(Tok::Field(name), start, end);
        Ok(())
    }
}
