### Rust

- `cargo fmt` and `cargo clippy -- -D warnings` are clean.
- No `unwrap()` or `expect()` on errors that can happen at runtime; return a `Result`
  and propagate with `?`. `expect("why this cannot fail")` only for real invariants.
- Library errors are typed (an enum, often with `thiserror`); application code may use
  `anyhow` with `.context(...)` if the project does.
- Borrow rather than clone; a `.clone()` that only silences the borrow checker is a smell
  to explain or remove.
- `unsafe` only with a `// SAFETY:` comment that states the invariant it relies on.
- Keep public APIs small: `pub(crate)` by default, `pub` on purpose.
- Use newtypes for values that must not be mixed up (ids, units, money).
