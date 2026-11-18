import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { ScanFacts } from '../types'
import { changePlan, changeSetupBrief, pendingUpdates, suggestionsOf, updateOfferLine, withSuggestion } from '../hooks/change-setup'
import { qaQuestion } from '../hooks/questionnaire'
import { BOARD, makeJira, mountJira, SERVER } from './jira-world'
import type { FakeJira } from './jira-world'
import { makeWorld, mountWorld, REPO, setUpProject } from './world'
import type { World } from './world'

// ---------------------------------------------------------------------------
// The plan: which questions a change asks, and what it suggests

const facts = (overrides: Partial<ScanFacts> = {}): ScanFacts => ({
  root: REPO,
  name: 'app',
  stacks: [{ id: 'go', language: 'Go', marker: 'go.mod' }],
  commands: { test: 'go test ./...' },
  commandSources: {},
  hasUi: false,
  git: { hasGit: true, origin: 'git@github.com:acme/app.git', remoteHost: 'github.com', host: 'github', hostReason: 'signed in' },
  conventions: [],
  ...overrides,
})

test('change plan: a new tracker brings the QA flow again only when people test, and jira asks no tracker', () => {
  const human = changePlan(facts(), ['tracker'], { tracker: 'none', qaMode: 'human-pr' })
  const bot = changePlan(facts(), ['tracker'], { tracker: 'none', qaMode: 'bot' })
  const jira = changePlan(facts(), ['jira'], { tracker: 'jira', qaMode: 'bot' })
  if (typeof human === 'string' || typeof bot === 'string' || typeof jira === 'string') throw new Error('refused')

  expect(human.topics).toEqual(['tracker', 'qa'])
  expect(bot.topics).toEqual(['tracker'])
  expect(bot.dropped).toContain('jiraProject')
  expect(bot.dropped).not.toContain('qaMode')
  expect(jira.given).toEqual({ tracker: 'jira' })
})

test('change plan: storage and unknown topics are refused, and update stands for what is new', () => {
  expect(changePlan(facts(), ['storage'], {})).toContain('cannot change here')
  expect(changePlan(facts(), ['colours'], {})).toContain('`colours` is not something change-setup asks')
  const update = changePlan(facts(), ['update'], { qa: true }, ['qa'])
  if (typeof update === 'string') throw new Error(update)
  expect(update.questions.map(question => question.key)).toEqual(['qaHuman'])
  expect(update.dropped).toContain('qa')
})

test('update: only a note from before the QA modes, under a newer godmode, lacks them (D60)', () => {
  expect(pendingUpdates('0.5.0', '0.6.0', { qa: true }).map(entry => entry.topic)).toEqual(['qa'])
  expect(pendingUpdates('0.4.0', '0.6.0', {}).map(entry => entry.topic)).toEqual(['qa'])
  // Not newer, already answered, or written after the QA modes: nothing to offer.
  expect(pendingUpdates('0.5.0', '0.5.0', { qa: true })).toEqual([])
  expect(pendingUpdates('0.5.0', '0.6.0', { qaMode: 'bot' })).toEqual([])
  expect(pendingUpdates('0.6.0', '0.7.0', {})).toEqual([])
  expect(updateOfferLine('0.5.0', '0.6.0', pendingUpdates('0.5.0', '0.6.0', {}))).toContain('asks something new since this project\'s setup (0.5.0): the QA mode')
  expect(updateOfferLine('0.5.0', '0.6.0', [])).toBe('This project was set up with godmode 0.5.0; 0.6.0 asks nothing new of it.')
  expect(updateOfferLine('0.6.0', '0.6.0', [])).toBeUndefined()
})

test('suggestions: the old qa on reads as no people and the QA agent, offered first and marked', () => {
  const suggestions = suggestionsOf({ qa: true })
  expect(withSuggestion(qaQuestion(facts()), suggestions).choices.map(choice => choice.label)).toEqual(['No (suggested)', 'Yes, people test'])
  const agent = qaQuestion(facts()).followUps?.({ qaHuman: false })[0]
  if (agent === undefined) throw new Error('no QA agent question')
  // The scan's own default is unmarked: the person's old answer wins.
  expect(withSuggestion(agent, suggestions).choices.map(choice => choice.label)).toEqual(['On (suggested)', 'Off'])
  expect(withSuggestion(agent, suggestionsOf({ qaMode: 'none' })).choices.map(choice => choice.label)).toEqual(['Off (current)', 'On'])
})

