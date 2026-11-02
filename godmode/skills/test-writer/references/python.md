# Python tests

## Runner

pytest, unless the project uses `unittest` or another runner. Plain `assert`; pytest
shows both sides on failure.

## Pure logic, many cases

```python
import pytest

@pytest.mark.parametrize(
    ("hours", "rate", "expected"),
    [(0, 50, 0), (1.5, 50, 75), (8, 62.5, 500)],
)
def test_invoice_total(hours, rate, expected):
    assert invoice_total(hours, rate) == expected


def test_invoice_total_rejects_negative_hours():
    with pytest.raises(ValueError, match="hours must be positive"):
        invoice_total(-1, 50)
```

## Fixtures

Shared setup goes in fixtures, in the nearest `conftest.py`. Keep them small and named
for what they give: `db_session`, `client`, `paid_invoice`.

```python
@pytest.fixture
def client(app):
    return app.test_client()


def test_unknown_invoice_returns_404(client):
    response = client.get("/invoices/999")
    assert response.status_code == 404
    assert response.json["error"] == "invoice not found"
```

## Files, environment and time

- `tmp_path` for files; never write into the repository.
- `monkeypatch.setenv(...)` and `monkeypatch.setattr(...)` for the environment and
  attributes; restored automatically.
- Control time by injecting a clock or with the project's freezing helper; never
  `time.sleep`.

## Faking

- Patch where the name is looked up: `monkeypatch.setattr("billing.mailer.send", fake)`
  when `billing.mailer` imported `send`.
- Fake HTTP at the client boundary (`responses`, `respx`, `pytest-httpx`, or the
  project's choice), not the project's own functions.
- Prefer a small fake object with real behaviour to a `MagicMock` that accepts anything.

## Command-line tools

Run the real entry point with the framework's runner (`CliRunner` for Click and Typer)
or `subprocess.run`, and assert the exit code, the output and the files written.

## Pitfalls

- A `MagicMock` returns another mock for any attribute, so a typo still passes: use
  `create_autospec` or a real fake.
- Tests that share module-level state pass alone and fail together; reset it in a
  fixture.
- Async code needs the project's async test plugin (`pytest-asyncio`, `anyio`), and every
  coroutine awaited.
