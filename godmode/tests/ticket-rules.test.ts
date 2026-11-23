import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { pendingUpdates } from '../hooks/change-setup'
import type { Answer } from '../hooks/storage'
import { plainError } from '../hooks/jira'
import { makeJira, mountJira, RUNNER_SERVER, SERVER, TOO_LARGE_TEXT } from './jira-world'
import type { FakeJira } from './jira-world'
import { makeWorld, mountWorld, REPO, setUpProject } from './world'
import type { World } from './world'

/*
 * The ticket-filing rules (D74, D76): a checklist of the decisions godmode makes when it
 * files a ticket, answered from the person's own tickets first, the team's where theirs say
 * nothing, and "?" where nothing does. Board data is messy on purpose.
 */

const SITE = '0c5e2f7a-1d3b-4e8f-9a6c-2b7d4e1f3a90'
const TEMPLATE = '## Steps to reproduce\n1.\n2.\n## Expected result\n## Actual result'

/** A messy PROD board: bugs in the next sprint, stories and a sub-task in no sprint, tasks in the active one. */
const messyBoard = (overrides: Partial<FakeJira> = {}) => {
  const jira = makeJira({
    projects: [{ key: 'PROD', name: 'Product' }],
    issueTypes: ['Task', 'Bug', 'Story', 'Sub-task'],
    fieldsMeta: {
      Bug: [
        { fieldId: 'summary', name: 'Summary', required: true },
        { fieldId: 'customfield_10100', name: 'Team', required: true },
      ],
      Story: [{ fieldId: 'customfield_10100', name: 'Team', required: false }],
    },
    account: 'acc-me',
    ...overrides,
  })
  const add = (number: number, fields: Partial<Parameters<typeof jira.issues.set>[1]>) =>
    jira.issues.set(`PROD-${number}`, { key: `PROD-${number}`, summary: `Issue ${number}`, status: 'To Do', ...fields })
  const team = (value: string) => ({ customfield_10100: { value } })
  for (const number of [1, 2, 3, 4]) {
    add(number, { type: 'Bug', priority: 'High', creator: number === 1 ? 'acc-me' : 'acc-sam', sprint: number === 4 ? undefined : [{ name: 'Sprint 42', state: 'future' }], description: number < 4 ? TEMPLATE : 'Export fails on Safari.', custom: team('Platform') })
  }
  for (const number of [5, 6, 7]) add(number, { type: 'Story', labels: ['editor'], custom: { ...team(number === 7 ? 'Editor' : 'Platform'), customfield_10200: '<describe the customer impact>' } })
  for (const number of [8, 9]) add(number, { type: 'Task', sprint: [{ name: 'Sprint 41', state: 'active' }], components: ['Web'], custom: team('Platform') })
  add(10, { type: 'Sub-task', parent: { key: 'PROD-5', type: 'Story' } })
  return jira
}

const ON_PROD: Record<string, Answer> = { tracker: 'jira', jiraCloudId: SITE, jiraProject: 'PROD', qaMode: 'none' }

type Person = { asked: string[]; texts: string[]; logs: string[]; offered: string[][] }

/** The world, the board and the person, who answers by chip (a list answers in turn; else the first option). */
const mount = (on: On, world: World, jira: FakeJira, answers: Record<string, string | string[]> = {}): Person => {
  const person: Person = { asked: [], texts: [], logs: [], offered: [] }
  mountWorld(on, world)
  mountJira(on, jira)
  on('ui.log', (_$, e) => {
    person.logs.push(e.text)
    return { value: undefined } as never
  })
  on('agent.list', () => ({ value: [] }))
  on('ui.toast', () => ({ value: undefined }) as never)
  on('tool.call', (_$, e) => {
    const input = e as unknown as Record<string, unknown>
    if (e.tool !== 'AskUserQuestion') return { result: 'ok' } as never
    const question = (input.questions as { question: string; header: string; options: { label: string }[] }[])[0]
    const header = question?.header ?? ''
    person.asked.push(header)
    person.texts.push(question?.question ?? '')
    person.offered.push(question?.options.map(option => option.label) ?? [])
    const given = answers[header]
    const answer = Array.isArray(given) ? (given.length > 1 ? given.shift() : given[0]) : given
    return { result: { questions: input.questions, answers: { [question?.question ?? '']: answer ?? question?.options[0]?.label ?? '' } } } as never
  })
  return person
}

