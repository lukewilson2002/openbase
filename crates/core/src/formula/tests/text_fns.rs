//! Text functions.

use super::support::*;
use crate::value::Value;

#[test]
fn concatenate() {
    check("CONCATENATE(\"a\", \"b\", \"c\")", t("abc"));
    check("CONCATENATE(1, \" \", 2.50)", t("1 2.5"));
    check("CONCATENATE(BLANK(), \"x\")", t("x"));
    check("CONCATENATE(\"only\")", t("only"));
    let c = with(&[("Tags", arr(vec![t("x"), t("y")]))]);
    check_in("CONCATENATE(\"[\", {Tags}, \"]\")", &c, t("[x, y]"));
    check_err("CONCATENATE(\"a\", 1/0)", "Division by zero");
}

#[test]
fn encode_url_component() {
    check("ENCODE_URL_COMPONENT(\"a b&c=d\")", t("a%20b%26c%3Dd"));
    check("ENCODE_URL_COMPONENT(\"-_.!~*'()\")", t("-_.!~*'()"));
    check("ENCODE_URL_COMPONENT(\"é/?\")", t("%C3%A9%2F%3F"));
    check("ENCODE_URL_COMPONENT(BLANK())", t(""));
    check("ENCODE_URL_COMPONENT(42)", t("42"));
}

#[test]
fn find() {
    check("FIND(\"fox\", \"quick brown fox\")", n(13.0));
    check("FIND(\"Fox\", \"quick brown fox\")", n(0.0));
    check("FIND(\"o\", \"hello world\")", n(5.0));
    check("FIND(\"o\", \"hello world\", 6)", n(8.0));
    check("FIND(\"o\", \"hello world\", 5)", n(5.0));
    check("FIND(\"o\", \"hello world\", 0)", n(5.0));
    check("FIND(\"o\", \"hello world\", 99)", n(0.0));
    check("FIND(\"\", \"abc\")", n(0.0));
    check("FIND(\"b\", BLANK())", n(0.0));
    check("FIND(\"✓\", \"é✓\")", n(2.0));
}

#[test]
fn search() {
    check("SEARCH(\"FOX\", \"quick brown fox\")", n(13.0));
    check("SEARCH(\"cat\", \"quick brown fox\")", Value::Null);
    check("SEARCH(\"O\", \"hello world\", 6)", n(8.0));
    check("SEARCH(\"É\", \"café\")", n(4.0));
    check("SEARCH(\"\", \"abc\")", Value::Null);
}

#[test]
fn left_right_mid() {
    check("LEFT(\"quick brown\", 5)", t("quick"));
    check("LEFT(\"ab\", 5)", t("ab"));
    check("LEFT(\"ab\", 0)", t(""));
    check("LEFT(\"ab\", -1)", t(""));
    check("LEFT(\"héllo\", 2)", t("hé"));
    check("LEFT(12345, 2)", t("12"));
    check("RIGHT(\"quick brown\", 5)", t("brown"));
    check("RIGHT(\"ab\", 5)", t("ab"));
    check("RIGHT(\"héllo\", 4)", t("éllo"));
    check("RIGHT(BLANK(), 2)", t(""));
    check("MID(\"quick brown\", 7, 5)", t("brown"));
    check("MID(\"abc\", 0, 2)", t("ab"));
    check("MID(\"abc\", 3, 10)", t("c"));
    check("MID(\"abc\", 10, 1)", t(""));
    check("MID(\"abc\", 2, -1)", t(""));
    check_err("LEFT(\"abc\", \"x\")", "as a number");
}

#[test]
fn len() {
    check("LEN(\"quick brown fox\")", n(15.0));
    check("LEN(\"\")", n(0.0));
    check("LEN(BLANK())", n(0.0));
    check("LEN(\"héllo✓\")", n(6.0));
    check("LEN(12.50)", n(4.0));
    check_err("LEN(ERROR())", "#ERROR!");
}

#[test]
fn lower_upper() {
    check("LOWER(\"Hello WORLD\")", t("hello world"));
    check("UPPER(\"Hello world\")", t("HELLO WORLD"));
    check("UPPER(\"straße\")", t("STRASSE"));
    check("LOWER(BLANK())", t(""));
    check("UPPER(1.5)", t("1.5"));
}

#[test]
fn replace() {
    check("REPLACE(\"database\", 2, 5, \"o\")", t("dose"));
    check("REPLACE(\"abc\", 1, 0, \"X\")", t("Xabc"));
    check("REPLACE(\"abc\", 4, 2, \"X\")", t("abcX"));
    check("REPLACE(\"abc\", 2, 100, \"\")", t("a"));
    check("REPLACE(\"héllo\", 2, 1, \"e\")", t("hello"));
}

#[test]
fn rept() {
    check("REPT(\"ab\", 3)", t("ababab"));
    check("REPT(\"x\", 0)", t(""));
    check("REPT(\"x\", -2)", t(""));
    check("REPT(\"x\", 2.9)", t("xx"));
    check_err("REPT(\"abc\", 1e12)", "too long");
    check_err("REPT(REPT(\"a\", 1000), 1000)", "too long");
}

#[test]
fn substitute() {
    check("SUBSTITUTE(\"a-b-c\", \"-\", \"+\")", t("a+b+c"));
    check("SUBSTITUTE(\"a-b-c\", \"-\", \"+\", 2)", t("a-b+c"));
    check("SUBSTITUTE(\"a-b-c\", \"-\", \"+\", 5)", t("a-b-c"));
    check("SUBSTITUTE(\"abc\", \"\", \"x\")", t("abc"));
    check("SUBSTITUTE(\"Hello\", \"l\", \"\")", t("Heo"));
    check("SUBSTITUTE(\"aaa\", \"A\", \"b\")", t("aaa"));
    check_err("SUBSTITUTE(\"a\", \"a\", \"b\", 0)", "index");
    check_err(
        "SUBSTITUTE(REPT(\"a\", 1000), \"a\", REPT(\"b\", 1000))",
        "too long",
    );
}

#[test]
fn t_function() {
    check("T(\"hello\")", t("hello"));
    check("T(42)", Value::Null);
    check("T(TRUE())", Value::Null);
    check("T(BLANK())", Value::Null);
    check_err("T(ERROR())", "#ERROR!");
}

#[test]
fn trim() {
    check("TRIM(\"  hi there \")", t("hi there"));
    check("TRIM(\"\\n\\tx\\n\")", t("x"));
    check("TRIM(BLANK())", t(""));
}