test('the PM\'s brief names the topics, the setup as it stands, and the update when one waits', () => {
  const pending = pendingUpdates('0.5.0', '0.6.0', { qa: true })
  const brief = changeSetupBrief({ noteVersion: '0.5.0', version: '0.6.0', storage: 'committed', dir: '.godmode', answers: { tracker: 'none', qa: true }, pending })
  expect(brief).toContain('Never edit the setup note in .godmode yourself')
  expect(brief).toContain('tracker "none", qa true')
  expect(brief).toContain('change ["update"]')
  expect(changeSetupBrief({ noteVersion: '0.6.0', version: '0.6.0', storage: 'outside', dir: '/x', answers: {}, pending: [] })).not.toContain('update"]')
})

// ---------------------------------------------------------------------------
// Change-setup end to end, through the plugin

type Person = {
  /** Each question the person saw, by its chip. */
  asked: string[]
  /** The choices each question offered, by its chip. */
  offered: Record<string, string[]>
}

/** Mounts the world, Jira when given, and the person, who picks `answers` by chip (else the first option; `null` dismisses). */
const mount = (on: On, world: World, answers: Record<string, string | null> = {}, jira?: FakeJira): Person => {
  const person: Person = { asked: [], offered: {} }
  mountWorld(on, world)
  on('agent.list', () => ({ value: [] }))
  on('ui.toast', () => ({ value: undefined }) as never)
  on('tool.call', (_$, e) => {
    const input = e as unknown as Record<string, unknown>
    if (e.tool !== 'AskUserQuestion') return { result: 'ok' } as never
    const question = (input.questions as { question: string; header: string; options: { label: string }[] }[])[0]
    const header = question?.header ?? ''
    person.asked.push(header)
    person.offered[header] = question?.options.map(option => option.label) ?? []
    const answer = answers[header]
    if (answer === null) return { deny: 'The person dismissed the question.' }
    return { result: { questions: input.questions, answers: { [question?.question ?? '']: answer ?? question?.options[0]?.label ?? '' } } } as never
  })
  if (jira !== undefined) mountJira(on, jira)
  return person
}

const godmode = ($: Engine, args = '') => $.command.run({ command: 'godmode', args } as Parameters<typeof $.command.run>[0])

/** A setup tool called by the main thread, as the PM does in change-setup mode. */
const call = async ($: Engine, name: string, input: Record<string, unknown> = {}) =>
  (await $.tool.call({ tool: `mcp__godmode__${name}`, ...input } as Parameters<typeof $.tool.call>[0])) as { deny?: string; result?: unknown }

const resultOf = (answer: { deny?: string; result?: unknown }) => {
  if (answer.deny !== undefined) throw new Error(`refused: ${answer.deny}`)
  return String(answer.result)
}

const SHARED = `${REPO}/.godmode/shared.json`
const PERSONAL = `${REPO}/.godmode/personal.json`

const sharedNote = (world: World) => JSON.parse(world.files.get(SHARED) ?? 'null') as { godmodeVersion: string; answers: Record<string, unknown> }
const personalNote = (world: World) => JSON.parse(world.files.get(PERSONAL) ?? 'null') as { answers: Record<string, unknown>; models: Record<string, unknown> }

/** The note's two files as they are on disk, to check nothing was written. */
const noteFiles = (world: World) => [world.files.get(SHARED), world.files.get(PERSONAL)]

const HUMAN_PR = {
  tracker: 'jira',
  jiraCloudId: 'site-1',
  jiraProject: 'APP',
  testCommand: 'npm test',
  qaMode: 'human-pr',
  qaBotFirst: false,
  qaWaitStatus: 'In QA',
  qaSignals: 'ticket-status,pr-approval',
  qaPassStatus: 'QA passed',
  qaApprovers: 'acme/qa',
}