const godmode = ($: Engine, args = '') => $.command.run({ command: 'godmode', args } as Parameters<typeof $.command.run>[0])

const call = async ($: Engine, name: string, input: Record<string, unknown> = {}) =>
  (await $.tool.call({ tool: `mcp__godmode__${name}`, ...input } as Parameters<typeof $.tool.call>[0])) as { deny?: string; result?: unknown }

const resultOf = (answer: { deny?: string; result?: unknown }) => {
  if (answer.deny !== undefined) throw new Error(`refused: ${answer.deny}`)
  return String(answer.result)
}

const RULES = `${REPO}/docs/conventions/ticket-filing.md`
const SHARED = `${REPO}/.godmode/shared.json`
const shared = (world: World) => JSON.parse(world.files.get(SHARED) ?? 'null') as { answers: Record<string, unknown>; conventions: { path: string; fingerprint: string }[] }

/** A set-up project on the PROD board, at godmode 0.7.0. */
const onProd = async (world: World, server = SERVER) => setUpProject(world, { sharedAnswers: ON_PROD, personalAnswers: { jiraServer: server, prApproval: 'ask' } })


/**
 * The live shape (the "Atlassian MCP" server, `{ issues: { nodes } }`, custom fields under
 * `customFields` by label): the person's own bugs go in the next cooldown sprint with a
 * "P3 - " prefix, a dev team, a priority field and a description template; their stories
 * sit in the backlog under an epic; only the team's tickets show chores.
 */
const liveBoard = (overrides: Partial<FakeJira> = {}) => {
  const jira = makeJira({ flavour: 'runner', isNodes: true, projects: [{ key: 'PROD', name: 'Product' }], account: 'acc-me', ...overrides })
  const sprint = [{ id: 2237, name: 'Web - Cooldown 12.2', state: 'future' }]
  const add = (number: number, fields: Partial<Parameters<typeof jira.issues.set>[1]>) =>
    jira.issues.set(`PROD-${number}`, { key: `PROD-${number}`, summary: `Issue ${number}`, status: 'To Do', ...fields })
  for (const number of [48, 49, 50, 51, 52]) {
    add(number, {
      type: 'Bug',
      summary: `P3 - Export fails ${number}`,
      creator: 'acc-me',
      parent: { key: 'PROD-1', type: 'Epic' },
      description: '## Repro steps\n1. Open the editor\n## Observed\nIt fails.\n## Expected\nIt works.',
      custom: { Sprint: sprint, 'Dev Team': { value: 'Squad A' }, 'Bug Priority': { value: 'P3' }, 'Impact Analysis': 'Impact: <describe the customer impact>' },
    })
  }
  for (const number of [5760, 5761, 5762]) add(number, { type: 'Story', summary: `Feature ${number}`, creator: 'acc-me', parent: { key: 'PROD-2', type: 'Epic' }, custom: { 'Dev Team': { value: 'Squad A' } } })
  // The team's: chores, and noise the checklist must not count.
  for (const number of [6001, 6002]) add(number, { type: 'Task', summary: `Chore ${number}`, creator: 'acc-sam' })
  for (const number of [6003, 6004, 6005, 6006]) add(number, { type: 'Finding', summary: `Finding ${number}`, creator: 'acc-sam' })
  return jira
}

/** Whether a line counts issue types across the board, as the old scan did. */
const isNoise = (line: string) => /\b\d+ of \d+\. Goes to\b|: \d+ of \d+\.$|Finding/.test(line)

