### Rust

- Unit tests in a `#[cfg(test)] mod tests` at the bottom of the file they test;
  integration tests in `tests/`, through the public API only.
- `assert_eq!` and `assert!` with a message when the values alone do not explain the
  failure. Tests may return `Result<(), E>` and use `?`.
- `#[should_panic(expected = "...")]` only for real panics; prefer asserting on an
  `Err` value.
- Files in a temporary folder (`tempfile` or the project's helper), never in the repo.
- Doc examples that show usage are tests too (`cargo test --doc`); keep them compiling.
- Async tests use the runtime's test attribute the project uses (for example
  `#[tokio::test]`).