test('changing only the QA mode keeps every other answer and drops the old mode\'s follow-ups (D22)', async ($, on) => {
  const world = makeWorld({ pluginVersion: '0.6.0' })
  await setUpProject(world, { sharedAnswers: HUMAN_PR, personalAnswers: { permissions: 'free', indicator: 'band', jiraServer: SERVER } })
  const person = mount(on, world, { QA: 'No', 'QA agent': 'On' })
  const personalBefore = world.files.get(PERSONAL)

  await godmode($, 'setup')
  const answered = resultOf(await call($, 'setup_questionnaire', { change: ['qa'] }))

  expect(person.asked).toEqual(['QA', 'QA agent'])
  expect(person.offered.QA?.[0]).toBe('Yes, people test (current)')
  expect(answered).toContain('Nothing is saved yet')
  expect(sharedNote(world).answers.qaMode).toBe('human-pr')

  const done = resultOf(await call($, 'setup_finish'))

  expect(person.asked.at(-1)).toBe('Save setup')
  expect(sharedNote(world).answers).toEqual({ tracker: 'jira', jiraCloudId: 'site-1', jiraProject: 'APP', testCommand: 'npm test', qaMode: 'bot' })
  expect(sharedNote(world).godmodeVersion).toBe('0.6.0')
  expect(world.files.get(PERSONAL)).toBe(personalBefore)
  expect(done).toContain('\nQA mode: bot (')
  expect(done).toContain('Tickets already waiting in qa leave it only with a QA pass recorded')
  // Saved, godmode is back in coding mode.
  expect((await call($, 'setup_finish')).deny).toContain('not in setup mode')
})

const jiraWith = (projects: string[]) => {
  const jira = makeJira()
  for (const project of projects) {
    for (const [index, status] of BOARD.map(column => column.name).entries()) {
      jira.issues.set(`${project}-${index + 1}`, { key: `${project}-${index + 1}`, summary: `Issue ${index + 1}`, status })
    }
  }
  return jira
}

test('changing the tracker to Jira asks the Jira questions after it, and keeps the QA mode', async ($, on) => {
  const world = makeWorld({ pluginVersion: '0.6.0' })
  await setUpProject(world, { sharedAnswers: { tracker: 'none', qaMode: 'bot' } })
  const person = mount(on, world, { Tracker: 'Jira', 'Jira project': 'APP (App)', 'Jira mapping': 'Keep it' }, jiraWith(['APP']))

  await godmode($, 'setup')
  resultOf(await call($, 'setup_questionnaire', { change: ['tracker'] }))
  const done = resultOf(await call($, 'setup_finish'))

  expect(person.asked).toEqual(['Tracker', 'Jira project', 'Jira mapping', 'Save setup'])
  expect(person.offered.Tracker?.[0]).toBe('None (markdown) (current)')
  expect(sharedNote(world).answers).toEqual({
    tracker: 'jira',
    jiraCloudId: 'site-1',
    jiraProject: 'APP',
    jiraTodoStatus: 'To Do',
    jiraDoingStatus: 'In Progress',
    jiraReviewStatus: 'Code Review',
    jiraDoneStatus: 'Done',
    qaMode: 'bot',
  })
  expect(personalNote(world).answers).toEqual({ permissions: 'free', attribution: false, jiraServer: SERVER })
  expect(done).toContain('Tickets the old tracker holds stay there')
})

test('jira runs the Jira questions again without the tracker one, the current project offered first', async ($, on) => {
  const world = makeWorld({ pluginVersion: '0.6.0' })
  const onJira = { tracker: 'jira', jiraCloudId: 'site-1', jiraProject: 'APP', jiraTodoStatus: 'To Do', jiraDoingStatus: 'In Progress', jiraReviewStatus: 'Code Review', jiraDoneStatus: 'Done', qaMode: 'none' }
  await setUpProject(world, { sharedAnswers: onJira, personalAnswers: { permissions: 'free', jiraServer: SERVER } })
  const person = mount(on, world, { 'Jira project': 'OPS (Ops)', 'Jira mapping': 'Keep it' }, jiraWith(['APP', 'OPS']))

  await godmode($, 'setup')
  resultOf(await call($, 'setup_questionnaire', { change: ['jira'] }))
  resultOf(await call($, 'setup_finish'))

  expect(person.asked).toEqual(['Jira project', 'Jira mapping', 'Save setup'])
  expect(person.offered['Jira project']?.[0]).toBe('APP (App) (current)')
  expect(sharedNote(world).answers).toEqual({ ...onJira, jiraProject: 'OPS' })
})

