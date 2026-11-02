### TypeScript and JavaScript

- Use the project's runner (Vitest, Jest, `node:test`, Playwright for end-to-end), as
  its config file names it.
- Most value comes from integration tests: a component or module tested with its real
  children and helpers, with only the network and the clock faked.
- UI tests find elements the way a user does: by role and accessible name first, then
  label, then text. Test ids are a last resort; CSS selectors and DOM structure never.
- Simulate real user events (`userEvent`, Playwright actions) rather than low-level
  synthetic events.
- Fake the network at the HTTP layer (MSW or the project's equivalent), not by mocking
  the project's own modules.
- Await every async assertion (`findBy...`, `await expect(...)`). A missing `await`
  makes a test pass without checking anything.
- No large snapshots. A small inline snapshot of a short value is fine.
