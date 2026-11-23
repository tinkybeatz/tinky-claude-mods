import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { AgentInfo, On, RenderElement } from 'claude-code'

import { describeAction, shellTitle } from '../hooks/pane-actions'
import { ACTIVITIES, activityColor, activityFromDescription, activityTag, NEUTRAL_COLOR } from '../hooks/pane-kinds'
import type { Answer } from '../hooks/storage'
import type { PaneRow } from '../types'
import { makeWorld, mountWorld, setUpProject } from './world'

/*
 * godmode's side pane (the "Side pane" indicator): the dispatch panel's look, ported into
 * godmode with its own pane id and state, under a red GODMODE header with godmode's own
 * sections; open while godmode is on, closed when it is off, and the band when it cannot show.
 */

const PANE_PROPS = {
  title: 'godmode',
  isFocused: false,
  bodyColumns: 48,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
} as const

const mountPane = ($: Engine) => $.ui.mount({ plugin: 'godmode', surface: 'terminal', component: 'Pane', requestId: 'godmode', props: PANE_PROPS })

const mountBand = ($: Engine) =>
  $.ui.mount({ plugin: 'godmode', surface: 'terminal', component: 'AbovePrompt', props: { bodyColumns: 80, hasSurvey: false, isCollapsed: false } } as Parameters<typeof $.ui.mount>[0])

const godmode = ($: Engine, args = '') => $.command.run({ command: 'godmode', args } as Parameters<typeof $.command.run>[0])

type Options = { indicator?: Answer; isPlaced?: boolean; agents?: AgentInfo[]; shared?: Record<string, Answer>; beneath?: (on: On) => void }

/** A set-up project with the side pane as the person's indicator, godmode switched on, and the engine's answers beneath. */
const startPane = async ($: Engine, on: On, options: Options = {}) => {
  const world = makeWorld({ gh: { login: 'me', prs: [] } })
  await setUpProject(world, { sharedAnswers: { tracker: 'none', qaMode: 'none', ...options.shared }, personalAnswers: { indicator: options.indicator ?? 'pane', care: 'careful' } })
  const clock = mountWorld(on, world)
  const seen = { opened: [] as string[], closed: [] as string[], commands: [] as string[], store: new Map<string, unknown>() }
  on('store.get', (_$, e) => ({ value: seen.store.get(e.key) }))
  on('store.set', (_$, e) => {
    seen.store.set(e.key, e.value)
    return { value: undefined } as never
  })
  on('command.register', (_$, e) => {
    seen.commands.push(e.name)
    return { value: { command: e.name } } as never
  })
  on('ui.open', (_$, e) => {
    seen.opened.push(e.id)
    return { value: options.isPlaced === false ? { isPlaced: false, reason: 'the terminal is narrower than 144 columns' } : { isPlaced: true } } as never
  })
  on('ui.panes', () => ({ value: seen.opened.filter(id => !seen.closed.includes(id)).map(id => ({ id, title: 'godmode', isShown: true, isFocused: false, isPlaced: options.isPlaced !== false })) }) as never)
  on('ui.close', (_$, e) => {
    seen.closed.push(e.id)
    return { value: undefined } as never
  })
  on('ui.toast', () => ({ value: undefined }) as never)
  on('ui.log', () => ({ value: undefined }) as never)
  on('agent.list', () => ({ value: options.agents ?? [] }))
  on('agent.spawn', (_$, e) => ({ model: e.model ?? 'inherit', agentId: `agent-${e.description}` }))
  on('model.classify', () => ({ value: 'writing or changing code' }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: {},
      rateLimits: [
        { kind: 'five_hour', percentUsed: 62.4, resetsAt: '2026-10-16T12:00:00Z' },
        { kind: 'seven_day', percentUsed: 93, resetsAt: '2026-10-19T09:30:00Z' },
      ],
    },
  }) as never)
  on('classic.Stop', () => ({}))
  on('session.start', (_$, e) => e as never)
  options.beneath?.(on)
  on('prompt.submit', (_$, e) => ({ text: e.text, context: e.context }))
  on('ui.render', () => ({ type: 'Text', children: ['engine'] }) as unknown as RenderElement)
  on('tool.call', (_$, e) => {
    const input = e as unknown as Record<string, unknown>
    if (e.tool === 'Bash') return { result: { stdout: '', stderr: '', interrupted: false, ...(input.run_in_background === true ? { backgroundTaskId: 'shell-1' } : {}) } } as never
    return { result: 'ok' } as never
  })
  await $.session.start({ cwd: world.sessionRoot } as Parameters<typeof $.session.start>[0])
  await godmode($)
  return { world, clock, seen }
}

