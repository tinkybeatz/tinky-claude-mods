### Go

- `gofmt` and `go vet` are clean; the project's linter (often `golangci-lint`) passes.
- Every error is handled or returned. Wrap with context: `fmt.Errorf("load invoice %d:
  %w", id, err)`. Compare with `errors.Is` and `errors.As`, never by string.
- Accept interfaces, return concrete types. Define an interface where it is used, and
  only when there are two implementations or a test needs one.
- `context.Context` is the first parameter of anything that does I/O or may block, and
  it is passed on, never stored in a struct.
- Every goroutine has a clear owner and a way to stop. Shared data is guarded by a mutex
  or owned by one goroutine and passed over a channel.
- `defer` closes what was opened, right after the error check.
- No `panic` for expected errors; no package-level mutable state.