test('a 0.5.0 note is offered only the QA questions, its qa: true suggesting the QA agent, and is re-stamped (D60)', async ($, on) => {
  const world = makeWorld({ pluginVersion: '0.6.0' })
  await setUpProject(world, { sharedAnswers: { tracker: 'none', qa: true } }, '0.5.0')
  // Every answer is the first option: the yes, then the suggestions, then Save.
  const person = mount(on, world)
  const personalBefore = world.files.get(PERSONAL)

  await godmode($, 'setup')
  resultOf(await call($, 'setup_questionnaire', { change: ['update'] }))
  const done = resultOf(await call($, 'setup_finish'))

  expect(person.asked).toEqual(['Update', 'QA', 'QA agent', 'Save setup'])
  expect(person.offered.QA).toEqual(['No (suggested)', 'Yes, people test'])
  expect(person.offered['QA agent']).toEqual(['On (suggested)', 'Off'])
  const shared = sharedNote(world)
  expect(shared.godmodeVersion).toBe('0.6.0')
  expect(shared.answers).toEqual({ tracker: 'none', qaMode: 'bot' })
  expect(world.files.get(PERSONAL)).toBe(personalBefore)
  expect(done).toContain('godmode version: 0.5.0 -> 0.6.0')
})

test('a shared change on an older note with nothing new left re-stamps the version; a personal one leaves the shared half alone', async ($, on) => {
  const world = makeWorld({ pluginVersion: '0.6.0' })
  // Written by 0.5.0 while the QA modes were built: it has a mode already, so nothing is new for it.
  await setUpProject(world, { sharedAnswers: { tracker: 'none', qaMode: 'none' } }, '0.5.0')
  mount(on, world, { Tracker: 'Linear', Indicator: 'Hint tag' })
  const sharedBefore = world.files.get(SHARED)

  await godmode($, 'setup')
  resultOf(await call($, 'setup_questionnaire', { change: ['indicator'] }))
  resultOf(await call($, 'setup_finish'))

  expect(world.files.get(SHARED)).toBe(sharedBefore)
  expect(personalNote(world).answers.indicator).toBe('hint')

  await godmode($, 'setup')
  resultOf(await call($, 'setup_questionnaire', { change: ['tracker'] }))
  resultOf(await call($, 'setup_finish'))

  expect(sharedNote(world).godmodeVersion).toBe('0.6.0')
  expect(sharedNote(world).answers).toEqual({ tracker: 'other', trackerName: 'Linear', qaMode: 'none' })
})

test('each answer lands in its half: the person\'s own in personal.json, the team\'s in shared.json (D61)', async ($, on) => {
  const world = makeWorld({ pluginVersion: '0.6.0' })
  await setUpProject(world, { sharedAnswers: { tracker: 'none', qaMode: 'bot' }, models: { dev: 'opus' } })
  const person = mount(on, world, { Permissions: 'Locked', 'Fix rounds': '5' })

  await godmode($, 'setup')
  resultOf(await call($, 'setup_questionnaire', { change: ['permissions', 'fixRoundLimit'] }))
  // A setting a question owns cannot be set freely, and nothing is saved.
  expect((await call($, 'setup_finish', { answers: { qaMode: 'none', testCommand: 'pnpm test' } })).deny).toContain('`qaMode` is set by a question')
  resultOf(await call($, 'setup_finish', { answers: { testCommand: 'pnpm test' } }))

  expect(person.offered.Permissions?.[0]).toBe('Free (current)')
  expect(sharedNote(world).answers).toEqual({ tracker: 'none', qaMode: 'bot', testCommand: 'pnpm test' })
  const personal = personalNote(world)
  expect(personal.answers).toEqual({ permissions: 'locked', attribution: false, fixRoundLimit: 5 })
  expect(personal.models).toEqual({ dev: 'opus' })
})

test('nothing is written without the person\'s yes: a "Not now" to the update, a Discard, a dismissed question', async ($, on) => {
  const world = makeWorld({ pluginVersion: '0.6.0' })
  await setUpProject(world, { sharedAnswers: { tracker: 'none', qa: true } }, '0.5.0')
  const answers: Record<string, string | null> = { Update: 'Not now', Attribution: 'Allow it', 'Save setup': 'Discard' }
  const person = mount(on, world, answers)
  const before = noteFiles(world)

  await godmode($, 'setup')
  expect(resultOf(await call($, 'setup_questionnaire', { change: ['update'] }))).toContain('nothing changed')
  expect(person.asked).toEqual(['Update'])

  await godmode($, 'setup')
  resultOf(await call($, 'setup_questionnaire', { change: ['attribution'] }))
  expect(resultOf(await call($, 'setup_finish'))).toContain('discarded')

  await godmode($, 'setup')
  answers.QA = null
  expect((await call($, 'setup_questionnaire', { change: ['qa'] })).deny).toContain('Nothing was saved')
  expect((await call($, 'setup_questionnaire', { change: ['storage'] })).deny).toContain('cannot change here')
  expect(resultOf(await call($, 'setup_finish'))).toContain('nothing to save')

  expect(noteFiles(world)).toEqual(before)
})

