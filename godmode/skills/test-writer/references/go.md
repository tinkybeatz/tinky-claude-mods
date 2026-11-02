# Go tests

## Runner

The standard `testing` package, `go test ./...`. Tests in `_test.go` files next to the
code. Use an assertion library only if the project already does.

## Table-driven tests

```go
func TestInvoiceTotal(t *testing.T) {
	tests := []struct {
		name  string
		hours float64
		rate  float64
		want  float64
	}{
		{"no hours", 0, 50, 0},
		{"partial hour", 1.5, 50, 75},
		{"full day", 8, 62.5, 500},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := InvoiceTotal(tt.hours, tt.rate)
			if got != tt.want {
				t.Errorf("InvoiceTotal(%v, %v) = %v, want %v", tt.hours, tt.rate, got, tt.want)
			}
		})
	}
}
```

## Errors

Check the error, not its text: `errors.Is(err, ErrNotFound)` or `errors.As`. Check that
no error came back before using the result: `if err != nil { t.Fatalf(...) }`.

## Helpers

- `t.Helper()` at the top of every helper, so failures point at the caller.
- `t.TempDir()` for files, `t.Setenv()` for the environment, `t.Cleanup()` for teardown.

## HTTP

- Handlers: `httptest.NewRecorder()` and `httptest.NewRequest(...)`, then assert the
  status and body.
- Clients: point them at an `httptest.NewServer(...)` that answers like the real
  service, including its failures.

## Faking

Fake dependencies through small interfaces defined where they are used, with a hand
written fake that behaves like the real thing. Avoid global variables swapped in tests.

## Concurrency

Run concurrent code's tests with `-race`. Wait with channels or `sync.WaitGroup`, never
`time.Sleep`. Inject the clock when behaviour depends on time.

## Pitfalls

- A loop variable captured by a subtest closure in old Go versions; the project's Go
  version decides whether `tt := tt` is still needed.
- `t.Fatal` from a goroutine other than the test's does not stop the test; report back
  through a channel.
- Tests that depend on map iteration order fail at random; sort first.
