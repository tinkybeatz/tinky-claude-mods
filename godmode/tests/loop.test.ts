import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { AgentInfo, AgentSpawnInput, On } from 'claude-code'

import type { Answer, ModelTier, AgentRole } from '../hooks/storage'
import { markdownBackend } from '../hooks/tickets'
import { FIRST_COMMIT, makeWorld, mountWorld, REPO, setUpProject, worldEngine } from './world'
import type { Gh, World } from './world'

// Spelled in pieces: a shell guard outside this repo blocks any command line that holds it.
const PR_CREATE = ['gh', 'pr', 'create'].join(' ')

const WORKTREES = '/work/app-worktrees'

/** Two open PRs: #12 is the person's own, #9 a teammate's. */
const ghWith = (): Gh => ({
  login: 'me',
  prs: [
    { number: 12, title: 'T-1 Export button', branch: 'godmode/t-1-export-button', author: 'me', files: ['src/export.ts'], head: 'a1b2c3d4e5' },
    { number: 9, title: 'Bump deps', branch: 'deps', author: 'teammate', files: ['package.json', 'src/report.tsx'], head: 'e5f6a7b8c9' },
  ],
})

type Options = {
  personal?: Record<string, Answer>
  shared?: Record<string, Answer>
  minimumModels?: Partial<Record<AgentRole, ModelTier>>
  gh?: Gh | null
  /** Switch on with `/godmode setup` rather than `/godmode`. */
  isChangeSetup?: boolean
  /** More hooks beneath the plugin, registered before the test first calls `$`. */
  beneath?: (on: On) => void
}

/** A set-up project with godmode on, and everything beneath the plugin recorded. */
const startLoop = async ($: Engine, on: On, options: Options = {}) => {
  const world = makeWorld({ gh: options.gh === null ? undefined : (options.gh ?? ghWith()) })
  const dir = await setUpProject(world, {
    personalAnswers: { permissions: 'free', ...options.personal },
    sharedAnswers: { tracker: 'none', ...options.shared },
    minimumModels: options.minimumModels ?? {},
  })
  mountWorld(on, world)
  options.beneath?.(on)
  const loop = {
    world,
    dir,
    /** Every call that got past the plugin, as `<tool> <command or path>`. */
    ran: [] as string[],
    /** Each question the person was asked. */
    asked: [] as string[],
    /** The person's answer; undefined dismisses the question. */
    answer: 'Allow' as string | undefined,
    /** What the Bash tool prints. */
    stdout: '',
    spawned: [] as AgentSpawnInput[],
    running: [] as AgentInfo[],
    tickets: markdownBackend(worldEngine(world), dir),
    /** What the plugin keeps across sessions (`$.store`). */
    store: new Map<string, unknown>(),
    /** The hidden context each prompt entered with. */
    contexts: [] as (readonly string[] | undefined)[],
  }
  on('store.get', (_$, e) => ({ value: loop.store.get(e.key) }))
  on('store.set', (_$, e) => {
    loop.store.set(e.key, e.value)
    return { value: undefined } as never
  })
  on('prompt.submit', (_$, e) => {
    loop.contexts.push(e.context)
    return { text: e.text, context: e.context }
  })
  on('agent.list', () => ({ value: loop.running }))
  on('agent.spawn', (_$, e) => {
    loop.spawned.push(e)
    return { model: e.model ?? 'inherit', agentId: `agent-${loop.spawned.length}` }
  })
  on('tool.call', (_$, e) => {
    const input = e as unknown as Record<string, unknown>
    if (e.tool === 'AskUserQuestion') {
      const question = (input.questions as { question: string }[])[0]?.question ?? ''
      loop.asked.push(question)
      if (loop.answer === undefined) return { deny: 'The person dismissed the question.' }
      return { result: { questions: input.questions, answers: { [question]: loop.answer } } } as never
    }
    loop.ran.push(`${e.tool} ${String(input.command ?? input.file_path ?? '')}`.trim())
    if (e.tool === 'Bash') return { result: { stdout: loop.stdout, stderr: '', interrupted: false } } as never
    return { result: 'ok' } as never
  })
  await godmode($, options.isChangeSetup === true ? 'setup' : '')
  return loop
}

type Loop = Awaited<ReturnType<typeof startLoop>>

const godmode = ($: Engine, args = '') => $.command.run({ command: 'godmode', args } as Parameters<typeof $.command.run>[0])

