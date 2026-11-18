import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import {
  backendFor,
  describeTicket,
  markdownBackend,
  normaliseId,
  OPEN_STATUSES,
  openTicketsOf,
  parseTicket,
  renderHeader,
  runTicketTool,
  slugOf,
  TICKET_TOOL_NAMES,
  TICKET_TOOLS,
  TicketError,
  trackerOf,
} from '../hooks/tickets'
import type { MoveCheck, TicketBackend, TicketChange, TicketComment, TicketDraft, TicketFilter, TicketHeader } from '../hooks/tickets'
import { godmodeStatusOf, guessMapping, jiraBackend, jiraServersIn, pickServer, statusMapOf } from '../hooks/jira'
import { SETUP_TOOL_NAMES } from '../hooks/setup'
import type { Answer } from '../hooks/storage'
import { archivedPath, BOARD, callJira, JIRA_TOOL_NAMES, makeJira, mountJira, RUNNER_SERVER, SERVER, sidePath, toolsCalled } from './jira-world'
import type { FakeIssue, FakeJira, JiraFlavour } from './jira-world'
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

test('a gate reads the open tickets, plus the ticket it moves and its fix tickets, and no other done ticket', async () => {
  const { world, backend } = markdown()
  for (const title of ['Open', 'Old', 'Original', 'Fix', 'Unreadable']) await backend.create(draft({ title }))
  await backend.move('T-2', { status: 'done' })
  await backend.move('T-3', { status: 'qa' })
  world.files.set(`${TICKETS}/T-4-fix.md`, (world.files.get(`${TICKETS}/T-4-fix.md`) ?? '').replace('created:', 'fixFor: T-3\ncreated:'))
  await backend.move('T-4', { status: 'done', qaResult: { result: 'passed', commit: 'abc1234' } })
  await backend.move('T-5', { status: 'done' })
  // A done ticket the gate does not ask for is never read: this one would fail the read.
  world.files.set(`${TICKETS}/done/T-5-unreadable.md`, 'not a ticket')
  const $ = worldEngine(world)
  const ids = (headers: TicketHeader[]) => headers.map(header => `${header.id} ${header.status}`)

  expect(ids(await openTicketsOf($, 'none', DIR))).toEqual(['T-1 todo', 'T-3 qa'])
  expect(ids(await openTicketsOf($, 'none', DIR, { id: 't-2' }))).toEqual(['T-1 todo', 'T-2 done', 'T-3 qa'])
  expect(await errorOf(backend.list({ statuses: ['todo', 'doing', 'review', 'qa', 'done'] }))).toContain('cannot be read')

  world.files.delete(`${TICKETS}/done/T-5-unreadable.md`)

  expect(ids(await openTicketsOf($, 'none', DIR, { id: 'T-3', withFixes: true }))).toEqual(['T-1 todo', 'T-3 qa', 'T-4 done'])
  expect(ids(await backend.list({ statuses: OPEN_STATUSES, around: { id: 'T-3' } }))).toEqual(['T-1 todo', 'T-3 qa'])
})

test('on Jira, a gate searches the open tickets, the ticket it moves and its fix tickets, never every done one', async () => {
  const world = makeWorld()
  await setUpProject(world, { sharedAnswers: { tracker: 'jira', jiraCloudId: 'site-1', jiraProject: 'APP', qaWaitStatus: 'In QA' } })
  const jira = makeJira()
  const sides: [string, string, string, Record<string, unknown>][] = [
    ['APP-1', 'In Progress', 'doing', {}],
    ['APP-2', 'Done', 'done', {}],
    ['APP-3', 'In QA', 'qa', {}],
    ['APP-4', 'Done', 'done', { fixFor: 'APP-3', qaResult: { result: 'passed', commit: 'abc1234' } }],
    ['APP-5', 'Done', 'done', {}],
  ]
  for (const [key, status, recorded, side] of sides) {
    jira.issues.set(key, { key, summary: key, status })
    world.files.set(sidePath(key), JSON.stringify({ title: key, status: recorded, blockedBy: [], visibleChange: true, ready: false, ...side }))
  }
  const $ = {
    ...worldEngine(world),
    tool: { list: async () => JIRA_TOOL_NAMES.map(tool => ({ name: `mcp__${SERVER}__${tool}`, description: tool, mcp: true })) },
    mcp: {
      call: async (server: string, tool: string, args: Record<string, unknown>) => {
        const answered = callJira(jira, server, tool, args)
        if (answered === 'not connected') throw new Error(`MCP server "${server}" is not connected`)
        return answered
      },
    },
  } as unknown as Parameters<typeof jiraBackend>[0]
  const backend = jiraBackend($, { tracker: 'jira', jiraCloudId: 'site-1', jiraProject: 'APP', qaWaitStatus: 'In QA', jiraServer: SERVER })
  const scope = () => jira.calls.map(call => /^key in \(([^)]*)\)/.exec(String(call.args.jql))?.[1])

  const ids = (await backend.list({ statuses: OPEN_STATUSES, around: { id: 'app-3', withFixes: true } })).map(header => header.id)

  expect(ids).toEqual(['APP-1', 'APP-3', 'APP-4'])
  expect(scope()).toEqual(['APP-1, APP-3, APP-4'])

  jira.calls.length = 0
  await backend.list({ statuses: OPEN_STATUSES, around: { id: 'APP-2' } })

  expect(scope()).toEqual(['APP-1, APP-2, APP-3'])
})

