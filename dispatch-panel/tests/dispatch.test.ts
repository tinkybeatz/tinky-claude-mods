import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { describeAction, shellTitle } from '../hooks/actions'
import { ACTIVITIES, NEUTRAL_COLOR, activityColor, activityFromDescription, activityTag } from '../hooks/kinds'
import type { Dispatch } from '../types'

const PANE_PROPS = {
  title: 'Dispatched',
  isFocused: false,
  bodyColumns: 40,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
} as const

const mountPane = ($: Engine) =>
  $.ui.mount({ plugin: 'dispatch-panel', surface: 'terminal', component: 'Pane', requestId: 'dispatches', props: PANE_PROPS })

test('a backgrounded Bash call moves from the active tab to the finished tab, and clear drops it', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  on('classic.Stop', () => ({}))
  on('tool.call', { tool: 'Bash' }, () => ({
    result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'shell-1' },
  }))

  await $.tool.call({
    tool: 'Bash',
    tool_use_id: 'use-1',
    command: 'npm run dev',
    description: 'Start the dev server',
    run_in_background: true,
  })

  const pane = await mountPane($)
  expect(await pane.find({ text: 'Start the dev server' })).toBeDefined()
  expect(await pane.find({ text: '●' })).toBeDefined()

  await clock.advance(65_000)
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [] })

  expect(await pane.find({ text: 'Start the dev server' })).toBeUndefined()
  expect(await pane.find({ type: 'Button', text: 'Finished (1)' })).toBeDefined()

  await pane.press({ key: 'tab-finished' })

  expect(await pane.find({ text: '✓' })).toBeDefined()
  expect(await pane.find({ text: '1m05s' })).toBeDefined()

  await pane.press({ key: 'clear' })

  expect(await pane.find({ text: 'Nothing finished yet.' })).toBeDefined()
})

test('a foreground Bash call is not listed', async ($, on) => {
  mock.clock(on)
  on('tool.call', { tool: 'Bash' }, () => ({
    result: { stdout: 'ok', stderr: '', interrupted: false },
  }))

  await $.tool.call({ tool: 'Bash', tool_use_id: 'use-2', command: 'ls' })

  const pane = await mountPane($)
  expect(await pane.find({ text: 'Nothing running.' })).toBeDefined()
})

test('an agent row sums its input and output tokens across requests', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  on('agent.spawn', () => ({ model: 'test-model', agentId: 'agent-1' }))
  on('turn.step', async function* (_$, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn',
      usage: {
        model: 'test-model',
        input_tokens: 200,
        cache_read_input_tokens: 1000,
        cache_creation_input_tokens: 300 * (e.index + 1),
        output_tokens: 150,
      },
    }
  })

  await $.agent.spawn({
    tool_use_id: 'use-3',
    prompt: 'Review the diff',
    description: 'Review the diff',
    subagentType: 'test',
  } as Parameters<typeof $.agent.spawn>[0])

  for (const index of [0, 1]) {
    const stream = $.turn.step({ turnId: 'turn-1', index, model: 'test-model', messageCount: 3, agentId: 'agent-1' })
    for await (const _chunk of stream) {
      // drain the step
    }
  }

  const pane = await mountPane($)
  expect(await pane.find({ text: 'Review the diff' })).toBeDefined()
  expect(await pane.find({ text: 'in 3.3k · out 300' })).toBeDefined()
  expect(await pane.find({ text: 'test' })).toBeDefined()
})