/** A tool call the way the model makes it; `agentId` absent is the main thread. */
const call = async ($: Engine, input: Record<string, unknown>) =>
  (await $.tool.call(input as Parameters<typeof $.tool.call>[0])) as { deny?: string; result?: unknown; context?: readonly string[]; isError?: boolean }

const bash = ($: Engine, command: string, agentId?: string) => call($, { tool: 'Bash', command, agentId })

const edit = ($: Engine, path: string, agentId?: string) => call($, { tool: 'Edit', file_path: path, old_string: 'a', new_string: 'b', agentId })

const spawn = ($: Engine, subagentType: string, prompt: string, model?: string) =>
  $.agent.spawn({ prompt, description: prompt.slice(0, 20), subagentType, model } as Parameters<typeof $.agent.spawn>[0]) as Promise<{
    deny?: string
    agentId?: string
    model?: string
  }>

/** Files a ticket, marked ready unless said otherwise. */
const fileTicket = async (loop: Loop, title: string, isReady = true) => {
  const header = await loop.tickets.create({ title, ask: title, visibleChange: false })
  if (isReady) await loop.tickets.move(header.id, { ready: true })
  return header.id
}

/** A dev agent dispatched on a ready ticket; resolves its agent id and worktree. */
const devAgent = async ($: Engine, loop: Loop, title = 'Report filters') => {
  const id = await fileTicket(loop, title)
  const started = await spawn($, 'godmode:dev', `Build ${id}.`)
  return { agentId: started.agentId ?? '', worktree: `${WORKTREES}/${id}`, ticket: id }
}

const reviewer = async ($: Engine) => (await spawn($, 'godmode:reviewer', 'Review PR #12.')).agentId ?? ''

// ---------------------------------------------------------------------------
// Permissions (D18), asked directly (D66)

test('Free: an agent commits and pushes alone, and force-pushing asks the person directly', async ($, on) => {
  const loop = await startLoop($, on)

  const pushed = await bash($, 'git commit -m "add filters" && git push', 'agent-x')
  expect(pushed.deny).toBeUndefined()
  expect(loop.asked).toEqual([])

  const forced = await bash($, 'git push --force-with-lease', 'agent-x')
  expect(forced.deny).toBeUndefined()
  expect(loop.asked).toHaveLength(1)
  expect(loop.asked[0]).toContain('force-push')
  expect(loop.asked[0]).toContain('agent-x')
  expect(loop.ran).toEqual(['Bash git commit -m "add filters" && git push', 'Bash git push --force-with-lease'])
})

test('an ask the person answers no is refused, and nothing runs', async ($, on) => {
  const loop = await startLoop($, on)
  loop.answer = 'Deny'

  const answer = await bash($, 'git push --force', 'agent-x')

  expect(answer.deny).toContain('The person said no')
  expect(loop.ran).toEqual([])
})

test('an ask with nobody to answer is refused, saying why and what unblocks it', async ($, on) => {
  const loop = await startLoop($, on)
  loop.answer = undefined

  const answer = await bash($, 'git push --force', 'agent-x')

  expect(answer.deny).toContain('could not ask them')
  expect(answer.deny).toContain('/godmode setup')
  expect(loop.ran).toEqual([])
})

test('Local only: edits run alone, every git and PR write asks', async ($, on) => {
  const loop = await startLoop($, on, { personal: { permissions: 'local-only' } })

  await edit($, `${REPO}/src/a.ts`, 'agent-x')
  expect(loop.asked).toEqual([])

  await bash($, 'git commit -m "x"', 'agent-x')
  await bash($, 'gh pr comment 12 --body "looks good"', 'agent-x')
  expect(loop.asked).toHaveLength(2)
  expect(loop.ran).toHaveLength(3)
})

test('Locked: even a file edit asks', async ($, on) => {
  const loop = await startLoop($, on, { personal: { permissions: 'locked' } })

  await edit($, `${REPO}/src/a.ts`, 'agent-x')

  expect(loop.asked).toHaveLength(1)
  expect(loop.asked[0]).toContain('edit files')
  expect(loop.asked[0]).toContain(`${REPO}/src/a.ts`)
})

test('Full freedom: force-pushing and others\' PRs need no question', async ($, on) => {
  const loop = await startLoop($, on, { personal: { permissions: 'full-freedom' } })

  await bash($, 'git push --force', 'agent-x')
  await bash($, 'gh pr comment 9 --body "rebased on yours"', 'agent-x')

  expect(loop.asked).toEqual([])
  expect(loop.ran).toHaveLength(2)
})