test('a ticket in qa stays in tickets/, and the default list shows it (D69)', async () => {
  const { world, backend } = markdown()
  await backend.create(draft({ title: 'One' }))
  await backend.create(draft({ title: 'Two' }))
  await backend.move('T-2', { status: 'done' })

  const waiting = await backend.move('T-1', { status: 'qa' })
  const back = await backend.move('T-2', { status: 'qa' })

  expect(waiting.status).toBe('qa')
  expect(back.status).toBe('qa')
  expect(ticketPaths(world)).toEqual([`${TICKETS}/T-1-one.md`, `${TICKETS}/T-2-two.md`, `${TICKETS}/next-id`])
  expect(world.files.get(`${TICKETS}/T-1-one.md`)).toContain('status: qa\n')
  expect((await backend.list({})).map(header => `${header.id} ${header.status}`)).toEqual(['T-1 qa', 'T-2 qa'])
  expect((await backend.list({ statuses: ['qa'] })).map(header => header.id)).toEqual(['T-1', 'T-2'])
})

test('tickets written before the qa status still read, list and move', async () => {
  const { world, backend } = markdown()
  const old = (status: string, number: number) =>
    `---\nid: T-${number}\ntitle: Old ${status}\nstatus: ${status}\nready: yes\nvisibleChange: no\nblockedBy:\nbranch:\npr:\ncreated: 2026-10-01\n---\n\n# T-${number} Old ${status}\n\n## Comments\n`
  world.files.set(`${TICKETS}/T-1-old-todo.md`, old('todo', 1))
  world.files.set(`${TICKETS}/T-2-old-doing.md`, old('doing', 2))
  world.files.set(`${TICKETS}/T-3-old-review.md`, old('review', 3))
  world.files.set(`${TICKETS}/done/T-4-old-done.md`, old('done', 4))

  expect((await backend.list({})).map(header => `${header.id} ${header.status}`)).toEqual(['T-1 todo', 'T-2 doing', 'T-3 review'])
  expect((await backend.list({ statuses: ['done'] })).map(header => header.id)).toEqual(['T-4'])
  expect((await backend.move('T-3', { status: 'qa' })).status).toBe('qa')
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

test('the ticket tools take the qa status, and their schema and text name it', async () => {
  const { backend, calls } = fakeBackend()

  const moved = await runTicketTool(backend, 'ticket_move', { id: 'T-4', status: 'qa' }, {})
  await runTicketTool(backend, 'ticket_list', { status: ['qa'] }, {})

  expect(moved).toContain('Updated T-4 | qa')
  expect(calls).toEqual([['move', 'T-4', { status: 'qa' }], ['list', { statuses: ['qa'] }]])
  const move = TICKET_TOOLS.find(tool => tool.name === 'ticket_move')
  expect(move?.description).toContain('(todo, doing, review, qa, done)')
  expect(JSON.stringify(move?.inputSchema)).toContain('"enum":["todo","doing","review","qa","done"]')
})

test('a QA result reads back from the header at its commit, and only the main thread records one through the loop', async () => {
  const header: TicketHeader = { ...draftHeader(), status: 'qa', pr: '#12', qaResult: { result: 'failed', commit: 'a1b2c3d4e5' } }
  const parsed = parseTicket(`${renderHeader(header)}\nbody`)
  expect(typeof parsed === 'string' ? parsed : parsed.header).toEqual(header)
  expect(describeTicket(header)).toContain('QA failed at a1b2c3d')

  const { backend, calls } = fakeBackend()
  const checkMove: MoveCheck = async (_id, change, qaWord) => ({ change: { ...change, qaResult: qaWord === undefined ? undefined : { result: qaWord, commit: 'c0ffee1' } } })
  expect(await errorOf(runTicketTool(backend, 'ticket_move', { id: 'T-4', qaResult: 'passed' }, { agentId: 'a1', checkMove }))).toContain('Only the main thread records a QA result')
  expect(await errorOf(runTicketTool(backend, 'ticket_move', { id: 'T-4', qaResult: 'passed' }, {}))).toContain('needs the PR\'s current commit')
  expect(await errorOf(runTicketTool(backend, 'ticket_move', { id: 'T-4', qaResult: 'maybe' }, { checkMove }))).toContain('not a QA result')
  await runTicketTool(backend, 'ticket_move', { id: 'T-4', qaResult: 'passed' }, { checkMove })

  expect(calls).toEqual([['move', 'T-4', { qaResult: { result: 'passed', commit: 'c0ffee1' } }]])
})

test('only the main thread changes visibleChange, files a fix ticket or overrides; an override\'s reason is written in the ticket', async () => {
  const { backend, calls } = fakeBackend()
  const agent = { agentId: 'a1' }

  expect(await errorOf(runTicketTool(backend, 'ticket_move', { id: 'T-4', visibleChange: false }, agent))).toContain('Only the main thread changes whether a ticket is a visible change')
  expect(await errorOf(runTicketTool(backend, 'ticket_create', { title: 'Fix', ask: 'fix it', visibleChange: true, fixFor: 'T-1' }, agent))).toContain('Only the main thread files a fix ticket')
  expect(await errorOf(runTicketTool(backend, 'ticket_move', { id: 'T-4', status: 'done', override: 'reverted' }, agent))).toContain('Only the main thread overrides')
  expect(await errorOf(runTicketTool(backend, 'ticket_move', { id: 'T-4', override: 'reverted' }, {}))).toContain('give the status it moves to')
  expect(calls).toEqual([])

  const moved = await runTicketTool(backend, 'ticket_move', { id: 'T-4', status: 'done', override: 'Reverted on main.' }, {})

  expect(moved).toContain('The override\'s reason is written in T-4\'s comments.')
  expect(calls).toEqual([
    ['move', 'T-4', { status: 'done' }],
    ['comment', 'T-4', { author: 'PM', text: 'Moved to done on the person\'s word, without the usual check: Reverted on main.' }],
  ])
})

test('a fix ticket names the ticket it fixes, which must exist, and reads back with it', async () => {
  const { backend } = markdown()
  const original = await backend.create(draft())

  const fix = await backend.create(draft({ title: 'Fix export', fixFor: original.id.toLowerCase() }))

  expect(fix.fixFor).toBe(original.id)
  expect((await backend.list({})).find(header => header.id === fix.id)?.fixFor).toBe(original.id)
  expect(describeTicket(fix)).toContain(`fix for ${original.id}`)
  expect(await errorOf(backend.create(draft({ fixFor: 'T-99' })))).toBe('fixFor names T-99, and there is no such ticket.')
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

test('Jira statuses: the setup\'s names map both ways, an unmapped board status keeps the recorded one, and Jira\'s category decides the rest', () => {
  const map = statusMapOf({ jiraReviewStatus: 'Code Review', qaWaitStatus: 'In QA' })

  expect(map).toEqual({ todo: 'To Do', doing: 'In Progress', review: 'Code Review', qa: 'In QA', done: 'Done' })
  expect(statusMapOf({}).qa).toBeUndefined()
  expect(godmodeStatusOf({ name: 'code review' }, map)).toBe('review')
  expect(godmodeStatusOf({ name: 'In QA' }, map, 'review')).toBe('qa')
  // A tester's "QA passed" is no status of godmode's: the ticket still waits in qa.
  expect(godmodeStatusOf({ name: 'QA passed', category: 'indeterminate' }, map, 'qa')).toBe('qa')
  expect(godmodeStatusOf({ name: 'Blocked', category: 'indeterminate' }, map)).toBe('doing')
  expect(godmodeStatusOf({ name: 'Closed', category: 'done' }, map)).toBe('done')
  // Two godmode statuses sharing one board status keep the one godmode recorded.
  expect(godmodeStatusOf({ name: 'Done' }, statusMapOf({ qaWaitStatus: 'Done' }), 'qa')).toBe('qa')

  expect(guessMapping(BOARD)).toEqual({ todo: 'To Do', doing: 'In Progress', review: 'Code Review', done: 'Done' })
  expect(guessMapping([{ name: 'Open', category: 'new' }, { name: 'Working', category: 'indeterminate' }, { name: 'Shipped', category: 'done' }])).toEqual({ todo: 'Open', doing: 'Working', done: 'Shipped' })
})

test('Jira server: found among the session\'s tools, the setup\'s pick wins, and none or an unpicked several says what is missing', () => {
  const tools = (server: string, names: string[]) => names.map(name => ({ name: `mcp__${server}__${name}`, description: '', mcp: true }))
  const full = ['getJiraIssue', 'searchJiraIssuesUsingJql', 'createJiraIssue', 'transitionJiraIssue', 'addOrEditJiraIssueComment']
  const servers = jiraServersIn([...tools('claude_ai_Atlassian', full), ...tools('work_jira', full), ...tools('claude_ai_Gmail', ['create_draft']), ...tools('half', full.slice(0, 2))])

  expect(servers.map(server => server.name)).toEqual(['claude_ai_Atlassian', 'work_jira'])
  expect(pickServer(servers, 'claude.ai Atlassian')).toMatchObject({ name: 'claude_ai_Atlassian' })
  expect(pickServer(servers.slice(1), 'claude.ai Atlassian')).toMatchObject({ name: 'work_jira' })
  expect(pickServer(servers, undefined)).toContain('Several Atlassian servers are connected (claude_ai_Atlassian, work_jira). Pick one with `/godmode setup`.')
  expect(pickServer([], undefined)).toContain('No Atlassian (Jira) server is connected to this session')
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

test('switching on declares the four ticket tools, the verdict tools and the setup tools', async ($, on) => {
  const world = makeWorld()
  await setUpProject(world)
  mountWorld(on, world)

  await godmode($)

  expect(world.tools).toEqual([...TICKET_TOOL_NAMES, 'review_verdict', 'qa_verdict', ...SETUP_TOOL_NAMES])
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

test('a ticket tool answers an error the model reads: while off, and on Jira with no server or no project, never falling back to files (D25)', async ($, on) => {
  const world = makeWorld()
  await setUpProject(world, { sharedAnswers: { tracker: 'jira', jiraCloudId: 'site-1' } })
  const jira = makeJira({ isDisconnected: true })
  mountWorld(on, world)
  mountJira(on, jira)

  const off = await callTool($, 'ticket_list', {})
  await godmode($)
  const noProject = await callTool($, 'ticket_create', { title: 'x', ask: 'y', visibleChange: false })
  await setUpProject(world, { sharedAnswers: { tracker: 'jira', jiraCloudId: 'site-1', jiraProject: 'APP' } })
  const noServer = await callTool($, 'ticket_create', { title: 'x', ask: 'y', visibleChange: false })

  expect(off.error).toContain('godmode is off')
  expect(noProject.error).toBe('The setup recorded no Jira project for the Jira tracker, so godmode does not know where to file tickets. Record it with `/godmode setup`.')
  expect(noServer.error).toContain('No Atlassian (Jira) server is connected to this session, so godmode cannot reach Jira. Connect the Atlassian connector (`/mcp`)')
  expect(jira.calls).toEqual([])
  expect([...world.files.keys()].some(path => path.includes('/tickets/') || path.includes('/tracker/'))).toBe(false)
})

/** A project on Jira project APP, its review and QA statuses named, godmode on, the pretend server beneath. */
const onJira = async ($: Engine, on: On, shared: Record<string, Answer> = {}, fake: Partial<FakeJira> = {}, personal?: Record<string, Answer>) => {
  const world = makeWorld()
  const jira = makeJira(fake)
  await setUpProject(world, {
    sharedAnswers: { tracker: 'jira', jiraCloudId: 'site-1', jiraProject: 'APP', jiraReviewStatus: 'Code Review', qaWaitStatus: 'In QA', ...shared },
    personalAnswers: { permissions: 'free', ...(personal ?? { jiraServer: jira.server }) },
  })
  mountWorld(on, world)
  mountJira(on, jira)
  await godmode($)
  return { world, jira }
}

const sideOf = (world: World, key: string) => JSON.parse(world.files.get(sidePath(key)) ?? 'null') as Record<string, unknown> | null

const FLAVOURS: readonly JiraFlavour[] = ['listing', 'runner']

for (const flavour of FLAVOURS) {
  test(`Jira (${flavour}): create files an issue in the project, and godmode's own fields go in a personal side file, never in the repo`, async ($, on) => {
    const { world, jira } = await onJira($, on, {}, { flavour })

    const created = await callTool($, 'ticket_create', { title: 'Export button', ask: 'add export', scopeOut: 'PDF.', visibleChange: false, blockedBy: ['app-9'] })

    expect(created).toEqual({ result: 'Filed APP-1 | todo | Export button | blocked by APP-9 | visible change: no' })
    const call = jira.calls.find(entry => entry.tool === 'createJiraIssue')
    expect(call?.server).toBe(jira.server)
    // Each server takes the issue type under its own field name.
    const typeField = flavour === 'listing' ? 'issueTypeName' : 'issueType'
    expect(call?.args).toEqual({ cloudId: 'site-1', projectKey: 'APP', summary: 'Export button', [typeField]: 'Task', description: '## The ask\n\nadd export\n\n## Scope\n\n**Out:** PDF.' })
    expect(sideOf(world, 'APP-1')).toEqual({ title: 'Export button', status: 'todo', blockedBy: ['APP-9'], visibleChange: false, ready: false, created: '2026-10-16' })
    expect([...world.files.keys()].some(path => path.startsWith(`${REPO}/.godmode/tickets`))).toBe(false)
  })

  test(`Jira (${flavour}): move transitions the issue to the mapped status and keeps branch, PR and ready aside; list and comment read both`, async ($, on) => {
    const { world, jira } = await onJira($, on, {}, { flavour })
    await callTool($, 'ticket_create', { title: 'Export button', ask: 'add export', visibleChange: true })

    const ready = await callTool($, 'ticket_move', { id: 'app-1', ready: true })
    const moved = await callTool($, 'ticket_move', { id: 'APP-1', status: 'review', pr: '#12', branch: 'godmode/app-1-export' })
    const listed = await callTool($, 'ticket_list', {})
    const commented = await callTool($, 'ticket_comment', { id: 'APP-1', text: 'Looks good.', author: 'reviewer' })

    // Ready changes no status, so the board is not touched for it.
    expect(ready).toEqual({ result: 'Updated APP-1 | todo | ready | Export button | visible change: yes | on the board: "To Do"' })
    expect(moved.result).toBe('Updated APP-1 | review | ready | Export button | branch godmode/app-1-export | PR #12 | visible change: yes | on the board: "Code Review"')
    expect(jira.issues.get('APP-1')?.status).toBe('Code Review')
    expect(toolsCalled(jira).filter(tool => tool === 'transitionJiraIssue')).toHaveLength(1)
    expect(sideOf(world, 'APP-1')).toMatchObject({ status: 'review', pr: '#12', branch: 'godmode/app-1-export', ready: true })
    expect(listed).toEqual({ result: moved.result?.toString().replace('Updated ', '') })
    expect(commented).toEqual({ result: 'Commented on APP-1.' })
    expect(jira.comments).toEqual([{ key: 'APP-1', body: '**reviewer:** Looks good.' }])
  })

  test(`Jira (${flavour}): a ticket in qa sits in the waiting status; a tester's status reads back with it, and a status the workflow cannot reach is refused`, async ($, on) => {
    const { jira } = await onJira($, on, {}, { flavour })
    await callTool($, 'ticket_create', { title: 'Export button', ask: 'add export', visibleChange: true })
    await callTool($, 'ticket_move', { id: 'APP-1', status: 'qa' })
    expect(jira.issues.get('APP-1')?.status).toBe('In QA')

    const issue = jira.issues.get('APP-1') as FakeIssue
    issue.status = 'QA passed'
    const passed = await callTool($, 'ticket_list', { status: ['qa'] })
    issue.status = 'In Progress'
    const failed = await callTool($, 'ticket_list', {})
    jira.unreachable.push('Done')
    const refused = await callTool($, 'ticket_move', { id: 'APP-1', status: 'done', override: 'Reverted.' })

    expect(passed).toEqual({ result: 'APP-1 | qa | Export button | visible change: yes | on the board: "QA passed"' })
    expect(failed).toEqual({ result: 'APP-1 | doing | Export button | visible change: yes | on the board: "In Progress"' })
    expect(refused.error).toContain('APP-1 cannot move from "In Progress" to "Done" on the board: its workflow leads to')
    expect(refused.error).toContain('Nothing changed.')
    expect(jira.comments).toEqual([])
  })

  test(`Jira (${flavour}): a move reports the status the issue landed in, from Jira, not the status it aimed at`, async ($, on) => {
    // The board's automation sends an issue moved to review straight on to QA.
    const { world, jira } = await onJira($, on, {}, { flavour, lands: target => (target === 'Code Review' ? 'In QA' : undefined) })
    await callTool($, 'ticket_create', { title: 'Export button', ask: 'add export', visibleChange: true })

    const moved = await callTool($, 'ticket_move', { id: 'APP-1', status: 'review' })

    expect(moved.result).toBe('Updated APP-1 | review | Export button | visible change: yes | on the board: "In QA"')
    expect(jira.issues.get('APP-1')?.status).toBe('In QA')
    expect(sideOf(world, 'APP-1')).toMatchObject({ status: 'review' })
  })
}

test('Jira: a move to qa with no waiting status named is refused, and the board is not touched', async ($, on) => {
  const { jira } = await onJira($, on, { qaWaitStatus: '' })
  await callTool($, 'ticket_create', { title: 'Export button', ask: 'add export', visibleChange: true })

  const refused = await callTool($, 'ticket_move', { id: 'APP-1', status: 'qa' })

  expect(refused.error).toContain('No board status is set for godmode\'s qa (the setup\'s waiting-for-QA status), so APP-1 cannot move there.')
  expect(toolsCalled(jira)).not.toContain('transitionJiraIssue')
})

test('Jira: the setup\'s server is called directly when its tools are missing from the tool list, and its shape is probed', async ($, on) => {
  const { jira } = await onJira($, on, {}, { flavour: 'runner', isDeferred: true }, { jiraServer: 'claude.ai Atlassian MCP' })

  const created = await callTool($, 'ticket_create', { title: 'Export button', ask: 'add export', visibleChange: true })
  const moved = await callTool($, 'ticket_move', { id: 'APP-1', status: 'review' })

  expect(created.result).toContain('Filed APP-1 | todo | Export button')
  expect(moved.result).toContain('on the board: "Code Review"')
  expect(jira.calls.find(call => call.tool === 'createJiraIssue')?.args).toMatchObject({ issueType: 'Task' })
  expect(jira.calls.find(call => call.tool === 'transitionJiraIssue')?.args).toEqual({ cloudId: 'site-1', issueIdOrKey: 'APP-1', transitionId: '3' })
})

test('Jira: with no server named and none in the tool list, the known server names that answer are tried before saying none is connected', async ($, on) => {
  const { jira } = await onJira($, on, {}, { flavour: 'runner', isDeferred: true }, {})

  const created = await callTool($, 'ticket_create', { title: 'Export button', ask: 'add export', visibleChange: true })

  expect(created.result).toContain('Filed APP-1')
  expect(jira.calls.find(call => call.tool === 'createJiraIssue')?.server).toBe('claude.ai Atlassian MCP')
  expect(RUNNER_SERVER).toBe('claude_ai_Atlassian_MCP')
})

test('Jira: list reads around an issue Jira no longer has, names it, and archives its side file so the next list is clean', async ($, on) => {
  const { world, jira } = await onJira($, on)
  await callTool($, 'ticket_create', { title: 'Export button', ask: 'add export', visibleChange: true })
  await callTool($, 'ticket_create', { title: 'Import button', ask: 'add import', visibleChange: true })
  jira.issues.delete('APP-1')

  const listed = await callTool($, 'ticket_list', {})
  jira.calls.length = 0
  const again = await callTool($, 'ticket_list', {})

  expect(listed).toEqual({
    result: 'APP-2 | todo | Import button | visible change: yes | on the board: "To Do"\nNot found in Jira: APP-1; its side file was archived (moved to archived/ beside the others).',
  })
  expect(world.files.has(sidePath('APP-1'))).toBe(false)
  expect(world.files.has(archivedPath('APP-1'))).toBe(true)
  expect(again).toEqual({ result: 'APP-2 | todo | Import button | visible change: yes | on the board: "To Do"' })
  expect(toolsCalled(jira)).toEqual(['searchJiraIssuesUsingJql'])
})

test('Jira: a status given as a bare name reads; a row with none is listed as unknown, and a key Jira leaves out is named', async ($, on) => {
  const { jira } = await onJira($, on)
  for (const title of ['One', 'Two', 'Three']) await callTool($, 'ticket_create', { title, ask: title, visibleChange: true })
  jira.statusShape = 'name'
  const named = await callTool($, 'ticket_list', {})
  jira.statusShape = 'none'
  jira.hidden = ['APP-3']
  const unread = await callTool($, 'ticket_list', {})

  expect(named.result).toBe(
    ['APP-1 | todo | One | visible change: yes | on the board: "To Do"', 'APP-2 | todo | Two | visible change: yes | on the board: "To Do"', 'APP-3 | todo | Three | visible change: yes | on the board: "To Do"'].join('\n'),
  )
  expect(unread.result).toBe(
    [
      'APP-1 | todo | One | visible change: yes | on the board: "unknown"',
      'APP-2 | todo | Two | visible change: yes | on the board: "unknown"',
      'Not found in Jira: APP-3; its side file was kept.',
    ].join('\n'),
  )
})

test('Other: the tools keep godmode\'s own copy in personal storage, and every answer tells the PM to mirror the change (D25)', async ($, on) => {
  const world = makeWorld()
  await setUpProject(world, { sharedAnswers: { tracker: 'other', trackerName: 'Linear' } })
  mountWorld(on, world)
  await godmode($)

  const created = await callTool($, 'ticket_create', { title: 'Export button', ask: 'add export', visibleChange: true })
  const moved = await callTool($, 'ticket_move', { id: 'T-1', status: 'review', pr: '#4' })
  const listed = await callTool($, 'ticket_list', {})
  const commented = await callTool($, 'ticket_comment', { id: 'T-1', text: 'noted' })

  // The PM's own tools are limited (D63), so the line has it tell the person, never try the tracker itself.
  const mirror = 'godmode cannot reach Linear, and neither can you: this is only godmode\'s own record. Tell the person in one line what to do in Linear themselves:'
  const never = 'Never try it yourself.'
  expect(created).toEqual({ result: `Filed T-1 | todo | Export button | visible change: yes\n${mirror} file a ticket titled "Export button" (godmode's T-1). ${never}` })
  expect(moved).toEqual({ result: `Updated T-1 | review | Export button | PR #4 | visible change: yes\n${mirror} move T-1 to review, and set pr on T-1. ${never}` })
  expect(listed.result).toContain(`${mirror} check these tickets there, as the tracker may have moved on. ${never}`)
  expect(commented).toEqual({ result: `Commented on T-1.\n${mirror} add the comment to T-1. ${never}` })
  expect(String(created.result)).not.toContain('tool this session has')
  expect(world.files.has(`${HOME}/.claude/godmode/projects/${FIRST_COMMIT}/tracker/tickets/T-1-export-button.md`)).toBe(true)
  expect([...world.files.keys()].some(path => path.startsWith(`${REPO}/.godmode/tickets`))).toBe(false)
})

test('with no setup note, the ticket tools say setup comes first', async ($, on) => {
  mountWorld(on, makeWorld())
  await godmode($)

  const answer = await callTool($, 'ticket_create', { title: 'x', ask: 'y', visibleChange: false })

  expect(answer.error).toContain('not set up in this project yet')
})
