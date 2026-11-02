### TypeScript and JavaScript

The type rules apply to TypeScript; in a JavaScript project, the rest still holds.

- `strict` mode stays on. No `any`: use `unknown` and narrow it, or a real type. No
  non-null assertion (`!`) where a check would do.
- Types describe the data at the boundary (request bodies, files, environment) and are
  checked there at runtime with the project's validation library; inside, trust them.
- Prefer union types and `as const` objects to enums, unless the project already uses
  enums.
- `async` code is awaited or its promise handled; no floating promises. Errors are
  `Error` objects, never strings.
- Import from a module's public entry, not its internals. No circular imports.
- Use the package manager the lockfile names (`package-lock.json` npm,
  `pnpm-lock.yaml` pnpm, `yarn.lock` yarn, `bun.lock` bun). Never mix them.
- In UI code, keep components small and state as local as it can be; derive values
  instead of storing copies of them.
