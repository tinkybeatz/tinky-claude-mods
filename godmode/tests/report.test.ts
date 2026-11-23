import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { AgentInfo, On } from 'claude-code'

import type { Answer } from '../hooks/storage'
import { markdownBackend } from '../hooks/tickets'
import type { TicketStatus } from '../hooks/tickets'
import { FIRST_COMMIT, makeWorld, mountWorld, REPO, setUpProject, worldEngine } from './world'
import type { Gh, World } from './world'

const WORKTREES = '/work/app-worktrees'

/** The current commit of PR #12, and one before it. */
const HEAD = 'a1b2c3d4e5f6a7b8'
const OLDER = '0f9e8d7c6b5a4938'

/** Two open PRs: #12 for T-2, #9 a teammate's. */
const ghWith = (): Gh => ({
  login: 'me',
  prs: [
    { number: 12, title: 'T-2 Export button', branch: 'godmode/t-2-export-button', author: 'me', files: ['src/export.ts'], head: HEAD },
    { number: 9, title: 'Bump deps', branch: 'deps', author: 'teammate', files: ['package.json', 'src/report.tsx'], head: 'e5f6a7b8c9', isDraft: false },
  ],
})

type Options = {
  shared?: Record<string, Answer>
  pluginVersion?: string
  noteVersion?: string
  /** The reviews `gh pr view` answers for PR #12. */
  reviews?: { login: string; state: string; commit: string }[]
}

/**
 * A set-up project on GitHub with everything beneath the plugin answered from memory:
 * the disk and git (`world`), the store, the agents running, and every spawn and state write.
 */
const startProject = async ($: Engine, on: On, options: Options = {}) => {
  const world = makeWorld({ gh: ghWith(), pluginVersion: options.pluginVersion ?? '0.2.0' })
  const dir = await setUpProject(world, { sharedAnswers: { tracker: 'none', ...options.shared } }, options.noteVersion)
  const project = {
    world,
    dir,
    tickets: markdownBackend(worldEngine(world), dir),
    store: new Map<string, unknown>(),
    running: [] as AgentInfo[],
    spawned: 0,
    stateWrites: 0,
    /** What `git log -1` prints in each folder. */
    commits: new Map<string, string>(),
    /** When set, `$.agent.list()` fails. */
    isAgentListBroken: false,
  }
  world.answer = run => {
    const [command, noun, verb, ref] = run.argv
    if (command === 'git' && noun === 'log') {
      const commit = project.commits.get(run.argv.at(-1)?.startsWith('refs/heads/') === true ? (run.argv.at(-1) ?? '') : (run.cwd ?? ''))
      return commit === undefined ? { exitCode: 128, stdout: '', stderr: 'fatal: bad revision' } : { exitCode: 0, stdout: `${commit}\n` }
    }
    if (command === 'gh' && noun === 'pr' && verb === 'view' && ref === '12') {
      const reviews = (options.reviews ?? []).map(review => ({ author: { login: review.login }, state: review.state, commit: { oid: review.commit } }))
      return { exitCode: 0, stdout: JSON.stringify({ headRefOid: HEAD, reviews }) }
    }
    return undefined
  }
  mountWorld(on, world)
  on('store.get', (_$, e) => ({ value: project.store.get(e.key) }))
  on('store.set', (_$, e) => {
    project.store.set(e.key, e.value)
    return { value: undefined } as never
  })
  on('state.set', (_$, e, next) => {
    project.stateWrites += 1
    return next(e)
  })
  on('agent.list', () => (project.isAgentListBroken ? ({ deny: 'the agent list is unavailable' } as never) : { value: project.running }))
  on('session.receive', (_$, e) => ({ text: e.text }) as never)
  on('agent.spawn', (_$, e) => {
    project.spawned += 1
    return { model: e.model ?? 'inherit', agentId: `agent-${project.spawned}` }
  })
  return project
}

type Project = Awaited<ReturnType<typeof startProject>>

