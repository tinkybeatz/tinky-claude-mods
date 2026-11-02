### Go

- Standard `testing` package; tests in `_test.go` files next to the code. Use the
  assertion library only if the project already does.
- Table-driven tests with `t.Run(name, ...)` for the same behaviour over several cases.
- `t.Helper()` in helpers, `t.TempDir()` for files, `t.Cleanup()` for teardown,
  `t.Setenv()` for environment variables.
- Fake I/O through small interfaces or `httptest.Server`, not global variables.
- Run with `-race` whenever the code under test is concurrent.
- Error messages say what was got and what was wanted:
  `t.Errorf("Total() = %v, want %v", got, want)`.