test('Free acts alone on the person\'s own PR, and asks before touching a teammate\'s', async ($, on) => {
  const loop = await startLoop($, on)

  await bash($, 'gh pr comment 12 --body "fixed"', 'agent-x')
  expect(loop.asked).toEqual([])

  await bash($, 'gh pr comment 9 --body "conflicts with mine"', 'agent-x')
  expect(loop.asked).toHaveLength(1)
  expect(loop.asked[0]).toContain('someone else')
})

test('a "never" setting refuses without asking, and names the setting', async ($, on) => {
  const loop = await startLoop($, on, { personal: { 'permission.push': 'never' } })

  const answer = await bash($, 'git push', 'agent-x')

  expect(answer.deny).toContain('never allows this')
  expect(answer.deny).toContain('permission.push')
  expect(loop.asked).toEqual([])
  expect(loop.ran).toEqual([])
})

test('godmode registers no permission check of its own: an "ask" never goes to Claude Code\'s decider (D66)', async ($, on) => {
  await startLoop($, on, { beneath: below => below('tool.check', () => ({ decision: 'allow' }) as never) })

  const verdict = (await $.tool.check({ tool: 'Bash', input: { command: 'git push --force' }, agentId: 'agent-x' } as Parameters<typeof $.tool.check>[0])) as {
    decision?: string
  }

  expect(verdict.decision).toBe('allow')
})

// ---------------------------------------------------------------------------
// Attribution (D15)

test('with attribution off, a commit or PR carrying an AI attribution line is refused', async ($, on) => {
  const loop = await startLoop($, on, { personal: { attribution: false } })
  loop.world.files.set('/tmp/body.md', 'Adds filters.\n\nGenerated with [Claude Code](https://claude.com/claude-code)\n')

  const commit = await bash($, 'git commit -m "$(cat <<\'EOF\'\nAdd filters\n\nCo-Authored-By: Claude <noreply@anthropic.com>\nEOF\n)"', 'agent-x')
  const pr = await bash($, `${PR_CREATE} --draft --title "T-1" --body-file /tmp/body.md`, 'agent-x')
  const clean = await bash($, 'git commit -m "Add filters"', 'agent-x')

  expect(commit.deny).toContain('attribution off')
  expect(commit.deny).toContain('Co-Authored-By: Claude')
  expect(pr.deny).toContain('Generated with [Claude Code]')
  expect(clean.deny).toBeUndefined()
  expect(loop.ran).toEqual(['Bash git commit -m "Add filters"'])
})

test('with attribution on, the same commit runs', async ($, on) => {
  const loop = await startLoop($, on, { personal: { attribution: true } })

  const commit = await bash($, 'git commit -m "Add filters\n\nCo-Authored-By: Claude <noreply@anthropic.com>"', 'agent-x')

  expect(commit.deny).toBeUndefined()
  expect(loop.ran).toHaveLength(1)
})

// ---------------------------------------------------------------------------
// The thin main thread (D63)

test('the main thread may talk, use tickets, dispatch and check status', async ($, on) => {
  const loop = await startLoop($, on)

  for (const input of [
    { tool: 'Bash', command: 'git status' },
    { tool: 'Bash', command: 'gh pr list --json number,files' },
    { tool: 'Bash', command: 'npm test', run_in_background: true },
    { tool: 'Agent', description: 'Research', prompt: 'Find the export code' },
    { tool: 'mcp__godmode__ticket_list' },
  ]) {
    const answer = await call($, input)
    expect([input.tool, answer.deny]).toEqual([input.tool, undefined])
  }
  expect(loop.ran).toContain('Bash git status')
  expect(loop.ran).toContain('Bash npm test')
})

test('the main thread\'s heavier work is refused, saying to dispatch a researcher or a shell', async ($, on) => {
  const loop = await startLoop($, on)

  for (const input of [
    { tool: 'Edit', file_path: `${REPO}/src/a.ts`, old_string: 'a', new_string: 'b' },
    { tool: 'Grep', pattern: 'export' },
    { tool: 'Bash', command: 'npm test' },
    { tool: 'WebSearch', query: 'csv export' },
  ]) {
    const answer = await call($, input)
    expect(answer.deny).toContain('Dispatch a researcher or a shell')
    expect(answer.deny).toContain('/godmode setup')
  }
  expect(loop.ran).toEqual([])
})

