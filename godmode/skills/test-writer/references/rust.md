# Rust tests

## Runner

`cargo test`. Unit tests in a `#[cfg(test)] mod tests` at the bottom of the file they
test, where they can reach private items. Integration tests in `tests/`, through the
public API only.

## Unit tests

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn total_of_a_partial_hour() {
        assert_eq!(invoice_total(1.5, 50.0), 75.0);
    }

    #[test]
    fn negative_hours_are_rejected() {
        let err = Invoice::new(-1.0, 50.0).unwrap_err();
        assert_eq!(err, InvoiceError::NegativeHours);
    }
}
```

- Prefer asserting on an `Err` value to `#[should_panic]`.
- Tests may return `Result<(), Box<dyn std::error::Error>>` and use `?` for setup steps.
- Add a message to `assert!` when the values alone would not explain a failure.

## Many cases

A loop over a slice of cases, or the project's parametrising crate (`rstest`) if it uses
one. Name each case in the assertion message.

## Files and processes

- A temporary folder per test (`tempfile::tempdir()` or the project's helper).
- A binary's behaviour: run it with `std::process::Command` (or `assert_cmd` if the
  project uses it) and assert exit status, output and files.

## Faking

Fake dependencies through a trait the code takes as a parameter, with a small struct
that implements it in the tests. Fake HTTP with a local test server crate the project
already uses.

## Async

Use the runtime's test attribute (`#[tokio::test]`, `#[async_std::test]`), and control
time with the runtime's test utilities (for example `tokio::time::pause`) instead of
sleeping.

## Doc tests

Examples in doc comments run as tests (`cargo test --doc`). Keep them short and
compiling; they are the public API's first users.

## Pitfalls

- Tests run in parallel threads by default: shared files, environment variables or
  global state need isolation.
- Floating-point equality: compare within a tolerance, or use integer cents for money.
