# TypeScript and JavaScript tests

## Runners

Use what the project uses: Vitest, Jest, `node:test`, or Playwright for end-to-end.
`vi.*` and `jest.*` helpers mirror each other; the examples use Vitest.

## Pure logic

```typescript
describe('formatAmount', () => {
  it('shows two decimals', () => {
    expect(formatAmount(24.5, 'EUR')).toBe('€24.50')
  })

  it('shows a dash for a missing amount', () => {
    expect(formatAmount(null, 'EUR')).toBe('—')
  })
})
```

## UI components (Testing Library)

- Find elements the way a user does, in this order: `getByRole` (with `name`),
  `getByLabelText`, `getByPlaceholderText`, `getByText`, `getByDisplayValue`, and
  `getByTestId` only as a last resort. Never `container.querySelector` or CSS classes.
- Drive them with `userEvent` (`const user = userEvent.setup()`), not `fireEvent`.
- Wait with `findBy...` or `waitFor`, always awaited.

```typescript
it('submits the entered email', async () => {
  const onSubmit = vi.fn()
  const user = userEvent.setup()
  render(<SignupForm onSubmit={onSubmit} />)

  await user.type(screen.getByLabelText(/email/i), 'ada@example.com')
  await user.click(screen.getByRole('button', { name: /sign up/i }))

  expect(onSubmit).toHaveBeenCalledWith({ email: 'ada@example.com' })
})
```

Test a hook through the component that uses it unless the hook is shared; then
`renderHook`.

## Network

Fake HTTP at the network layer with MSW (or the project's equivalent), so the code's own
fetching runs for real:

```typescript
it('shows an error when the list cannot load', async () => {
  server.use(http.get('/api/users', () => HttpResponse.json({}, { status: 500 })))
  render(<UserList />)
  expect(await screen.findByRole('alert')).toHaveTextContent(/could not load/i)
})
```

## Time and randomness

`vi.useFakeTimers()` and `vi.setSystemTime(...)`, restored after the test. Inject or stub
`Math.random` and `crypto.randomUUID` when the output depends on them.

## Layout

Follow the project: tests next to the code (`thing.test.ts`) or in a `__tests__` or
`tests` folder. Shared setup in the runner's setup file; factories in a test helpers
module.

## Pitfalls

- A missing `await` on an async assertion makes the test pass without checking.
- Module mocks of the project's own files hide real bugs; mock the boundary instead.
- Large `toMatchSnapshot` files get updated blindly; use specific assertions.
