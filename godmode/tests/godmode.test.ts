import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { GodmodeMode, SetupScope } from '../types'
import { FIRST_COMMIT, HOME, makeWorld, mountWorld, REPO, setUpProject } from './world'

type Seen = { isOn?: boolean; mode?: GodmodeMode; setupScope?: SetupScope; recheck?: string[]; writes: number }

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
    if (e.key === 'setupScope') seen.setupScope = e.value as SetupScope
    if (e.key === 'recheck') seen.recheck = e.value as string[]
    return next(e)
  })
  return seen
}

/** A project already set up, so `/godmode` switches on in coding mode. */
const setUp = async (on: On) => {
  const world = makeWorld()
  await setUpProject(world)
  mountWorld(on, world)
  return world
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
  await setUp(on)
  const seen = watchState(on)

  const answer = await godmode($)

  expect(seen.isOn).toBe(true)
  expect(seen.mode).toBe('coding')
  expect(answer.text).toBeUndefined()
})

test('/godmode while on changes nothing', async ($, on) => {
  await setUp(on)
  const seen = watchState(on)
  await godmode($, 'setup')
  const writes = seen.writes

  const answer = await godmode($)

  expect(seen.writes).toBe(writes)
  expect(seen.mode).toBe('change-setup')
  expect(answer.text).toBeUndefined()
})

test('/godmode setup switches on in change-setup mode, from off and from coding', async ($, on) => {
  await setUp(on)
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
  await setUp(on)
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

test('/godmode with no setup note switches on in setup mode', async ($, on) => {
  mountWorld(on, makeWorld())
  const seen = watchState(on)

  const answer = await godmode($)

  expect(seen.isOn).toBe(true)
  expect(seen.mode).toBe('setup')
  expect(seen.setupScope).toBe('full')
  expect(answer.text).toBeUndefined()
})

for (const storage of ['committed', 'gitignored', 'outside'] as const) {
  test(`/godmode finds ${storage === 'outside' ? 'an' : 'a'} ${storage} note and switches on in coding mode`, async ($, on) => {
    const world = makeWorld()
    await setUpProject(world, { storage })
    mountWorld(on, world)
    const seen = watchState(on)

    const answer = await godmode($)

    expect(seen.mode).toBe('coding')
    expect(seen.recheck).toEqual([])
    expect(answer.text).toBeUndefined()
  })
}

test('/godmode in a teammate\'s committed project, with no personal note, runs the personal setup', async ($, on) => {
  const world = makeWorld()
  await setUpProject(world, { storage: 'committed' })
  world.files.delete(`${REPO}/.godmode/personal.json`)
  mountWorld(on, world)
  const seen = watchState(on)

  await godmode($)

  expect(seen.mode).toBe('setup')
  expect(seen.setupScope).toBe('personal')
})

test('/godmode lists a conventions file edited or removed since the note for re-check', async ($, on) => {
  const world = makeWorld()
  world.files.set(`${REPO}/docs/testing.md`, 'Red-check every test.\n')
  world.files.set(`${REPO}/docs/git.md`, 'Branch per ticket.\n')
  await setUpProject(world, { conventions: ['AGENTS.md', 'docs/testing.md', 'docs/git.md'] })
  world.files.set(`${REPO}/docs/testing.md`, 'Red-check every test, and extend before adding.\n')
  world.files.delete(`${REPO}/docs/git.md`)
  mountWorld(on, world)
  const seen = watchState(on)

  const answer = await godmode($)

  expect(seen.mode).toBe('coding')
  expect(seen.recheck).toEqual(['docs/testing.md', 'docs/git.md'])
  expect(answer.text).toBeUndefined()
})

test('/godmode on a note from an older godmode says an update is available, in one line', async ($, on) => {
  const world = makeWorld({ pluginVersion: '0.3.0' })
  await setUpProject(world, {}, '0.2.0')
  mountWorld(on, world)
  const seen = watchState(on)

  const answer = await godmode($)

  expect(seen.mode).toBe('coding')
  expect(answer.text).toContain('godmode update is available')
  expect(answer.text).toContain('0.2.0')
  expect(answer.text).toContain('0.3.0')
  expect(answer.text?.split('\n')).toHaveLength(1)
})

for (const version of ['0.2.0', '0.10.0']) {
  test(`/godmode on a note from godmode ${version}, run by 0.2.0, says nothing`, async ($, on) => {
    const world = makeWorld({ pluginVersion: '0.2.0' })
    await setUpProject(world, {}, version)
    mountWorld(on, world)

    const answer = await godmode($)

    expect(answer.text).toBeUndefined()
  })
}

test('/godmode in a folder with no git runs setup without failing', async ($, on) => {
  mountWorld(on, makeWorld({ git: undefined, sessionRoot: '/work/notes' }))
  const seen = watchState(on)

  const answer = await godmode($)

  expect(seen.mode).toBe('setup')
  expect(answer.text).toBeUndefined()
})

test('/godmode on a note it cannot read says so and runs setup', async ($, on) => {
  const world = makeWorld()
  world.files.set(`${REPO}/.godmode/shared.json`, '{ not json')
  mountWorld(on, world)
  const seen = watchState(on)

  const answer = await godmode($)

  expect(seen.mode).toBe('setup')
  expect(answer.text).toContain(`${REPO}/.godmode/shared.json`)
})

test('/godmode finds an outside note under CLAUDE_CONFIG_DIR by the first commit', async ($, on) => {
  const world = makeWorld({ env: { HOME, CLAUDE_CONFIG_DIR: '/config/claude' } })
  const dir = await setUpProject(world, { storage: 'outside' })
  mountWorld(on, world)
  const seen = watchState(on)

  await godmode($)

  expect(dir).toBe(`/config/claude/godmode/projects/${FIRST_COMMIT}`)
  expect(seen.mode).toBe('coding')
})
