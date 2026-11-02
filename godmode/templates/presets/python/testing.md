### Python

- Use pytest unless the project uses something else. Plain `assert` statements; pytest
  shows the values.
- Shared setup goes in fixtures, in `conftest.py` next to the tests that use it.
  `pytest.mark.parametrize` for the same behaviour over several inputs.
- `tmp_path` for files, `monkeypatch` for environment variables and attributes. Never
  write outside the test's temporary folder.
- Patch where a name is looked up, not where it is defined, and only at the boundaries
  (network, clock, randomness, other services).
- Freeze or inject time instead of sleeping. Seed or inject randomness.
- `pytest.raises(SomeError, match=...)` checks the error and its message.
