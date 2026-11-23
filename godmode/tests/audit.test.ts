import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { Answer } from '../hooks/storage'
import { makeWorld, mountWorld, REPO, setUpProject } from './world'
import type { World } from './world'

/*
 * `/godmode audit` (D75): the saved setup checked against the project as it is now, in place,
 * after an update and a reload that start no session.
 */

type Audit = { logs: string[]; asked: string[]; contexts: (readonly string[] | undefined)[] }

/** The world, the person (who answers the first option) and a record of logged lines and prompt context. */
const mount = (on: On, world: World): Audit => {
  const audit: Audit = { logs: [], asked: [], contexts: [] }
  mountWorld(on, world)
  mock.store(on)
  on('agent.list', () => ({ value: [] }))
  on('ui.toast', () => ({ value: undefined }) as never)
  on('ui.log', (_$, e) => {
    audit.logs.push(e.text)
    return { value: undefined } as never
  })
  on('prompt.submit', (_$, e) => {
    audit.contexts.push(e.context)
    return { text: e.text, context: e.context }
  })
  on('tool.call', (_$, e) => {
    const input = e as unknown as Record<string, unknown>
    if (e.tool !== 'AskUserQuestion') return { result: 'ok' } as never
    const question = (input.questions as { question: string; header: string; options: { label: string }[] }[])[0]
    audit.asked.push(question?.header ?? '')
    return { result: { questions: input.questions, answers: { [question?.question ?? '']: question?.options[0]?.label ?? '' } } } as never
  })
  return audit
}

const godmode = ($: Engine, args = '') => $.command.run({ command: 'godmode', args } as Parameters<typeof $.command.run>[0])

const prompt = ($: Engine) => $.prompt.submit({ text: 'next?' } as Parameters<typeof $.prompt.submit>[0])

const call = async ($: Engine, name: string, input: Record<string, unknown> = {}) =>
  (await $.tool.call({ tool: `mcp__godmode__${name}`, ...input } as Parameters<typeof $.tool.call>[0])) as { deny?: string; result?: unknown }

/** A project whose saved answers all hold: its test script exists and its base branch is there. */
const cleanProject = async (world: World, shared: Record<string, Answer> = {}) => {
  world.files.set(`${REPO}/package.json`, JSON.stringify({ name: 'app', scripts: { test: 'vitest run' } }))
  world.answer = run => (run.argv.join(' ') === 'git show-ref --verify --quiet refs/heads/main' ? { exitCode: 0, stdout: '' } : undefined)
  await setUpProject(world, {
    sharedAnswers: { tracker: 'none', qaMode: 'bot', baseBranch: 'main', testCommand: 'npm test', ...shared },
    personalAnswers: { autoMerge: false, prApproval: 'ask' },
  })
}

test('a clean project audits in one line, and godmode stays where it was', async ($, on) => {
  const world = makeWorld({ pluginVersion: '0.7.1' })
  await cleanProject(world)
  mount(on, world)
  await godmode($)

  const audit = await godmode($, 'audit')

  expect(audit.text).toMatch(/^godmode audit: all \d+ checks hold for godmode 0\.7\.1\.$/)
  expect(audit.context).toBeUndefined()
  expect((await call($, 'setup_finish')).deny).toContain('not in setup mode')
})

test('after an update and a reload mid-session, the next prompt suggests the audit once, and the audit runs in place', async ($, on) => {
  const world = makeWorld({ pluginVersion: '0.7.0' })
  await cleanProject(world)
  const audit = mount(on, world)
  await godmode($)
  await prompt($)
  expect(audit.logs).toEqual([])

  // `/plugin update` and `/reload-plugins`: a new version loads, and no session starts.
  world.pluginVersion = '0.7.1'
  await prompt($)
  await prompt($)

  expect(audit.logs).toEqual(['godmode 0.7.1 is loaded, and this project\'s setup (.godmode) was written by 0.7.0: `/godmode audit` checks it against the project and the new version.'])
  expect((await godmode($, 'audit')).text).toMatch(/^godmode audit: all \d+ checks hold for godmode 0\.7\.1\.$/)
})

test('drift is listed with its fix: a stale command, a renamed base branch, an edited conventions file, an older note; the picked fixes save on a yes', async ($, on) => {
  const world = makeWorld({ pluginVersion: '0.7.1' })
  world.files.set(`${REPO}/package.json`, JSON.stringify({ name: 'app', scripts: { test: 'vitest run', lint: 'eslint .' } }))
  world.answer = run => (run.argv.join(' ') === 'git show-ref --verify --quiet refs/heads/trunk' ? { exitCode: 0, stdout: '' } : undefined)
  await setUpProject(world, { sharedAnswers: { tracker: 'none', qaMode: 'bot', baseBranch: 'main', testCommand: 'npm run e2e' }, personalAnswers: { autoMerge: false } }, '0.6.0')
  world.files.set(`${REPO}/AGENTS.md`, '# Agent rules\n\nEdited by hand.\n')
  const person = mount(on, world)
  await godmode($)

  const audit = await godmode($, 'audit')
  const text = audit.text ?? ''

  expect(text).toMatch(/^godmode audit of \.godmode: \d+ checks hold; 4 to fix, 1 to consider\.$/m)
  expect(text).toContain('1. testCommand "npm run e2e" does not hold: `npm run e2e` runs `e2e`, which is not a script in package.json: name a script that exists. Fix: ask the person for the right value')
  expect(text).toContain('the base branch main no longer exists')
  expect(text).toContain('AGENTS.md was edited by hand since setup. Fix: read it, then save it as checked: setup_finish with `conventions: ["AGENTS.md"]`')
  expect(text).toContain('new since godmode 0.6.0: whether godmode may approve a PR')
  expect(text).toContain('- Consider: the project now has a lint command, `npm run lint`')
  expect(text).toContain('Nothing has changed.')
  expect(audit.context?.join('\n')).toContain('Apply only the fixes the person picks')

  // The person picks the command, the branch and the file; setup_finish saves them on their yes.
  const saved = await call($, 'setup_finish', { answers: { testCommand: 'npm test', baseBranch: 'trunk' }, conventions: ['AGENTS.md'] })
  expect(saved.deny).toBeUndefined()
  expect(person.asked).toEqual(['Save setup'])
  const after = (await godmode($, 'audit')).text ?? ''
  expect(after).toContain('1 to fix, 1 to consider')
  expect(after).toContain('new since godmode 0.6.0')
})
