#!/usr/bin/env bash
# Full local check: formatting, lints, tests. Run before every commit.
set -euo pipefail
cd "$(dirname "$0")/.."
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