test('an agent is coloured by its activity: named outright by its description, or picked by the classifier', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const asked: string[] = []
  mock.store(on)
  const listed = ['Implement the export button', 'Update PROD-4882 in Jira'].map(id => ({
    id,
    description: id,
    type: 'general-purpose',
    status: 'running' as const,
  }))
  on('agent.list', () => ({ value: listed }))
  on('command.register', () => ({ value: {} }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.panes', () => ({ value: [] }))
  on('session.start', (_$, e) => e as never)
  on('model.classify', (_$, e) => {
    asked.push(e.text)
    // The Jira task is named outright by its description, so this answer never reaches it.
    return { value: e.text.includes('export button') ? 'writing or changing code' : 'writing docs or text' }
  })
  on('agent.spawn', (_$, e) => ({ model: 'test-model', agentId: e.description }))

  await $.session.start({ cwd: '/tmp' } as Parameters<typeof $.session.start>[0])
  for (const description of ['Implement the export button', 'Update PROD-4882 in Jira']) {
    await $.agent.spawn({
      tool_use_id: description,
      prompt: description,
      description,
      subagentType: 'general-purpose',
    } as Parameters<typeof $.agent.spawn>[0])
  }
  await clock.advance(3000)

  expect(asked).toHaveLength(1)
  const pane = await mountPane($)
  const code = await pane.find({ text: 'Implement the export button' })
  const jira = await pane.find({ text: 'Update PROD-4882 in Jira' })
  expect(code).toBeDefined()
  expect(jira).toBeDefined()
  const drawn = JSON.stringify(await pane.drawn())
  expect(drawn).toContain('#3b82f6')
  expect(drawn).toContain('#22d3ee')
  expect(drawn).toContain('[code]')
  expect(drawn).toContain('[jira]')
  expect(await pane.find({ text: 'general-purpose' })).toBeUndefined()
})

const row = (id: string): Dispatch => ({ id, kind: 'agent', label: 'general-purpose', purpose: '', status: 'running', startedAt: 0 })

test('every activity has its own colour, and unclassified agents and shells are neutral', () => {
  const colors = ACTIVITIES.map(activity => activity.color)
  expect(new Set(colors).size).toBe(colors.length)
  expect(activityColor(row('x'))).toBe(NEUTRAL_COLOR)
  expect(activityColor({ ...row('s'), kind: 'shell' })).toBe(NEUTRAL_COLOR)
  expect(activityFromDescription('Update PROD-4882 in Jira')).toBe('updating tickets (Jira, issues)')
  expect(activityFromDescription('Find or spec swap element ticket')).toBe('updating tickets (Jira, issues)')
  expect(activityFromDescription('Open a PR for the fix')).toBe('git, branches or pull requests')
  expect(activityFromDescription('Build PROD-4888')).toBeUndefined()
  expect(activityFromDescription('Research realtime collaboration')).toBeUndefined()
  const tags = ACTIVITIES.map(activity => activity.tag)
  expect(new Set(tags).size).toBe(tags.length)
  expect(activityTag(row('x'))).toBeUndefined()
})

test('tool calls become short action phrases', () => {
  expect(describeAction('Bash', { command: 'git commit -m "x"' })).toBe('committing')
  expect(describeAction('Bash', { command: 'cd repo && pnpm test' })).toBe('running tests')
  expect(describeAction('Bash', { command: ['gh', 'pr', 'create', '--draft'].join(' ') })).toBe('opening a PR')
  expect(describeAction('Bash', { command: 'make thing', description: 'Generate the fixtures' })).toBe(
    'generate the fixtures',
  )
  expect(describeAction('Read', { file_path: '/repo/src/register.tsx' })).toBe('reading register.tsx')
  expect(describeAction('Edit', { file_path: '/repo/a.ts' })).toBe('editing a.ts')
  expect(describeAction('mcp__claude_ai_Atlassian_MCP__editJiraIssue', {})).toBe('updating Jira')
  expect(describeAction('mcp__claude_ai_Atlassian_MCP__getJiraIssue', {})).toBe('reading Jira')
  expect(shellTitle('until [ "$(gh pr view 1233 --json state -q .state)" = MERGED ]; do sleep 30; done')).toBe('Checking CI')
  expect(shellTitle('pnpm test --run')).toBe('Running tests')
  expect(shellTitle('npm run dev')).toBe('npm run dev')
})

test("a running agent's card shows its current action, and thinking between tool calls", async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  on('agent.spawn', () => ({ model: 'test-model', agentId: 'agent-9' }))
  let pane: Awaited<ReturnType<typeof mountPane>> | undefined
  let seenDuringCall: boolean | undefined
  on('tool.call', { tool: 'Bash' }, async () => {
    pane ??= await mountPane($)
    seenDuringCall = (await pane.find({ text: 'committing' })) !== undefined
    return { result: { stdout: '', stderr: '', interrupted: false } }
  })

  await $.agent.spawn({
    tool_use_id: 'use-9',
    prompt: 'Commit the work',
    description: 'Commit the work',
    subagentType: 'dev',
  } as Parameters<typeof $.agent.spawn>[0])
  await $.tool.call({ tool: 'Bash', tool_use_id: 'use-10', command: 'git commit -m "wip"', agentId: 'agent-9' })

  expect(seenDuringCall).toBe(true)
  expect(await pane?.find({ text: 'thinking' })).toBeDefined()
})

