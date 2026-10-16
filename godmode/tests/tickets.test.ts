import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import {
  backendFor,
  markdownBackend,
  normaliseId,
  parseTicket,
  renderHeader,
  runTicketTool,
  slugOf,
  TICKET_TOOL_NAMES,
  TicketError,
  trackerOf,
} from '../hooks/tickets'
import type { TicketBackend, TicketChange, TicketComment, TicketDraft, TicketFilter, TicketHeader } from '../hooks/tickets'
import { FIRST_COMMIT, HOME, makeWorld, mountWorld, REPO, setUpProject, worldEngine } from './world'
import type { World } from './world'

const DIR = `${REPO}/.godmode`
const TICKETS = `${DIR}/tickets`

const draft = (overrides: Partial<TicketDraft> = {}): TicketDraft => ({
  title: 'Export button',
  ask: 'add an export button to the report page',
  visibleChange: true,
  ...overrides,
})

/** The markdown backend over an in-memory world, in committed storage. */
const markdown = () => {
  const world = makeWorld()
  return { world, backend: markdownBackend(worldEngine(world), DIR) }
}

/** The message a promise rejects with, or undefined when it resolves. */
const errorOf = async (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  )

const ticketPaths = (world: World) => [...world.files.keys()].filter(path => path.startsWith(`${TICKETS}/`)).sort()

test('create files T-1, T-2, ... as T-<n>-<slug>.md with the header and the ticket shape', async () => {
  const { world, backend } = markdown()

  const first = await backend.create(
    draft({
      measured: 'The report page has no export (src/report.tsx).',
      inferred: 'CSV is enough.',
      scopeIn: 'The button and the CSV.',
      scopeOut: 'PDF.',
      tests: 'A test that clicks it.',
    }),
  )
  const second = await backend.create(draft({ title: 'Crash on empty report!', blockedBy: ['t-1'], visibleChange: false }))

  expect(first.id).toBe('T-1')
  expect(second).toEqual({
    id: 'T-2',
    title: 'Crash on empty report!',
    status: 'todo',
    blockedBy: ['T-1'],
    visibleChange: false,
    ready: false,
    created: '2026-10-16',
  })
  expect(ticketPaths(world)).toEqual([`${TICKETS}/T-1-export-button.md`, `${TICKETS}/T-2-crash-on-empty-report.md`, `${TICKETS}/next-id`])
  const text = world.files.get(`${TICKETS}/T-1-export-button.md`) ?? ''
  expect(text.startsWith('---\nid: T-1\ntitle: Export button\nstatus: todo\nready: no\nvisibleChange: yes\nblockedBy:\nbranch:\npr:\ncreated: 2026-10-16\n---\n\n# T-1 Export button\n')).toBe(true)
  expect(text).toContain('## The ask\n\nadd an export button to the report page\n')
  expect(text).toContain('## Measured\n\nThe report page has no export (src/report.tsx).\n')
  expect(text).toContain('## Scope\n\n**In:** The button and the CSV.\n\n**Out:** PDF.\n')
  expect(text).not.toContain('## Constraints')
  expect(text.endsWith('## Comments\n')).toBe(true)
})

test('an id is never reused, even after its ticket file is gone', async () => {
  const { world, backend } = markdown()
  await backend.create(draft())
  await backend.create(draft({ title: 'Second' }))
  world.files.delete(`${TICKETS}/T-2-second.md`)

  const third = await backend.create(draft({ title: 'Third' }))

  expect(third.id).toBe('T-3')
})

test('an id counts tickets already in done/, and files written before the counter', async () => {
  const { world, backend } = markdown()
  const old = await markdownBackend(worldEngine(world), DIR).create(draft())
  world.files.delete(`${TICKETS}/next-id`)
  await backend.move(old.id, { status: 'done' })

  expect((await backend.create(draft({ title: 'Next' }))).id).toBe('T-2')
})

