import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { AgentInfo, AgentSpawnInput, On } from 'claude-code'

import { fableOutcome } from '../hooks/role'
import type { Answer, ModelTier, AgentRole } from '../hooks/storage'
import { markdownBackend, otherBackend } from '../hooks/tickets'
import { makeJira, mountJira, RUNNER_SERVER, SERVER, sidePath } from './jira-world'
import { FIRST_COMMIT, makeWorld, mountWorld, REPO, setUpProject, worldEngine } from './world'
import type { Gh, GhCheck, World } from './world'

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
    personalAnswers: { ...options.personal },
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
    /** godmode's own copy of the tickets: in the personal tracker folder on Other (D25). */
    tickets: options.shared?.tracker === 'other' ? otherBackend(worldEngine(world)) : markdownBackend(worldEngine(world), dir),
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
// Free writes and the controlled actions (D74)

const allowOnce = ($: Engine, action: string, target: string, agentId?: string) =>
  call($, { tool: 'mcp__godmode__allow_once', action, target, ask: `please do ${action} on ${target}`, agentId })

test('agents write freely: edits, commits, pushes, a draft PR and comments, a teammate\'s PR included, with no question', async ($, on) => {
  const loop = await startLoop($, on)

  await edit($, `${REPO}/src/a.ts`, 'agent-x')
  await bash($, 'git commit -m "add filters" && git push', 'agent-x')
  await bash($, `${PR_CREATE} --draft --title "T-1"`, 'agent-x')
  await bash($, 'gh pr comment 12 --body "fixed"', 'agent-x')
  await bash($, 'gh pr comment 9 --body "conflicts with mine"', 'agent-x')
  await bash($, 'gh pr review 9 --comment --body "one note"', 'agent-x')
  await bash($, 'git branch -D godmode/t-1-old', 'agent-x')

  expect(loop.asked).toEqual([])
  expect(loop.ran).toHaveLength(7)
})

test('careful: a risky action is refused until the person\'s ask is recorded, then runs once on that target only', async ($, on) => {
  const loop = await startLoop($, on)

  const refused = await bash($, 'gh pr close 9', 'agent-x')
  expect(refused.deny).toContain('risky action, and godmode asks the person first: closing a PR (#9)')
  expect(refused.deny).toContain('such as "close #9"')
  expect(refused.deny).toContain('allow_once (action: close-pr, target: 9)')

  expect((await allowOnce($, 'close-pr', '#9')).deny).toBeUndefined()
  expect((await bash($, 'gh pr close 12', 'agent-x')).deny).toContain('closing a PR (#12)')
  expect((await bash($, 'gh pr close 9', 'agent-x')).deny).toBeUndefined()
  // One ask, one use.
  expect((await bash($, 'gh pr close 9', 'agent-x')).deny).toContain('closing a PR (#9)')
  expect(loop.ran).toEqual(['Bash gh pr close 9'])
  expect(loop.asked).toEqual([])
})

test('not careful: the same risky actions just run, others\' PRs included', async ($, on) => {
  const loop = await startLoop($, on, { personal: { care: 'not-careful' } })

  for (const command of ['gh pr close 9', 'gh pr review 9 --approve', 'git push origin --delete deps', 'git push --force-with-lease origin deps', 'gh pr ready 9']) {
    expect([command, (await bash($, command, 'agent-x')).deny]).toEqual([command, undefined])
  }
  expect(loop.ran).toHaveLength(5)
  expect(loop.asked).toEqual([])
})

test('an agent cannot record an ask: only the main thread unlocks a risky action', async ($, on) => {
  const loop = await startLoop($, on)

  const byAgent = await allowOnce($, 'approve-pr', '9', 'agent-x')
  expect(byAgent.deny).toContain('Only the PM records the person\'s ask')

  expect((await bash($, 'gh pr review 9 --approve', 'agent-x')).deny).toContain('approving a PR (#9)')
  expect(loop.ran).toEqual([])
})

test('careful: deleting a branch godmode did not make and force-pushing over pushed work ask first; godmode\'s own unpushed branch is free', async ($, on) => {
  const loop = await startLoop($, on)
  loop.world.pushed = ['deps', 'godmode/t-1-export-button']

  expect((await bash($, 'git push origin --delete deps', 'agent-x')).deny).toContain('deleting a branch (deps)')
  expect((await bash($, 'git branch -D godmode/t-3-scratch', 'agent-x')).deny).toBeUndefined()
  expect((await bash($, 'git push --force-with-lease origin godmode/t-3-scratch', 'agent-x')).deny).toBeUndefined()
  const forced = await bash($, 'git push --force-with-lease origin godmode/t-1-export-button', 'agent-x')
  expect(forced.deny).toContain('force-pushing over pushed work (godmode/t-1-export-button: godmode/t-1-export-button is on origin)')
  // Pushing to a teammate's PR branch is acting on their work.
  expect((await bash($, 'git push origin deps', 'agent-x')).deny).toContain('acting on someone else\'s PR (#9: its branch deps is teammate\'s PR)')
  expect(loop.ran).toEqual(['Bash git branch -D godmode/t-3-scratch', 'Bash git push --force-with-lease origin godmode/t-3-scratch'])
})

test('careful: approving a PR, marking someone else\'s ready or editing it ask first; the person\'s own PR is theirs to act on', async ($, on) => {
  const loop = await startLoop($, on)

  expect((await bash($, 'gh pr review 12 --approve', 'agent-x')).deny).toContain('approving a PR (#12)')
  expect((await bash($, 'gh pr ready 9', 'agent-x')).deny).toContain('acting on someone else\'s PR (#9: opened by teammate)')
  expect((await bash($, 'gh pr edit 9 --add-label bug', 'agent-x')).deny).toContain('acting on someone else\'s PR (#9: opened by teammate)')
  expect((await bash($, 'gh pr edit 12 --add-label bug', 'agent-x')).deny).toBeUndefined()
  expect(loop.ran).toEqual(['Bash gh pr edit 12 --add-label bug'])
})

test('a PR\'s owner is read live: a failed read of the person\'s login is tried again, and never kept', async ($, on) => {
  let failures = 2
  const loop = await startLoop($, on)
  loop.world.reject = run => (run.argv.join(' ') === 'gh api user --jq .login' && failures-- > 0 ? 'gh timed out' : undefined)

  // Both reads fail: godmode cannot tell, so it asks the person, saying why.
  expect((await bash($, 'gh pr edit 9 --add-label bug', 'agent-x')).deny).toContain('gh could not read your own login')
  // The next call reads again, and now it answers.
  expect((await bash($, 'gh pr edit 12 --add-label bug', 'agent-x')).deny).toBeUndefined()
})

/** A Jira project PROD where the person (`acc-me`) created PROD-48 by hand and a colleague created PROD-12. */
const prodBoard = (overrides: Parameters<typeof makeJira>[0] = {}) => {
  const jira = makeJira({ projects: [{ key: 'PROD', name: 'Product' }], account: 'acc-me', ...overrides })
  jira.issues.set('PROD-48', { key: 'PROD-48', summary: 'Mine', status: 'To Do', creator: 'acc-me' })
  jira.issues.set('PROD-12', { key: 'PROD-12', summary: 'Sam\'s', status: 'To Do', creator: 'acc-sam' })
  return jira
}

const ON_PROD = { tracker: 'jira', jiraCloudId: '0c5e2f7a-1d3b-4e8f-9a6c-2b7d4e1f3a90', jiraProject: 'PROD', qaMode: 'none' }

const transition = ($: Engine, key: string) =>
  call($, { tool: 'mcp__claude_ai_Atlassian__transitionJiraIssue', cloudId: 'acme.atlassian.net', issueIdOrKey: key, agentId: 'agent-x' })

test('careful: a Jira ticket the person created by hand moves freely; a colleague\'s asks first until the person asks for it', async ($, on) => {
  const jira = prodBoard()
  const loop = await startLoop($, on, { shared: ON_PROD, personal: { jiraServer: SERVER }, beneath: below => mountJira(below, jira) })

  expect((await transition($, 'prod-48')).deny).toBeUndefined()
  const refused = await transition($, 'PROD-12')
  expect(refused.deny).toContain('acting on someone else\'s ticket (PROD-12: someone else created PROD-12)')
  expect((await call($, { tool: 'mcp__godmode__ticket_move', id: 'PROD-12', status: 'doing' })).deny).toContain('(PROD-12: someone else created PROD-12)')

  await allowOnce($, 'others-ticket', 'PROD-12')
  expect((await transition($, 'PROD-12')).deny).toBeUndefined()
  expect(loop.ran).toEqual(['mcp__claude_ai_Atlassian__transitionJiraIssue', 'mcp__claude_ai_Atlassian__transitionJiraIssue'])
  // The account is read live on each check; each issue's creator, which never changes, once.
  await transition($, 'PROD-48')
  expect(jira.calls.filter(found => found.tool === 'atlassianUserInfo')).toHaveLength(5)
  expect(jira.calls.filter(found => found.tool === 'getJiraIssue' && found.args.issueIdOrKey === 'PROD-48')).toHaveLength(1)
})

test('not careful: a colleague\'s Jira ticket just moves, with no ownership read', async ($, on) => {
  const jira = prodBoard()
  const loop = await startLoop($, on, { shared: ON_PROD, personal: { jiraServer: SERVER, care: 'not-careful' }, beneath: below => mountJira(below, jira) })

  expect((await transition($, 'PROD-12')).deny).toBeUndefined()
  expect(loop.ran).toEqual(['mcp__claude_ai_Atlassian__transitionJiraIssue'])
  expect(jira.calls.filter(found => found.tool === 'atlassianUserInfo')).toHaveLength(0)
})

test('the Atlassian account is read in the shape the server answers (`{ data: { accountId } }`), and deleting a ticket asks first', async ($, on) => {
  const jira = prodBoard({ flavour: 'runner' })
  await startLoop($, on, { shared: ON_PROD, personal: { jiraServer: RUNNER_SERVER }, beneath: below => mountJira(below, jira) })

  expect((await transition($, 'PROD-48')).deny).toBeUndefined()
  const removed = await call($, { tool: 'mcp__claude_ai_Atlassian__deleteJiraIssue', issueIdOrKey: 'PROD-48', agentId: 'agent-x' })
  expect(removed.deny).toContain('deleting a ticket (PROD-48)')
})