const godmode = async ($: Engine, args = '') => (await $.command.run({ command: 'godmode', args } as Parameters<typeof $.command.run>[0])) as { text?: string; context?: readonly string[] }

/** Files a ticket and moves it to `status`; resolves its id. */
const ticket = async (project: Project, title: string, status: TicketStatus, change: { ready?: boolean; pr?: string; branch?: string; blockedBy?: string[] } = {}) => {
  const header = await project.tickets.create({ title, ask: title, visibleChange: true, blockedBy: change.blockedBy })
  await project.tickets.move(header.id, { status, ready: change.ready, pr: change.pr, branch: change.branch })
  return header.id
}

/** Seeds the person's store with a dev dispatch of their own godmode on each ticket. */
const dispatched = (project: Project, ids: string[], extra: Record<string, unknown> = {}) => {
  const all = (project.store.get(`devDispatches:${FIRST_COMMIT}`) ?? {}) as Record<string, unknown>
  for (const id of ids) all[id] = { agentId: `old-${id}`, at: '2026-10-16T09:00:00.000Z', ...extra }
  project.store.set(`devDispatches:${FIRST_COMMIT}`, all)
}

const running = (id: string, type: string, description: string): AgentInfo => ({ id, type, description, status: 'running' })

/** Every file under the project's tickets folder, with its text, to see nothing was changed. */
const ticketFiles = (world: World) => [...world.files].filter(([path]) => path.includes('/tickets/')).sort()

// ---------------------------------------------------------------------------
// `/godmode report` (D44, D70)

test('/godmode report with no setup says so, and changes nothing', async ($, on) => {
  const world = makeWorld()
  mountWorld(on, world)
  let writes = 0
  on('state.set', (_$, e, next) => {
    writes += 1
    return next(e)
  })
  on('agent.list', () => ({ value: [] }))

  const report = await godmode($, 'report')

  expect(report.text).toContain('Setup: not set up in this project yet. `/godmode` runs the setup.')
  expect(report.text).toContain('Agents running: none.')
  expect(report.text).not.toContain('Open PRs')
  expect(writes).toBe(0)
  expect(world.files.size).toBe(0)
})

test('/godmode report gives the setup check, open PRs with their files, tickets, the next ones, fix rounds and running agents', async ($, on) => {
  const project = await startProject($, on)
  await godmode($)
  const blocker = await ticket(project, 'Search box', 'todo', { ready: true })
  await ticket(project, 'Export button', 'review', { pr: '12' })
  await ticket(project, 'Filters', 'todo', { blockedBy: [blocker] })
  await ticket(project, 'Dark mode', 'todo')
  await ticket(project, 'Report filters', 'doing', { ready: true })
  project.store.set(`fixRounds:${FIRST_COMMIT}`, { 'T-2': { count: 2, extra: 0, counted: [] }, 'T-5': { count: 3, extra: 0, counted: [] } })
  project.running = [running('agent-7', 'godmode:reviewer', 'Review PR #12'), { ...running('agent-8', 'Explore', 'old'), status: 'completed' }]
  const files = ticketFiles(project.world)
  const writes = project.stateWrites

  const lines = (await godmode($, 'report')).text?.split('\n') ?? []

  expect(lines[0]).toBe('godmode report')
  expect(lines).toContain('Setup: done with godmode 0.2.0; godmode is on, in coding mode.')
  expect(lines).toContain('Open PRs (2):')
  expect(lines).toContain('- #12 "T-2 Export button" (draft, by me): src/export.ts')
  expect(lines).toContain('- #9 "Bump deps" (by teammate): package.json, src/report.tsx')
  expect(lines).toContain('Tickets: 3 todo, 1 doing, 1 review.')
  expect(lines).toContain('- todo: T-1 "Search box" (ready); T-3 "Filters" (blocked by T-1); T-4 "Dark mode"')
  expect(lines).toContain('- review: T-2 "Export button"')
  expect(lines).toContain('Next: T-1 "Search box".')
  expect(lines).toContain('Waiting on QA: none.')
  expect(lines).toContain('Fix rounds: T-2 2 of 3, T-5 3 of 3 (at the limit).')
  expect(lines).toContain('Agents running (1):')
  expect(lines).toContain('- godmode:reviewer: "Review PR #12" (agent-7)')
  // A report reads; it moves no ticket and writes no state.
  expect(ticketFiles(project.world)).toEqual(files)
  expect(project.stateWrites).toBe(writes)
})