test('moving to done moves the file to tickets/done/, and moving it back brings it out', async () => {
  const { world, backend } = markdown()
  await backend.create(draft())
  await backend.create(draft({ title: 'Other' }))

  const done = await backend.move('T-1', { status: 'done', pr: '#12' })
  expect(done.status).toBe('done')
  expect(ticketPaths(world)).toEqual([`${TICKETS}/T-2-other.md`, `${TICKETS}/done/T-1-export-button.md`, `${TICKETS}/next-id`])
  expect(world.runs.map(run => run.argv[0])).toEqual(['mkdir', 'mv'])
  expect(world.files.get(`${TICKETS}/done/T-1-export-button.md`)).toContain('status: done\n')
  expect(world.files.get(`${TICKETS}/done/T-1-export-button.md`)).toContain('pr: #12\n')

  const reopened = await backend.move('T-1', { status: 'review' })
  expect(reopened.status).toBe('review')
  expect(world.files.has(`${TICKETS}/T-1-export-button.md`)).toBe(true)
  expect(world.files.has(`${TICKETS}/done/T-1-export-button.md`)).toBe(false)
})

test('a move keeps the body and changes only the header fields given', async () => {
  const { world, backend } = markdown()
  await backend.create(draft({ constraints: 'Keep the old CSV columns.' }))
  await backend.create(draft({ title: 'Blocker' }))
  const before = parseTicket(world.files.get(`${TICKETS}/T-1-export-button.md`) ?? '')

  const moved = await backend.move('T-1', { status: 'doing', branch: 't-1-export', ready: true, blockedBy: ['T-2'] })
  const after = parseTicket(world.files.get(`${TICKETS}/T-1-export-button.md`) ?? '')

  expect(moved).toEqual({ ...draftHeader(), status: 'doing', branch: 't-1-export', ready: true, blockedBy: ['T-2'] })
  if (typeof before === 'string' || typeof after === 'string') throw new Error('unreadable ticket')
  expect(after.body).toBe(before.body)
  expect(after.header).toEqual(moved)
})

const draftHeader = (): TicketHeader => ({
  id: 'T-1',
  title: 'Export button',
  status: 'todo',
  blockedBy: [],
  visibleChange: true,
  ready: false,
  created: '2026-10-16',
})

test('list reads headers, open tickets by default, and filters by status', async () => {
  const { backend } = markdown()
  await backend.create(draft({ title: 'One' }))
  await backend.create(draft({ title: 'Two' }))
  await backend.create(draft({ title: 'Three' }))
  await backend.move('T-2', { status: 'review' })
  await backend.move('T-3', { status: 'done' })

  const ids = async (filter: TicketFilter) => (await backend.list(filter)).map(header => `${header.id} ${header.status}`)

  expect(await ids({})).toEqual(['T-1 todo', 'T-2 review'])
  expect(await ids({ statuses: ['review'] })).toEqual(['T-2 review'])
  expect(await ids({ statuses: ['done', 'todo'] })).toEqual(['T-1 todo', 'T-3 done'])
  expect(await ids({ statuses: ['doing'] })).toEqual([])
})

test('list ignores a body that holds its own --- lines, and files that are not tickets', async () => {
  const { world, backend } = markdown()
  await backend.create(draft({ ask: 'split this:\n---\nstatus: done\n---' }))
  world.files.set(`${TICKETS}/README.md`, '# notes')

  const listed = await backend.list({})

  expect(listed.map(header => `${header.id} ${header.status}`)).toEqual(['T-1 todo'])
})

test('comments are added in order under ## Comments', async () => {
  const { world, backend } = markdown()
  await backend.create(draft())

  await backend.comment('T-1', { author: 'reviewer', text: 'change-request: no test for an empty report' })
  await backend.comment('1', { author: 'PM', text: 'Sent back for a fix round.' })

  const text = world.files.get(`${TICKETS}/T-1-export-button.md`) ?? ''
  expect(text.endsWith(
    '## Comments\n\n### 2026-10-16 09:30 UTC, reviewer\n\nchange-request: no test for an empty report\n\n### 2026-10-16 09:30 UTC, PM\n\nSent back for a fix round.\n',
  )).toBe(true)
})

test('an unknown id, a bad id and a blocker that does not exist are errors the model can read', async () => {
  const { backend } = markdown()
  await backend.create(draft())

  expect(await errorOf(backend.move('T-9', { status: 'doing' }))).toContain('There is no ticket T-9.')
  expect(await errorOf(backend.comment('ABC-1', { author: 'PM', text: 'x' }))).toContain('not a ticket id')
  expect(await errorOf(backend.create(draft({ blockedBy: ['T-7'] })))).toContain('there is no such ticket')
  expect(await errorOf(backend.move('T-1', { blockedBy: ['T-1'] }))).toContain('cannot block itself')
})