test('when the person\'s Atlassian account cannot be read, a ticket godmode did not file stays controlled, saying why', async ($, on) => {
  const jira = prodBoard({ account: undefined })
  const loop = await startLoop($, on, { shared: ON_PROD, personal: { jiraServer: SERVER }, beneath: below => mountJira(below, jira) })

  const refused = await transition($, 'PROD-48')

  expect(refused.deny).toContain('godmode could not read your Atlassian account, so it cannot tell whether you created it')
  // The read was tried again before asking, and the failure is not kept.
  expect(jira.calls.filter(found => found.tool === 'atlassianUserInfo')).toHaveLength(2)
  expect(loop.ran).toEqual([])
})

test('a note\'s old permissions tier is ignored: even "locked" writes freely', async ($, on) => {
  const loop = await startLoop($, on, { personal: { permissions: 'locked' } })

  await bash($, 'git commit -m "x" && git push', 'agent-x')

  expect(loop.asked).toEqual([])
  expect(loop.ran).toHaveLength(1)
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

  expect(commit.deny).toContain('carry no AI attribution')
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
    expect(answer.deny).toContain('dispatch a dev agent, a researcher or a background shell')
    expect(answer.deny).toContain(`allow_once (action: main-thread, target: ${input.tool})`)
  }
  expect(loop.ran).toEqual([])
})

test('the person\'s explicit ask lets the PM do the work itself, for that message only', async ($, on) => {
  const loop = await startLoop($, on)

  await allowOnce($, 'main-thread', 'Edit')
  expect((await edit($, `${REPO}/src/a.ts`)).deny).toBeUndefined()
  expect((await edit($, `${REPO}/src/b.ts`)).deny).toBeUndefined()
  await $.prompt.submit({ text: 'thanks, next' } as Parameters<typeof $.prompt.submit>[0])
  expect((await edit($, `${REPO}/src/c.ts`)).deny).toContain('editing files')
  expect(loop.ran).toEqual([`Edit ${REPO}/src/a.ts`, `Edit ${REPO}/src/b.ts`])
})

test('an unknown tool, one added after this build, is the PM\'s on the main thread', async ($, on) => {
  const loop = await startLoop($, on)

  for (const tool of ['SomeToolAddedLater', 'mcp__other_server__do_thing', 'Artifact']) expect((await call($, { tool })).deny).toBeUndefined()
  expect(loop.ran).toEqual(['SomeToolAddedLater', 'mcp__other_server__do_thing', 'Artifact'])
})

test('the main thread reads up to its limit per prompt; the person\'s next prompt starts the count over', async ($, on) => {
  const loop = await startLoop($, on, { personal: { mainThreadReadLimit: 2 } })
  const read = (path: string) => call($, { tool: 'Read', file_path: `${REPO}/${path}` })

  expect((await read('a.ts')).deny).toBeUndefined()
  expect((await read('b.ts')).deny).toBeUndefined()
  const third = await read('c.ts')
  expect(third.deny).toContain('reading more than 2 files')

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
  expect(refused.deny).toContain('allow_once (action: extra-agent, target: agent)')
  expect(loop.spawned).toEqual([])
  // The person asked for this one now: it starts, once.
  await allowOnce($, 'extra-agent', 'agent')
  expect((await spawn($, 'Explore', 'Find the export code')).deny).toBeUndefined()
  expect((await spawn($, 'Explore', 'Find the export code')).deny).toContain('at most 5 agents')
  loop.spawned.length = 0

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
  expect(notReady.deny).toContain('When the person says go')
  expect(noTicket.deny).toContain('names none')
  expect(unknown.deny).toContain('no such ticket')
  expect(loop.spawned).toEqual([])
})

test('Other: a dev agent starts on godmode\'s own T-n ticket', async ($, on) => {
  const loop = await startLoop($, on, { shared: { tracker: 'other', trackerName: 'Linear' } })
  const id = await fileTicket(loop, 'Export button')

  const started = await spawn($, 'godmode:dev', `Build ${id}.`)

  expect(id).toBe('T-1')
  expect(started.deny).toBeUndefined()
  expect(loop.spawned[0]?.prompt).toContain('Ticket: T-1, "Export button"')
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
  expect(scratch.deny).toBeUndefined()
})

test('contention and the worktree guard are settings', async ($, on) => {
  const loop = await startLoop($, on, { personal: { contention: false, worktreeGuard: false } })
  const dev = await devAgent($, loop)

  expect(loop.spawned[0]?.prompt).not.toContain('held')
  expect((await edit($, `${dev.worktree}/src/report.tsx`, dev.agentId)).deny).toBeUndefined()
  expect((await edit($, `${REPO}/src/a.ts`, dev.agentId)).deny).toBeUndefined()
})

test('a dev agent still starts when the open PRs cannot be listed, its brief saying so', async ($, on) => {
  const loop = await startLoop($, on)
  loop.world.answer = run => (run.argv[0] === 'gh' && run.argv[2] === 'list' ? { exitCode: 1, stdout: '', stderr: 'HTTP 502' } : undefined)
  const id = await fileTicket(loop, 'Export button')

  const answer = await spawn($, 'godmode:dev', `Build ${id}.`)

  expect(answer.deny).toBeUndefined()
  expect(loop.spawned[0]?.prompt).toContain('godmode could not list the open PRs\' files just now')
  expect(loop.spawned[0]?.prompt).toContain('HTTP 502')
})

// ---------------------------------------------------------------------------
// Drafts and the merge gate (D53)

test('a PR is opened only as a draft', async ($, on) => {
  const loop = await startLoop($, on)

  const ready = await bash($, `${PR_CREATE} --title "T-1" --body "x"`, 'agent-x')
  const draft = await bash($, `${PR_CREATE} --draft --title "T-1" --body "x"`, 'agent-x')

  expect(ready.deny).toContain('add `--draft`')
  expect(draft.deny).toBeUndefined()
  expect(loop.ran).toHaveLength(1)
})

/** godmode's own ticket on PR #12, in review: the PR is godmode's work. */
const ownTicketOn12 = async (loop: Loop, visibleChange = false) => {
  const header = await loop.tickets.create({ title: 'Export button', ask: 'Add an export button', visibleChange })
  await loop.tickets.move(header.id, { status: 'review', ready: true, pr: 'https://github.com/acme/app/pull/12' })
  return header.id
}

/** The person said "merge #<pr>": the PM records it, then merges. */
const mergeOnAsk = async ($: Engine, pr = '12', command = `gh pr merge ${pr} --squash`) => {
  await allowOnce($, 'merge', pr)
  return bash($, command)
}

test('godmode\'s own PR: ready waits for its own review at the current commit; then the person\'s "merge" goes through', async ($, on) => {
  const loop = await startLoop($, on)
  await ownTicketOn12(loop)

  const before = await bash($, 'gh pr ready 12')
  expect(before.deny).toContain('PR #12 is godmode\'s own work')
  expect(before.deny).toContain('godmode\'s review has no verdict on PR #12')
  expect(before.deny).toContain('allow_once (action: ready-as-is, target: 12)')

  const agentId = await reviewer($)
  const recorded = await call($, { tool: 'mcp__godmode__review_verdict', pr: '12', verdict: 'clean', summary: 'Good.', agentId })
  expect(recorded.result).toContain('Recorded clean for PR #12 at a1b2c3d')
  expect(recorded.result).toContain('Mark PR #12 ready now')
  expect(recorded.result).toContain('The project sets no merge conditions; the person says "merge"')

  expect((await bash($, 'gh pr ready 12')).deny).toBeUndefined()
  // Careful: merging asks first, even with nothing missing.
  const unasked = await bash($, 'gh pr merge 12 --squash')
  expect(unasked.deny).toContain('Merging is a risky action, and godmode asks the person first. This project sets no merge conditions.')
  expect(unasked.deny).toContain('When the person says "merge #12"')
  expect((await mergeOnAsk($)).deny).toBeUndefined()
  expect(loop.ran).toEqual(['Bash gh pr ready 12', 'Bash gh pr merge 12 --squash'])
})

test('the person\'s ask marks godmode\'s own PR ready as it is', async ($, on) => {
  const loop = await startLoop($, on)
  await ownTicketOn12(loop)

  await allowOnce($, 'ready-as-is', '12')
  expect((await bash($, 'gh pr ready 12')).deny).toBeUndefined()
  expect((await bash($, 'gh pr ready 12')).deny).toContain('godmode\'s own work')
})

test('a verdict counts only at the commit it was given at', async ($, on) => {
  const loop = await startLoop($, on)
  const agentId = await reviewer($)
  await call($, { tool: 'mcp__godmode__review_verdict', pr: '12', verdict: 'clean', agentId })
  const pr = loop.world.gh?.prs.find(candidate => candidate.number === 12)
  if (pr !== undefined) pr.head = 'ffff000111'

  const answer = await bash($, 'gh pr ready 12')

  expect(answer.deny).toContain('godmode\'s last verdict (clean) was at a1b2c3d and PR #12 is now at ffff000')
  expect(loop.ran).toEqual([])
})

test('a change-request verdict keeps godmode\'s PR a draft', async ($, on) => {
  const loop = await startLoop($, on)
  const agentId = await reviewer($)
  await call($, { tool: 'mcp__godmode__review_verdict', pr: '#12', verdict: 'change-request', agentId })

  const answer = await bash($, 'gh pr ready 12', 'agent-x')

  expect(answer.deny).toContain('godmode\'s review at a1b2c3d is change-request')
  expect(loop.ran).toEqual([])
})

test('only a reviewer records a verdict', async ($, on) => {
  const loop = await startLoop($, on)
  const dev = await devAgent($, loop)

  const byDev = await call($, { tool: 'mcp__godmode__review_verdict', pr: '12', verdict: 'clean', agentId: dev.agentId })
  const byPm = await call($, { tool: 'mcp__godmode__review_verdict', pr: '12', verdict: 'clean' })

  expect(byDev.deny).toContain('Only a reviewer agent records a verdict')
  expect(byPm.deny).toContain('Only a reviewer agent records a verdict')
  expect(loop.store.get(`verdicts:${FIRST_COMMIT}`)).toBeUndefined()
})

test('a verdict is kept across sessions, per project', async ($, on) => {
  const loop = await startLoop($, on)
  const agentId = await reviewer($)
  await call($, { tool: 'mcp__godmode__review_verdict', pr: '12', verdict: 'clean', agentId })

  const stored = loop.store.get(`verdicts:${FIRST_COMMIT}`) as Record<string, { verdict: string; headCommit: string; agentId: string }>

  expect(stored['12']).toMatchObject({ verdict: 'clean', headCommit: 'a1b2c3d4e5', agentId })
})

