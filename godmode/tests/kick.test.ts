import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { KICK } from '../hooks/register'
import { makeWorld, mountWorld, REPO, setUpProject } from './world'
import type { World } from './world'

/*
 * 0.8.3: a `/godmode` command that leaves the PM instructions starts the PM's turn itself, with
 * one short prompt; the instructions are the command's hidden context. A command with nothing
 * for the PM starts none.
 */

type Prompt = { text: string; context: readonly string[] }

/** The world's clock: the PM's prompt is sent from a timer right after the command. */
let clock: ReturnType<typeof mountWorld> | undefined

/** Mounts the world and records every prompt that reaches the engine. */
const mount = (on: On, world: World) => {
  const prompts: Prompt[] = []
  clock = mountWorld(on, world)
  mock.store(on)
  on('agent.list', () => ({ value: [] }))
  on('ui.toast', () => ({ value: undefined }) as never)
  on('ui.log', () => ({ value: undefined }) as never)
  on('ui.panes', () => ({ value: [] }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('prompt.submit', (_$, e) => {
    prompts.push({ text: e.text, context: e.context ?? [] })
    return { text: e.text, context: e.context }
  })
  on('tool.call', (_$, e) => {
    const input = e as unknown as Record<string, unknown>
    if (e.tool !== 'AskUserQuestion') return { result: 'ok' } as never
    const question = (input.questions as { question: string; options: { label: string }[] }[])[0]
    return { result: { questions: input.questions, answers: { [question?.question ?? '']: question?.options.at(-1)?.label ?? '' } } } as never
  })
  return prompts
}

const godmode = async ($: Engine, args = '') => {
  const answer = await $.command.run({ command: 'godmode', args } as Parameters<typeof $.command.run>[0])
  // The prompt goes from a timer right after the command: let it fire.
  await clock?.advance(1)
  return answer
}

const kicks = (prompts: readonly Prompt[]) => prompts.filter(prompt => prompt.text === KICK)

/** A project set up for the loop, its note written by the running version. */
const setUp = async (world: World) => {
  world.files.set(`${REPO}/package.json`, JSON.stringify({ name: 'app', scripts: { test: 'vitest run' } }))
  await setUpProject(world, { sharedAnswers: { tracker: 'none', qaMode: 'none', testCommand: 'npm test' }, personalAnswers: { care: 'careful', indicator: 'mode' } })
}

test('/godmode into coding mode starts the PM\'s turn once, with its role in the command\'s context and nothing said twice', async ($, on) => {
  const world = makeWorld()
  await setUp(world)
  const prompts = mount(on, world)

  const answer = await godmode($)

  expect(answer.context?.join('\n')).toContain('You are the PM')
  expect(kicks(prompts)).toHaveLength(1)
  // The kick carries no reminder of the role the command's context already gave.
  expect(kicks(prompts)[0]?.context.join('\n') ?? '').not.toContain('godmode is on: you are its PM')
})

test('/godmode with no setup starts one turn, in which the PM dispatches the setup agent', async ($, on) => {
  const prompts = mount(on, makeWorld())

  const answer = await godmode($)

  expect(answer.context?.join('\n')).toContain('Dispatch the setup now')
  expect(kicks(prompts)).toHaveLength(1)
})

test('/godmode setup starts one turn for the change-setup brief', async ($, on) => {
  const world = makeWorld()
  await setUp(world)
  const prompts = mount(on, world)

  await godmode($, 'setup')

  expect(kicks(prompts)).toHaveLength(1)
})

test('/godmode audit starts a turn only when it found something to fix', async ($, on) => {
  const world = makeWorld({ pluginVersion: '0.8.3' })
  await setUpProject(world, { sharedAnswers: { tracker: 'none', qaMode: 'none', testCommand: 'npm run e2e' } }, '0.8.0')
  world.files.set(`${REPO}/package.json`, JSON.stringify({ name: 'app', scripts: { test: 'vitest run' } }))
  const prompts = mount(on, world)

  const audit = await godmode($, 'audit')

  expect(audit.context).toBeDefined()
  expect(kicks(prompts)).toHaveLength(1)
})

test('commands with nothing for the PM start no turn: /godmode while on, off, report, try, try stop and reset', async ($, on) => {
  const world = makeWorld()
  await setUp(world)
  const prompts = mount(on, world)
  await godmode($)
  const before = kicks(prompts).length

  for (const args of ['', 'report', 'try', 'try stop', 'off', 'reset']) await godmode($, args)

  expect(before).toBe(1)
  expect(kicks(prompts)).toHaveLength(1)
})