test('the side pane opens with godmode, under a red GODMODE header naming the mode, and closes when godmode turns off', async ($, on) => {
  const { seen } = await startPane($, on)

  expect(seen.opened).toEqual(['godmode'])
  const pane = await mountPane($)
  expect(await pane.find({ text: 'GODMODE' })).toBeDefined()
  expect(await pane.find({ text: ' · coding' })).toBeDefined()
  expect(await pane.find({ type: 'Button', text: 'Active (0)' })).toBeDefined()
  expect(await pane.find({ text: 'Nothing running.' })).toBeDefined()
  // Sections with nothing in them are left out.
  expect(await pane.find({ text: /^Tickets/ })).toBeUndefined()
  expect(await pane.find({ text: /^Waits on you/ })).toBeUndefined()
  expect(await pane.find({ text: 'Try' })).toBeUndefined()

  await godmode($, 'off')
  expect(seen.closed).toEqual(['godmode'])
})

test('the side pane stays open in every godmode mode: change-setup too', async ($, on) => {
  const { seen } = await startPane($, on)
  await godmode($, 'setup')
  expect(seen.closed).toEqual([])
  const pane = await mountPane($)
  expect(await pane.find({ text: ' · change-setup' })).toBeDefined()
})

test('another indicator opens no pane', async ($, on) => {
  const { seen } = await startPane($, on, { indicator: 'band' })
  expect(seen.opened).toEqual([])
})

test('a pane the terminal cannot place falls back to the band, so the person still sees godmode is on', async ($, on) => {
  await startPane($, on, { isPlaced: false })

  const band = await mountBand($)
  expect(await band.find({ text: 'GODMODE' })).toBeDefined()
})

test('a placed pane leaves the band to the engine', async ($, on) => {
  await startPane($, on)

  const band = await mountBand($)
  expect(await band.find({ text: 'GODMODE' })).toBeUndefined()
  expect(await band.find({ text: 'engine' })).toBeDefined()
})

test('godmode\'s sections: open tickets with their status, and what waits on the person', async ($, on) => {
  await startPane($, on)
  const create = (title: string) => $.tool.call({ tool: 'mcp__godmode__ticket_create', title, ask: title, visibleChange: false } as Parameters<typeof $.tool.call>[0])
  await create('Export button')
  await create('Report filters')
  await $.tool.call({ tool: 'mcp__godmode__ticket_move', id: 'T-2', ready: true, status: 'doing' } as Parameters<typeof $.tool.call>[0])

  const pane = await mountPane($)

  expect(await pane.find({ text: 'Tickets (2)' })).toBeDefined()
  expect(await pane.find({ text: 'Waits on you (1)' })).toBeDefined()
  // T-1 waits for the person's go; T-2 is under way.
  expect(await pane.find({ text: 'T-1: go to start' })).toBeDefined()
  expect(await pane.find({ text: 'doing' })).toBeDefined()
})

// ---------------------------------------------------------------------------
// The dispatch panel's content, ported (agents, shells, tabs, tokens, durations, usage bars)

