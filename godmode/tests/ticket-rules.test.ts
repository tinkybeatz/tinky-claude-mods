import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { pendingUpdates } from '../hooks/change-setup'
import { rulesFromScan, scanBoard, scanLines, unclearScan } from '../hooks/ticket-rules'
import type { Answer } from '../hooks/storage'
import { makeJira, mountJira, SERVER, SPRINT_FIELD } from './jira-world'
import type { FakeJira } from './jira-world'
import { makeWorld, mountWorld, REPO, setUpProject } from './world'
import type { World } from './world'

/*
 * The ticket-filing rules (D74), learned from a messy board: mixed issue types, half the
 * tickets in no sprint, a field left holding template text, a required field.
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

type Person = { asked: string[]; texts: string[] }

/** The world, the board and the person, who answers by chip (a list answers in turn; else the first option). */
const mount = (on: On, world: World, jira: FakeJira, answers: Record<string, string | string[]> = {}): Person => {
  const person: Person = { asked: [], texts: [] }
  mountWorld(on, world)
  mountJira(on, jira)
  on('agent.list', () => ({ value: [] }))
  on('ui.toast', () => ({ value: undefined }) as never)
  on('tool.call', (_$, e) => {
    const input = e as unknown as Record<string, unknown>
    if (e.tool !== 'AskUserQuestion') return { result: 'ok' } as never
    const question = (input.questions as { question: string; header: string; options: { label: string }[] }[])[0]
    const header = question?.header ?? ''
    person.asked.push(header)
    person.texts.push(question?.question ?? '')
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
const onProd = async (world: World) => setUpProject(world, { sharedAnswers: ON_PROD, personalAnswers: { jiraServer: SERVER, prApproval: 'ask' } })

test('a messy board reads as rules: types and where each goes, half in no sprint, usual field values, template text and required fields', () => {
  const jira = messyBoard()
  const rows = [...jira.issues.values()].map(issue => ({ key: issue.key, fields: { creator: { accountId: issue.creator }, ...rowFields(issue) } }))
  const scan = scanBoard({ project: 'PROD', site: SITE, issues: rows, account: 'acc-me', typeFields: { Bug: [{ id: 'customfield_10100', name: 'Team', isRequired: true, hasDefault: false }] } })
  const lines = scanLines(scan).join('\n')

  expect(scan.total).toBe(10)
  expect(scan.mine).toBe(1)
  expect(lines).toContain('- Bug: 4 of 10. Goes to: next sprint 3, backlog 1. No parent, usually priority High.')
  expect(lines).toContain('- Story: 3 of 10. Goes to: backlog 3.')
  expect(lines).toContain('- Task: 2 of 10. Goes to: active sprint 2.')
  expect(lines).toContain('- Sub-task: 1 of 10. Goes to: backlog 1. A parent on 1 of 1 (Story).')
  expect(lines).toContain(`- The sprint field is ${SPRINT_FIELD}.`)
  expect(lines).toContain('- Team (customfield_10100) is set on 9 of 10, usually Platform (8), Editor (1).')
  expect(lines).toContain('- A Bug requires Team (customfield_10100).')
  expect(lines).toContain('- description still holds template text on 3 issues')
  expect(lines).toContain('- customfield_10200 still holds template text on 3 issues ("<describe the customer impact>")')
  expect(rulesFromScan(scan, '2026-11-23')).toContain('ask the person, never guess')
  expect(unclearScan({ ...scan, total: 0 })).toBe('PROD has no issues yet')
})

/** An issue's fields as the board gives them with `*all`, for the pure scan. */
const rowFields = (issue: Parameters<ReturnType<typeof makeJira>['issues']['set']>[1]) => ({
  issuetype: { name: issue.type ?? 'Task' },
  ...(issue.sprint === undefined ? {} : { [SPRINT_FIELD]: issue.sprint }),
  ...(issue.parent === undefined ? {} : { parent: { key: issue.parent.key, fields: { issuetype: { name: issue.parent.type } } } }),
  labels: issue.labels ?? [],
  components: (issue.components ?? []).map(name => ({ name })),
  ...(issue.priority === undefined ? {} : { priority: { name: issue.priority } }),
  description: issue.description ?? null,
  ...issue.custom,
})

test('the tickets topic scans the board; the person corrects it, the PM rewrites the rules, and they are saved and fingerprinted on a yes', async ($, on) => {
  const world = makeWorld({ pluginVersion: '0.7.0' })
  await onProd(world)
  const person = mount(on, world, messyBoard(), { 'Ticket rules': ['Scan the board, then I confirm', 'Bugs go in the active sprint, not the next one', 'Save'] })

  await godmode($, 'setup')
  expect(resultOf(await call($, 'setup_questionnaire', { change: ['tickets'] }))).toContain('call mcp__godmode__ticket_rules with no arguments')
  const corrected = resultOf(await call($, 'ticket_rules'))

  expect(person.texts[1]).toContain('Here is how your team seems to file tickets:')
  expect(person.texts[1]).toContain('- Bug: 4 of 10. Goes to: next sprint 3, backlog 1.')
  expect(corrected).toContain('"Bugs go in the active sprint, not the next one"')
  expect(corrected).toContain('# Ticket filing')
  expect(world.files.has(RULES)).toBe(false)

  const saved = resultOf(await call($, 'ticket_rules', { rules: '# Ticket filing\n\n- Bugs go in the active sprint, with Team set.\n' }))

  expect(saved).toContain('Saved docs/conventions/ticket-filing.md')
  expect(person.texts[2]).toContain('Save these ticket-filing rules?')
  expect(world.files.get(RULES)).toBe('# Ticket filing\n\n- Bugs go in the active sprint, with Team set.\n')
  expect(shared(world).answers.ticketRules).toBe('docs/conventions/ticket-filing.md')
  expect(shared(world).conventions.map(file => file.path)).toContain('docs/conventions/ticket-filing.md')
})

test('explain only: the person\'s words go to the PM to turn into rules, and rules not confirmed are not saved', async ($, on) => {
  const world = makeWorld({ pluginVersion: '0.7.0' })
  await onProd(world)
  mount(on, world, messyBoard(), { 'Ticket rules': ['I\'ll explain it myself', 'Bugs: Bug type, next sprint, Team set. Everything else: Task in the backlog.', 'Not yet'] })

  await godmode($, 'setup')
  const explained = resultOf(await call($, 'ticket_rules'))
  const refused = resultOf(await call($, 'ticket_rules', { rules: '# Ticket filing\n\n- Bugs go in the next sprint.\n' }))

  expect(explained).toContain('explained how their team files tickets')
  expect(explained).toContain('Bugs: Bug type, next sprint, Team set.')
  expect(refused).toContain('did not save these rules')
  expect(world.files.has(RULES)).toBe(false)
})

test('an empty project says the scan found nothing clear, and falls back to the person explaining', async ($, on) => {
  const world = makeWorld({ pluginVersion: '0.7.0' })
  await onProd(world)
  const empty = messyBoard()
  empty.issues.clear()
  const person = mount(on, world, empty, { 'Ticket rules': ['Scan the board, then I confirm', 'Every ticket is a Task in the backlog.'] })

  await godmode($, 'setup')
  const answer = resultOf(await call($, 'ticket_rules'))

  expect(person.texts[1]).toContain('The scan found nothing clear: PROD has no issues yet.')
  expect(answer).toContain('"Every ticket is a Task in the backlog."')
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