test('/godmode report with no ticket the person said go for suggests the next ones to say go for', async ($, on) => {
  const project = await startProject($, on)
  await ticket(project, 'Search box', 'todo')
  await ticket(project, 'Filters', 'todo')

  const report = await godmode($, 'report')

  expect(report.text).toContain('Next, once you say go: T-1 "Search box"; T-2 "Filters".')
  expect(report.text).toContain('godmode is off')
})

test('/godmode report lists the tickets waiting on QA with their signal, read as the prompt hook reads it', async ($, on) => {
  const project = await startProject($, on, {
    shared: { qaMode: 'human-pr', qaSignals: 'pr-approval', qaApprovers: 'alice' },
    reviews: [{ login: 'alice', state: 'APPROVED', commit: HEAD }],
  })
  await godmode($)
  const id = await ticket(project, 'Export button', 'qa', { pr: '12' })

  const report = await godmode($, 'report')

  expect(report.text).toContain('Tickets: 1 qa.')
  expect(report.text).toContain(
    `Waiting on QA:\nQA ${id} ("Export button"): alice approved PR #12's current commit a1b2c3d. That is a QA pass godmode saw but did not record: record it with ticket_move (id: ${id}, qaResult: passed).`,
  )
  // The PM records a result; the report does not.
  expect((await project.tickets.list({ statuses: ['qa'] }))[0]?.qaResult).toBeUndefined()
})

test('/godmode report says a QA approval at an older commit still waits', async ($, on) => {
  const project = await startProject($, on, {
    shared: { qaMode: 'human-pr', qaSignals: 'pr-approval', qaApprovers: 'alice' },
    reviews: [{ login: 'alice', state: 'APPROVED', commit: OLDER }],
  })
  await ticket(project, 'Export button', 'qa', { pr: '12' })

  const report = await godmode($, 'report')

  expect(report.text).toContain('QA T-1 ("Export button"): still waiting (approved at an older commit')
})

test('/godmode report carries the update notice', async ($, on) => {
  await startProject($, on, { pluginVersion: '0.3.0', noteVersion: '0.2.0' })

  const report = await godmode($, 'report')

  expect(report.text).toContain('A godmode update is available for this project\'s conventions (set up with 0.2.0, now 0.3.0)')
})

// ---------------------------------------------------------------------------
// Resume on `/godmode` (D57)

test('/godmode resumes each ticket in doing or review with one line, and tells the PM to pick each up', async ($, on) => {
  const project = await startProject($, on)
  const doing = await ticket(project, 'Report filters', 'doing', { ready: true, branch: 'godmode/t-1-report-filters' })
  const review = await ticket(project, 'Export button', 'review', { pr: 'https://github.com/acme/app/pull/12', branch: 'godmode/t-2-export-button' })
  await ticket(project, 'Search box', 'todo', { ready: true })
  await ticket(project, 'Dark mode', 'qa', { pr: '9' })
  await ticket(project, 'Old', 'done')
  project.world.files.set(`${WORKTREES}/${doing}/.git`, 'gitdir: x\n')
  project.commits.set(`${WORKTREES}/${doing}`, 'abc1234 add filter chips')
  dispatched(project, [doing, review])

  const answer = await godmode($)

  expect(answer.text?.split('\n')).toEqual([
    `Resuming ${doing} "Report filters", doing: worktree ${WORKTREES}/${doing}, last commit abc1234 "add filter chips".`,
    `Resuming ${review} "Export button", in review: branch godmode/t-2-export-button, PR #12.`,
  ])
  const told = answer.context?.find(text => text.startsWith('godmode resumed')) ?? ''
  expect(told).toContain(`- ${doing} (doing): dispatch one godmode:dev agent on ${doing}, briefed to read what its worktree holds and go on from its last commit (abc1234)`)
  expect(told).toContain(`- ${review} (review, PR #12): no review verdict at its current commit a1b2c3d. Dispatch one godmode:reviewer on PR #12`)
  // A ticket waiting on QA has no dev agent to restart, and switching on shows no QA line.
  expect(answer.text).not.toContain('Dark mode')
  expect(told).not.toContain('T-4')
  expect(answer.text).not.toContain('QA')
})