test('a backgrounded shell moves from the active tab to the finished tab, and clear drops it', async ($, on) => {
  const { clock } = await startPane($, on)

  await $.tool.call({ tool: 'Bash', tool_use_id: 'use-1', command: 'npm run dev', description: 'Start the dev server', run_in_background: true } as Parameters<typeof $.tool.call>[0])

  const pane = await mountPane($)
  expect(await pane.find({ text: 'Start the dev server' })).toBeDefined()
  expect(await pane.find({ text: '●' })).toBeDefined()

  await clock.advance(65_000)
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [] } as Parameters<typeof $.classic.Stop>[0])

  expect(await pane.find({ text: 'Start the dev server' })).toBeUndefined()
  expect(await pane.find({ type: 'Button', text: 'Finished (1)' })).toBeDefined()
  await pane.press({ key: 'tab-finished' })
  expect(await pane.find({ text: '✓' })).toBeDefined()
  expect(await pane.find({ text: '1m05s' })).toBeDefined()
  await pane.press({ key: 'clear' })
  expect(await pane.find({ text: 'Nothing finished yet.' })).toBeDefined()
})

test('an agent card sums its tokens across requests and names its godmode role and ticket', async ($, on) => {
  await startPane($, on, {
    beneath: below =>
      below('turn.step', async function* (_$, e) {
        return {
          turnId: e.turnId,
          index: e.index,
          answer: '',
          toolUses: [],
          stopReason: 'end_turn',
          usage: { model: 'test-model', input_tokens: 200, cache_read_input_tokens: 1000, cache_creation_input_tokens: 300 * (e.index + 1), output_tokens: 150 },
        }
      }),
  })
  await $.agent.spawn({ tool_use_id: 'use-3', prompt: 'Review PR #3.', description: 'Review PR 3', subagentType: 'godmode:reviewer' } as Parameters<typeof $.agent.spawn>[0])
  for (const index of [0, 1]) {
    const stream = $.turn.step({ turnId: 'turn-1', index, model: 'test-model', messageCount: 3, agentId: 'agent-Review PR 3' } as Parameters<typeof $.turn.step>[0])
    for await (const _chunk of stream) {
      // drain the step
    }
  }

  const pane = await mountPane($)
  expect(await pane.find({ text: 'Review PR 3' })).toBeDefined()
  expect(await pane.find({ text: 'in 3.3k · out 300' })).toBeDefined()
  expect(await pane.find({ text: 'reviewer' })).toBeDefined()
  expect(await pane.find({ text: '▸ ' })).toBeDefined()
})

test('the footer draws the session and week usage bars', async ($, on) => {
  const { clock } = await startPane($, on)
  await clock.advance(1000)

  const pane = await mountPane($)
  expect(await pane.find({ text: 'Session (5h)' })).toBeDefined()
  expect(await pane.find({ text: 'Week' })).toBeDefined()
  expect(await pane.find({ text: '93%' })).toBeDefined()
})

test('godmode and the dispatch panel never clash: another pane id, godmode\'s own command and state', async ($, on) => {
  const { seen } = await startPane($, on)
  expect(seen.opened).not.toContain('dispatches')
  expect(seen.commands).toEqual(['godmode'])
})

test('ported: an action reads as a short phrase, a shell as its title, an activity as its colour and tag', () => {
  expect(describeAction('Bash', { command: 'git commit -m x' })).toBe('committing')
  expect(describeAction('Read', { file_path: '/work/app/src/a.ts' })).toBe('reading a.ts')
  expect(describeAction('mcp__claude_ai_Atlassian__editJiraIssue', {})).toBe('updating Jira')
  expect(shellTitle('vitest run')).toBe('Running tests')
  const row: PaneRow = { id: 'a', kind: 'agent', label: 'Explore', purpose: 'x', status: 'running', startedAt: 0 }
  expect(activityColor(row)).toBe(NEUTRAL_COLOR)
  const coded = { ...row, activity: ACTIVITIES[0].label }
  expect(activityColor(coded)).toBe(ACTIVITIES[0].color)
  expect(activityTag(coded)).toBe('code')
  expect(activityFromDescription('Update APP-12 in Jira')).toBe('updating tickets (Jira, issues)')
})
