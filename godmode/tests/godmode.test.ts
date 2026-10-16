import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { GodmodeMode } from '../types'

type Seen = { isOn?: boolean; mode?: GodmodeMode; writes: number }

/**
 * Records every write godmode makes to its state. A test's `$` has no `state` noun, but
 * its `state.set` hook sits beneath the plugin and sees each write on its way down.
 */
const watchState = (on: On) => {
  const seen: Seen = { writes: 0 }
  on('state.set', (_$, e, next) => {
    seen.writes += 1
    if (e.key === 'isOn') seen.isOn = e.value as boolean
    if (e.key === 'mode') seen.mode = e.value as GodmodeMode
    return next(e)
  })
  return seen
}

const godmode = ($: Engine, args = '') => $.command.run({ command: 'godmode', args } as Parameters<typeof $.command.run>[0])

test('session start registers /godmode', async ($, on) => {
  const names: string[] = []
  on('command.register', (_$, e) => {
    names.push(e.name)
    return { value: {} } as never
  })
  on('session.start', (_$, e) => e as never)

  await $.session.start({ cwd: '/tmp' } as Parameters<typeof $.session.start>[0])

  expect(names).toEqual(['godmode'])
})

test('/godmode switches on in coding mode, quietly', async ($, on) => {
  const seen = watchState(on)

  const answer = await godmode($)

  expect(seen.isOn).toBe(true)
  expect(seen.mode).toBe('coding')
  expect(answer.text).toBeUndefined()
})

test('/godmode while on changes nothing', async ($, on) => {
  const seen = watchState(on)
  await godmode($, 'setup')
  const writes = seen.writes

  const answer = await godmode($)

  expect(seen.writes).toBe(writes)
  expect(seen.mode).toBe('change-setup')
  expect(answer.text).toBeUndefined()
})

test('/godmode setup switches on in change-setup mode, from off and from coding', async ($, on) => {
  const seen = watchState(on)

  await godmode($, 'setup')
  expect(seen.isOn).toBe(true)
  expect(seen.mode).toBe('change-setup')

  await godmode($, 'off')
  await godmode($)
  expect(seen.mode).toBe('coding')

  const answer = await godmode($, 'setup')
  expect(seen.isOn).toBe(true)
  expect(seen.mode).toBe('change-setup')
  expect(answer.text).toContain('change-setup')
})

test('/godmode off switches off, and says so when already off', async ($, on) => {
  const seen = watchState(on)
  await godmode($)

  const answer = await godmode($, 'off')
  expect(seen.isOn).toBe(false)
  expect(answer.text).toContain('off')

  const writes = seen.writes
  const again = await godmode($, 'off')
  expect(seen.writes).toBe(writes)
  expect(again.text).toBe('godmode is already off.')
})

test('/godmode report and /godmode try answer without touching state', async ($, on) => {
  const seen = watchState(on)

  const report = await godmode($, 'report')
  const tried = await godmode($, 'try T-3')
  const bare = await godmode($, 'try')

  expect(seen.writes).toBe(0)
  expect(report.text).toContain('not built yet')
  expect(tried.text).toContain('T-3')
  expect(tried.text).toContain('not built yet')
  expect(bare.text).toContain('Name a ticket')
})

test('an unknown /godmode argument lists the commands and changes nothing', async ($, on) => {
  const seen = watchState(on)

  const answer = await godmode($, 'launch')

  expect(seen.writes).toBe(0)
  expect(answer.text).toContain('Unknown `/godmode launch`')
  expect(answer.text).toContain('/godmode try <ticket>')
})