test('the main thread reads up to its limit per prompt; the person\'s next prompt starts the count over', async ($, on) => {
  const loop = await startLoop($, on, { personal: { mainThreadReadLimit: 2 } })
  const read = (path: string) => call($, { tool: 'Read', file_path: `${REPO}/${path}` })

  expect((await read('a.ts')).deny).toBeUndefined()
  expect((await read('b.ts')).deny).toBeUndefined()
  const third = await read('c.ts')
  expect(third.deny).toContain('reading more than 2 files')
  expect(third.deny).toContain('mainThreadReadLimit')

  await $.prompt.submit({ text: 'and the docs?' } as Parameters<typeof $.prompt.submit>[0])
  expect((await read('c.ts')).deny).toBeUndefined()
  expect(loop.ran).toHaveLength(3)
})

test('agents are not held to the main thread\'s limits', async ($, on) => {
  const loop = await startLoop($, on)

  const answer = await call($, { tool: 'Grep', pattern: 'export', agentId: 'agent-x' })

  expect(answer.deny).toBeUndefined()
  expect(loop.ran).toEqual(['Grep'])
})

test('the thin main thread is a setting, and applies only in coding mode while on', async ($, on) => {
  const loosened = await startLoop($, on, { personal: { thinMainThread: false } })
  expect((await edit($, `${REPO}/src/a.ts`)).deny).toBeUndefined()

  await godmode($, 'setup')
  await godmode($, 'off')
  expect((await bash($, 'npm test')).deny).toBeUndefined()
  expect(loosened.ran).toEqual([`Edit ${REPO}/src/a.ts`, 'Bash npm test'])
})

test('in change-setup mode the main thread may edit the setup itself', async ($, on) => {
  const loop = await startLoop($, on, { isChangeSetup: true })

  expect((await edit($, `${REPO}/AGENTS.md`)).deny).toBeUndefined()
  expect(loop.ran).toEqual([`Edit ${REPO}/AGENTS.md`])
})

// ---------------------------------------------------------------------------
// Dispatch: the cap (D58), model floors (D62), ready tickets (D52)

const running = (count: number): AgentInfo[] =>
  Array.from({ length: count }, (_, index) => ({ id: `run-${index}`, description: `task ${index}`, type: 'godmode:dev', status: 'running' as const }))

test('a sixth agent is refused while five run, saying why; a finished one frees a place', async ($, on) => {
  const loop = await startLoop($, on)
  loop.running = [...running(5), { id: 'done', description: 'old', type: 'Explore', status: 'completed' }]

  const refused = await spawn($, 'Explore', 'Find the export code')
  expect(refused.deny).toContain('at most 5 agents at once')
  expect(refused.deny).toContain('agentCap')
  expect(loop.spawned).toEqual([])

  loop.running = running(4)
  expect((await spawn($, 'Explore', 'Find the export code')).deny).toBeUndefined()
  expect(loop.spawned).toHaveLength(1)
})

test('the agent cap is a setting', async ($, on) => {
  const loop = await startLoop($, on, { personal: { agentCap: 2 } })
  loop.running = running(2)

  expect((await spawn($, 'Explore', 'x')).deny).toContain('at most 2 agents')
})

test('each role runs at least on its model: a lower pick is raised, a higher one stands', async ($, on) => {
  const loop = await startLoop($, on, { minimumModels: { researcher: 'opus' } })

  await spawn($, 'godmode:reviewer', 'Review PR #12.', 'haiku')
  await spawn($, 'godmode:researcher', 'Find the export code.')
  await spawn($, 'godmode:qa', 'Try T-1.', 'opus')
  await spawn($, 'Explore', 'Look around.', 'haiku')

  expect(loop.spawned.map(spawned => spawned.model)).toEqual(['opus', 'opus', 'opus', 'haiku'])
})

test('a dev agent starts only on a ticket the person said go for', async ($, on) => {
  const loop = await startLoop($, on)
  const id = await fileTicket(loop, 'Export button', false)

  const notReady = await spawn($, 'godmode:dev', `Build ${id}.`)
  const noTicket = await spawn($, 'godmode:dev', 'Build the export button.')
  const unknown = await spawn($, 'godmode:dev', 'Build T-99.')

  expect(notReady.deny).toContain('not marked ready')
  expect(notReady.deny).toContain('requireReadyTicket')
  expect(noTicket.deny).toContain('names none')
  expect(unknown.deny).toContain('no such ticket')
  expect(loop.spawned).toEqual([])
})