test('ids, slugs and headers read back as written', () => {
  expect(normaliseId('t-12')).toBe('T-12')
  expect(normaliseId(' T7 ')).toBe('T-7')
  expect(normaliseId('03')).toBe('T-3')
  expect(normaliseId('T-0')).toBeUndefined()
  expect(normaliseId('PROJ-3')).toBeUndefined()
  expect(slugOf('Café: über-fast export!!')).toBe('cafe-uber-fast-export')
  expect(slugOf('***')).toBe('ticket')
  expect(slugOf('a'.repeat(60))).toHaveLength(40)

  const header: TicketHeader = { ...draftHeader(), blockedBy: ['T-2', 'T-3'], branch: 'b', pr: 'https://x/pull/4', ready: true }
  const parsed = parseTicket(`${renderHeader(header)}\nbody`)
  expect(parsed).toEqual({ header, body: '\nbody' })
  expect(parseTicket('no header')).toBe('it has no header between `---` lines')
  expect(parseTicket('---\nid: T-1\nstatus: blocked\n---\n')).toContain('not one of')
})

/** A backend that records what reaches it, to test routing with no files. */
const fakeBackend = () => {
  const calls: unknown[][] = []
  const header = (id = 'T-4'): TicketHeader => ({ ...draftHeader(), id })
  const backend: TicketBackend = {
    tracker: 'none',
    create: async (value: TicketDraft) => (calls.push(['create', value]), header()),
    move: async (id: string, change: TicketChange) => (calls.push(['move', id, change]), { ...header(id), ...change }),
    list: async (filter: TicketFilter) => (calls.push(['list', filter]), [header('T-1'), { ...header('T-2'), status: 'review', ready: true, pr: '#3' }]),
    comment: async (id: string, comment: TicketComment) => (calls.push(['comment', id, comment]), header(id)),
  }
  return { backend, calls }
}

test('each ticket tool reaches its backend call with the input checked', async () => {
  const { backend, calls } = fakeBackend()

  const created = await runTicketTool(backend, 'ticket_create', { title: 'Export', ask: 'add export', visibleChange: 'yes', blockedBy: 'T-1, T-2' }, {})
  const moved = await runTicketTool(backend, 'ticket_move', { id: 'T-4', status: 'review', pr: '#9', branch: '' }, { agentId: 'a1' })
  const listed = await runTicketTool(backend, 'ticket_list', { status: 'review' }, {})
  const commented = await runTicketTool(backend, 'ticket_comment', { id: 'T-4', text: 'clean-to-merge' }, { agentId: 'a1' })
  await runTicketTool(backend, 'ticket_comment', { id: 'T-4', text: 'noted' }, {})

  expect(calls).toEqual([
    ['create', expect.objectContaining({ title: 'Export', ask: 'add export', visibleChange: true, blockedBy: ['T-1', 'T-2'] })],
    ['move', 'T-4', { status: 'review', pr: '#9', branch: undefined }],
    ['list', { statuses: ['review'] }],
    ['comment', 'T-4', { author: 'agent a1', text: 'clean-to-merge' }],
    ['comment', 'T-4', { author: 'PM', text: 'noted' }],
  ])
  expect(created).toBe('Filed T-4 | todo | Export button | visible change: yes')
  expect(moved).toContain('Updated T-4 | review')
  expect(listed).toBe('T-1 | todo | Export button | visible change: yes\nT-2 | review | ready | Export button | PR #3 | visible change: yes')
  expect(commented).toBe('Commented on T-4.')
})

test('only the main thread marks a ticket ready (D52)', async () => {
  const { backend, calls } = fakeBackend()

  expect(await errorOf(runTicketTool(backend, 'ticket_move', { id: 'T-4', ready: true }, { agentId: 'a1' }))).toContain('Only the main thread')
  await runTicketTool(backend, 'ticket_move', { id: 'T-4', ready: true }, {})

  expect(calls).toEqual([['move', 'T-4', { ready: true }]])
})

