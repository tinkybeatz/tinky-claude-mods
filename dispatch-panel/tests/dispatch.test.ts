import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { describeAction } from '../hooks/actions'
import { ACTIVITIES, NEUTRAL_COLOR, activityColor } from '../hooks/kinds'
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

test('an agent row shows its latest input tokens and its summed output tokens', async ($, on) => {
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
  expect(await pane.find({ text: 'in 1.8k · out 300' })).toBeDefined()
})

test('an agent is coloured by the activity the classifier picks, not by its type', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const asked: string[] = []
  mock.store(on)
  on('agent.list', () => ({ value: [] }))
  on('command.register', () => ({ value: {} }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.panes', () => ({ value: [] }))
  on('session.start', (_$, e) => e as never)
  on('model.classify', (_$, e) => {
    asked.push(e.text)
    return { value: e.text.includes('Jira') ? 'updating tickets (Jira, issues)' : 'writing or changing code' }
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

  expect(asked).toHaveLength(2)
  const pane = await mountPane($)
  const code = await pane.find({ text: 'Implement the export button' })
  const jira = await pane.find({ text: 'Update PROD-4882 in Jira' })
  expect(code).toBeDefined()
  expect(jira).toBeDefined()
  const drawn = JSON.stringify(await pane.drawn())
  expect(drawn).toContain('#3b82f6')
  expect(drawn).toContain('#22d3ee')
})

const row = (id: string): Dispatch => ({ id, kind: 'agent', label: 'general-purpose', purpose: '', status: 'running', startedAt: 0 })

test('every activity has its own colour, and unclassified agents and shells are neutral', () => {
  const colors = ACTIVITIES.map(activity => activity.color)
  expect(new Set(colors).size).toBe(colors.length)
  expect(activityColor(row('x'))).toBe(NEUTRAL_COLOR)
  expect(activityColor({ ...row('s'), kind: 'shell' })).toBe(NEUTRAL_COLOR)
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
