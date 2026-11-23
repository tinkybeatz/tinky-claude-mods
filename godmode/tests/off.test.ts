import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { isPersonPaneClose, NOTE_GONE, PANE_CLOSED, SETUP_UNFINISHED } from '../hooks/off'
import type { Answer } from '../hooks/storage'
import { makeWorld, mountWorld, REPO, setUpProject } from './world'
import type { World } from './world'

/*
 * 0.8.3: godmode never stays on where its tools cannot work. A setup that does not finish, the
 * person closing the side pane, or a note that is gone switches it fully off: no pane, no
 * indicator, nothing injected into the next prompt.
 */

type Seen = { logs: string[]; contexts: (readonly string[] | undefined)[]; closes: string[] }

const mount = (on: On, world: World): Seen => {
  const seen: Seen = { logs: [], contexts: [], closes: [] }
  mountWorld(on, world)
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }) as never)
  on('agent.list', () => ({ value: [] }))
  on('agent.spawn', (_$, e) => ({ model: e.model ?? 'inherit', agentId: 'agent-setup' }))
  on('ui.toast', () => ({ value: undefined }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.panes', () => ({ value: [{ id: 'godmode', title: 'godmode', isShown: true, isFocused: false, isPlaced: true }] }) as never)
  on('ui.close', (_$, e) => {
    seen.closes.push(`${e.id}:${e.origin.kind}`)
    return { value: undefined } as never
  })
  on('ui.log', (_$, e) => {
    seen.logs.push(e.text)
    return { value: undefined } as never
  })
  on('session.receive', (_$, e) => e as never)
  on('prompt.submit', (_$, e) => {
    seen.contexts.push(e.context)
    return { text: e.text, context: e.context }
  })
  on('tool.call', () => ({ result: 'ok' }) as never)
  return seen
}

const godmode = ($: Engine, args = '') => $.command.run({ command: 'godmode', args } as Parameters<typeof $.command.run>[0])

const prompt = ($: Engine) => $.prompt.submit({ text: 'next?' } as Parameters<typeof $.prompt.submit>[0])

/** The setup agent's end, as its task notification reaches the main thread. */
const setupEnds = ($: Engine, status: string) =>
  $.session.receive({
    origin: { kind: 'task-notification' },
    text: `<task-notification><task-id>agent-setup</task-id><status>${status}</status><result>Stopped.</result></task-notification>`,
  } as unknown as Parameters<typeof $.session.receive>[0])

const setUp = (world: World, personal: Record<string, Answer> = {}) =>
  setUpProject(world, { sharedAnswers: { tracker: 'none', qaMode: 'none' }, personalAnswers: { care: 'careful', indicator: 'pane', ...personal } })

for (const status of ['completed', 'killed', 'failed']) {
  test(`a setup agent that ends ${status} before setup_finish saved turns godmode off, and nothing is injected after`, async ($, on) => {
    const seen = mount(on, makeWorld())
    await godmode($)
    await $.agent.spawn({ prompt: 'Set up godmode for this project. Scope: full.', description: 'godmode setup', subagentType: 'godmode:setup' } as Parameters<typeof $.agent.spawn>[0])

    await setupEnds($, status)

    expect(seen.logs).toContain(SETUP_UNFINISHED)
    await prompt($)
    expect(seen.contexts.at(-1)).toBeUndefined()
    expect((await godmode($, 'off')).text).toBe('godmode is already off.')
  })
}

test('a setup agent ending after setup saved leaves godmode on in coding mode', async ($, on) => {
  const world = makeWorld()
  await setUp(world)
  const seen = mount(on, world)
  await godmode($)
  await $.agent.spawn({ prompt: 'Review PR #3.', description: 'review', subagentType: 'godmode:setup' } as Parameters<typeof $.agent.spawn>[0])

  await setupEnds($, 'completed')

  expect(seen.logs).not.toContain(SETUP_UNFINISHED)
  await prompt($)
  expect(seen.contexts.at(-1)?.join('\n')).toContain('godmode is on: you are its PM')
})

test('only the person\'s own close of godmode\'s pane means "godmode off"; godmode\'s own close and an unload do not', () => {
  // The test kit cannot raise a close with the person's origin, so the rule the ui.close hook applies is checked here.
  expect(isPersonPaneClose({ id: 'godmode', origin: { kind: 'person' } })).toBe(true)
  expect(isPersonPaneClose({ id: 'godmode', origin: { kind: 'plugin' } })).toBe(false)
  expect(isPersonPaneClose({ id: 'godmode', origin: { kind: 'unload' } })).toBe(false)
  expect(isPersonPaneClose({ id: 'dispatches', origin: { kind: 'person' } })).toBe(false)
})

test('godmode\'s own close at /godmode off closes the pane once and does not loop', async ($, on) => {
  const world = makeWorld()
  await setUp(world)
  const seen = mount(on, world)
  await godmode($)

  await godmode($, 'off')

  expect(seen.closes.filter(close => close.startsWith('godmode:'))).toHaveLength(1)
  expect(seen.logs).not.toContain(PANE_CLOSED)
})

test('a note deleted while godmode is on turns it off at the next prompt, in coding mode and in change-setup', async ($, on) => {
  const world = makeWorld()
  await setUp(world)
  const seen = mount(on, world)

  for (const args of ['', 'setup']) {
    await godmode($, args)
    const saved = new Map(world.files)
    for (const path of [...world.files.keys()]) if (path.startsWith(`${REPO}/.godmode/`)) world.files.delete(path)
    await prompt($)
    expect(seen.contexts.at(-1)).toBeUndefined()
    expect(seen.logs.filter(line => line === NOTE_GONE)).toHaveLength(args === '' ? 1 : 2)
    for (const [path, text] of saved) world.files.set(path, text)
  }
})
