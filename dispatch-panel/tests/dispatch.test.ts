import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { GROUP_COLORS, groupColor } from '../hooks/kinds'
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

test('agent types map to their group colour from the fixed table, unknown types to white', () => {
  const agent = (label: string): Dispatch => ({ id: label, kind: 'agent', label, purpose: '', status: 'running', startedAt: 0 })
  expect(groupColor(agent('claude'))).toBe(GROUP_COLORS.code)
  expect(groupColor(agent('general-purpose'))).toBe(GROUP_COLORS.code)
  expect(groupColor(agent('test'))).toBe(GROUP_COLORS.review)
  expect(groupColor(agent('Explore'))).toBe(GROUP_COLORS.explore)
  expect(groupColor(agent('Plan'))).toBe(GROUP_COLORS.plan)
  expect(groupColor(agent('claude-code-guide'))).toBe(GROUP_COLORS.helper)
  expect(groupColor(agent('code-reviewer'))).toBe(GROUP_COLORS.unknown)
  expect(groupColor({ ...agent('bash'), kind: 'shell' })).toBe(GROUP_COLORS.shell)
})