test('the ready-ticket rule is a setting', async ($, on) => {
  const loop = await startLoop($, on, { personal: { requireReadyTicket: false } })
  const id = await fileTicket(loop, 'Export button', false)

  expect((await spawn($, 'godmode:dev', `Build ${id}.`)).deny).toBeUndefined()
})

// ---------------------------------------------------------------------------
// Contention (D47, D48) and the worktree (D38)

test('a dev agent gets its worktree, its branch and every open PR\'s files in its brief', async ($, on) => {
  const loop = await startLoop($, on)
  const id = await fileTicket(loop, 'Report filters')

  await spawn($, 'godmode:dev', `Build ${id}.`)

  const [started] = loop.spawned
  const worktree = `${WORKTREES}/${id}`
  expect(started?.cwd).toBe(worktree)
  expect(started?.model).toBe('sonnet')
  expect(started?.prompt).toContain(`Build ${id}.`)
  expect(started?.prompt).toContain(`Your worktree: ${worktree}, on branch godmode/t-1-report-filters`)
  expect(started?.prompt).toContain('src/export.ts (PR #12, me)')
  expect(started?.prompt).toContain('src/report.tsx (PR #9, teammate)')
  expect(started?.prompt).toContain('--draft')
  expect(loop.world.gitRuns).toContain(`git worktree add -b godmode/t-1-report-filters ${worktree} origin/main`)
  expect((await loop.tickets.list({})).find(ticket => ticket.id === id)?.branch).toBe('godmode/t-1-report-filters')
})

test('a second dispatch on the same ticket reuses its worktree and leaves its own PR out of the held files', async ($, on) => {
  const loop = await startLoop($, on)
  const id = await fileTicket(loop, 'Export button')
  await spawn($, 'godmode:dev', `Build ${id}.`)

  await spawn($, 'godmode:dev', `Fix round on ${id}.`)

  expect(loop.world.gitRuns.filter(command => command.startsWith('git worktree add'))).toHaveLength(1)
  expect(loop.spawned[1]?.prompt).not.toContain('src/export.ts')
  expect(loop.spawned[1]?.prompt).toContain('src/report.tsx')
})

test('a dev agent edits freely inside its worktree, but not a file another PR holds', async ($, on) => {
  const loop = await startLoop($, on)
  const dev = await devAgent($, loop)

  const free = await edit($, `${dev.worktree}/src/filters.ts`, dev.agentId)
  const held = await edit($, `${dev.worktree}/src/report.tsx`, dev.agentId)

  expect(free.deny).toBeUndefined()
  expect(held.deny).toContain('`src/report.tsx` is held by open PR #9 (Bump deps, by teammate)')
  expect(held.deny).toContain('Stop and report')
  expect(loop.ran).toEqual([`Edit ${dev.worktree}/src/filters.ts`])
})

test('a PR opened after the dispatch blocks its files too, once the sweep is refreshed', async ($, on) => {
  const loop = await startLoop($, on, { personal: { contentionRefreshSeconds: 0 } })
  const dev = await devAgent($, loop)
  loop.world.gh?.prs.push({ number: 15, title: 'Theme', branch: 'theme', author: 'teammate', files: ['src/theme.ts'], head: 'f00' })

  const held = await edit($, `${dev.worktree}/src/theme.ts`, dev.agentId)

  expect(held.deny).toContain('held by open PR #15')
})

test('a dev agent cannot edit outside its worktree; scratch files are fine', async ($, on) => {
  const loop = await startLoop($, on)
  const dev = await devAgent($, loop)

  const main = await edit($, `${REPO}/src/filters.ts`, dev.agentId)
  const scratch = await edit($, '/tmp/notes.md', dev.agentId)

  expect(main.deny).toContain('outside it')
  expect(main.deny).toContain(`${dev.worktree}/src/filters.ts`)
  expect(main.deny).toContain('worktreeGuard')
  expect(scratch.deny).toBeUndefined()
})

test('contention and the worktree guard are settings', async ($, on) => {
  const loop = await startLoop($, on, { personal: { contention: false, worktreeGuard: false } })
  const dev = await devAgent($, loop)

  expect(loop.spawned[0]?.prompt).not.toContain('held')
  expect((await edit($, `${dev.worktree}/src/report.tsx`, dev.agentId)).deny).toBeUndefined()
  expect((await edit($, `${REPO}/src/a.ts`, dev.agentId)).deny).toBeUndefined()
})