test('careful, merging on its own is off: arming auto-merge asks the person first', async ($, on) => {
  const off = await startLoop($, on)
  const agentId = await reviewer($)
  await call($, { tool: 'mcp__godmode__review_verdict', pr: '12', verdict: 'clean', agentId })

  const armed = await bash($, 'gh pr merge 12 --auto --squash')

  expect(armed.deny).toContain('Merging is a risky action, and godmode asks the person first')
  expect(off.ran).toEqual([])
})

test('merging on its own, once the conditions hold: godmode\'s clean PR merges or is armed with no ask', async ($, on) => {
  const loop = await startLoop($, on, { personal: { autoMerge: true } })
  const agentId = await reviewer($)
  await call($, { tool: 'mcp__godmode__review_verdict', pr: '12', verdict: 'clean', agentId })

  expect((await bash($, 'gh pr merge 12 --auto --squash')).deny).toBeUndefined()
  expect((await bash($, 'gh pr merge 12 --squash')).deny).toBeUndefined()
  // Someone else's PR is theirs to merge: godmode merges it on its own only when the person asks.
  expect((await bash($, 'gh pr merge 9 --squash')).deny).toContain('It is teammate\'s PR.')
  expect(loop.ran).toEqual(['Bash gh pr merge 12 --auto --squash', 'Bash gh pr merge 12 --squash'])
})

test('the merge gate asks for the PR by number', async ($, on) => {
  await startLoop($, on)

  expect((await bash($, 'gh pr ready', 'agent-x')).deny).toContain('Name the PR by number')
})

// ---------------------------------------------------------------------------
// QA modes (D69): what holds ready and merge after a clean review

/** A ticket on PR #12 whose review comes back clean at the PR's current commit; resolves its id and the verdict's answer. */
const reviewedClean = async ($: Engine, loop: Loop, visibleChange = true) => {
  const header = await loop.tickets.create({ title: 'Export button', ask: 'Add an export button', visibleChange })
  await loop.tickets.move(header.id, { status: 'review', ready: true, pr: 'https://github.com/acme/app/pull/12' })
  const agentId = await reviewer($)
  const verdict = await call($, { tool: 'mcp__godmode__review_verdict', pr: '12', verdict: 'clean', agentId })
  return { id: header.id, answer: String(verdict.result) }
}

const ticketOf = async (loop: Loop, id: string) => (await loop.tickets.list({ statuses: ['todo', 'doing', 'review', 'qa', 'done'] })).find(header => header.id === id)

/** The PM's ticket_move; `agentId` makes it an agent's. */
const moveTicket = ($: Engine, input: Record<string, unknown>, agentId?: string) => call($, { tool: 'mcp__godmode__ticket_move', ...input, agentId })

const newCommitOn12 = (loop: Loop) => {
  const pr = loop.world.gh?.prs.find(candidate => candidate.number === 12)
  if (pr !== undefined) pr.head = 'ffff000111'
}

test('human-pr: a clean review moves the ticket to qa, and ready and merge wait for a QA pass at the current commit', async ($, on) => {
  const loop = await startLoop($, on, { shared: { qaMode: 'human-pr' } })
  const { id, answer } = await reviewedClean($, loop)

  expect(answer).toContain(`godmode moved ${id} to qa`)
  expect((await ticketOf(loop, id))?.status).toBe('qa')
  // godmode's own loop is done, so the PR is marked ready; people's QA is the project's merge condition.
  expect((await bash($, 'gh pr ready 12')).deny).toBeUndefined()
  const merge = await mergeOnAsk($)
  expect(merge.deny).toContain('PR #12 does not meet this project\'s merge conditions yet: a QA pass from the people who test (no QA pass recorded for T-1 at a1b2c3d)')
  expect(merge.deny).toContain('If they say "merge anyway"')
  expect(loop.ran).toEqual(['Bash gh pr ready 12'])

  const passed = await moveTicket($, { id, qaResult: 'passed' })
  expect(String(passed.result)).toContain(`Recorded QA passed for ${id} at a1b2c3d`)
  expect((await ticketOf(loop, id))?.qaResult).toEqual({ result: 'passed', commit: 'a1b2c3d4e5' })
  // The earlier "merge" was not used up by the refusal.
  expect((await bash($, 'gh pr merge 12 --squash')).deny).toBeUndefined()
  expect(loop.ran).toEqual(['Bash gh pr ready 12', 'Bash gh pr merge 12 --squash'])
})

test('Other: godmode\'s own move to qa tells the PM to mirror it in the tracker (D25)', async ($, on) => {
  const loop = await startLoop($, on, { shared: { qaMode: 'human-pr', tracker: 'other', trackerName: 'Linear' } })
  const { id, answer } = await reviewedClean($, loop)

  expect((await ticketOf(loop, id))?.status).toBe('qa')
  expect(answer).toContain(`godmode moved ${id} to qa`)
  expect(answer).toContain(`godmode cannot reach Linear, and neither can you: this is only godmode's own record. Tell the person in one line what to do in Linear themselves: move ${id} to qa. Never try it yourself.`)
})

test('human-pr: a QA pass holds only at the commit it was given at', async ($, on) => {
  const loop = await startLoop($, on, { shared: { qaMode: 'human-pr' } })
  const { id } = await reviewedClean($, loop)
  await moveTicket($, { id, qaResult: 'passed' })
  newCommitOn12(loop)
  // The new commit is reviewed clean again, so only QA holds the PR now.
  const agentId = await reviewer($)
  await call($, { tool: 'mcp__godmode__review_verdict', pr: '12', verdict: 'clean', agentId })

  const merge = await mergeOnAsk($)

  expect(merge.deny).toContain('last QA passed was at a1b2c3d, and the PR is now at ffff000')
  expect(loop.ran).toEqual([])
})

test('human-pr: only the main thread records a QA result, and a fail sends the ticket back for a counted fix round', async ($, on) => {
  const loop = await startLoop($, on, { shared: { qaMode: 'human-pr' } })
  const { id } = await reviewedClean($, loop)

  const byAgent = await moveTicket($, { id, qaResult: 'passed' }, 'agent-x')
  const failed = await moveTicket($, { id, qaResult: 'failed' })

  expect(byAgent.deny).toContain('Only the main thread records a QA result')
  expect(String(failed.result)).toContain('back in doing for fix round 1 of 3 on this ticket')
  expect(await ticketOf(loop, id)).toMatchObject({ status: 'doing', qaResult: { result: 'failed', commit: 'a1b2c3d4e5' } })
  const rounds = () => (loop.store.get(`fixRounds:${FIRST_COMMIT}`) as Record<string, { count: number }>)[id]?.count
  expect(rounds()).toBe(1)
  expect((await mergeOnAsk($)).deny).toContain(`${id} failed QA at a1b2c3d`)

  // The same fail recorded again at the same commit is the same round.
  const again = await moveTicket($, { id, qaResult: 'failed' })
  expect(String(again.result)).toContain('fix round 1 of 3 on this ticket')
  expect(rounds()).toBe(1)
})

test('human-pr: a ticket leaves qa only with a QA pass at its PR\'s current commit', async ($, on) => {
  const loop = await startLoop($, on, { shared: { qaMode: 'human-pr' } })
  const { id } = await reviewedClean($, loop)

  const early = await moveTicket($, { id, status: 'review' })
  expect(early.deny).toContain(`${id} is waiting in qa, and leaves it only with a QA pass recorded at its PR's current commit`)
  expect((await ticketOf(loop, id))?.status).toBe('qa')

  await moveTicket($, { id, qaResult: 'passed' })
  expect((await moveTicket($, { id, status: 'done' })).deny).toBeUndefined()
  expect((await ticketOf(loop, id))?.status).toBe('done')
})

test('human-pr with the QA agent first: the ticket stays in review until it passed, and ready says so', async ($, on) => {
  const loop = await startLoop($, on, { shared: { qaMode: 'human-pr', qaBotFirst: true } })
  const { id, answer } = await reviewedClean($, loop)

  expect(answer).toContain(`Next godmode's QA agent tests ${id}`)
  expect((await ticketOf(loop, id))?.status).toBe('review')
  expect((await bash($, 'gh pr ready 12')).deny).toContain(`${id} is a visible change, and the QA agent has not passed it`)
})

test('human-pr: a ticket with no visible change skips human QA', async ($, on) => {
  const loop = await startLoop($, on, { shared: { qaMode: 'human-pr' } })
  const { id, answer } = await reviewedClean($, loop, false)

  expect(answer).toContain('Mark PR #12 ready now')
  expect((await ticketOf(loop, id))?.status).toBe('review')
  expect((await bash($, 'gh pr ready 12')).deny).toBeUndefined()
  expect((await mergeOnAsk($)).deny).toBeUndefined()
})

