import { expect, mock, test } from 'claude-code/testing'
import type { Engine, Plugin } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { GodmodeIndicator } from '../types'

const PANE = 'dispatches'

/**
 * A stand-in for godmode: only its `isOn` and `indicator` values matter to the panel, so
 * `/godmode`, `/godmode off` and `/godmode <style>` here just write them, as the real mod
 * does when it switches or its setup changes the indicator. It never writes `indicator`
 * unasked, as godmode leaves it unset until a setup answers. The kit runs an inline
 * plugin's hooks on their own, so they name nothing from this file's scope.
 */
const godmode: Plugin = {
  name: 'godmode',
  register: on => {
    on('command.run', { command: 'godmode' }, async ($, e) => {
      const arg = e.args.trim()
      if (arg === 'mode' || arg === 'hint' || arg === 'band' || arg === 'pane') {
        await $.state.set({ plugin: 'godmode', key: 'indicator' }, arg)
      } else {
        await $.state.set({ plugin: 'godmode', key: 'isOn' }, arg !== 'off')
      }
      return { text: '' }
    })
  },
}

/**
 * Answers the pane calls beneath the panel with one record of open panes, as the engine keeps.
 * The person's close mark takes a pane out of that record; the panel only learns of it there.
 */
const panes = (on: On) => {
  const open = new Set<string>()
  mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  on('command.register', () => ({ value: { command: 'dispatches' } }))
  on('session.start', (_$, e) => e)
  on('ui.open', (_$, e) => {
    open.add(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.close', (_$, e) => {
    open.delete(e.id)
    return { value: undefined }
  })
  on('ui.panes', () => ({
    value: [...open].map(id => ({ id, title: id, isShown: true, isFocused: false, isPlaced: true })),
  }))
  return { isOpen: () => open.has(PANE), closeByHand: () => open.delete(PANE) }
}

const start = ($: Engine) => $.session.start({ cwd: '/tmp' } as Parameters<typeof $.session.start>[0])
const run = ($: Engine, command: string, args = '') =>
  $.command.run({ command, args } as Parameters<typeof $.command.run>[0])
const switchGodmode = ($: Engine, args: '' | 'off' | GodmodeIndicator) => run($, 'godmode', args)

test('godmode switching on hides the panel', { plugins: [godmode] }, async ($, on) => {
  const pane = panes(on)
  await start($)
  expect(pane.isOpen()).toBe(true)

  await switchGodmode($, '')

  expect(pane.isOpen()).toBe(false)
})

test('godmode switching off brings back the panel it hid', { plugins: [godmode] }, async ($, on) => {
  const pane = panes(on)
  await start($)
  await switchGodmode($, '')

  await switchGodmode($, 'off')

  expect(pane.isOpen()).toBe(true)
})

test('a panel the person closed stays closed across godmode on and off', { plugins: [godmode] }, async ($, on) => {
  const pane = panes(on)
  await start($)
  pane.closeByHand()

  await switchGodmode($, '')
  await switchGodmode($, 'off')

  expect(pane.isOpen()).toBe(false)
})

test('a panel the person opened while godmode was on is theirs to close', { plugins: [godmode] }, async ($, on) => {
  const pane = panes(on)
  await start($)
  await switchGodmode($, '')
  await run($, 'dispatches')
  pane.closeByHand()

  await switchGodmode($, 'off')

  expect(pane.isOpen()).toBe(false)
})

test('a session that starts with godmode on opens the panel only once godmode is off', { plugins: [godmode] }, async ($, on) => {
  const pane = panes(on)
  await switchGodmode($, '')
  await start($)
  expect(pane.isOpen()).toBe(false)

  await switchGodmode($, 'off')

  expect(pane.isOpen()).toBe(true)
})

test('godmode on with a mode label, hint tag or band leaves the panel open', { plugins: [godmode] }, async ($, on) => {
  const pane = panes(on)
  await start($)

  for (const style of ['mode', 'hint', 'band'] as const) {
    await switchGodmode($, style)
    await switchGodmode($, '')
    expect(pane.isOpen()).toBe(true)
    await switchGodmode($, 'off')
  }
})

test('godmode set to its pane while on hides the panel, and set to a band brings it back', { plugins: [godmode] }, async ($, on) => {
  const pane = panes(on)
  await switchGodmode($, 'band')
  await start($)
  await switchGodmode($, '')
  expect(pane.isOpen()).toBe(true)

  await switchGodmode($, 'pane')
  expect(pane.isOpen()).toBe(false)

  await switchGodmode($, 'band')
  expect(pane.isOpen()).toBe(true)
})

test('a session that starts with godmode on and a band opens the panel', { plugins: [godmode] }, async ($, on) => {
  const pane = panes(on)
  await switchGodmode($, 'band')
  await switchGodmode($, '')

  await start($)

  expect(pane.isOpen()).toBe(true)
})

test('without godmode the panel opens at start, and a closed one comes back only on /dispatches', async ($, on) => {
  const pane = panes(on)
  await start($)
  expect(pane.isOpen()).toBe(true)

  pane.closeByHand()
  expect(pane.isOpen()).toBe(false)

  await run($, 'dispatches')
  expect(pane.isOpen()).toBe(true)
})