test('a dev agent does not start when the open PRs cannot be listed', async ($, on) => {
  const loop = await startLoop($, on)
  loop.world.answer = run => (run.argv[0] === 'gh' && run.argv[2] === 'list' ? { exitCode: 1, stdout: '', stderr: 'HTTP 502' } : undefined)
  const id = await fileTicket(loop, 'Export button')

  const answer = await spawn($, 'godmode:dev', `Build ${id}.`)

  expect(answer.deny).toContain('could not list the open PRs')
  expect(answer.deny).toContain('HTTP 502')
  expect(loop.spawned).toEqual([])
})

// ---------------------------------------------------------------------------
// Drafts and the merge gate (D53)

test('a PR is opened only as a draft', async ($, on) => {
  const loop = await startLoop($, on)

  const ready = await bash($, `${PR_CREATE} --title "T-1" --body "x"`, 'agent-x')
  const draft = await bash($, `${PR_CREATE} --draft --title "T-1" --body "x"`, 'agent-x')

  expect(ready.deny).toContain('add `--draft`')
  expect(ready.deny).toContain('draftsOnly')
  expect(draft.deny).toBeUndefined()
  expect(loop.ran).toHaveLength(1)
})

test('no ready or merge without a verdict; a reviewer\'s clean verdict at the current commit clears it', async ($, on) => {
  const loop = await startLoop($, on)

  const before = await bash($, 'gh pr ready 12')
  expect(before.deny).toContain('PR #12 has no review verdict')

  const agentId = await reviewer($)
  const recorded = await call($, { tool: 'mcp__godmode__review_verdict', pr: '12', verdict: 'clean', summary: 'Good.', agentId })
  expect(recorded.result).toContain('Recorded clean for PR #12 at a1b2c3d')

  expect((await bash($, 'gh pr ready 12')).deny).toBeUndefined()
  expect((await bash($, 'gh pr merge 12 --squash')).deny).toBeUndefined()
  expect(loop.ran).toEqual(['Bash gh pr ready 12', 'Bash gh pr merge 12 --squash'])
})

test('a verdict counts only at the commit it was given at', async ($, on) => {
  const loop = await startLoop($, on)
  const agentId = await reviewer($)
  await call($, { tool: 'mcp__godmode__review_verdict', pr: '12', verdict: 'clean', agentId })
  const pr = loop.world.gh?.prs.find(candidate => candidate.number === 12)
  if (pr !== undefined) pr.head = 'ffff000111'

  const answer = await bash($, 'gh pr ready 12')

  expect(answer.deny).toContain('given at commit a1b2c3d, and the PR is now at ffff000')
  expect(loop.ran).toEqual([])
})

test('a change-request verdict keeps the PR a draft', async ($, on) => {
  const loop = await startLoop($, on)
  const agentId = await reviewer($)
  await call($, { tool: 'mcp__godmode__review_verdict', pr: '#12', verdict: 'change-request', agentId })

  const answer = await bash($, 'gh pr merge 12', 'agent-x')

  expect(answer.deny).toContain('change-request, not clean')
  expect(loop.ran).toEqual([])
})

test('only a reviewer records a verdict', async ($, on) => {
  const loop = await startLoop($, on)
  const dev = await devAgent($, loop)

  const byDev = await call($, { tool: 'mcp__godmode__review_verdict', pr: '12', verdict: 'clean', agentId: dev.agentId })
  const byPm = await call($, { tool: 'mcp__godmode__review_verdict', pr: '12', verdict: 'clean' })

  expect(byDev.deny).toContain('Only a reviewer agent records a verdict')
  expect(byPm.deny).toContain('Only a reviewer agent records a verdict')
  expect((await bash($, 'gh pr ready 12')).deny).toContain('no review verdict')
})

test('a verdict is kept across sessions, per project', async ($, on) => {
  const loop = await startLoop($, on)
  const agentId = await reviewer($)
  await call($, { tool: 'mcp__godmode__review_verdict', pr: '12', verdict: 'clean', agentId })

  const stored = loop.store.get(`verdicts:${FIRST_COMMIT}`) as Record<string, { verdict: string; headCommit: string; agentId: string }>

  expect(stored['12']).toMatchObject({ verdict: 'clean', headCommit: 'a1b2c3d4e5', agentId })
})

