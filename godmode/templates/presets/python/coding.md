### Python

- Type hints on every public function and method; the project's type checker (mypy,
  pyright) passes. Prefer precise types to `Any`.
- Data that crosses a boundary is parsed into a typed structure (a dataclass, a
  validation model) at the boundary, not passed around as loose dicts.
- Catch specific exceptions, never a bare `except:` or a broad `except Exception` that
  hides the error. Re-raise with `raise ... from err` to keep the cause.
- Use `pathlib` for paths, context managers (`with`) for files, locks and connections.
- No mutable default arguments. No work at import time beyond definitions.
- Timestamps are timezone-aware.
- Use the project's environment and dependency tool (uv, Poetry, pip with a lock file),
  and add dependencies through it, never by hand-editing installed packages.