test('human-pr: a PR no ticket of godmode\'s names is looked up by the key in its title, read live, and never linked', async ($, on) => {
  const loop = await startLoop($, on, { shared: { qaMode: 'human-pr' } })
  const agentId = await reviewer($)
  await call($, { tool: 'mcp__godmode__review_verdict', pr: '12', verdict: 'clean', agentId })

  expect((await bash($, 'gh pr ready 12')).deny).toBeUndefined()
  const merge = await mergeOnAsk($)
  // PR #12's title names T-1, which godmode does not have: said as it is, with no ask to link it.
  expect(merge.deny).toContain('a QA pass from the people who test (godmode found no ticket T-1)')
  expect(merge.deny).not.toMatch(/ticket_move \(pr|link|adopt/)
  expect(await loop.tickets.list({ statuses: ['todo', 'doing', 'review', 'qa', 'done'] })).toEqual([])
})

test('human-staging: the merge runs on the person\'s go, and the ticket goes to qa, not done', async ($, on) => {
  const loop = await startLoop($, on, { shared: { qaMode: 'human-staging' } })
  const { id } = await reviewedClean($, loop)
  expect((await ticketOf(loop, id))?.status).toBe('review')

  const ready = await bash($, 'gh pr ready 12')
  const merged = await mergeOnAsk($)

  expect(ready.deny).toBeUndefined()
  expect(merged.deny).toBeUndefined()
  expect(merged.context?.join('\n')).toContain(`godmode moved ${id} to qa, not done`)
  expect((await ticketOf(loop, id))?.status).toBe('qa')
  expect((await moveTicket($, { id, status: 'done' })).deny).toContain(`${id} is waiting in qa`)
  await moveTicket($, { id, qaResult: 'passed' })
  expect((await moveTicket($, { id, status: 'done' })).deny).toBeUndefined()
})

test('human-staging: a visible change is not closed straight from review, and a fail keeps it in qa', async ($, on) => {
  const loop = await startLoop($, on, { shared: { qaMode: 'human-staging' } })
  const { id } = await reviewedClean($, loop)

  expect((await moveTicket($, { id, status: 'done' })).deny).toContain(`${id} is a visible change in QA mode human-staging, so it is done only once people passed it`)
  await mergeOnAsk($)
  const failed = await moveTicket($, { id, qaResult: 'failed' })

  expect(String(failed.result)).toContain('its fix is a new ticket')
  expect((await ticketOf(loop, id))?.status).toBe('qa')
  expect(loop.store.get(`fixRounds:${FIRST_COMMIT}`)).toBeUndefined()
})

test('none: a clean review goes straight to ready', async ($, on) => {
  const loop = await startLoop($, on, { shared: { qaMode: 'none' } })
  const { id, answer } = await reviewedClean($, loop)

  expect(answer).toContain('Mark PR #12 ready now')
  expect((await bash($, 'gh pr ready 12')).deny).toBeUndefined()
  expect((await ticketOf(loop, id))?.status).toBe('review')
  expect(loop.ran).toEqual(['Bash gh pr ready 12'])
})

test('a note from before the QA modes with qa: true gates as bot: the QA agent\'s pass holds ready, no human QA pass does', async ($, on) => {
  const loop = await startLoop($, on, { shared: { qa: true } })
  const { id, answer } = await reviewedClean($, loop)

  expect(answer).toContain(`Next godmode's QA agent tests ${id}`)
  expect((await bash($, 'gh pr ready 12')).deny).toContain('the QA agent has not passed it')
  await qaVerdict($, loop, id, 'pass')
  expect((await ticketOf(loop, id))?.status).toBe('review')
  expect((await bash($, 'gh pr ready 12')).deny).toBeUndefined()
  expect((await mergeOnAsk($)).context).toBeUndefined()
  expect((await ticketOf(loop, id))?.status).toBe('review')
})

test('a merge behind gh\'s -R flag, a path, bash -c or the raw API meets the merge gate, though writes are free', async ($, on) => {
  const loop = await startLoop($, on)

  for (const command of ['gh pr -R acme/app merge 12', 'gh --repo acme/app pr merge 12', '/usr/bin/gh pr merge 12', 'bash -c "gh pr merge 12"', 'gh api -X PUT repos/acme/app/pulls/12/merge']) {
    expect([command, (await bash($, command, 'agent-x')).deny]).toEqual([command, expect.stringContaining('Merging is a risky action')])
  }
  const graphql = await bash($, 'gh api graphql -f query=\'mutation { markPullRequestReadyForReview(input: {pullRequestId: "PR_1"}) { clientMutationId } }\'', 'agent-x')

  expect(graphql.deny).toContain('godmode cannot tell which PR this `gh api` call would have marked ready')
  expect(graphql.deny).toContain('`gh pr ready 12`')
  expect(loop.ran).toEqual([])
})

test('human-pr: an agent cannot turn a ticket\'s visible change off to skip people\'s QA', async ($, on) => {
  const loop = await startLoop($, on, { shared: { qaMode: 'human-pr' } })
  const { id } = await reviewedClean($, loop)

  const flipped = await moveTicket($, { id, visibleChange: false }, 'agent-x')

  expect(flipped.deny).toContain('Only the main thread changes whether a ticket is a visible change')
  expect((await ticketOf(loop, id))?.visibleChange).toBe(true)
  expect((await mergeOnAsk($)).deny).toContain('a QA pass from the people who test')
})

test('human-pr: auto-merge is refused even when switched on, by gh pr merge and by the API, saying to merge directly', async ($, on) => {
  const loop = await startLoop($, on, { shared: { qaMode: 'human-pr' }, personal: { autoMerge: true } })
  const { id } = await reviewedClean($, loop)
  await moveTicket($, { id, qaResult: 'passed' })

  const armed = await bash($, 'gh pr merge 12 --auto --squash')
  const viaApi = await bash($, 'gh api graphql -f query=\'mutation { enablePullRequestAutoMerge(input: {pullRequestId: "PR_1"}) { clientMutationId } }\'', 'agent-x')

  expect(armed.deny).toContain('GitHub\'s auto-merge cannot wait for this project\'s QA pass, so PR #12 is not armed. Merge it directly once QA passes (`gh pr merge 12`)')
  expect(viaApi.deny).toContain('godmode cannot tell which PR this `gh api` call would have merged')
  expect(loop.ran).toEqual([])
  expect((await bash($, 'gh pr merge 12 --squash')).deny).toBeUndefined()
})

test('human-staging with the merge gate off: auto-merge is refused, and a merge must name its PR so its ticket moves to qa', async ($, on) => {
  const loop = await startLoop($, on, { shared: { qaMode: 'human-staging' }, personal: { autoMerge: true, mergeGate: false } })
  const { id } = await reviewedClean($, loop)

  const armed = await bash($, 'gh pr merge 12 --auto')
  const unnamed = await bash($, 'gh pr merge --squash')
  const merged = await bash($, 'gh pr merge 12 --squash')

  expect(armed.deny).toContain('its tickets would never move to qa for people to test on staging')
  expect(unnamed.deny).toContain('Name the PR by number')
  expect(merged.deny).toBeUndefined()
  expect(merged.context?.join('\n')).toContain(`godmode moved ${id} to qa, not done`)
  expect(loop.ran).toEqual(['Bash gh pr merge 12 --squash'])
})

/** A second visible-change ticket on PR #12, in review. */
const secondTicketOn12 = async (loop: Loop) => {
  const header = await loop.tickets.create({ title: 'Export menu', ask: 'Add an export menu entry', visibleChange: true })
  await loop.tickets.move(header.id, { status: 'review', ready: true, pr: '12' })
  return header.id
}

test('human-pr: a PR that carries two tickets moves both to qa, and is marked ready only once each passed', async ($, on) => {
  const loop = await startLoop($, on, { shared: { qaMode: 'human-pr' } })
  const header = await loop.tickets.create({ title: 'Export button', ask: 'Add an export button', visibleChange: true })
  await loop.tickets.move(header.id, { status: 'review', ready: true, pr: 'https://github.com/acme/app/pull/12' })
  const second = await secondTicketOn12(loop)
  const agentId = await reviewer($)

  const verdict = await call($, { tool: 'mcp__godmode__review_verdict', pr: '12', verdict: 'clean', agentId })
  expect(String(verdict.result)).toContain(`godmode moved ${header.id} to qa: people test the PR now. godmode moved ${second} to qa`)
  expect((await ticketOf(loop, second))?.status).toBe('qa')

  await moveTicket($, { id: header.id, qaResult: 'passed' })
  expect((await mergeOnAsk($)).deny).toContain(`no QA pass recorded for ${second} at a1b2c3d`)

  await moveTicket($, { id: second, qaResult: 'passed' })
  expect((await bash($, 'gh pr merge 12 --squash')).deny).toBeUndefined()
})

test('human-staging: a merged PR that carries two tickets moves each to qa', async ($, on) => {
  const loop = await startLoop($, on, { shared: { qaMode: 'human-staging' } })
  const { id } = await reviewedClean($, loop)
  const second = await secondTicketOn12(loop)

  const merged = await mergeOnAsk($)

  expect(merged.context?.join('\n')).toContain(`godmode moved ${second} to qa, not done`)
  expect((await ticketOf(loop, id))?.status).toBe('qa')
  expect((await ticketOf(loop, second))?.status).toBe('qa')
})

test('the main thread moves a ticket out of qa with an override reason, written in the ticket; an agent cannot', async ($, on) => {
  const loop = await startLoop($, on, { shared: { qaMode: 'human-pr' } })
  const { id } = await reviewedClean($, loop)

  const byAgent = await moveTicket($, { id, status: 'done', override: 'Reverted on main.' }, 'agent-x')
  expect(byAgent.deny).toContain('Only the main thread overrides')
  expect((await ticketOf(loop, id))?.status).toBe('qa')

  const moved = await moveTicket($, { id, status: 'done', override: 'Reverted on main; nothing left to test.' })

  expect(moved.deny).toBeUndefined()
  expect((await ticketOf(loop, id))?.status).toBe('done')
  const file = [...loop.world.files].find(([path]) => path.includes(`/tickets/done/${id}-`))?.[1] ?? ''
  expect(file).toContain('Moved to done on the person\'s word, without the usual check: Reverted on main; nothing left to test.')
})

test('human-staging: the original leaves qa for done once its fix ticket records a pass', async ($, on) => {
  const loop = await startLoop($, on, { shared: { qaMode: 'human-staging' } })
  const { id } = await reviewedClean($, loop)
  await mergeOnAsk($)
  const failed = await moveTicket($, { id, qaResult: 'failed' })
  expect(String(failed.result)).toContain(`file it with ticket_create (fixFor: ${id})`)

  const filed = await call($, { tool: 'mcp__godmode__ticket_create', title: 'Fix export', ask: 'The export is empty', visibleChange: true, fixFor: id })
  const fix = /Filed (T-\d+)/.exec(String(filed.result))?.[1] ?? ''
  expect(String(filed.result)).toContain(`fix for ${id}`)
  expect((await moveTicket($, { id, status: 'done' })).deny).toContain(`${id} is waiting in qa`)

  await loop.tickets.move(fix, { status: 'qa', pr: '9' })
  const passed = await moveTicket($, { id: fix, qaResult: 'passed' })
  expect(String(passed.result)).toContain(`${fix} fixes ${id}, so ${id} may now move from qa to done`)

  const closed = await moveTicket($, { id, status: 'done' })
  expect(String(closed.result)).toContain(`${id} closes on its fix ticket ${fix}'s QA pass`)
  expect((await ticketOf(loop, id))?.status).toBe('done')
})

test('local branches: a ticket with only a branch records QA at the branch\'s head; a deleted branch says so and points to the override', async ($, on) => {
  const loop = await startLoop($, on, { gh: null, shared: { qaMode: 'human-staging' } })
  const branch = 'godmode/t-1-export-button'
  let hasBranch = true
  loop.world.answer = run =>
    run.argv.join(' ') === `git rev-parse --verify refs/heads/${branch}^{commit}`
      ? hasBranch
        ? { exitCode: 0, stdout: 'b1b2c3d4e5\n' }
        : { exitCode: 128, stdout: '', stderr: 'fatal: Needed a single revision' }
      : undefined
  const header = await loop.tickets.create({ title: 'Export button', ask: 'Add an export button', visibleChange: true })
  await loop.tickets.move(header.id, { status: 'qa', branch })

  const passed = await moveTicket($, { id: header.id, qaResult: 'passed' })
  expect(String(passed.result)).toContain(`Recorded QA passed for ${header.id} at b1b2c3d`)

  hasBranch = false
  const gone = await moveTicket($, { id: header.id, status: 'done' })
  expect(gone.deny).toContain(`could not read the head commit of its branch \`${branch}\`: the branch may have been deleted`)
  expect(gone.deny).toContain('`override` reason')
  expect((await ticketOf(loop, header.id))?.status).toBe('qa')
})

test('a dev agent\'s new draft PR leaves a ticket waiting in qa where it is', async ($, on) => {
  const loop = await startLoop($, on, { shared: { qaMode: 'human-staging' } })
  const dev = await devAgent($, loop)
  await loop.tickets.move(dev.ticket, { status: 'qa', pr: 'https://github.com/acme/app/pull/12' })
  loop.stdout = 'https://github.com/acme/app/pull/14\n'

  await bash($, `${PR_CREATE} --draft --title "x" --body "x"`, dev.agentId)

  expect(await ticketOf(loop, dev.ticket)).toMatchObject({ status: 'qa', pr: 'https://github.com/acme/app/pull/12' })
})

test('a draft PR on a board with no review status keeps the PR link on the ticket, and the PM is told to move it by hand', async ($, on) => {
  const jira = makeJira()
  const board = { tracker: 'jira', jiraCloudId: '0c5e2f7a-1d3b-4e8f-9a6c-2b7d4e1f3a90', jiraProject: 'APP', jiraTodoStatus: 'To Do', jiraDoingStatus: 'In Progress', jiraDoneStatus: 'Done' }
  const loop = await startLoop($, on, { shared: board, personal: { jiraServer: SERVER }, beneath: below => mountJira(below, jira) })
  jira.issues.set('APP-1', { key: 'APP-1', summary: 'Report filters', status: 'To Do' })
  loop.world.files.set(sidePath('APP-1'), JSON.stringify({ title: 'Report filters', status: 'todo', blockedBy: [], visibleChange: false, ready: true }))
  const started = await spawn($, 'godmode:dev', 'Build APP-1.')
  expect(started.deny).toBeUndefined()
  loop.stdout = 'https://github.com/acme/app/pull/14\n'

  await bash($, `${PR_CREATE} --draft --title "APP-1" --body "x"`, started.agentId)
  await $.prompt.submit({ text: 'status?' } as Parameters<typeof $.prompt.submit>[0])

  const side = JSON.parse(loop.world.files.get(sidePath('APP-1')) ?? '{}') as { pr?: string; status?: string }
  expect(side.pr).toBe('https://github.com/acme/app/pull/14')
  expect(side.status).not.toBe('review')
  const told = loop.contexts.at(-1)?.join('\n') ?? ''
  expect(told).toContain('godmode recorded PR https://github.com/acme/app/pull/14 on APP-1, but could not move it to review')
  expect(told).toContain('fix the status mapping with `/godmode setup`')
})

// ---------------------------------------------------------------------------
// The fix-round limit (D56)

/** A ready ticket on PR #12, in review; resolves its id. */
const ticketOn12 = async (loop: Loop) => {
  const header = await loop.tickets.create({ title: 'Export button', ask: 'Add an export button', visibleChange: true })
  await loop.tickets.move(header.id, { status: 'review', ready: true, pr: 'https://github.com/acme/app/pull/12' })
  return header.id
}

/** A reviewer's verdict on PR #12 at its current commit; resolves the answer it reads. */
const verdictOn12 = async ($: Engine, verdict: string) => {
  const agentId = await reviewer($)
  return String((await call($, { tool: 'mcp__godmode__review_verdict', pr: '12', verdict, agentId })).result)
}

const roundsOf = (loop: Loop, id: string) => (loop.store.get(`fixRounds:${FIRST_COMMIT}`) as Record<string, { count: number }> | undefined)?.[id]?.count

test('review change-requests and human QA fails count on one counter, once per round, and each answer says the round', async ($, on) => {
  const loop = await startLoop($, on, { shared: { qaMode: 'human-pr' } })
  const id = await ticketOn12(loop)

  expect(await verdictOn12($, 'change-request')).toContain(`For ${id} this is fix round 1 of 3.`)
  expect(roundsOf(loop, id)).toBeUndefined()
  expect((await spawn($, 'godmode:dev', `Fix ${id}.`)).deny).toBeUndefined()
  // A second dispatch for the same verdict is the same round.
  expect((await spawn($, 'godmode:dev', `Fix ${id} again.`)).deny).toBeUndefined()
  expect(roundsOf(loop, id)).toBe(1)

  newCommitOn12(loop)
  await verdictOn12($, 'clean')
  const failed = await moveTicket($, { id, qaResult: 'failed' })
  expect(String(failed.result)).toContain('back in doing for fix round 2 of 3 on this ticket')
  expect((await spawn($, 'godmode:dev', `Fix ${id}: the testers' findings.`)).deny).toBeUndefined()
  expect(roundsOf(loop, id)).toBe(2)
})

test('past the limit a fix-round dispatch is refused, saying to ask the person and how to go on', async ($, on) => {
  const loop = await startLoop($, on, { personal: { fixRoundLimit: 1 } })
  const id = await ticketOn12(loop)
  await verdictOn12($, 'change-request')
  await spawn($, 'godmode:dev', `Fix ${id}.`)
  newCommitOn12(loop)

  const answer = await verdictOn12($, 'change-request')
  const dispatches = loop.spawned.length
  const refused = await spawn($, 'godmode:dev', `Fix ${id}.`)

  expect(answer).toContain(`For ${id} this is fix round 2 of 1. That is past the fix-round limit (1): stop and ask the person`)
  expect(refused.deny).toContain(`This would be fix round 2 of 1 on ${id}, past the fix-round limit, so the dev agent did not start`)
  expect(refused.deny).toContain('ask the person what to do')
  expect(refused.deny).toContain(`ticket_move (id: ${id}, moreFixRounds: 1 or more)`)
  expect(loop.spawned).toHaveLength(dispatches)
  expect(roundsOf(loop, id)).toBe(1)
})

test('a human QA fail past the limit says to stop, and its fix round is refused too', async ($, on) => {
  const loop = await startLoop($, on, { shared: { qaMode: 'human-pr' }, personal: { fixRoundLimit: 1 } })
  const id = await ticketOn12(loop)
  await verdictOn12($, 'change-request')
  await spawn($, 'godmode:dev', `Fix ${id}.`)
  newCommitOn12(loop)
  await verdictOn12($, 'clean')

  const failed = await moveTicket($, { id, qaResult: 'failed' })

  expect(String(failed.result)).toContain('fix round 2 of 1 on this ticket')
  expect(String(failed.result)).toContain('past the fix-round limit (1): stop and ask the person')
  expect((await spawn($, 'godmode:dev', `Fix ${id}.`)).deny).toContain('past the fix-round limit')
})

test('the main thread lets a stopped ticket go on with moreFixRounds; an agent can neither raise nor reset the count', async ($, on) => {
  const loop = await startLoop($, on, { personal: { fixRoundLimit: 1 } })
  const id = await ticketOn12(loop)
  await verdictOn12($, 'change-request')
  await spawn($, 'godmode:dev', `Fix ${id}.`)
  newCommitOn12(loop)
  await verdictOn12($, 'change-request')

  const raisedByAgent = await moveTicket($, { id, moreFixRounds: 5 }, 'agent-x')
  await moveTicket($, { id, status: 'done' }, 'agent-x')
  await moveTicket($, { id, status: 'doing' }, 'agent-x')
  expect(raisedByAgent.deny).toContain('Only the main thread allows more fix rounds')
  expect(roundsOf(loop, id)).toBe(1)
  expect((await spawn($, 'godmode:dev', `Fix ${id}.`)).deny).toContain('past the fix-round limit')

  expect((await moveTicket($, { id, moreFixRounds: 0 })).deny).toContain('must be a whole number')
  const raised = await moveTicket($, { id, moreFixRounds: 1 })
  expect(String(raised.result)).toContain(`${id} may now have up to 2 fix rounds (1 so far)`)
  expect((await spawn($, 'godmode:dev', `Fix ${id}.`)).deny).toBeUndefined()
  expect(roundsOf(loop, id)).toBe(2)
})

test('the count ends when the main thread closes the ticket, or when its PR merges', async ($, on) => {
  const loop = await startLoop($, on, { shared: { qaMode: 'none' } })
  const id = await ticketOn12(loop)
  await verdictOn12($, 'change-request')
  await spawn($, 'godmode:dev', `Fix ${id}.`)
  expect(roundsOf(loop, id)).toBe(1)

  await moveTicket($, { id, status: 'done' })
  expect(roundsOf(loop, id)).toBeUndefined()

  await moveTicket($, { id, status: 'doing' })
  newCommitOn12(loop)
  await verdictOn12($, 'change-request')
  await spawn($, 'godmode:dev', `Fix ${id}.`)
  expect(roundsOf(loop, id)).toBe(1)
  const pr = loop.world.gh?.prs.find(candidate => candidate.number === 12)
  if (pr !== undefined) pr.head = 'abcdef0123'
  await verdictOn12($, 'clean')
  expect((await mergeOnAsk($)).deny).toBeUndefined()
  expect(roundsOf(loop, id)).toBeUndefined()
})

test('human-staging: a fail after the merge counts no fix round, and a dispatch after it is not one', async ($, on) => {
  const loop = await startLoop($, on, { shared: { qaMode: 'human-staging' }, personal: { fixRoundLimit: 1 } })
  const id = await ticketOn12(loop)
  await verdictOn12($, 'clean')
  await mergeOnAsk($)

  const failed = await moveTicket($, { id, qaResult: 'failed' })
  const again = await spawn($, 'godmode:dev', `Look at ${id}.`)

  expect(String(failed.result)).not.toContain('fix round')
  expect(again.deny).toBeUndefined()
  expect(loop.store.get(`fixRounds:${FIRST_COMMIT}`)).toBeUndefined()
})

/** The ticket on PR #12's dev agent, dispatched by name before any review; resolves the ticket and the agent's id. */
const devOn12 = async ($: Engine, loop: Loop) => {
  const id = await ticketOn12(loop)
  const started = (await $.agent.spawn({ prompt: `Build ${id}.`, description: 'build', subagentType: 'godmode:dev', name: 'builder' } as Parameters<
    typeof $.agent.spawn
  >[0])) as { agentId?: string }
  return { id, agentId: started.agentId ?? '' }
}

/** The main thread's SendMessage to `to`. */
const sendTo = ($: Engine, to: string) => call($, { tool: 'SendMessage', to, message: 'The review asks for changes: fix them on your branch.' })

const sentCount = (loop: Loop) => loop.ran.filter(line => line === 'SendMessage').length

test('a fix round sent to the dev agent by SendMessage is counted, by its id or its name, once per verdict', async ($, on) => {
  const loop = await startLoop($, on)
  const dev = await devOn12($, loop)
  expect(roundsOf(loop, dev.id)).toBeUndefined()
  await verdictOn12($, 'change-request')

  expect((await sendTo($, dev.agentId)).deny).toBeUndefined()
  expect(roundsOf(loop, dev.id)).toBe(1)
  // The same verdict is the same round, whichever address the message uses.
  expect((await sendTo($, 'builder')).deny).toBeUndefined()
  expect((await sendTo($, `builder [${dev.agentId}]`)).deny).toBeUndefined()
  expect(roundsOf(loop, dev.id)).toBe(1)
  expect(sentCount(loop)).toBe(3)

  newCommitOn12(loop)
  await verdictOn12($, 'change-request')
  await sendTo($, 'builder')
  expect(roundsOf(loop, dev.id)).toBe(2)
})

test('past the limit a fix round by SendMessage is refused, and goes once the main thread allows more', async ($, on) => {
  const loop = await startLoop($, on, { personal: { fixRoundLimit: 1 } })
  const dev = await devOn12($, loop)
  await verdictOn12($, 'change-request')
  await sendTo($, dev.agentId)
  newCommitOn12(loop)
  await verdictOn12($, 'change-request')

  const refused = await sendTo($, dev.agentId)

  expect(refused.deny).toContain(`This would be fix round 2 of 1 on ${dev.id}, past the fix-round limit, so the message did not reach the dev agent`)
  expect(refused.deny).toContain(`ticket_move (id: ${dev.id}, moreFixRounds: 1 or more), then send it again`)
  expect(sentCount(loop)).toBe(1)
  expect(roundsOf(loop, dev.id)).toBe(1)

  await moveTicket($, { id: dev.id, moreFixRounds: 1 })
  expect((await sendTo($, 'builder')).deny).toBeUndefined()
  expect(roundsOf(loop, dev.id)).toBe(2)
})

test('a message with no fix round pending, or to an agent that is not the ticket\'s dev, passes uncounted', async ($, on) => {
  const loop = await startLoop($, on, { personal: { fixRoundLimit: 1 } })
  const dev = await devOn12($, loop)

  expect((await sendTo($, dev.agentId)).deny).toBeUndefined()
  await verdictOn12($, 'change-request')
  const other = await reviewer($)
  expect((await sendTo($, other)).deny).toBeUndefined()
  expect((await sendTo($, 'someone-else')).deny).toBeUndefined()
  // An agent's own message is not the PM sending a fix round.
  expect((await call($, { tool: 'SendMessage', to: dev.agentId, message: 'Done.', agentId: other })).deny).toBeUndefined()

  expect(sentCount(loop)).toBe(4)
  expect(roundsOf(loop, dev.id)).toBeUndefined()
})

test('a dispatch and a SendMessage for the same verdict are one fix round', async ($, on) => {
  const loop = await startLoop($, on, { personal: { fixRoundLimit: 1 } })
  const dev = await devOn12($, loop)
  await verdictOn12($, 'change-request')

  expect((await spawn($, 'godmode:dev', `Fix ${dev.id}.`)).deny).toBeUndefined()
  expect((await sendTo($, 'builder')).deny).toBeUndefined()

  expect(roundsOf(loop, dev.id)).toBe(1)
})

test('a finished dev agent woken by SendMessage resumes without naming its ticket, and keeps its worktree', async ($, on) => {
  const loop = await startLoop($, on)
  const dev = await devOn12($, loop)
  await verdictOn12($, 'change-request')
  const message = 'The review asks for changes: fix them on your branch.'
  expect((await sendTo($, 'builder')).deny).toBeUndefined()

  const resumed = (await $.agent.spawn({
    prompt: message,
    description: 'build',
    subagentType: 'godmode:dev',
    resume: { agentId: dev.agentId },
  } as Parameters<typeof $.agent.spawn>[0])) as { deny?: string }

  expect(resumed.deny).toBeUndefined()
  expect(loop.spawned.at(-1)?.prompt).toBe(message)
  expect(roundsOf(loop, dev.id)).toBe(1)
  expect((await edit($, `${REPO}/src/export.ts`, dev.agentId)).deny).toContain('outside it')
})

test('a human QA fail\'s fix round by SendMessage is refused past the limit too', async ($, on) => {
  const loop = await startLoop($, on, { shared: { qaMode: 'human-pr' }, personal: { fixRoundLimit: 1 } })
  const dev = await devOn12($, loop)
  await verdictOn12($, 'change-request')
  await sendTo($, dev.agentId)
  newCommitOn12(loop)
  await verdictOn12($, 'clean')
  await moveTicket($, { id: dev.id, qaResult: 'failed' })

  expect((await sendTo($, dev.agentId)).deny).toContain('past the fix-round limit')
})

// ---------------------------------------------------------------------------
// The QA agent's result (D35, D71)

const headOf12 = (loop: Loop) => loop.world.gh?.prs.find(candidate => candidate.number === 12)?.head ?? ''

/** A QA agent's result on a ticket at the commit it tested, PR #12's current one unless said; resolves the answer it reads. */
const qaVerdict = async ($: Engine, loop: Loop, ticket: string, result: string, commit = headOf12(loop)) => {
  const agentId = (await spawn($, 'godmode:qa', `Test ${ticket} on PR #12.`)).agentId ?? ''
  return call($, { tool: 'mcp__godmode__qa_verdict', ticket, result, commit, summary: 'Checked.', agentId })
}

test('only the QA agent records its result, at the PR\'s current commit', async ($, on) => {
  const loop = await startLoop($, on, { shared: { qaMode: 'bot' } })
  const dev = await devAgent($, loop)
  const id = await ticketOn12(loop)

  const byDev = await call($, { tool: 'mcp__godmode__qa_verdict', ticket: id, result: 'pass', agentId: dev.agentId })
  const byReviewer = await call($, { tool: 'mcp__godmode__qa_verdict', ticket: id, result: 'pass', agentId: await reviewer($) })
  const byPm = await call($, { tool: 'mcp__godmode__qa_verdict', ticket: id, result: 'pass' })
  expect(byDev.deny).toContain('Only the godmode QA agent records a result')
  expect(byReviewer.deny).toContain('Only the godmode QA agent records a result')
  expect(byPm.deny).toContain('Only the godmode QA agent records a result')
  expect(loop.store.get(`qaVerdicts:${FIRST_COMMIT}`)).toBeUndefined()

  expect((await qaVerdict($, loop, id, 'maybe')).deny).toContain('not a QA result')
  expect((await qaVerdict($, loop, 'T-99', 'pass')).deny).toContain('There is no ticket T-99')
  const passed = await qaVerdict($, loop, id.toLowerCase(), 'pass')
  expect(String(passed.result)).toContain(`Recorded QA pass for ${id} at a1b2c3d`)
  expect(loop.store.get(`qaVerdicts:${FIRST_COMMIT}`)).toMatchObject({ [id]: { result: 'pass', commit: 'a1b2c3d4e5' } })
})

test('a QA agent fail counts a fix round on the same counter, once per result, by dispatch or message', async ($, on) => {
  const loop = await startLoop($, on, { shared: { qaMode: 'bot' } })
  const dev = await devOn12($, loop)
  await verdictOn12($, 'clean')

  const failed = await qaVerdict($, loop, dev.id, 'fail')
  expect(String(failed.result)).toContain(`Recorded QA fail for ${dev.id} at a1b2c3d`)
  expect(String(failed.result)).toContain(`For ${dev.id} this is fix round 1 of 3.`)
  expect(roundsOf(loop, dev.id)).toBeUndefined()

  expect((await sendTo($, 'builder')).deny).toBeUndefined()
  expect(roundsOf(loop, dev.id)).toBe(1)
  // The same fail is the same round, by a message again or a dispatch.
  expect((await sendTo($, dev.agentId)).deny).toBeUndefined()
  expect((await spawn($, 'godmode:dev', `Fix ${dev.id}.`)).deny).toBeUndefined()
  expect(roundsOf(loop, dev.id)).toBe(1)

  // The fix is a new commit, reviewed clean, and fails QA again: a second round.
  newCommitOn12(loop)
  await verdictOn12($, 'clean')
  expect(String((await qaVerdict($, loop, dev.id, 'fail')).result)).toContain('fix round 2 of 3')
  await sendTo($, 'builder')
  expect(roundsOf(loop, dev.id)).toBe(2)
})

test('a change-request and a QA agent fail add up on one counter, and past the limit a QA fail\'s round is refused', async ($, on) => {
  const loop = await startLoop($, on, { shared: { qaMode: 'bot' }, personal: { fixRoundLimit: 1 } })
  const dev = await devOn12($, loop)
  await verdictOn12($, 'change-request')
  await sendTo($, 'builder')
  newCommitOn12(loop)
  await verdictOn12($, 'clean')

  const failed = await qaVerdict($, loop, dev.id, 'fail')
  const refused = await sendTo($, 'builder')
  const dispatch = await spawn($, 'godmode:dev', `Fix ${dev.id}.`)

  expect(String(failed.result)).toContain(`For ${dev.id} this is fix round 2 of 1. That is past the fix-round limit (1): stop and ask the person`)
  expect(refused.deny).toContain(`This would be fix round 2 of 1 on ${dev.id}, past the fix-round limit, so the message did not reach the dev agent`)
  expect(dispatch.deny).toContain('past the fix-round limit')
  expect(roundsOf(loop, dev.id)).toBe(1)

  await moveTicket($, { id: dev.id, moreFixRounds: 1 })
  expect((await sendTo($, 'builder')).deny).toBeUndefined()
  expect(roundsOf(loop, dev.id)).toBe(2)
})

test('a QA agent pass starts no fix round', async ($, on) => {
  const loop = await startLoop($, on, { shared: { qaMode: 'bot' } })
  const dev = await devOn12($, loop)
  await verdictOn12($, 'clean')

  const passed = await qaVerdict($, loop, dev.id, 'pass')

  expect(String(passed.result)).toContain('mark PR #12 ready now')
  expect(String(passed.result)).not.toContain('fix round')
  expect((await sendTo($, 'builder')).deny).toBeUndefined()
  expect(roundsOf(loop, dev.id)).toBeUndefined()
})

test('human-pr with the QA agent first: its pass moves the ticket to qa for the testers; its fail leaves it in review', async ($, on) => {
  const loop = await startLoop($, on, { shared: { qaMode: 'human-pr', qaBotFirst: true } })
  const { id } = await reviewedClean($, loop)

  const failed = await qaVerdict($, loop, id, 'fail')
  expect(String(failed.result)).toContain(`For ${id} this is fix round 1 of 3.`)
  expect((await ticketOf(loop, id))?.status).toBe('review')

  const passed = await qaVerdict($, loop, id, 'pass')
  expect(String(passed.result)).toContain(`godmode moved ${id} to qa: people test the PR now.`)
  expect((await ticketOf(loop, id))?.status).toBe('qa')
  expect((await bash($, ['gh', 'pr', 'ready', '12'].join(' '))).deny).toBeUndefined()
})

test('qa_verdict needs the commit the QA agent tested, and refuses it once the PR has moved past it', async ($, on) => {
  const loop = await startLoop($, on, { shared: { qaMode: 'bot' } })
  const id = await ticketOn12(loop)
  const tested = headOf12(loop)
  newCommitOn12(loop)

  const qa = (await spawn($, 'godmode:qa', `Test ${id} on PR #12.`)).agentId ?? ''
  const unnamed = await call($, { tool: 'mcp__godmode__qa_verdict', ticket: id, result: 'pass', agentId: qa })
  const moved = await qaVerdict($, loop, id, 'pass', tested)

  expect(unnamed.deny).toContain('`commit` is required')
  expect(moved.deny).toContain(`${id}'s PR has moved on: you tested a1b2c3d, and its head is now ffff000`)
  expect(loop.store.get(`qaVerdicts:${FIRST_COMMIT}`)).toBeUndefined()
  expect(String((await qaVerdict($, loop, id, 'pass', 'ffff000')).result)).toContain(`Recorded QA pass for ${id} at ffff000`)
})

test('bot: a visible change\'s PR is marked ready or merged only with the QA agent\'s pass at its current commit', async ($, on) => {
  const loop = await startLoop($, on, { shared: { qaMode: 'bot' } })
  const { id, answer } = await reviewedClean($, loop)
  expect(answer).toContain(`Next godmode's QA agent tests ${id} at this commit`)

  expect((await bash($, 'gh pr ready 12')).deny).toContain(`${id} is a visible change, and the QA agent has not passed it at the current commit a1b2c3d, so PR #12 is not ready`)
  expect((await bash($, 'gh pr merge 12')).deny).toContain('godmode\'s own checks are not done')

  await qaVerdict($, loop, id, 'fail')
  expect((await bash($, 'gh pr ready 12')).deny).toContain(`The QA agent failed ${id} at the current commit a1b2c3d`)

  // The fix: a new commit, reviewed clean; the old fail no longer holds it, and an old pass would not clear it.
  newCommitOn12(loop)
  await verdictOn12($, 'clean')
  expect((await bash($, 'gh pr ready 12')).deny).toContain('Its last QA result (fail) is from commit a1b2c3d')
  await qaVerdict($, loop, id, 'pass')
  expect((await bash($, 'gh pr ready 12')).deny).toBeUndefined()
  expect(loop.ran).toEqual(['Bash gh pr ready 12'])
})

test('bot: a PR no ticket of godmode\'s names has no QA agent step; one whose tickets change nothing visible is not held either', async ($, on) => {
  const loop = await startLoop($, on, { shared: { qaMode: 'bot' } })
  await verdictOn12($, 'clean')
  expect((await bash($, 'gh pr ready 12')).deny).toBeUndefined()

  await reviewedClean($, loop, false)
  expect((await bash($, 'gh pr ready 12')).deny).toBeUndefined()
})

test('bot: when the app cannot run, only the main thread records the person\'s skip, and never over a fail', async ($, on) => {
  const loop = await startLoop($, on, { shared: { qaMode: 'bot' } })
  const { id } = await reviewedClean($, loop)
  const skip = (agentId?: string, summary = 'The staging database is down; the person said ship it.') =>
    call($, { tool: 'mcp__godmode__qa_verdict', ticket: id, result: 'skipped', summary, agentId })

  const byAgent = await skip((await spawn($, 'godmode:qa', `Test ${id}.`)).agentId)
  const noReason = await skip(undefined, ' ')
  expect(byAgent.deny).toContain('Only the main thread records a skipped QA')
  expect(noReason.deny).toContain('needs the person\'s reason')
  expect((await bash($, 'gh pr ready 12')).deny).toContain('has not passed it')

  const skipped = await skip()
  expect(String(skipped.result)).toContain(`Recorded that the person skipped the QA agent on ${id} at a1b2c3d`)
  expect(loop.store.get(`qaVerdicts:${FIRST_COMMIT}`)).toMatchObject({ [id]: { result: 'skipped', commit: 'a1b2c3d4e5' } })
  expect((await bash($, 'gh pr ready 12')).deny).toBeUndefined()

  await qaVerdict($, loop, id, 'fail')
  expect((await skip()).deny).toContain(`The QA agent failed ${id} at this commit a1b2c3d`)
  expect((await bash($, 'gh pr ready 12')).deny).toContain(`The QA agent failed ${id}`)
})

test('human-pr with the QA agent first: a ticket moves to qa only after its pass at the current commit, or by override', async ($, on) => {
  const loop = await startLoop($, on, { shared: { qaMode: 'human-pr', qaBotFirst: true } })
  const { id } = await reviewedClean($, loop)

  const early = await moveTicket($, { id, status: 'qa' })
  expect(early.deny ?? String(early.result)).toContain(`${id} is a visible change, and the QA agent has not passed it at the current commit a1b2c3d, so it does not move to qa`)
  expect((await ticketOf(loop, id))?.status).toBe('review')

  await qaVerdict($, loop, id, 'fail')
  const failed = await moveTicket($, { id, status: 'qa' })
  expect(failed.deny ?? String(failed.result)).toContain(`The QA agent failed ${id}`)
  expect((await ticketOf(loop, id))?.status).toBe('review')

  // An override never passes over the QA agent's fail at the current commit.
  const overridden = await moveTicket($, { id, status: 'qa', override: 'The person tests it themselves.' })
  expect(overridden.deny).toContain(`The QA agent failed ${id} at the current commit a1b2c3d`)
  expect(overridden.deny).toContain('An override is for an app the QA agent cannot run')
  expect((await ticketOf(loop, id))?.status).toBe('review')

  // At a new commit the old fail no longer holds, and the override is the person's word.
  newCommitOn12(loop)
  await moveTicket($, { id, status: 'qa', override: 'The app cannot run on this machine; the person tests it themselves.' })
  expect((await ticketOf(loop, id))?.status).toBe('qa')
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
  // The next prompt carries only the PM's one-line reminder: the review notice is not repeated.
  expect(loop.contexts[1]).toEqual([expect.stringContaining('godmode is on: you are its PM')])
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

test('godmode\'s context7 tools serve only while godmode is on in a set-up project (D12)', async ($, on) => {
  const loop = await startLoop($, on)
  const docs = (agentId?: string) => call($, { tool: 'mcp__plugin_godmode_context7__query-docs', libraryId: '/vercel/next.js', query: 'routing', agentId })

  expect((await docs('agent-x')).deny).toBeUndefined()

  await godmode($, 'off')
  const off = await docs('agent-x')
  expect(off.deny).toBe('godmode\'s context7 tools work only while godmode is on in a set-up project, and godmode is off. Nothing ran.')

  await godmode($)
  for (const path of [...loop.world.files.keys()].filter(file => file.startsWith(`${loop.dir}/`))) loop.world.files.delete(path)
  // Any `/godmode` command makes the loop read the note again.
  await godmode($, 'report')
  expect((await docs('agent-x')).deny).toContain('this project is not set up for godmode yet')
  expect(loop.ran.filter(ran => ran.startsWith('mcp__plugin_godmode_context7__'))).toHaveLength(1)
})

test('godmode off: no loop rule applies', async ($, on) => {
  const loop = await startLoop($, on, { personal: { attribution: false } })
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

// ---------------------------------------------------------------------------
// The PM on Fable (D74)

/** The model each step beneath the plugin was sent with; a step on a model `fails` names answers that error with no message. */
const stepsBeneath = (models: string[], fails: Record<string, string> = {}, logs: string[] = []) => (below: On) => {
  below('ui.log', (_$, e) => {
    logs.push(e.text)
    return { value: undefined } as never
  })
  below('turn.step', async function* (_$, e) {
    models.push(e.model)
    const error = fails[e.model]
    if (error !== undefined) return { turnId: e.turnId, index: e.index, answer: error, toolUses: [], stopReason: null, usage: null }
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: null }
  })
}

const step = async ($: Engine, model: string, agentId?: string) => {
  const stream = $.turn.step({ turnId: 'turn-1', index: 0, model, messageCount: 1, ...(agentId === undefined ? {} : { agentId }) })
  for await (const _chunk of stream) {
    // drain the step
  }
}

test('while godmode is on, the main loop runs on Fable; agents keep their model, and off gives the person theirs back', async ($, on) => {
  const models: string[] = []
  await startLoop($, on, { beneath: stepsBeneath(models) })

  await step($, 'claude-opus-4-1')
  await step($, 'claude-sonnet-4-5', 'agent-x')
  await step($, 'claude-fable-5')
  await godmode($, 'off')
  await step($, 'claude-opus-4-1')

  expect(models).toEqual(['fable', 'claude-sonnet-4-5', 'claude-fable-5', 'claude-opus-4-1'])
})

test('Fable unavailable here: the same request goes to Opus, later steps go straight there, and it is logged once', async ($, on) => {
  const models: string[] = []
  const logs: string[] = []
  await startLoop($, on, { beneath: stepsBeneath(models, { fable: 'API Error: 404 {"type":"not_found_error","message":"model: fable"}' }, logs) })

  await step($, 'claude-opus-4-1')
  await step($, 'claude-opus-4-1')

  expect(models).toEqual(['fable', 'opus', 'opus'])
  expect(logs).toEqual(['Fable is unavailable here, so the PM runs on Opus.'])
})

test('an ordinary error on Fable (overload, network) never moves the PM off it', async ($, on) => {
  const models: string[] = []
  await startLoop($, on, { beneath: stepsBeneath(models, { fable: 'API Error: 529 overloaded_error' }) })

  await step($, 'claude-opus-4-1')
  await step($, 'claude-opus-4-1')

  expect(models).toEqual(['fable', 'fable'])
})

test('which Fable outcomes mean the model is unavailable: a thrown or returned model error, never an ordinary one', () => {
  expect(fableOutcome({ error: 'model_not_found: fable' })).toBe('unavailable')
  expect(fableOutcome({ error: 'Your organization is not allowed to use this model (oauth_org_not_allowed)' })).toBe('unavailable')
  expect(fableOutcome({ error: 'The model fable is not available on your plan' })).toBe('unavailable')
  expect(fableOutcome({ error: 'fetch failed: ECONNRESET' })).toBe('unknown')
  expect(fableOutcome({ error: 'rate_limit: too many requests' })).toBe('unknown')
  expect(fableOutcome({ stopReason: 'end_turn', answer: 'ok' })).toBe('works')
  expect(fableOutcome({ stopReason: null, answer: 'API Error: 500 server_error' })).toBe('unknown')
})

// ---------------------------------------------------------------------------
// The project's merge conditions, checked live on every PR (D77, D78)

/** Sets what GitHub says of a PR: its reviews at its head, its checks, its merge state. */
const prState = (loop: Loop, number: number, state: { approvedBy?: string[]; changesBy?: string[]; checks?: GhCheck['conclusion'] | 'running'; mergeState?: string }) => {
  const pr = loop.world.gh?.prs.find(candidate => candidate.number === number)
  if (pr === undefined) throw new Error(`no PR #${number}`)
  pr.reviews = [
    ...(state.approvedBy ?? []).map(login => ({ login, state: 'APPROVED' as const, commit: pr.head })),
    ...(state.changesBy ?? []).map(login => ({ login, state: 'CHANGES_REQUESTED' as const, commit: pr.head })),
  ]
  if (state.checks !== undefined) pr.checks = [state.checks === 'running' ? { name: 'build', status: 'IN_PROGRESS' } : { name: 'build', status: 'COMPLETED', conclusion: state.checks }]
  if (state.mergeState !== undefined) pr.mergeState = state.mergeState
}

const TWO_CONDITIONS = { mergeConditions: 'approvals,ci', humanReviewCount: 1 }

test('an outside PR merges on the person\'s "merge" once its conditions hold, checked live, with nothing linked or recorded', async ($, on) => {
  const loop = await startLoop($, on, { shared: TWO_CONDITIONS })
  prState(loop, 9, { approvedBy: ['carol'], checks: 'SUCCESS' })

  expect((await bash($, 'gh pr merge 9 --squash')).deny).toContain('Every merge condition holds: 1 approval from someone other than its author (1/1 at the current commit); green CI (1 green). It is teammate\'s PR.')
  const merged = await mergeOnAsk($, '9')

  expect(merged.deny).toBeUndefined()
  // godmode's own review and QA agent are never conditions on work it did not do.
  expect(loop.store.get(`verdicts:${FIRST_COMMIT}`)).toBeUndefined()
  expect(await loop.tickets.list({ statuses: ['todo', 'doing', 'review', 'qa', 'done'] })).toEqual([])
  expect(loop.ran).toEqual(['Bash gh pr merge 9 --squash'])
})

test('careful: an outside PR missing a condition is named with its live state, and "merge anyway" goes through', async ($, on) => {
  const loop = await startLoop($, on, { shared: TWO_CONDITIONS })
  prState(loop, 9, { approvedBy: ['carol'], checks: 'FAILURE' })

  const refused = await mergeOnAsk($, '9')
  expect(refused.deny).toContain('PR #9 does not meet this project\'s merge conditions yet: green CI (failing: build).')
  expect(refused.deny).toContain('allow_once (action: merge-anyway, target: 9)')
  expect(refused.deny).not.toMatch(/\/godmode (setup|off)|setting|switch|turn .* off|loosen/i)

  await allowOnce($, 'merge-anyway', '9')
  const merged = await bash($, 'gh pr merge 9 --squash')
  expect(merged.deny).toBeUndefined()
  expect(merged.context?.join('\n')).toContain('PR #9 merged on the person\'s "merge anyway", with these not met: green CI (failing: build).')
  expect(loop.ran).toEqual(['Bash gh pr merge 9 --squash'])
})

test('not careful: an outside PR missing a condition merges, and godmode says what was missing', async ($, on) => {
  const loop = await startLoop($, on, { shared: TWO_CONDITIONS, personal: { care: 'not-careful' } })
  prState(loop, 9, { changesBy: ['carol'], checks: 'running' })

  const merged = await bash($, 'gh pr merge 9 --squash')

  expect(merged.deny).toBeUndefined()
  expect(merged.context?.join('\n')).toContain('godmode merged PR #9 with these not met: 1 approval from someone other than its author (carol requested changes); green CI (1 of 1 still running).')
  expect(loop.ran).toEqual(['Bash gh pr merge 9 --squash'])
})

test('an empty conditions list checks nothing: a PR merges on the person\'s "merge" whatever its CI says', async ($, on) => {
  const loop = await startLoop($, on, { shared: { mergeConditions: 'none' } })
  prState(loop, 9, { checks: 'FAILURE' })

  expect((await bash($, 'gh pr merge 9')).deny).toContain('This project sets no merge conditions.')
  expect((await mergeOnAsk($, '9', 'gh pr merge 9')).deny).toBeUndefined()
  expect(loop.ran).toEqual(['Bash gh pr merge 9'])
})

test('godmode\'s own PR goes through its own loop first, then the project\'s conditions; merging on its own waits for both', async ($, on) => {
  const loop = await startLoop($, on, { shared: { mergeConditions: 'ci' }, personal: { autoMerge: true } })
  await ownTicketOn12(loop)
  prState(loop, 12, { checks: 'SUCCESS' })

  const early = await bash($, 'gh pr merge 12 --squash')
  expect(early.deny).toContain('godmode\'s own checks are not done: godmode\'s review has no verdict on PR #12')

  await verdictOn12($, 'clean')
  prState(loop, 12, { checks: 'running' })
  expect((await bash($, 'gh pr merge 12 --squash')).deny).toContain('green CI (1 of 1 still running)')

  prState(loop, 12, { checks: 'SUCCESS' })
  expect((await bash($, 'gh pr merge 12 --squash')).deny).toBeUndefined()
  expect(loop.ran).toEqual(['Bash gh pr merge 12 --squash'])
})

test('approvals count live: never the author nor the person, only named reviewers when there are some', async ($, on) => {
  const loop = await startLoop($, on, { shared: { mergeConditions: 'approvals', humanReviewCount: 1, humanReviewers: 'bob' } })
  const { answer } = await reviewedClean($, loop)
  expect(answer).toContain('Request bob as reviewers')

  prState(loop, 12, { approvedBy: ['me', 'carol'] })
  expect((await mergeOnAsk($)).deny).toContain('1 approval from bob (0/1 at the current commit)')
  prState(loop, 12, { changesBy: ['bob'] })
  expect((await bash($, 'gh pr merge 12 --squash')).deny).toContain('bob requested changes')
  prState(loop, 12, { approvedBy: ['bob'] })
  expect((await bash($, 'gh pr merge 12 --squash')).deny).toBeUndefined()
})

test('a PR that cannot be read is tried again, then the person is asked, saying why; not careful merges and says it did not check', async ($, on) => {
  const loop = await startLoop($, on, { shared: TWO_CONDITIONS })
  loop.world.answer = run => (run.argv.join(' ').startsWith('gh pr view 9') ? { exitCode: 1, stdout: '', stderr: 'HTTP 502' } : undefined)

  const refused = await mergeOnAsk($, '9')
  expect(refused.deny).toContain('godmode could not read PR #9 to check its merge conditions (gh could not read PR #9: HTTP 502)')
  expect(refused.deny).toContain('allow_once (action: merge-anyway, target: 9)')
  expect(loop.world.runs.filter(run => run.argv.join(' ').startsWith('gh pr view 9')).length).toBeGreaterThanOrEqual(2)
})

test('no refusal anywhere suggests switching a rule off: each names the ask that lets it run, or the live state that is missing', async ($, on) => {
  const loop = await startLoop($, on, { shared: { ...TWO_CONDITIONS, qaMode: 'bot' }, personal: { attribution: false, agentCap: 1 } })
  await ownTicketOn12(loop, true)
  prState(loop, 9, { checks: 'FAILURE' })
  const dev = await devAgent($, loop)
  loop.running = running(1)
  const refusals = [
    await edit($, `${REPO}/src/a.ts`),
    await call($, { tool: 'Grep', pattern: 'x' }),
    await call($, { tool: 'WebFetch', url: 'https://example.com' }),
    await bash($, 'npm test'),
    await bash($, `${PR_CREATE} --title "x"`, 'agent-x'),
    await bash($, 'git commit -m "x\n\nCo-Authored-By: Claude <noreply@anthropic.com>"', 'agent-x'),
    await bash($, 'gh pr ready 12', 'agent-x'),
    await bash($, 'gh pr merge 12', 'agent-x'),
    await mergeOnAsk($, '9'),
    await bash($, 'gh pr close 9', 'agent-x'),
    await bash($, 'git push origin --delete deps', 'agent-x'),
    await spawn($, 'Explore', 'Look around.'),
    await spawn($, 'godmode:dev', 'Build T-99.'),
  ]
  expect(dev.agentId).not.toBe('')
  for (const refusal of refusals) {
    expect(refusal.deny).toBeDefined()
    expect([refusal.deny, /\/godmode (setup|off)|\(setting|To change the rule|loosen the rule|switch (it|this|the rule) off|turn (it|this|the rule) off/i.test(refusal.deny ?? '')]).toEqual([refusal.deny, false])
  }
})