test('an agent the engine stops listing is moved to finished, and clear all drops active rows too', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  let listed = [{ id: 'agent-x', description: 'Stuck agent', type: 'claude', status: 'running' as const }]
  on('agent.list', () => ({ value: listed }))
  on('model.classify', () => ({ value: 'something else' }))
  on('command.register', () => ({ value: {} }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.panes', () => ({ value: [] }))
  on('session.start', (_$, e) => e as never)

  await $.session.start({ cwd: '/tmp' } as Parameters<typeof $.session.start>[0])
  await clock.advance(1000)
  const pane = await mountPane($)
  expect(await pane.find({ type: 'Button', text: 'Active (1)' })).toBeDefined()

  listed = []
  await clock.advance(1000)
  expect(await pane.find({ type: 'Button', text: 'Active (0)' })).toBeDefined()
  expect(await pane.find({ type: 'Button', text: 'Finished (1)' })).toBeDefined()

  listed = [{ id: 'agent-y', description: 'Another agent', type: 'claude', status: 'running' as const }]
  await clock.advance(1000)
  expect(await pane.find({ type: 'Button', text: 'Active (1)' })).toBeDefined()
  await $.command.run({ command: 'dispatches', args: 'clear all' } as Parameters<typeof $.command.run>[0])
  expect(await pane.find({ type: 'Button', text: 'Active (0)' })).toBeDefined()
  expect(await pane.find({ type: 'Button', text: 'Finished (0)' })).toBeDefined()
})

test("a shell's completion notification ends its row with the status it reports", async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  mock.session(on)
  on('tool.call', { tool: 'Bash' }, (_$, e) => ({
    result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: e.tool_use_id },
  }))

  for (const id of ['shell-ok', 'shell-bad']) {
    await $.tool.call({ tool: 'Bash', tool_use_id: id, command: 'sleep 30', description: `Wait ${id}`, run_in_background: true })
  }
  const notify = (id: string, status: string) =>
    $.session.append({
      door: 'delivery',
      origin: { kind: 'engine' },
      uuid: `row-${id}`,
      agentId: 'agent-owner',
      message: {
        type: 'user',
        role: 'user',
        content: [
          {
            type: 'text',
            text: `<task-notification>\n<task-id>${id}</task-id>\n<output-file>/tmp/x</output-file>\n<status>${status}</status>\n<summary>Shell finished</summary>\n</task-notification>`,
          },
        ],
      },
    } as unknown as Parameters<typeof $.session.append>[0])
  await notify('shell-ok', 'completed')
  await notify('shell-bad', 'failed')

  const pane = await mountPane($)
  expect(await pane.find({ type: 'Button', text: 'Active (0)' })).toBeDefined()
  await pane.press({ key: 'tab-finished' })
  expect(await pane.find({ text: '✓' })).toBeDefined()
  expect(await pane.find({ text: '✗' })).toBeDefined()
})

test('an agent that hands back and goes idle is finished, and returns to active if woken', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  let status: 'running' | 'idle' = 'running'
  on('agent.list', () => ({ value: [{ id: 'agent-z', description: 'Build PROD-4888', type: 'dev', status }] }))
  on('model.classify', () => ({ value: 'writing or changing code' }))
  on('command.register', () => ({ value: {} }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.panes', () => ({ value: [] }))
  on('session.start', (_$, e) => e as never)

  await $.session.start({ cwd: '/tmp' } as Parameters<typeof $.session.start>[0])
  await clock.advance(1000)
  const pane = await mountPane($)
  expect(await pane.find({ type: 'Button', text: 'Active (1)' })).toBeDefined()

  status = 'idle'
  await clock.advance(1000)
  expect(await pane.find({ type: 'Button', text: 'Active (0)' })).toBeDefined()
  expect(await pane.find({ type: 'Button', text: 'Finished (1)' })).toBeDefined()

  status = 'running'
  await clock.advance(1000)
  expect(await pane.find({ type: 'Button', text: 'Active (1)' })).toBeDefined()
})

test('an idle teammate is waiting for a message, so it stays active', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  const teammate = {
    id: 'mate-1',
    teammateId: 'researcher@team',
    description: 'Research the API',
    type: 'teammate',
    status: 'idle' as const,
  }
  on('agent.list', () => ({ value: [teammate] }))
  on('model.classify', () => ({ value: 'searching or researching' }))
  on('command.register', () => ({ value: {} }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.panes', () => ({ value: [] }))
  on('session.start', (_$, e) => e as never)

  await $.session.start({ cwd: '/tmp' } as Parameters<typeof $.session.start>[0])
  await clock.advance(1000)
  const pane = await mountPane($)
  expect(await pane.find({ type: 'Button', text: 'Active (1)' })).toBeDefined()
  expect(await pane.find({ text: '◌' })).toBeDefined()
})

test('rows are grouped into Agents and Shells sections', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  on('agent.spawn', () => ({ model: 'test-model', agentId: 'agent-s' }))
  on('tool.call', { tool: 'Bash' }, () => ({
    result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'shell-s' },
  }))

  await $.agent.spawn({
    tool_use_id: 'use-s',
    prompt: 'Build it',
    description: 'Build it',
    subagentType: 'dev',
  } as Parameters<typeof $.agent.spawn>[0])
  await $.tool.call({ tool: 'Bash', tool_use_id: 'use-t', command: 'npm run dev', run_in_background: true })

  const pane = await mountPane($)
  expect(await pane.find({ type: 'Text', text: '▾ Agents (1)' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: '▾ Shells (1)' })).toBeDefined()

  await pane.press({ key: 'section-agent' })
  expect(await pane.find({ type: 'Text', text: '▸ Agents (1)' })).toBeDefined()
  expect(await pane.find({ text: 'Build it' })).toBeUndefined()
  expect(await pane.find({ text: 'npm run dev' })).toBeDefined()

  await pane.press({ key: 'section-agent' })
  expect(await pane.find({ text: 'Build it' })).toBeDefined()
})

