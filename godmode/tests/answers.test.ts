import { expect, test } from 'claude-code/testing'

import { answerIssueLines, checkAnswer, cleanAnswers, jiraProjectKeyOf, jiraSiteOf } from '../hooks/answers'
import { sitesIn, unknownJqlValues } from '../hooks/jira'
import { questionsFor, resolveAnswer } from '../hooks/questionnaire'
import type { Question } from '../hooks/questionnaire'
import { pnpmWorkspacesIn, scriptUseOf } from '../hooks/verify'
import type { ScanFacts } from '../types'

/*
 * Messy answers, as people type them: links, any case, stray spaces and quotes, sentences
 * under Other. Each answer key has one rule, used when it is given and when a note is read.
 */

const facts = (): ScanFacts => ({
  root: '/work/app',
  name: 'app',
  stacks: [{ id: 'node', language: 'TypeScript', marker: 'package.json', packageManager: 'pnpm' }],
  commands: { test: 'pnpm test', start: 'pnpm dev' },
  commandSources: {},
  hasUi: true,
  git: { hasGit: true, origin: 'git@github.com:acme/app.git', remoteHost: 'github.com', host: 'github', hostReason: 'signed in' },
  conventions: [],
})

test('a Jira project key comes out of a bare key in any case, a choice label, and a board or issue link', () => {
  expect(jiraProjectKeyOf('PROD')).toBe('PROD')
  expect(jiraProjectKeyOf('  prod ')).toBe('PROD')
  expect(jiraProjectKeyOf('PROD (Product)')).toBe('PROD')
  expect(jiraProjectKeyOf('https://acme.atlassian.net/jira/software/c/projects/PROD/boards/133/backlog')).toBe('PROD')
  // The value the live run saved: the whole link, upper-cased.
  expect(jiraProjectKeyOf('HTTPS://ACME.ATLASSIAN.NET/JIRA/SOFTWARE/C/PROJECTS/PROD/BOARDS/133/BACKLOG')).toBe('PROD')
  expect(jiraProjectKeyOf('https://acme.atlassian.net/browse/PROD-123')).toBe('PROD')
  expect(jiraProjectKeyOf('https://acme.atlassian.net/jira/software/c/boards/133?selectedIssue=PROD-9')).toBe('PROD')
  expect(jiraProjectKeyOf('the product board')).toBeUndefined()
  expect(jiraProjectKeyOf('https://acme.atlassian.net/jira/your-work')).toBeUndefined()
})

test('an Atlassian site is a cloud id kept as it is, else the host the servers take: a bare name is an Atlassian Cloud site', () => {
  expect(jiraSiteOf('acme')).toBe('acme.atlassian.net')
  expect(jiraSiteOf(' Acme ')).toBe('acme.atlassian.net')
  expect(jiraSiteOf('https://acme.atlassian.net/jira/software/c/projects/PROD/boards/1')).toBe('acme.atlassian.net')
  expect(jiraSiteOf('acme.atlassian.net')).toBe('acme.atlassian.net')
  expect(jiraSiteOf('jira.acme.com:8443/browse')).toBe('jira.acme.com')
  expect(jiraSiteOf('A82B720B-BD01-4D4F-B4CA-CEEE3CE5DF74')).toBe('a82b720b-bd01-4d4f-b4ca-ceee3ce5df74')
  expect(jiraSiteOf('our jira')).toBeUndefined()
})

test('each answer key has its rule: tidied where safe, refused with a reason where not, empty always passes', () => {
  expect(checkAnswer('jiraProject', 'nope nope')).toEqual({ problem: expect.stringContaining('is not a Jira project key') })
  expect(checkAnswer('testCommand', ' `pnpm   test` ')).toEqual({ value: 'pnpm test' })
  expect(checkAnswer('testCommand', 'none')).toEqual({ value: '' })
  expect(checkAnswer('qaApprovers', '@alice, bob and acme/qa')).toEqual({ value: 'alice, bob, acme/qa' })
  expect(checkAnswer('qaApprovers', 'Alice Smith (QA lead)')).toEqual({ problem: expect.stringContaining('"(QA", "lead)" are not GitHub logins') })
  expect(checkAnswer('fixRoundLimit', '5')).toEqual({ value: 5 })
  expect(checkAnswer('fixRoundLimit', 'five')).toEqual({ problem: expect.stringContaining('is not a whole number') })
  expect(checkAnswer('autoMerge', 'yes')).toEqual({ value: true })
  expect(checkAnswer('branchPrefix', 'my prefix/')).toEqual({ problem: expect.stringContaining('git refuses spaces') })
  expect(checkAnswer('qaWaitStatus', '  "In QA" ')).toEqual({ value: 'In QA' })
  expect(checkAnswer('qaSignals', 'pr-approval, slack')).toEqual({ value: 'pr-approval' })
  expect(checkAnswer('jiraProject', '')).toEqual({ value: '' })
  // A note before D69 holds qa: true; the rules leave a yes/no alone.
  expect(checkAnswer('qa', true)).toEqual({ value: true })
})