test('a ticket tool refuses bad input before it reaches the backend', async () => {
  const { backend, calls } = fakeBackend()

  expect(await errorOf(runTicketTool(backend, 'ticket_create', { title: 'x', visibleChange: true }, {}))).toContain('`ask` is required')
  expect(await errorOf(runTicketTool(backend, 'ticket_create', { title: 'x', ask: 'y' }, {}))).toContain('`visibleChange` is required')
  expect(await errorOf(runTicketTool(backend, 'ticket_move', { id: 'T-4' }, {}))).toContain('Nothing to change')
  expect(await errorOf(runTicketTool(backend, 'ticket_move', { id: 'T-4', status: 'blocked' }, {}))).toContain('is not a status')
  expect(await errorOf(runTicketTool(backend, 'ticket_list', { status: ['todo', 'later'] }, {}))).toContain('is not a status')

  expect(calls).toEqual([])
})

test('Jira and Other say they are not built yet and what is missing, with no fallback (D25)', () => {
  const $ = worldEngine(makeWorld())

  expect(() => backendFor($, 'jira', DIR)).toThrow('The Jira tracker is not built yet')
  expect(() => backendFor($, 'jira', DIR)).toThrow('Atlassian connector')
  expect(() => backendFor($, 'other', DIR)).toThrow('The "Other" tracker is not built yet')
  expect(() => backendFor($, 'other', DIR)).toThrow('nothing fell back to markdown')
  expect(backendFor($, 'none', DIR).tracker).toBe('none')
  expect(trackerOf({})).toBe('none')
  expect(trackerOf({ tracker: 'Jira' })).toBe('jira')
  expect(() => trackerOf({ tracker: 'linear' })).toThrow(TicketError)
})

/** Calls a ticket tool the way the model does, through the plugin's `tool.call` hook. */
const callTool = async ($: Engine, name: string, input: Record<string, unknown>) => {
  // The plugin's own `{ deny }` reaches the test's `$.tool.call` as it was returned.
  const answer = (await $.tool.call({ tool: `mcp__godmode__${name}`, ...input } as Parameters<typeof $.tool.call>[0])) as { result?: unknown; deny?: string }
  return answer.deny !== undefined ? { error: answer.deny } : { result: answer.result }
}

const godmode = ($: Engine, args = '') => $.command.run({ command: 'godmode', args } as Parameters<typeof $.command.run>[0])

test('switching on declares the four ticket tools and review_verdict, listed in the prompt', async ($, on) => {
  const world = makeWorld()
  await setUpProject(world)
  mountWorld(on, world)

  await godmode($)

  expect(world.tools).toEqual([...TICKET_TOOL_NAMES, 'review_verdict'])
})

test('the ticket tools work end to end through the plugin, in the note\'s storage', async ($, on) => {
  const world = makeWorld()
  await setUpProject(world, { storage: 'outside' })
  mountWorld(on, world)
  await godmode($)

  const created = await callTool($, 'ticket_create', { title: 'Export button', ask: 'add export', visibleChange: true })
  const moved = await callTool($, 'ticket_move', { id: 'T-1', status: 'done' })
  const listed = await callTool($, 'ticket_list', { status: ['done'] })

  const outside = `${HOME}/.claude/godmode/projects/${FIRST_COMMIT}/tickets`
  expect(created).toEqual({ result: 'Filed T-1 | todo | Export button | visible change: yes' })
  expect(moved).toEqual({ result: 'Updated T-1 | done | Export button | visible change: yes' })
  expect(listed).toEqual({ result: 'T-1 | done | Export button | visible change: yes' })
  expect(world.files.has(`${outside}/done/T-1-export-button.md`)).toBe(true)
  expect([...world.files.keys()].some(path => path.startsWith(`${REPO}/.godmode`))).toBe(false)
})

test('a ticket tool answers an error the model reads: while off, and on a tracker not built yet', async ($, on) => {
  const world = makeWorld()
  await setUpProject(world, { sharedAnswers: { tracker: 'jira' } })
  mountWorld(on, world)

  const off = await callTool($, 'ticket_list', {})
  await godmode($)
  const jira = await callTool($, 'ticket_create', { title: 'x', ask: 'y', visibleChange: false })

  expect(off.error).toContain('godmode is off')
  expect(jira.error).toContain('The Jira tracker is not built yet')
  expect([...world.files.keys()].some(path => path.includes('/tickets/'))).toBe(false)
})

test('with no setup note, the ticket tools say setup comes first', async ($, on) => {
  mountWorld(on, makeWorld())
  await godmode($)

  const answer = await callTool($, 'ticket_create', { title: 'x', ask: 'y', visibleChange: false })

  expect(answer.error).toContain('not set up in this project yet')
})