test("what a dispatched agent starts is listed inside its card, stays active while any of it runs, and a stopped agent's shells stop with it", async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  const statuses: Record<string, 'running' | 'idle'> = { lead: 'running', helper: 'running' }
  on('agent.list', () => ({
    value: [
      { id: 'lead', description: 'Research realtime collaboration', type: 'general-purpose', status: statuses.lead },
      { id: 'helper', description: 'Compare CRDT libraries', type: 'Explore', status: statuses.helper, parentId: 'lead' },
    ],
  }))
  on('model.classify', () => ({ value: 'searching or researching' }))
  on('command.register', () => ({ value: {} }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.panes', () => ({ value: [] }))
  on('session.start', (_$, e) => e as never)
  on('tool.call', { tool: 'Bash' }, () => ({
    result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'shell-h' },
  }))

  await $.session.start({ cwd: '/tmp' } as Parameters<typeof $.session.start>[0])
  await $.tool.call({
    tool: 'Bash',
    tool_use_id: 'use-h',
    command: 'npm view yjs',
    description: 'Look up yjs',
    run_in_background: true,
    agentId: 'helper',
  })
  await clock.advance(3000)

  const pane = await mountPane($)
  expect(await pane.find({ type: 'Button', text: 'Active (1)' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: '▾ Agents (1)' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: '▾ Shells (1)' })).toBeUndefined()
  expect(await pane.find({ text: 'Compare CRDT libraries' })).toBeDefined()
  expect(await pane.find({ text: 'Look up yjs' })).toBeDefined()
  expect(await pane.find({ text: '[shell]' })).toBeDefined()
  expect(await pane.find({ text: '  └' })).toBeDefined()

  statuses.lead = 'idle'
  await clock.advance(1000)
  expect(await pane.find({ type: 'Button', text: 'Active (1)' })).toBeDefined()

  statuses.helper = 'killed' as never
  await clock.advance(1000)
  expect(await pane.find({ type: 'Button', text: 'Active (0)' })).toBeDefined()
  await pane.press({ key: 'tab-finished' })
  expect(await pane.find({ text: '■' })).toBeDefined()

})

test("the footer draws a bar for each of the account's rate-limit windows", async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse('2026-10-14T12:00:00Z') })
  mock.store(on)
  on('agent.list', () => ({ value: [] }))
  on('command.register', () => ({ value: {} }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.panes', () => ({ value: [] }))
  on('session.start', (_$, e) => e as never)
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: {},
      rateLimits: [
        { kind: 'five_hour', percentUsed: 62.4, resetsAt: '2026-10-14T14:14:00Z' },
        { kind: 'seven_day', percentUsed: 93, resetsAt: '2026-10-17T16:00:00Z' },
      ],
    },
  }) as never)

  await $.session.start({ cwd: '/tmp' } as Parameters<typeof $.session.start>[0])
  await clock.advance(1000)
  const pane = await mountPane($)
  expect(await pane.find({ text: 'Session (5h)' })).toBeDefined()
  expect(await pane.find({ text: '62%' })).toBeDefined()
  expect(await pane.find({ text: '· resets in 2h14m' })).toBeDefined()
  expect(await pane.find({ text: 'Week' })).toBeDefined()
  expect(await pane.find({ text: '· resets in 3d04h' })).toBeDefined()
  expect(JSON.stringify(await pane.drawn())).toContain('#ef4444')
})

test('a shell that ends between turns is finished as soon as its notification is queued', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  on('tool.call', { tool: 'Bash' }, () => ({
    result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'shell-q' },
  }))
  on('session.receive', (_$, e) => ({ text: e.text }) as never)

  await $.tool.call({ tool: 'Bash', tool_use_id: 'use-q', command: 'npm run build', run_in_background: true })
  const pane = await mountPane($)
  expect(await pane.find({ type: 'Button', text: 'Active (1)' })).toBeDefined()

  await $.session.receive({
    origin: { kind: 'task-notification' },
    text: '<task-notification>\n<task-id>shell-q</task-id>\n<status>completed</status>\n<summary>Background command "npm run build" completed (exit code 0)</summary>\n</task-notification>',
  } as unknown as Parameters<typeof $.session.receive>[0])
  expect(await pane.find({ type: 'Button', text: 'Active (0)' })).toBeDefined()
  expect(await pane.find({ type: 'Button', text: 'Finished (1)' })).toBeDefined()
})