test('the live shape: sprint, fields and templates under customFields are read from the person\'s own tickets, one line per log, and no type counts', async ($, on) => {
  const world = makeWorld({ pluginVersion: '0.7.0' })
  await onProd(world, RUNNER_SERVER)
  const person = mount(on, world, liveBoard(), { 'Ticket rules': ['Scan my tickets, then I confirm', 'Looks right', 'Sub-task', 'Leave it out'] })
  await godmode($, 'setup')

  const saved = resultOf(await call($, 'ticket_rules'))
  const shown = person.logs.join('\n')

  expect(person.logs.every(line => !line.includes('\n'))).toBe(true)
  expect(person.logs[0]).toBe('How you file tickets in PROD, read from 8 of your latest tickets:')
  expect(shown).toContain('- Bug: Bug (from 5 of your tickets)')
  expect(shown).toContain('- Feature or change: Story (from 3 of your tickets)')
  expect(shown).toContain('- Chore or maintenance: Task (from 2 of the team\'s tickets; none of yours settle it)')
  expect(shown).toContain('- Piece of a bigger item: ?')
  expect(person.logs[1]).toBe('Issue type:')
  expect(shown).toContain('- Bug: the next sprint, named like "Web - Cooldown <n>.<n>" (e.g. "Web - Cooldown 12.2") (from 5 of your tickets)')
  expect(shown).toContain('- Story: the backlog (from 3 of your tickets)')
  expect(shown).toContain('Parent:\n- Bug: an Epic; ask the person which one each time (from 5 of your tickets)')
  expect(shown).toContain('- Assignee: you, unless you say otherwise')
  expect(shown).toContain('- Bug: Dev Team = Squad A (habit, 5 of 5); Bug Priority = P3 (habit, 5 of 5); fill or leave: Impact Analysis (template text)')
  expect(shown).toContain('- Bug: starts "P<n> - " (from 5 of your tickets)')
  expect(shown).toContain('- Bug: Description: Repro steps, Observed, Expected (from 5 of your tickets)')
  expect(shown).toContain('- Task: none (from 2 of the team\'s tickets; none of yours settle it)')
  expect(person.logs.some(isNoise)).toBe(false)
  // The "?" item is asked, and the answer saved under its heading.
  expect(person.texts).toContain('Which issue type does a piece of a bigger item get? Type it under Other.')
  expect(saved).toContain('Saved docs/conventions/ticket-filing.md')
  const file = world.files.get(RULES) ?? ''
  expect(file).toContain('## Issue type')
  expect(file).toContain('- Piece of a bigger item: Sub-task (your answer)')
  expect(file).toContain('## Placement')
  expect(file.split('\n').some(isNoise)).toBe(false)
})

test('with no tickets of their own, the person sees the team\'s answers, each saying so', async ($, on) => {
  const world = makeWorld({ pluginVersion: '0.7.0' })
  await onProd(world, RUNNER_SERVER)
  const person = mount(on, world, liveBoard({ account: 'acc-nobody' }), { 'Ticket rules': ['Scan my tickets, then I confirm', 'Looks right', 'Leave it out'] })
  await godmode($, 'setup')

  resultOf(await call($, 'ticket_rules'))

  expect(person.logs[0]).toBe('How you file tickets in PROD, read from the team\'s latest 14 tickets, as you have none in PROD:')
  expect(person.logs).toContain('- Bug: Bug (from 5 of the team\'s tickets; none of yours settle it)')
})

test('a correction typed over the checklist goes to the PM with the checklist, to rewrite and confirm', async ($, on) => {
  const world = makeWorld({ pluginVersion: '0.7.0' })
  await onProd(world, RUNNER_SERVER)
  const person = mount(on, world, liveBoard(), { 'Ticket rules': ['Scan my tickets, then I confirm', 'Correct it', 'Bugs go in the active sprint, not the next one', 'Save'] })
  await godmode($, 'setup')

  const corrected = resultOf(await call($, 'ticket_rules'))
  expect(corrected).toContain('"Bugs go in the active sprint, not the next one"')
  expect(corrected).toContain('## Placement')
  expect(world.files.has(RULES)).toBe(false)

  resultOf(await call($, 'ticket_rules', { rules: '# Ticket filing\n\n## Placement\n\n- Bug: the active sprint\n' }))
  expect(person.texts.at(-1)).toBe('Save the ticket-filing rules shown above?')
  expect(person.logs).toContain('- Bug: the active sprint')
  expect(shared(world).answers.ticketRules).toBe('docs/conventions/ticket-filing.md')
  expect(shared(world).conventions.map(file => file.path)).toContain('docs/conventions/ticket-filing.md')
})