// ---------------------------------------------------------------------------
// Every end of a change-setup is coding mode, with its gates on

/** A main-thread edit: change-setup mode lets it through, and coding mode's thin main thread refuses it (D63). */
const mainThreadEdit = async ($: Engine) =>
  (await $.tool.call({ tool: 'Edit', file_path: `${REPO}/src/a.ts`, old_string: 'a', new_string: 'b' } as Parameters<typeof $.tool.call>[0])) as { deny?: string }

type ChangeEnd = {
  name: string
  /** The note's godmode version; the plugin runs 0.6.0. */
  noteVersion: string
  sharedAnswers: Record<string, string | boolean>
  /** The person's answers by chip; `null` dismisses the question. */
  answers: Record<string, string | null>
  /** Ends the change; resolves what the PM read. */
  end: ($: Engine) => Promise<string>
}

const textOf = (answer: { deny?: string; result?: unknown }) => answer.deny ?? String(answer.result)

const askedThenFinished = (topic: string) => async ($: Engine) => {
  resultOf(await call($, 'setup_questionnaire', { change: [topic] }))
  return textOf(await call($, 'setup_finish'))
}

const CHANGE_ENDS: ChangeEnd[] = [
  { name: 'a save', noteVersion: '0.6.0', sharedAnswers: { tracker: 'none', qaMode: 'bot' }, answers: { Attribution: 'Allow it' }, end: askedThenFinished('attribution') },
  { name: 'a discard', noteVersion: '0.6.0', sharedAnswers: { tracker: 'none', qaMode: 'bot' }, answers: { Attribution: 'Allow it', 'Save setup': 'Discard' }, end: askedThenFinished('attribution') },
  { name: 'a dismissed save question', noteVersion: '0.6.0', sharedAnswers: { tracker: 'none', qaMode: 'bot' }, answers: { Attribution: 'Allow it', 'Save setup': null }, end: askedThenFinished('attribution') },
  {
    name: 'a "Not now" to the update',
    noteVersion: '0.5.0',
    sharedAnswers: { tracker: 'none', qa: true },
    answers: { Update: 'Not now' },
    end: async $ => textOf(await call($, 'setup_questionnaire', { change: ['update'] })),
  },
  {
    name: 'a dismissed update question',
    noteVersion: '0.5.0',
    sharedAnswers: { tracker: 'none', qa: true },
    answers: { Update: null },
    end: async $ => textOf(await call($, 'setup_questionnaire', { change: ['update'] })),
  },
  {
    name: 'an update with nothing new',
    noteVersion: '0.6.0',
    sharedAnswers: { tracker: 'none', qaMode: 'bot' },
    answers: {},
    end: async $ => textOf(await call($, 'setup_questionnaire', { change: ['update'] })),
  },
  { name: 'nothing to save', noteVersion: '0.6.0', sharedAnswers: { tracker: 'none', qaMode: 'bot' }, answers: {}, end: async $ => textOf(await call($, 'setup_finish')) },
  { name: '/godmode typed', noteVersion: '0.6.0', sharedAnswers: { tracker: 'none', qaMode: 'bot' }, answers: {}, end: async $ => (await godmode($)).text ?? '' },
]

for (const ending of CHANGE_ENDS) {
  test(`a change-setup ended by ${ending.name} is back in coding mode, with its gates on`, async ($, on) => {
    const world = makeWorld({ pluginVersion: '0.6.0' })
    await setUpProject(world, { sharedAnswers: ending.sharedAnswers }, ending.noteVersion)
    mount(on, world, ending.answers)

    await godmode($, 'setup')
    expect((await mainThreadEdit($)).deny).toBeUndefined()

    expect(await ending.end($)).toContain('back in coding mode')

    expect((await mainThreadEdit($)).deny).toContain('godmode keeps the main thread thin')
    expect((await call($, 'setup_finish')).deny).toContain('not in setup mode')
  })
}