test('a saved note is repaired where safe and flagged where not, each with the topic that fixes it', () => {
  const saved = { jiraProject: 'HTTPS://ACME.ATLASSIAN.NET/JIRA/SOFTWARE/C/PROJECTS/PROD/BOARDS/133/BACKLOG', jiraCloudId: 'acme', qaApprovers: '', tracker: 'jira', branchPrefix: 'my prefix' }
  const { answers, repairs, issues } = cleanAnswers(saved, 'shared')

  expect(answers).toEqual({ jiraProject: 'PROD', jiraCloudId: 'acme.atlassian.net', qaApprovers: '', tracker: 'jira' })
  expect(repairs.map(repair => repair.key)).toEqual(['jiraProject', 'jiraCloudId'])
  expect(issues).toEqual([{ key: 'branchPrefix', value: 'my prefix', problem: expect.stringContaining('git refuses spaces'), topic: undefined, half: 'shared' }])
  const lines = answerIssueLines(repairs, issues)
  expect(lines[0]).toContain('reads the setup\'s jiraProject')
  expect(lines[0]).toContain('as "PROD"')
  expect(lines[0]).toContain('(topic `check`)')
  expect(lines[2]).toContain('cannot be used')
})

/** The QA signals question as setup asks it with Jira and people testing the PR on GitHub. */
const signalsQuestion = (): Question => {
  const qa = questionsFor(facts(), 'full').find(question => question.key === 'qaHuman')
  const where = qa?.followUps?.({ qaHuman: true })[0]
  const signals = where?.followUps?.({ qaHuman: true, tracker: 'jira', qaMode: 'human-pr' }).find(question => question.key === 'qaSignals')
  if (signals === undefined) throw new Error('no signals question')
  return signals
}

test('a sentence typed under Other on the QA signals maps its words to the choices, and nothing is dropped that matched', () => {
  const live = resolveAnswer(signalsQuestion(), 'QA sometimes moves ticket to Done, sometimes approves or merges PR themselves. really depends.')
  expect(live.values).toEqual({ qaSignals: 'ticket-status,pr-approval,pr-merged' })
  expect(live.note).toContain('was read as Ticket status')
  expect(live.note).not.toContain('left out')

  const vague = resolveAnswer(signalsQuestion(), 'Slack, PR approval')
  expect(vague.values).toEqual({ qaSignals: 'pr-approval' })
  expect(vague.note).toContain('"Slack" named none of the choices')
})

test('Atlassian\'s site lists are read in each server\'s shape, each site once', () => {
  const wrapped = { data: { resources: [{ cloudId: 'a82b720b-bd01-4d4f-b4ca-ceee3ce5df74', url: 'https://acme.atlassian.net', products: [] }] } }
  expect(sitesIn(wrapped)).toEqual([{ id: 'a82b720b-bd01-4d4f-b4ca-ceee3ce5df74', name: 'acme', url: 'https://acme.atlassian.net' }])
  const perProduct = [
    { id: 'x-1', name: 'acme', url: 'https://acme.atlassian.net', scopes: ['read:confluence'] },
    { id: 'x-1', name: 'acme', url: 'https://acme.atlassian.net', scopes: ['read:jira-work'] },
  ]
  expect(sitesIn(perProduct)).toHaveLength(1)
})

test('Jira\'s JQL error names each unknown project and status', () => {
  expect(unknownJqlValues("The value 'NOPE' does not exist for the field 'project'. The value 'QA ok' does not exist for the field 'status'.")).toEqual([
    { value: 'NOPE', field: 'project' },
    { value: 'QA ok', field: 'status' },
  ])
})

test('a package-manager command names the script it runs; built-ins and other tools name none', () => {
  expect(scriptUseOf('pnpm editor:dev')).toEqual({ script: 'editor:dev', isRun: false, isElsewhere: false })
  expect(scriptUseOf('npm run build -- --watch')).toEqual({ script: 'build', isRun: true, isElsewhere: false })
  expect(scriptUseOf('pnpm --filter web dev')).toEqual({ script: 'dev', isRun: false, isElsewhere: true })
  expect(scriptUseOf('PORT=3000 npm start')).toEqual({ script: 'start', isRun: true, isElsewhere: false })
  expect(scriptUseOf('pnpm install')).toBeUndefined()
  expect(scriptUseOf('npm ci')).toBeUndefined()
  expect(scriptUseOf('make dev')).toBeUndefined()
  expect(pnpmWorkspacesIn("packages:\n  - 'apps/*'\n  - packages/web # the site\n  - '!**/test'\nother: 1\n")).toEqual(['apps/*', 'packages/web'])
})