test('explaining it themselves, the person answers the same checklist item by item', async ($, on) => {
  const world = makeWorld({ pluginVersion: '0.7.0' })
  await onProd(world)
  const person = mount(on, world, messyBoard(), { 'Ticket rules': ['I\'ll explain it myself', 'Bug', 'Story', 'Leave it out', 'Leave it out', 'Bugs in the next sprint, the rest in the backlog', 'Ask me each time', 'Leave it out', 'Leave it out', 'Leave it out', 'Leave it out', 'Save'] })
  await godmode($, 'setup')

  resultOf(await call($, 'ticket_rules'))

  expect(person.texts[1]).toBe('Which issue type does a bug get? Type it under Other.')
  const file = world.files.get(RULES) ?? ''
  expect(file).toContain('- Bug: Bug (your answer)')
  expect(file).toContain('- Placement: Bugs in the next sprint, the rest in the backlog (your answer)')
  expect(file).toContain('- Parent: ask the person each time (your answer)')
  expect(file).not.toContain('Chore or maintenance')
})

test('an empty project says the scan found nothing to read, and offers explaining first', async ($, on) => {
  const world = makeWorld({ pluginVersion: '0.7.0' })
  await onProd(world)
  const empty = messyBoard()
  empty.issues.clear()
  const person = mount(on, world, empty, { 'Ticket rules': ['Scan my tickets, then I confirm', 'Skip for now'] })
  await godmode($, 'setup')

  await call($, 'ticket_rules')

  expect(person.texts[1]).toBe('The scan found nothing to read: PROD has no issues yet. How should godmode learn your team\'s ticket rules?')
  expect(person.offered[1]).toEqual(['I\'ll explain it myself', 'Try the scan again'])
})

test('while coding, the PM reads the rules, adds the person\'s new rule on a yes, and an agent cannot change them', async ($, on) => {
  const world = makeWorld({ pluginVersion: '0.7.0' })
  await onProd(world)
  mount(on, world, messyBoard(), { 'Ticket rules': 'Save' })
  await godmode($)

  expect(resultOf(await call($, 'ticket_rules'))).toContain('no ticket rules yet')
  resultOf(await call($, 'ticket_rules', { rules: '# Ticket filing\n\n- From now on bugs go in the next sprint.\n' }))
  expect(resultOf(await call($, 'ticket_rules'))).toContain('From now on bugs go in the next sprint.')
  expect((await call($, 'ticket_rules', { rules: 'x', agentId: 'agent-x' })).deny).toContain('Only the PM changes the ticket rules')
})

test('filing a ticket the rules do not fully cover: a required field left out is refused by name, then filed with it', async ($, on) => {
  const world = makeWorld({ pluginVersion: '0.7.0' })
  await onProd(world)
  const jira = messyBoard()
  mount(on, world, jira)
  await godmode($)

  const ticket = { title: 'Export fails', ask: 'Export fails on Safari', visibleChange: true }
  const missing = await call($, 'ticket_create', { ...ticket, jira: { issueType: 'Bug', labels: ['editor'] } })
  expect(missing.deny).toContain('A Bug in PROD requires Team (customfield_10100), which this ticket does not set')
  expect(missing.deny).toContain('ask the person rather than guess')

  resultOf(await call($, 'ticket_create', { ...ticket, jira: { issueType: 'Bug', labels: ['editor'], parent: 'PROD-5', fields: { customfield_10100: { value: 'Platform' } } } }))
  const created = jira.calls.find(found => found.tool === 'createJiraIssue')
  expect(created?.args).toMatchObject({ issueTypeName: 'Bug', parent: 'PROD-5', additional_fields: { labels: ['editor'], customfield_10100: { value: 'Platform' } } })
})