test('/godmode reads a review verdict at the PR\'s current commit into the resume', async ($, on) => {
  const project = await startProject($, on)
  const clean = await ticket(project, 'Export button', 'review', { pr: '12' })
  const changes = await ticket(project, 'Bump deps', 'review', { pr: '9' })
  dispatched(project, [clean, changes])
  project.store.set(`verdicts:${FIRST_COMMIT}`, {
    '12': { verdict: 'clean', headCommit: HEAD, at: '2026-10-16T09:00:00.000Z' },
    '9': { verdict: 'change-request', headCommit: 'e5f6a7b8c9', at: '2026-10-16T09:00:00.000Z' },
  })

  const told = (await godmode($)).context?.find(text => text.startsWith('godmode resumed')) ?? ''

  expect(told).toContain(`- ${clean} (review, PR #12): its review was clean at a1b2c3d. Go on from there, as the QA mode says.`)
  expect(told).toContain(`- ${changes} (review, PR #9): its review asked for changes at e5f6a7b (change-request). Start the fix round as usual.`)
})

test('/godmode does not resume a ticket whose dev agent of this session is still running', async ($, on) => {
  const project = await startProject($, on)
  await godmode($)
  const busy = await ticket(project, 'Report filters', 'doing', { ready: true })
  const idle = await ticket(project, 'Search box', 'doing', { ready: true })
  dispatched(project, [idle])
  await $.agent.spawn({ prompt: `Build ${busy}.`, description: 'Build', subagentType: 'godmode:dev' } as Parameters<typeof $.agent.spawn>[0])
  project.running = [running('agent-1', 'godmode:dev', 'Build')]
  await godmode($, 'off')

  const answer = await godmode($)

  expect(answer.text?.split('\n')).toEqual([`Resuming ${idle} "Search box", doing: no worktree yet.`])
})

test('/godmode resumes only the tickets this person\'s godmode dispatched, never a teammate\'s or a workflow\'s', async ($, on) => {
  const project = await startProject($, on)
  const mine = await ticket(project, 'Report filters', 'doing', { ready: true })
  const teammates = await ticket(project, 'Search box', 'doing', { ready: true })
  const workflows = await ticket(project, 'Dark mode', 'doing', { ready: true })
  dispatched(project, [mine])
  dispatched(project, [workflows], { isWorkflow: true })

  const answer = await godmode($)

  expect(answer.text?.split('\n')).toEqual([`Resuming ${mine} "Report filters", doing: no worktree yet.`])
  const told = answer.context?.find(text => text.startsWith('godmode resumed')) ?? ''
  expect(told).not.toContain(teammates)
  expect(told).not.toContain(workflows)
})

test('/godmode lists the tickets but holds the dispatch when it cannot list the running agents', async ($, on) => {
  const project = await startProject($, on)
  const doing = await ticket(project, 'Report filters', 'doing', { ready: true })
  dispatched(project, [doing])
  project.isAgentListBroken = true

  const answer = await godmode($)

  expect(answer.text).toContain(`Resuming ${doing}`)
  const told = answer.context?.find(text => text.startsWith('godmode resumed')) ?? ''
  expect(told).toContain('could not list the running agents')
  expect(told).toContain('Do not dispatch on any of it until you can check which agents run')
})

