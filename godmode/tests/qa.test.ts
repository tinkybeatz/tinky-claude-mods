import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { QA_MODES, qaModeLine, qaModeOf } from '../hooks/role'
import { makeWorld, mountWorld, REPO } from './world'
import type { World } from './world'

const godmode = ($: Engine, args = '') => $.command.run({ command: 'godmode', args } as Parameters<typeof $.command.run>[0])

/** A committed note exactly as godmode 0.5.0 wrote it, before the four QA modes (D34's on or off). */
const noteFrom050 = (world: World, qa?: boolean) => {
  const answers = qa === undefined ? { tracker: 'none' } : { tracker: 'none', qa }
  world.pluginVersion = '0.5.0'
  world.files.set(`${REPO}/AGENTS.md`, '# Agent rules\n')
  world.files.set(
    `${REPO}/.godmode/shared.json`,
    JSON.stringify({ godmodeVersion: '0.5.0', storage: 'committed', writtenAt: '2026-11-01T10:00:00.000Z', answers, minimumModels: {}, conventions: [] }),
  )
  world.files.set(`${REPO}/.godmode/personal.json`, JSON.stringify({ writtenAt: '2026-11-01T10:00:00.000Z', answers: { permissions: 'free' }, models: {} }))
}

test('QA on or off from an older note reads as bot or none; the four modes read as themselves (D69)', () => {
  expect(qaModeOf({ qa: true })).toBe('bot')
  expect(qaModeOf({ qa: false })).toBe('none')
  expect(qaModeOf({})).toBe('none')
  for (const qaMode of QA_MODES) expect(qaModeOf({ qa: qaMode })).toBe(qaMode)
  expect(qaModeOf({ qa: 'sometimes' })).toBe('none')
  expect(qaModeLine({ qa: 'human-pr' }).startsWith('QA mode: human-pr (')).toBe(true)
})

test('the qaMode answer setup records wins over an older on or off one; an unknown mode falls back to it', () => {
  expect(qaModeOf({ qaMode: 'human-staging', qa: true })).toBe('human-staging')
  expect(qaModeOf({ qaMode: 'none', qa: true })).toBe('none')
  expect(qaModeOf({ qaMode: 'sometimes', qa: true })).toBe('bot')
  expect(qaModeOf({ qaMode: 'sometimes' })).toBe('none')
  // Only the human modes carry how people test; the others stay one sentence.
  expect(qaModeLine({ qaMode: 'bot', qaBotFirst: true, qaSignals: 'pr-approval' })).not.toContain('Pass signals')
  expect(qaModeLine({ qaMode: 'human-pr', qaSignals: 'pr-approval,slack' })).toContain('Pass signals: being told, a PR approval from nobody named yet.')
})

test('a note written with the four modes tells the PM its mode and pass signals on /godmode', async ($, on) => {
  const world = makeWorld()
  noteFrom050(world)
  const shared = JSON.parse(world.files.get(`${REPO}/.godmode/shared.json`) ?? '{}') as Record<string, unknown>
  const answers = { tracker: 'none', qaMode: 'human-pr', qaBotFirst: true, qaSignals: 'pr-approval', qaApprovers: 'alice, bob' }
  world.files.set(`${REPO}/.godmode/shared.json`, JSON.stringify({ ...shared, answers }))
  mountWorld(on, world)

  const answer = await godmode($)

  expect(answer.context).toContainEqual(
    expect.stringContaining('QA mode: human-pr (people test the PR before merge; it is not marked ready until QA passed). The QA agent tests first: yes. Pass signals: being told, a PR approval from alice, bob.'),
  )
})

test('a 0.5.0 note with QA on tells the PM "QA mode: bot" on /godmode, beside its role', async ($, on) => {
  const world = makeWorld()
  noteFrom050(world, true)
  mountWorld(on, world)

  const answer = await godmode($)

  expect(answer.text).toBeUndefined()
  expect(answer.context?.[0]).toContain('You are the PM')
  expect(answer.context).toContainEqual(expect.stringContaining('QA mode: bot'))
})

test('a 0.5.0 note with QA off, or with no QA answer, tells the PM "QA mode: none"', async ($, on) => {
  const world = makeWorld()
  mountWorld(on, world)

  for (const qa of [false, undefined]) {
    noteFrom050(world, qa)
    const answer = await godmode($)
    await godmode($, 'off')

    expect(answer.context).toContainEqual(expect.stringContaining('QA mode: none'))
  }
})

test('without its role file, the PM still hears the QA mode', async ($, on) => {
  const world = makeWorld({ plugin: new Map() })
  noteFrom050(world, true)
  mountWorld(on, world)

  const answer = await godmode($)

  expect(answer.context).toEqual([expect.stringContaining('QA mode: bot')])
})