test('update offers the ticket rules to a Jira note that has none', () => {
  expect(pendingUpdates('0.6.0', '0.7.0', { tracker: 'jira', qaMode: 'bot', prApproval: 'ask' }).map(entry => entry.topic)).toEqual(['tickets'])
  expect(pendingUpdates('0.6.0', '0.7.0', { tracker: 'jira', qaMode: 'bot', prApproval: 'ask', ticketRules: 'docs/conventions/ticket-filing.md' })).toEqual([])
  expect(pendingUpdates('0.6.0', '0.7.0', { tracker: 'none', qaMode: 'bot', prApproval: 'ask' })).toEqual([])
})

// ---------------------------------------------------------------------------
// Answers too large for the session (the live scan on a big board)

/** The searches a scan made, by their page size. */
const pageSizes = (jira: FakeJira) => jira.calls.filter(found => found.tool === 'searchJiraIssuesUsingJql' && /ORDER BY created DESC$/.test(String(found.args.jql))).map(found => found.args.maxResults)

/** Whether any text the person saw, or the model was given, carries the saved-file notice. */
const leaks = (texts: readonly string[]) => texts.some(text => /tool-results|Output has been saved|exceeds maximum allowed tokens|Format: JSON/.test(text))

test('a scan page too large for the session is asked again at half the size, and the scan goes on in slim pages', async ($, on) => {
  const world = makeWorld({ pluginVersion: '0.7.0' })
  await onProd(world)
  const jira = messyBoard({ isTooLarge: args => Number(args.maxResults) > 5 })
  const person = mount(on, world, jira, { 'Ticket rules': ['Scan my tickets, then I confirm', 'Looks right', 'Leave it out'] })
  await godmode($, 'setup')

  const saved = resultOf(await call($, 'ticket_rules'))

  expect(pageSizes(jira).slice(0, 2)).toEqual([10, 5])
  const scanned = jira.calls.find(found => found.tool === 'searchJiraIssuesUsingJql' && Array.isArray(found.args.fields))
  expect(scanned?.args.fields).not.toContain('*all')
  expect(scanned?.args.fields).toContain('customfield_10100')
  expect(person.logs[0]).toBe('How you file tickets in PROD, read from 1 of your latest tickets:')
  expect(saved).toContain('Saved docs/conventions/ticket-filing.md')
  expect(leaks([...person.texts, ...person.logs, saved])).toBe(false)
})

test('a scan too large on every try says so in one plain sentence, offers explaining first, and never shows the saved-file notice', async ($, on) => {
  const world = makeWorld({ pluginVersion: '0.7.0' })
  await onProd(world)
  const person = mount(on, world, messyBoard({ isTooLarge: () => true }), { 'Ticket rules': ['Scan my tickets, then I confirm', 'I\'ll explain it myself', 'Leave it out'] })
  await godmode($, 'setup')

  const answer = resultOf(await call($, 'ticket_rules'))

  expect(person.texts[1]).toBe('godmode could not read the board: Jira\'s answer was too large. How should godmode learn your team\'s ticket rules?')
  expect(person.offered[1]).toEqual(['I\'ll explain it myself', 'Try the scan again'])
  expect(person.texts[2]).toBe('Which issue type does a bug get? Type it under Other.')
  expect(answer).toContain('left every item out')
  expect(leaks([...person.texts, ...person.logs, answer])).toBe(false)
})

test('an error is one plain sentence of 150 characters at most, with no file path and nothing after it', () => {
  expect(plainError(new Error(TOO_LARGE_TEXT))).toBe('result (349,076 characters) exceeds maximum allowed tokens.')
  expect(plainError(`Jira's search failed: ${'x'.repeat(300)}`)).toHaveLength(150)
  expect(plainError('Could not open /home/dev/project/notes.txt. Try again later.')).toBe('Could not open ….')
})