test('/godmode tells the PM to ask the person first when the ticket\'s last dev agent ended with a question', async ($, on) => {
  const project = await startProject($, on)
  await godmode($)
  const asked = await ticket(project, 'Report filters', 'doing', { ready: true })
  const done = await ticket(project, 'Search box', 'doing', { ready: true })
  await $.agent.spawn({ prompt: `Build ${asked}.`, description: 'Build', subagentType: 'godmode:dev' } as Parameters<typeof $.agent.spawn>[0])
  await $.agent.spawn({ prompt: `Build ${done}.`, description: 'Build', subagentType: 'godmode:dev' } as Parameters<typeof $.agent.spawn>[0])
  const notice = (id: string, result: string) =>
    `<task-notification>\n<task-id>${id}</task-id>\n<status>completed</status>\n<summary>Agent "Build" completed</summary>\n<result>${result}</result>\n</task-notification>`
  await $.session.receive({ origin: { kind: 'task-notification' }, text: notice('agent-1', 'The ticket says "export", and the code has two exports.\nShould it export the archived rows too?') } as Parameters<typeof $.session.receive>[0])
  await $.session.receive({ origin: { kind: 'task-notification' }, text: notice('agent-2', 'Committed the first half; the session ran out of time.') } as Parameters<typeof $.session.receive>[0])
  await godmode($, 'off')

  const told = (await godmode($)).context?.find(text => text.startsWith('godmode resumed')) ?? ''

  expect(told).toContain(`- ${asked} (doing): its last dev agent stopped to ask the person something`)
  expect(told).toContain('Ask the person first')
  expect(told).toContain(`- ${done} (doing): dispatch one godmode:dev agent on ${done}`)
})

test('/godmode reads a clean review with a QA agent fail at the same commit as a fix round', async ($, on) => {
  const project = await startProject($, on)
  const failed = await ticket(project, 'Export button', 'review', { pr: '12' })
  dispatched(project, [failed])
  project.store.set(`verdicts:${FIRST_COMMIT}`, { '12': { verdict: 'clean', headCommit: HEAD, at: '2026-10-16T09:00:00.000Z' } })
  project.store.set(`qaVerdicts:${FIRST_COMMIT}`, { [failed]: { result: 'fail', commit: HEAD, at: '2026-10-16T09:10:00.000Z' } })

  const told = (await godmode($)).context?.find(text => text.startsWith('godmode resumed')) ?? ''

  expect(told).toContain(`- ${failed} (review, PR #12): its review was clean at a1b2c3d, and the QA agent failed it there. Start the fix round`)
  expect(told).not.toContain('Go on from there')
})

test('/godmode with nothing in progress stays quiet', async ($, on) => {
  const project = await startProject($, on)
  await ticket(project, 'Search box', 'todo', { ready: true })
  await ticket(project, 'Dark mode', 'qa', { pr: '9' })

  const answer = await godmode($)

  expect(answer.text).toBeUndefined()
  expect(answer.context?.some(text => text.startsWith('godmode resumed'))).toBe(false)
})

// ---------------------------------------------------------------------------
// The update notice (D60)

test('/godmode on a note from an older godmode says so in one line beside the resume, and leaves the note as it was', async ($, on) => {
  const project = await startProject($, on, { pluginVersion: '0.3.0', noteVersion: '0.2.0' })
  const doing = await ticket(project, 'Report filters', 'doing', { ready: true })
  dispatched(project, [doing])
  const note = project.world.files.get(`${REPO}/.godmode/shared.json`)

  const answer = await godmode($)

  const lines = answer.text?.split('\n') ?? []
  expect(lines).toHaveLength(2)
  expect(lines[0]).toBe('A godmode update is available for this project\'s conventions (set up with 0.2.0, now 0.3.0): `/godmode audit` checks the setup and lists what is new.')
  expect(lines[1]).toContain(`Resuming ${doing}`)
  expect(project.world.files.get(`${REPO}/.godmode/shared.json`)).toBe(note)
  expect(note).toContain('"godmodeVersion": "0.2.0"')
})