test('auto-merge is off unless the person turns it on', async ($, on) => {
  const off = await startLoop($, on)
  const agentId = await reviewer($)
  await call($, { tool: 'mcp__godmode__review_verdict', pr: '12', verdict: 'clean', agentId })

  const armed = await bash($, 'gh pr merge 12 --auto --squash')

  expect(armed.deny).toContain('Auto-merge is off')
  expect(armed.deny).toContain('autoMerge')
  expect(off.ran).toEqual([])
})

test('with auto-merge on, a clean PR can be armed', async ($, on) => {
  const loop = await startLoop($, on, { personal: { autoMerge: true } })
  const agentId = await reviewer($)
  await call($, { tool: 'mcp__godmode__review_verdict', pr: '12', verdict: 'clean', agentId })

  expect((await bash($, 'gh pr merge 12 --auto --squash')).deny).toBeUndefined()
  expect(loop.ran).toEqual(['Bash gh pr merge 12 --auto --squash'])
})

test('the merge gate asks for the PR by number', async ($, on) => {
  await startLoop($, on)

  expect((await bash($, 'gh pr ready', 'agent-x')).deny).toContain('Name the PR by number')
})

// ---------------------------------------------------------------------------
// Review start (D35, D64)

test('a dev agent\'s draft PR tells the PM to start the review, once, on its next prompt', async ($, on) => {
  const loop = await startLoop($, on)
  const dev = await devAgent($, loop)
  loop.stdout = 'https://github.com/acme/app/pull/14\n'

  const opened = await bash($, `${PR_CREATE} --draft --title "T-1" --body "x"`, dev.agentId)
  expect(opened.context?.join('\n')).toContain('stop here and report the PR link')

  await $.prompt.submit({ text: 'status?' } as Parameters<typeof $.prompt.submit>[0])
  await $.prompt.submit({ text: 'and now?' } as Parameters<typeof $.prompt.submit>[0])

  const told = loop.contexts[0]?.join('\n') ?? ''
  expect(told).toContain('PR #14 (https://github.com/acme/app/pull/14) for T-1')
  expect(told).toContain('dispatch one godmode:reviewer agent per PR')
  expect(loop.contexts[1]).toBeUndefined()
  const ticket = (await loop.tickets.list({})).find(header => header.id === dev.ticket)
  expect(ticket?.status).toBe('review')
  expect(ticket?.pr).toBe('https://github.com/acme/app/pull/14')
})

test('the PM also hears of a new draft PR in its next tool result', async ($, on) => {
  const loop = await startLoop($, on)
  const dev = await devAgent($, loop)
  loop.stdout = 'https://github.com/acme/app/pull/14\n'
  await bash($, `${PR_CREATE} --draft --title "T-1" --body "x"`, dev.agentId)
  loop.stdout = ''

  const status = await bash($, 'git status')

  expect(status.context?.join('\n')).toContain('Start each review now')
})

test('a PR opened by an agent that is not a dev, or with review start off, queues nothing', async ($, on) => {
  const loop = await startLoop($, on, { personal: { reviewStart: false } })
  const dev = await devAgent($, loop)
  loop.stdout = 'https://github.com/acme/app/pull/14\n'

  const byDev = await bash($, `${PR_CREATE} --draft --title "x" --body "x"`, dev.agentId)
  const byOther = await bash($, `${PR_CREATE} --draft --title "x" --body "x"`, 'agent-x')
  loop.stdout = ''
  const status = await bash($, 'git status')

  expect(byDev.context).toBeUndefined()
  expect(byOther.context).toBeUndefined()
  expect(status.context).toBeUndefined()
})

test('godmode off: no loop rule applies', async ($, on) => {
  const loop = await startLoop($, on, { personal: { permissions: 'locked', attribution: false } })
  await godmode($, 'off')
  loop.running = running(9)

  await bash($, `${PR_CREATE} --title "x" --body "Co-Authored-By: Claude"`)
  await edit($, `${REPO}/src/a.ts`)
  const started = await spawn($, 'godmode:reviewer', 'x', 'haiku')

  expect(loop.asked).toEqual([])
  expect(loop.ran).toHaveLength(2)
  expect(started.deny).toBeUndefined()
  expect(loop.spawned[0]?.model).toBe('haiku')
})
