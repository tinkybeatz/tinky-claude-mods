import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { AgentSpawnInput, On } from 'claude-code'

import type { ScanFacts } from '../types'
import { gapQuestions, questionsFor, resolveAnswer } from '../hooks/questionnaire'
import type { Question } from '../hooks/questionnaire'
import { analyse, presetFoldersFor, scanProject } from '../hooks/scan'
import type { Snapshot } from '../hooks/scan'
import { fillTemplate, notesKey } from '../hooks/setup'
import { projectOf } from '../hooks/storage'
import { trackerOf } from '../hooks/tickets'
import { makeJira, mountJira, SERVER } from './jira-world'
import { FIRST_COMMIT, HOME, makeWorld, mountWorld, REPO, worldEngine } from './world'
import type { World } from './world'

// ---------------------------------------------------------------------------
// The scan, per stack (D29)

const snapshot = (files: Record<string, string>, extra: string[] = [], nested: string[] = []): Snapshot => ({
  root: REPO,
  names: new Set([...Object.keys(files), ...extra]),
  texts: files,
  nested: new Set(nested),
})

const packageJson = (scripts: Record<string, string>, dependencies: Record<string, string> = {}) => JSON.stringify({ name: 'app', scripts, dependencies })

test('scan: a pnpm React app in TypeScript, with a runnable UI', () => {
  const found = analyse(
    snapshot(
      { 'package.json': packageJson({ build: 'vite build', test: 'vitest run', dev: 'vite', lint: 'eslint .', typecheck: 'tsc --noEmit' }, { react: '18', 'react-dom': '18' }) },
      ['pnpm-lock.yaml', 'tsconfig.json'],
    ),
  )
  expect(found.stacks).toEqual([{ id: 'node', language: 'TypeScript', marker: 'package.json', packageManager: 'pnpm', framework: 'react-dom' }])
  expect(found.commands).toEqual({
    install: 'pnpm install',
    build: 'pnpm build',
    test: 'pnpm test',
    start: 'pnpm dev',
    lint: 'pnpm lint',
    typecheck: 'pnpm typecheck',
  })
  expect(found.commandSources.test).toBe('package.json scripts.test')
  expect(found.hasUi).toBe(true)
})

test('scan: npm\'s placeholder test script is no test command, and a library has no UI', () => {
  const found = analyse(snapshot({ 'package.json': packageJson({ test: 'echo "Error: no test specified" && exit 1', start: 'node index.js' }) }))
  expect(found.stacks[0]?.language).toBe('JavaScript')
  expect(found.commands.test).toBeUndefined()
  expect(found.commands.start).toBe('npm start')
  expect(found.hasUi).toBe(false)
})

test('scan: a Python project with uv, pytest, ruff and Django', () => {
  const found = analyse(snapshot({ 'pyproject.toml': '[project]\ndependencies = ["django>=5", "pytest", "ruff"]\n' }, ['uv.lock', 'manage.py']))
  expect(found.stacks[0]).toEqual({ id: 'python', language: 'Python', marker: 'pyproject.toml', packageManager: 'uv', framework: 'django' })
  expect(found.commands).toEqual({
    test: 'uv run pytest',
    lint: 'uv run ruff check .',
    format: 'uv run ruff format --check .',
    install: 'uv sync',
    start: 'uv run python manage.py runserver',
  })
  expect(found.hasUi).toBe(true)
})

test('scan: a Python CLI with requirements and a tests folder, and no UI', () => {
  const found = analyse(snapshot({ 'requirements.txt': 'click\n' }, ['tests']))
  expect(found.commands).toEqual({ test: 'python -m unittest', install: 'pip install -r requirements.txt' })
  expect(found.hasUi).toBe(false)
})

test('scan: Rust, Go, Ruby on Rails, Gradle, Laravel, Phoenix, .NET, Flutter and Deno', () => {
  const rust = analyse(snapshot({ 'Cargo.toml': '[package]\nname = "cli"\n' }, [], ['src/main.rs']))
  expect(rust.commands).toEqual({ build: 'cargo build', test: 'cargo test', lint: 'cargo clippy', format: 'cargo fmt --check', start: 'cargo run' })

  const go = analyse(snapshot({ 'go.mod': 'module example.com/app\n' }, ['main.go']))
  expect(go.commands.test).toBe('go test ./...')
  expect(go.commands.start).toBe('go run .')

  const rails = analyse(snapshot({ Gemfile: "gem 'rails'\ngem 'rspec-rails'\n" }, ['spec'], ['config/application.rb']))
  expect(rails.stacks[0]?.framework).toBe('rails')
  expect(rails.commands.test).toBe('bundle exec rspec')
  expect(rails.commands.start).toBe('bin/rails server')
  expect(rails.hasUi).toBe(true)

  const gradle = analyse(snapshot({ 'build.gradle.kts': 'plugins { kotlin("jvm") }\n' }, ['gradlew']))
  expect(gradle.stacks[0]?.language).toBe('Kotlin')
  expect(gradle.commands.test).toBe('./gradlew test')

  const laravel = analyse(snapshot({ 'composer.json': JSON.stringify({ require: { 'laravel/framework': '11' }, 'require-dev': { 'phpunit/phpunit': '11' } }) }, ['artisan']))
  expect(laravel.commands.test).toBe('vendor/bin/phpunit')
  expect(laravel.commands.start).toBe('php artisan serve')

  const phoenix = analyse(snapshot({ 'mix.exs': 'defp deps do [{:phoenix, "~> 1.7"}] end\n' }))
  expect(phoenix.commands.start).toBe('mix phx.server')

  const dotnet = analyse(snapshot({}, ['App.sln']))
  expect(dotnet.stacks[0]?.language).toBe('C#')
  expect(dotnet.commands.test).toBe('dotnet test')

  const flutter = analyse(snapshot({ 'pubspec.yaml': 'dependencies:\n  flutter:\n    sdk: flutter\n' }))
  expect(flutter.commands.test).toBe('flutter test')
  expect(flutter.hasUi).toBe(true)

  const deno = analyse(snapshot({ 'deno.json': JSON.stringify({ tasks: { dev: 'deno run -A main.ts' } }) }))
  expect(deno.commands).toEqual({ test: 'deno test', lint: 'deno lint', start: 'deno task dev' })
})

test('scan: a Makefile fills only what no manifest said, and an empty folder finds nothing', () => {
  const made = analyse(snapshot({ 'go.mod': 'module x\n', Makefile: 'build:\n\tgo build\nrun:\n\t./x\ntest:\n\tgo test\n' }))
  expect(made.commands.test).toBe('go test ./...')
  expect(made.commands.start).toBe('make run')
  expect(made.commandSources.start).toBe('Makefile target run')

  const empty = analyse(snapshot({}))
  expect(empty.stacks).toEqual([])
  expect(empty.commands).toEqual({})
})

test('scan: the preset folders follow the stacks, one per stack, else a generic folder', () => {
  const node = analyse(snapshot({ 'package.json': packageJson({}) }, ['tsconfig.json'])).stacks
  const python = analyse(snapshot({ 'requirements.txt': 'x\n' })).stacks
  expect(presetFoldersFor(node, ['go', 'python', 'typescript'])).toEqual(['typescript'])
  expect(presetFoldersFor([...node, ...python], ['python', 'typescript'])).toEqual(['typescript', 'python'])
  expect(presetFoldersFor(python, ['generic', 'rust'])).toEqual(['generic'])
  expect(presetFoldersFor(python, ['rust'])).toEqual([])
})

test('scan: the whole project, conventions files and git included', async () => {
  const world = makeWorld({ gh: { login: 'me', prs: [] } })
  world.files.set(`${REPO}/go.mod`, 'module x\n')
  world.files.set(`${REPO}/CLAUDE.md`, '# Rules\n')
  world.files.set(`${REPO}/.claude/rules/testing.md`, 'Red-check.\n')
  world.files.set(`${REPO}/docs/adr/0001-use-go.md`, '# ADR 1\n')
  world.files.set(`${REPO}/docs/adr/README`, 'not markdown\n')
  const $ = worldEngine(world)

  const facts = await scanProject($, await projectOf($))

  expect(facts.name).toBe('app')
  expect(facts.stacks.map(stack => stack.id)).toEqual(['go'])
  expect(facts.conventions).toEqual(['CLAUDE.md', '.claude/rules/testing.md', 'docs/adr/0001-use-go.md'])
  expect(facts.git).toEqual({
    hasGit: true,
    origin: 'git@github.com:acme/app.git',
    remoteHost: 'github.com',
    host: 'github',
    hostReason: '`origin` is on github.com and `gh` is signed in',
    baseBranch: 'main',
  })
})

// ---------------------------------------------------------------------------
// The questionnaire: only the gaps, plus the person's own choices (D29)

const facts = (overrides: Partial<ScanFacts> = {}): ScanFacts => ({
  root: REPO,
  name: 'app',
  stacks: [{ id: 'go', language: 'Go', marker: 'go.mod' }],
  commands: { build: 'go build ./...', test: 'go test ./...' },
  commandSources: {},
  hasUi: false,
  git: { hasGit: true, origin: 'git@github.com:acme/app.git', remoteHost: 'github.com', host: 'github', hostReason: 'signed in' },
  conventions: [],
  ...overrides,
})

test('questionnaire: a fully scanned project asks only the person\'s choices, in order', () => {
  expect(questionsFor(facts(), 'full').map(question => question.key)).toEqual(['autoMerge', 'prApproval', 'storage', 'tracker', 'attribution', 'qaHuman', 'indicator'])
})

test('questionnaire: each gap the scan left becomes one question, first', () => {
  const gaps = facts({
    stacks: [],
    commands: {},
    hasUi: true,
    git: { hasGit: true, origin: 'git@gitlab.com:acme/app.git', remoteHost: 'gitlab.com', host: 'local', hostReason: '`origin` is not on github.com' },
  })
  expect(gapQuestions(gaps).map(question => question.key)).toEqual(['stack', 'testCommand', 'startCommand', 'gitHost'])
  expect(questionsFor(gaps, 'full').map(question => question.key).slice(0, 5)).toEqual(['stack', 'testCommand', 'startCommand', 'gitHost', 'autoMerge'])
  const host = gapQuestions(gaps).find(question => question.key === 'gitHost')
  expect(host?.choices.map(choice => choice.value)).toEqual(['local', 'other'])
})

test('questionnaire: GitHub with gh not signed in asks; no origin at all asks nothing (local branches, D54)', () => {
  const unsigned = facts({ git: { hasGit: true, origin: 'https://github.com/acme/app', remoteHost: 'github.com', host: 'local', hostReason: '`gh` is not signed in to github.com' } })
  expect(gapQuestions(unsigned).map(question => question.choices.map(choice => choice.value))).toEqual([['github', 'local']])
  const none = facts({ git: { hasGit: true, host: 'local', hostReason: 'the repo has no `origin` remote' } })
  expect(gapQuestions(none)).toEqual([])
})

/** The QA question for these facts, and the follow-ups each answer leads to. */
const qaFlow = (scanned: ScanFacts) => {
  const qa = questionsFor(scanned, 'full').find(question => question.key === 'qaHuman')
  if (qa === undefined) throw new Error('no QA question')
  const after = (question: Question | undefined, answers: Record<string, string | boolean>) => question?.followUps?.(answers) ?? []
  return { qa, after }
}

test('questionnaire: people testing leads to where; no people, to the QA agent (D69)', () => {
  const { qa, after } = qaFlow(facts())
  expect(qa.choices.map(choice => choice.value)).toEqual([true, false])
  expect(after(qa, { qaHuman: true }).map(question => question.header)).toEqual(['QA where'])
  expect(after(qa, { qaHuman: false }).map(question => question.header)).toEqual(['QA agent'])
  expect(after(qa, { qaHuman: false })[0]?.choices.map(choice => choice.value)).toEqual(['none', 'bot'])
  const [where] = after(qa, { qaHuman: true })
  expect(where?.choices.map(choice => choice.value)).toEqual(['human-pr', 'human-staging'])
})

test('questionnaire: the runnable UI only picks the QA agent\'s default, with people testing or without (D34, D71)', () => {
  const defaults = (hasUi: boolean) => {
    const { qa, after } = qaFlow(facts({ hasUi, uiReason: 'React app' }))
    const [agent] = after(qa, { qaHuman: false })
    const [botFirst] = after(after(qa, { qaHuman: true })[0], { qaHuman: true, qaMode: 'human-pr' })
    return [agent?.choices[0], botFirst?.choices[0]]
  }
  expect(defaults(true)).toEqual([
    { label: 'On (default)', value: 'bot' },
    { label: 'Yes (default)', value: true },
  ])
  expect(defaults(false)).toEqual([
    { label: 'Off (default)', value: 'none' },
    { label: 'No (default)', value: false },
  ])
})

test('questionnaire: each pass signal is offered only where godmode can read it (D70)', () => {
  const humanFlow = (scanned: ScanFacts, answers: Record<string, string | boolean>) => {
    const { qa, after } = qaFlow(scanned)
    const followUps = after(after(qa, { qaHuman: true })[0], { ...answers, qaHuman: true })
    const signals = followUps.find(question => question.key === 'qaSignals')
    return { headers: followUps.map(question => question.header), offered: signals?.choices.map(choice => choice.label) }
  }
  const local = facts({ git: { hasGit: true, host: 'local', hostReason: 'the repo has no `origin` remote' } })

  // Markdown tickets have no board, so only the PR approval, and only before the merge on GitHub.
  expect(humanFlow(facts(), { tracker: 'none', qaMode: 'human-pr' })).toEqual({ headers: ['QA bot first', 'QA signals'], offered: ['PR approval', 'PR merged', 'Only being told'] })
  expect(humanFlow(facts(), { tracker: 'none', qaMode: 'human-staging' })).toEqual({ headers: ['QA bot first'], offered: undefined })
  expect(humanFlow(local, { tracker: 'none', qaMode: 'human-pr' })).toEqual({ headers: ['QA bot first'], offered: undefined })
  // A board asks its waiting status too, and offers its pass status.
  expect(humanFlow(facts(), { tracker: 'jira', qaMode: 'human-pr' })).toEqual({
    headers: ['QA bot first', 'QA waiting', 'QA signals'],
    offered: ['Ticket status', 'PR approval', 'PR merged', 'Only being told'],
  })
  expect(humanFlow(local, { tracker: 'other', qaMode: 'human-staging' })).toEqual({
    headers: ['QA bot first', 'QA waiting', 'QA signals'],
    offered: ['Ticket status', 'Only being told'],
  })
})

test('questionnaire: the signals are picked together, each leading to its own name question', () => {
  const { qa, after } = qaFlow(facts())
  const signals = after(after(qa, { qaHuman: true })[0], { qaHuman: true, tracker: 'jira', qaMode: 'human-pr' }).find(question => question.key === 'qaSignals')
  if (signals === undefined) throw new Error('no signals question')
  expect(signals.multiSelect).toBe(true)
  expect(resolveAnswer(signals, 'Ticket status, PR approval').values).toEqual({ qaSignals: 'ticket-status,pr-approval' })
  expect(resolveAnswer(signals, 'pr-approval').values).toEqual({ qaSignals: 'pr-approval' })
  expect(resolveAnswer(signals, 'Only being told').values).toEqual({ qaSignals: '' })
  const unclear = resolveAnswer(signals, 'PR approval, Slack')
  expect(unclear.values).toEqual({ qaSignals: 'pr-approval' })
  expect(unclear.note).toContain('"Slack" named none of the choices')
  expect(after(signals, { qaSignals: 'ticket-status,pr-approval' }).map(question => question.header)).toEqual(['QA pass', 'QA approvers'])
  expect(after(signals, { qaSignals: '' })).toEqual([])
})

test('questionnaire: a personal setup asks only the personal questions (D61)', () => {
  expect(questionsFor(facts({ commands: {} }), 'personal').map(question => question.key)).toEqual(['autoMerge', 'prApproval', 'attribution', 'indicator'])
})

test('questionnaire: answers by label, by value, and typed under Other', () => {
  const [, , , tracker] = questionsFor(facts(), 'full')
  if (tracker === undefined) throw new Error('no tracker question')
  expect(resolveAnswer(tracker, 'None (markdown)').values).toEqual({ tracker: 'none' })
  expect(resolveAnswer(tracker, 'jira').values).toEqual({ tracker: 'jira' })
  expect(resolveAnswer(tracker, 'no tracker').values).toEqual({ tracker: 'none' })
  expect(resolveAnswer(tracker, 'Linear').values).toEqual({ tracker: 'other', trackerName: 'Linear' })
  const [merging] = questionsFor(facts(), 'full')
  if (merging === undefined) throw new Error('no merging question')
  const unclear = resolveAnswer(merging, 'whatever')
  expect(unclear.values).toEqual({ autoMerge: false })
  expect(unclear.note).toContain('/godmode setup')
})

test('a tracker answer of "no tracker", in any words, is None (D23)', () => {
  for (const words of ['none', 'None', 'no tracker', 'No', 'markdown', 'None (markdown)', '']) expect(trackerOf({ tracker: words })).toBe('none')
  expect(trackerOf({ tracker: 'Jira' })).toBe('jira')
})

test('templates: placeholders with a value are filled, the rest kept; stack notes have their keys', () => {
  expect(fillTemplate('Run {{ testCommand }} on {{baseBranch}}; {{unknown}}.', { testCommand: 'go test ./...' })).toBe('Run go test ./... on {{baseBranch}}; {{unknown}}.')
  expect(notesKey('coding.md')).toBe('languageNotes')
  expect(notesKey('testing.md')).toBe('testingNotes')
  expect(notesKey('error-handling.md')).toBe('errorHandlingNotes')
})

// ---------------------------------------------------------------------------
// Setup mode end to end, through the plugin

const SETUP_AGENT = 'agent-setup'

/** The templates godmode ships, as fixtures. */
const TEMPLATES: Record<string, string> = {
  'required/AGENTS.md': '# {{projectName}}: agent rules\n\nTests: `{{testCommand}}`. Conventions: {{conventionsDir}}.\nOne test: {{singleTestCommand}}\n',
  'required/CLAUDE.md': '@AGENTS.md\n',
  'required/coding-standards.md': '# Coding standards\n\n{{languageNotes}}\n',
  'required/testing-rules.md': '# Testing\n\n{{testingNotes}}\n',
  'required/pr-template.md': '## Summary\n',
  'optional/security-rules.md': '# Security\n',
  'presets/typescript/coding.md': 'Use strict mode.\n',
  'presets/typescript/testing.md': 'Tests sit next to the code.\n',
  'presets/python/coding.md': 'Type hints everywhere.\n',
  'README.md': 'not a template\n',
}

/** A TypeScript web app on GitHub, with no conventions yet. */
const webApp = (overrides: Partial<World> = {}) => {
  const world = makeWorld({ gh: { login: 'me', prs: [] }, templates: new Map(Object.entries(TEMPLATES)), ...overrides })
  world.files.set(`${REPO}/package.json`, packageJson({ test: 'vitest run', dev: 'vite' }, { react: '18' }))
  world.files.set(`${REPO}/tsconfig.json`, '{}\n')
  return world
}

type Setup = {
  world: World
  /** Each question the person saw, by its chip. */
  asked: string[]
  /** The choices each question offered, by its chip. */
  offered: Record<string, string[]>
  /** The person's answer per chip; absent, the first option; `null` dismisses it; a list answers each time asked, in turn. */
  answers: Record<string, string | null | (string | null)[]>
  /** Each question's full text, in order. */
  texts: string[]
  /** Edits that got past the plugin. */
  edited: string[]
  spawned: AgentSpawnInput[]
  contexts: (readonly string[] | undefined)[]
}

const godmode = ($: Engine, args = '') => $.command.run({ command: 'godmode', args } as Parameters<typeof $.command.run>[0])

/** Mounts the world and the person beneath the plugin; registers every hook before the first `$` call. */
const mount = (on: On, world: World, answers: Setup['answers'] = {}, beneath?: (on: On) => void): Setup => {
  const setup: Setup = { world, asked: [], offered: {}, answers, texts: [], edited: [], spawned: [], contexts: [] }
  mountWorld(on, world)
  on('agent.list', () => ({ value: [] }))
  on('ui.toast', () => ({ value: undefined }) as never)
  on('agent.spawn', (_$, e) => {
    setup.spawned.push(e)
    return { model: e.model ?? 'inherit', agentId: `agent-${setup.spawned.length}` }
  })
  on('prompt.submit', (_$, e) => {
    setup.contexts.push(e.context)
    return { text: e.text, context: e.context }
  })
  on('tool.call', (_$, e) => {
    const input = e as unknown as Record<string, unknown>
    if (e.tool === 'AskUserQuestion') {
      const question = (input.questions as { question: string; header: string; options: { label: string }[] }[])[0]
      const header = question?.header ?? ''
      setup.asked.push(header)
      setup.texts.push(question?.question ?? '')
      setup.offered[header] = question?.options.map(option => option.label) ?? []
      const given = setup.answers[header]
      const answer = Array.isArray(given) ? (given.length > 1 ? given.shift() : given[0]) : given
      if (answer === null) return { deny: 'The person dismissed the question.' }
      return { result: { questions: input.questions, answers: { [question?.question ?? '']: answer ?? question?.options[0]?.label ?? '' } } } as never
    }
    setup.edited.push(String(input.file_path ?? ''))
    return { result: 'ok' } as never
  })
  beneath?.(on)
  return setup
}

const tool = async ($: Engine, name: string, input: Record<string, unknown> = {}) =>
  (await $.tool.call({ tool: `mcp__godmode__${name}`, agentId: SETUP_AGENT, ...input } as Parameters<typeof $.tool.call>[0])) as { deny?: string; result?: unknown }

const resultOf = (answer: { deny?: string; result?: unknown }) => {
  if (answer.deny !== undefined) throw new Error(`refused: ${answer.deny}`)
  return String(answer.result)
}

const editAs = ($: Engine, path: string) =>
  $.tool.call({ tool: 'Edit', file_path: path, old_string: 'a', new_string: 'b', agentId: SETUP_AGENT } as Parameters<typeof $.tool.call>[0]) as Promise<{ deny?: string }>

const sharedNote = (world: World, dir = `${REPO}/.godmode`) => JSON.parse(world.files.get(`${dir}/shared.json`) ?? 'null') as {
  storage: string
  answers: Record<string, unknown>
  conventions: { path: string; fingerprint: string }[]
}
const personalNote = (world: World, dir = `${REPO}/.godmode`) => JSON.parse(world.files.get(`${dir}/personal.json`) ?? 'null') as { answers: Record<string, unknown> }

test('setup, no conventions: the preset is written, the note lands, and the next /godmode is coding mode', async ($, on) => {
  const setup = mount(on, webApp(), { Indicator: 'Band', QA: 'No' })

  await godmode($)
  // The PM dispatches the setup agent, which runs on Opus whatever the call asked (D33, D39).
  await $.agent.spawn({
    prompt: 'Set up godmode for this project. Scope: full.',
    description: 'godmode setup',
    subagentType: 'godmode:setup',
    model: 'haiku',
  } as Parameters<typeof $.agent.spawn>[0])
  expect(setup.spawned[0]?.model).toBe('opus')
  expect(setup.spawned[0]?.prompt).toBe('Set up godmode for this project. Scope: full.')
  const scan = resultOf(await tool($, 'setup_scan'))
  expect(scan).toContain('"presetsForThisProject": [\n      "typescript"\n    ]')
  expect(scan).toContain('"required": [\n      "AGENTS.md",')

  const answers = resultOf(await tool($, 'setup_questionnaire'))
  // A web app with its commands found and GitHub signed in: no gap to ask about.
  // No people test, and the runnable UI makes the QA agent the default (D69).
  expect(setup.asked).toEqual(['Merging', 'Approvals', 'Storage', 'Tracker', 'Attribution', 'QA', 'QA agent', 'Indicator'])
  expect(answers).toContain('- qaMode: "bot"')

  const wrote = resultOf(await tool($, 'setup_write_preset'))
  expect(wrote).toContain('- wrote AGENTS.md from required/AGENTS.md')
  expect(wrote).toContain('- wrote .github/pull_request_template.md from required/pr-template.md')
  expect(setup.world.files.get(`${REPO}/AGENTS.md`)).toBe(
    '# app: agent rules\n\nTests: `pnpm test`. Conventions: docs/conventions.\nOne test: {{singleTestCommand}}\n'.replace('pnpm test', 'npm test'),
  )
  expect(setup.world.files.get(`${REPO}/docs/conventions/coding-standards.md`)).toBe('# Coding standards\n\nUse strict mode.\n')
  expect(setup.world.files.get(`${REPO}/docs/conventions/testing-rules.md`)).toBe('# Testing\n\nTests sit next to the code.\n')
  expect(setup.world.files.has(`${REPO}/docs/conventions/security-rules.md`)).toBe(false)

  const done = resultOf(await tool($, 'setup_finish', { answers: { singleTestCommand: 'npx vitest run <file>' } }))
  expect(done).toContain('setup is done')
  // The PM learns the QA mode from the report.
  expect(done).toContain('\nQA mode: bot (')

  const shared = sharedNote(setup.world)
  expect(shared.storage).toBe('committed')
  expect(shared.answers).toEqual({
    stack: 'TypeScript',
    installCommand: 'npm install',
    testCommand: 'npm test',
    startCommand: 'npm run dev',
    baseBranch: 'main',
    singleTestCommand: 'npx vitest run <file>',
    tracker: 'none',
    qaMode: 'bot',
  })
  expect(personalNote(setup.world).answers).toEqual({ autoMerge: false, prApproval: 'ask', attribution: false, indicator: 'band' })
  expect(shared.conventions.map(file => file.path)).toEqual([
    'AGENTS.md',
    'CLAUDE.md',
    'docs/conventions/coding-standards.md',
    '.github/pull_request_template.md',
    'docs/conventions/testing-rules.md',
  ])
  expect(shared.conventions.every(file => file.fingerprint.startsWith('sha256:'))).toBe(true)

  // The PM hears once that setup finished, on its next prompt.
  await $.prompt.submit({ text: 'what now?' } as Parameters<typeof $.prompt.submit>[0])
  await $.prompt.submit({ text: 'and now?' } as Parameters<typeof $.prompt.submit>[0])
  // The report and the PM's role come once; then each prompt carries only the one-line reminder (D64).
  expect(setup.contexts[0]?.join('\n')).toContain('godmode: setup is done')
  expect(setup.contexts[0]?.join('\n')).toContain('You are the PM')
  expect(setup.contexts[0]?.join('\n')).not.toContain('${CLAUDE_PLUGIN_ROOT}')
  expect(setup.contexts[0]?.join('\n')).toContain('/godmode/rules/writing-tickets.md')
  expect(setup.contexts[1]).toEqual([expect.stringContaining('godmode is on: you are its PM')])

  // Coding mode now, and again in the next session.
  const off = await godmode($, 'off')
  expect(off.text).toContain('off')
  const next = await godmode($)
  expect(next.text).toBeUndefined()
  expect(next.context?.[0]).toContain('You are the PM')
  expect(resultOf(await tool($, 'ticket_list', { agentId: undefined }))).toBe('No open tickets.')
  expect((await tool($, 'setup_scan')).deny).toContain('not in setup mode')
})

test('setup never overwrites a file, and a missing required piece stops the finish (D31)', async ($, on) => {
  const world = webApp()
  world.files.set(`${REPO}/AGENTS.md`, '# Our own rules\n')
  const setup = mount(on, world)
  await godmode($)
  await tool($, 'setup_scan')
  await tool($, 'setup_questionnaire')

  const wrote = resultOf(await tool($, 'setup_write_preset', { pieces: ['CLAUDE.md', 'coding-standards.md'] }))

  expect(wrote).toContain('- wrote CLAUDE.md')
  expect(wrote).not.toContain('AGENTS.md')
  expect(setup.world.files.get(`${REPO}/AGENTS.md`)).toBe('# Our own rules\n')
  const refused = await tool($, 'setup_finish')
  expect(refused.deny).toContain('Required pieces are missing (D31): AGENTS.md, pr-template.md, testing-rules.md')
  expect(setup.world.files.has(`${REPO}/.godmode/shared.json`)).toBe(false)
  expect((await tool($, 'setup_write_preset', { pieces: ['nope.md'] })).deny).toContain('No required template named nope.md')
})

test('setup, solid conventions: adopted as they are, missing pieces filled, nothing of theirs edited (D3, D32)', async ($, on) => {
  const world = webApp()
  world.files.set(`${REPO}/AGENTS.md`, '# Agent rules\n')
  world.files.set(`${REPO}/CLAUDE.md`, '@AGENTS.md\n')
  world.files.set(`${REPO}/docs/standards/coding.md`, '# Coding\n')
  world.files.set(`${REPO}/docs/standards/testing.md`, '# Testing\n')
  const setup = mount(on, world)
  await godmode($)
  const scan = resultOf(await tool($, 'setup_scan'))
  expect(scan).toContain('"docs/standards/coding.md"')
  await tool($, 'setup_questionnaire')

  resultOf(await tool($, 'setup_write_preset', { pieces: ['pr-template.md'] }))
  resultOf(
    await tool($, 'setup_finish', {
      covered: { 'AGENTS.md': 'AGENTS.md', 'CLAUDE.md': 'CLAUDE.md', 'coding-standards.md': 'docs/standards/coding.md', 'testing-rules.md': 'docs/standards/testing.md' },
    }),
  )

  expect(setup.edited).toEqual([])
  expect(sharedNote(setup.world).conventions.map(file => file.path)).toEqual([
    'AGENTS.md',
    'CLAUDE.md',
    'docs/standards/coding.md',
    'docs/standards/testing.md',
    '.github/pull_request_template.md',
  ])
})

test('setup, weak conventions: no edit in place until the person says yes (D32)', async ($, on) => {
  const world = webApp()
  world.files.set(`${REPO}/CLAUDE.md`, 'be nice\n')
  const setup = mount(on, world, { Conventions: 'No, keep them' })
  await godmode($)
  await tool($, 'setup_scan')

  const before = await editAs($, `${REPO}/CLAUDE.md`)
  expect(before.deny).toContain('setup_confirm')

  const no = resultOf(await tool($, 'setup_confirm', { change: 'Add the test command and the review rules.', why: 'Agents cannot tell how to check their work.' }))
  expect(no).toContain('said no')
  expect((await editAs($, `${REPO}/CLAUDE.md`)).deny).toContain('setup_confirm')

  setup.answers.Conventions = 'Yes, improve them'
  const yes = resultOf(await tool($, 'setup_confirm', { change: 'Add the test command.', why: 'Agents need it.', files: ['CLAUDE.md'] }))
  expect(yes).toContain('you may now edit CLAUDE.md')
  expect((await editAs($, `${REPO}/CLAUDE.md`)).deny).toBeUndefined()
  // A new file is never held back.
  expect((await editAs($, `${REPO}/docs/conventions/new.md`)).deny).toBeUndefined()
  expect(setup.edited).toEqual([`${REPO}/CLAUDE.md`, `${REPO}/docs/conventions/new.md`])
  expect(setup.asked.filter(header => header === 'Conventions')).toHaveLength(2)
})

test('setup asks only the gaps, never reference repos, and skips what the person already said', async ($, on) => {
  const world = makeWorld({ gh: undefined, templates: new Map(Object.entries(TEMPLATES)) })
  world.files.set(`${REPO}/requirements.txt`, 'click\n')
  const setup = mount(on, world, { Tests: 'pytest -q' })
  await godmode($)

  const refused = await tool($, 'setup_questionnaire', { extra: [{ key: 'refs', question: 'Any reference repos agents may read?', options: ['Yes', 'No'] }] })
  expect(refused.deny).toContain('never asks about reference repos')
  expect(setup.asked).toEqual([])

  const answers = resultOf(
    await tool($, 'setup_questionnaire', {
      extra: [{ key: 'e2eCommand', question: 'Which end-to-end suite runs before merge?', options: ['None', 'make e2e'] }],
      given: { tracker: 'no tracker', storage: 'outside', qaHuman: 'no', qaMode: 'none' },
    }),
  )
  // The QA answer and its follow-up were given, so neither is asked.
  expect(setup.asked).toEqual(['Tests', 'e2eCommand', 'Merging', 'Approvals', 'Attribution', 'Indicator'])
  expect(answers).toContain('- qaMode: "none"')
  expect(answers).toContain('- testCommand: "pytest -q"')
  expect(answers).toContain('- tracker: "none"')
  // "None" for a command records none.
  expect(answers).toContain('- e2eCommand: ""')
})

test('setup that cannot ask stops, saying which questions are left for the PM to relay', async ($, on) => {
  const setup = mount(on, webApp(), { Storage: null })
  await godmode($)

  const stopped = await tool($, 'setup_questionnaire')

  expect(stopped.deny).toContain('could not ask the person')
  expect(stopped.deny).toContain('- storage:')
  expect(stopped.deny).toContain('- indicator:')
  expect(stopped.deny).not.toContain('- autoMerge:')
  expect(setup.asked).toEqual(['Merging', 'Approvals', 'Storage'])
})

/** A setup run through to its note with the person's answers; resolves the report. */
const setUp = async ($: Engine) => {
  await godmode($)
  await tool($, 'setup_questionnaire')
  resultOf(await tool($, 'setup_write_preset'))
  return resultOf(await tool($, 'setup_finish'))
}

test('setup, people test the PR: where, the bot pass, the board\'s statuses and the approvers land in the shared note (D69, D70, D71)', async ($, on) => {
  const setup = mount(on, webApp(), {
    Tracker: 'Jira',
    QA: 'Yes, people test',
    'QA where': 'On the PR',
    'QA bot first': 'No',
    'QA waiting': 'In QA',
    'QA signals': 'Ticket status, PR approval',
    'QA pass': 'Ready to ship',
    'QA approvers': 'acme/qa',
  })

  const done = await setUp($)

  expect(setup.asked).toEqual(['Merging', 'Approvals', 'Storage', 'Tracker', 'Attribution', 'QA', 'QA where', 'QA bot first', 'QA waiting', 'QA signals', 'QA pass', 'QA approvers', 'Indicator'])
  const answers = sharedNote(setup.world).answers
  expect(answers).toMatchObject({
    qaMode: 'human-pr',
    qaBotFirst: false,
    qaWaitStatus: 'In QA',
    qaSignals: 'ticket-status,pr-approval',
    qaPassStatus: 'Ready to ship',
    qaApprovers: 'acme/qa',
  })
  // The answer that only led to where people test is not kept, and nor is the old on or off.
  expect(Object.keys(answers)).not.toContain('qaHuman')
  expect(Object.keys(answers)).not.toContain('qa')
  expect(Object.keys(personalNote(setup.world).answers).filter(key => key.startsWith('qa'))).toEqual([])
  expect(done).toContain('\nQA mode: human-pr (')
  expect(done).toContain('The QA agent tests first: no. Waiting-for-QA status: "In QA". Pass signals: being told, the ticket moved to "Ready to ship", a PR approval from acme/qa.')
})

test('setup, people test on staging: no PR signal and, with markdown tickets, no board signal (D69, D70)', async ($, on) => {
  const setup = mount(on, webApp(), { QA: 'Yes, people test', 'QA where': 'On staging' })

  const done = await setUp($)

  expect(setup.asked).toEqual(['Merging', 'Approvals', 'Storage', 'Tracker', 'Attribution', 'QA', 'QA where', 'QA bot first', 'Indicator'])
  const answers = sharedNote(setup.world).answers
  // The runnable UI made the bot pass first the default (D71).
  expect(answers).toMatchObject({ tracker: 'none', qaMode: 'human-staging', qaBotFirst: true })
  expect(Object.keys(answers).filter(key => key.startsWith('qa')).sort()).toEqual(['qaBotFirst', 'qaMode'])
  expect(done).toContain('\nQA mode: human-staging (')
  expect(done).toContain('Pass signals: being told.')
})

test('setup, no people and no QA agent: the mode is none, with nothing else asked (D69)', async ($, on) => {
  const setup = mount(on, webApp(), { QA: 'No', 'QA agent': 'Off' })

  const done = await setUp($)

  expect(setup.asked.filter(header => header.startsWith('QA'))).toEqual(['QA', 'QA agent'])
  expect(sharedNote(setup.world).answers.qaMode).toBe('none')
  expect(done).toContain('\nQA mode: none (')
})

test('setup that cannot ask the QA question lists its follow-ups, so one round of answers covers them', async ($, on) => {
  const setup = mount(on, webApp(), { QA: null })
  await godmode($)

  const stopped = await tool($, 'setup_questionnaire')

  expect(setup.asked.at(-1)).toBe('QA')
  expect(stopped.deny).toContain('- qaHuman: Do people (QA engineers) test changes')
  expect(stopped.deny).toContain('  if Yes, people test:\n    - qaMode: Where do the people test')
  expect(stopped.deny).toContain('      if On the PR:\n        - qaBotFirst:')
  expect(stopped.deny).toContain('  if No:\n    - qaMode: Should a QA agent run the app')
  expect(stopped.deny).toContain('- indicator:')
})

test('setup that stops at the tracker lists the board\'s QA questions as conditional, and one round of answers then covers the flow', async ($, on) => {
  const setup = mount(on, webApp(), { Tracker: null })
  await godmode($)

  const stopped = await tool($, 'setup_questionnaire')

  expect(setup.asked.at(-1)).toBe('Tracker')
  // The tracker is unknown, so what only a board brings is listed, marked with its condition.
  expect(stopped.deny).toContain('      if On staging:\n        - qaBotFirst:')
  expect(stopped.deny).toContain('        - qaWaitStatus (only if the tracker is Jira or Other): Which status')
  expect(stopped.deny).toContain('        - qaSignals (only if the tracker is Jira or Other): Being told')
  expect(stopped.deny).toContain('(Ticket status [only if the tracker is Jira or Other] / PR approval / PR merged / Only being told)')
  expect(stopped.deny).toContain('- qaPassStatus: Which status on the board means QA passed?')

  // The PM relays them; the person picks Jira. Every QA dialog is dismissed, so only `given` can answer.
  for (const header of ['Tracker', 'QA', 'QA where', 'QA bot first', 'QA waiting', 'QA signals', 'QA pass', 'Attribution', 'Indicator']) setup.answers[header] = null
  const answers = resultOf(
    await tool($, 'setup_questionnaire', {
      given: {
        tracker: 'Jira',
        attribution: 'No attribution',
        qaHuman: 'Yes, people test',
        qaMode: 'On staging',
        qaBotFirst: 'Yes',
        qaWaitStatus: 'In QA',
        qaSignals: 'Ticket status',
        qaPassStatus: 'QA passed',
        indicator: 'Band',
      },
    }),
  )

  expect(setup.asked.slice(4)).toEqual(['Merging', 'Approvals', 'Storage'])
  expect(answers).toContain('- qaWaitStatus: "In QA"')
  expect(answers).toContain('- qaSignals: "ticket-status"')
  expect(answers).toContain('- qaPassStatus: "QA passed"')
})

test('setup asked again on another QA branch keeps none of the earlier branch\'s answers', async ($, on) => {
  const setup = mount(on, webApp(), {
    Tracker: 'Jira',
    QA: 'Yes, people test',
    'QA where': 'On the PR',
    'QA waiting': 'In QA',
    'QA signals': 'Ticket status, PR approval',
    'QA pass': 'Ready to ship',
    'QA approvers': 'acme/qa',
    Indicator: null,
  })
  await godmode($)
  expect((await tool($, 'setup_questionnaire')).deny).toContain('could not ask the person')

  Object.assign(setup.answers, { QA: 'No', 'QA agent': 'Off', Indicator: 'Band' })
  resultOf(await tool($, 'setup_questionnaire'))
  resultOf(await tool($, 'setup_write_preset'))
  resultOf(await tool($, 'setup_finish'))

  const answers = sharedNote(setup.world).answers
  expect(Object.keys(answers).filter(key => key.startsWith('qa'))).toEqual(['qaMode'])
  expect(answers.qaMode).toBe('none')
  expect(answers.tracker).toBe('jira')
})

test('setup in gitignored storage keeps the conventions under .godmode, excluded from git (D19, D65)', async ($, on) => {
  const setup = mount(on, webApp(), { Storage: 'Gitignored' })
  await godmode($)
  await tool($, 'setup_questionnaire')

  resultOf(await tool($, 'setup_write_preset'))
  resultOf(await tool($, 'setup_finish'))

  expect(setup.world.files.has(`${REPO}/AGENTS.md`)).toBe(false)
  expect(setup.world.files.get(`${REPO}/.godmode/conventions/pr-template.md`)).toBe('## Summary\n')
  expect(setup.world.files.get(`${REPO}/.git/info/exclude`)).toContain('.godmode/')
  expect(sharedNote(setup.world).conventions.map(file => file.path)).toContain('.godmode/conventions/AGENTS.md')
})

test('setup outside the repo writes nothing in it, and every agent brief lists the conventions (D19)', async ($, on) => {
  const setup = mount(on, webApp(), { Storage: 'Outside the repo' })
  await godmode($)
  await tool($, 'setup_questionnaire')
  resultOf(await tool($, 'setup_write_preset'))
  resultOf(await tool($, 'setup_finish'))

  const dir = `${HOME}/.claude/godmode/projects/${FIRST_COMMIT}`
  expect([...setup.world.files.keys()].filter(path => path.startsWith(`${REPO}/`))).toEqual([`${REPO}/package.json`, `${REPO}/tsconfig.json`])
  expect(sharedNote(setup.world, dir).conventions[0]?.path).toBe(`${dir}/conventions/AGENTS.md`)

  await $.agent.spawn({ prompt: 'Review PR #3.', description: 'review', subagentType: 'godmode:reviewer' } as Parameters<typeof $.agent.spawn>[0])
  expect(setup.spawned[0]?.prompt).toContain(`- ${dir}/conventions/AGENTS.md`)
  expect(setup.spawned[0]?.model).toBe('opus')
})

test('setup with Jira: the one server is used unasked, the site read, the project picked, and the board\'s statuses offered for the mapping and for QA', async ($, on) => {
  const jira = makeJira()
  for (const [index, status] of ['To Do', 'In Progress', 'Code Review', 'In QA', 'QA passed', 'Done'].entries()) {
    jira.issues.set(`APP-${index + 1}`, { key: `APP-${index + 1}`, summary: `Issue ${index + 1}`, status })
  }
  const setup = mount(
    on,
    webApp(),
    {
      Tracker: 'Jira',
      'Jira project': 'APP (App)',
      'Jira mapping': 'Keep it',
      QA: 'Yes, people test',
      'QA where': 'On staging',
      'QA bot first': 'No',
      'QA waiting': 'In QA',
      'QA signals': 'Ticket status',
      'QA pass': 'QA passed',
    },
    beneath => mountJira(beneath, jira),
  )

  await setUp($)

  expect(setup.asked).toEqual(['Merging', 'Approvals', 'Storage', 'Tracker', 'Jira project', 'Jira mapping', 'Attribution', 'QA', 'QA where', 'QA bot first', 'QA waiting', 'QA signals', 'QA pass', 'Indicator'])
  expect(setup.offered['Jira project']).toEqual(['APP (App)', 'OPS (Ops)'])
  expect(setup.offered['QA waiting']).toEqual(['In QA', 'To Do', 'In Progress', 'Code Review'])
  expect(setup.offered['QA pass']).toEqual(['QA passed', 'Done', 'To Do', 'In Progress'])
  const shared = sharedNote(setup.world).answers
  expect(shared).toMatchObject({
    tracker: 'jira',
    jiraCloudId: '0c5e2f7a-1d3b-4e8f-9a6c-2b7d4e1f3a90',
    jiraProject: 'APP',
    jiraTodoStatus: 'To Do',
    jiraDoingStatus: 'In Progress',
    jiraReviewStatus: 'Code Review',
    jiraDoneStatus: 'Done',
    qaWaitStatus: 'In QA',
    qaPassStatus: 'QA passed',
  })
  // The server's name is this person's, so it stays out of the team's half (D61).
  expect(Object.keys(shared)).not.toContain('jiraServer')
  expect(Object.keys(shared)).not.toContain('jiraStatusMap')
  expect(personalNote(setup.world).answers.jiraServer).toBe(SERVER)
})

test('setup with Jira and no Atlassian server connected asks nothing more and says what is missing', async ($, on) => {
  const setup = mount(on, webApp(), { Tracker: 'Jira', QA: 'No', 'QA agent': 'Off' }, beneath => mountJira(beneath, makeJira({ isDisconnected: true })))
  await godmode($)

  const answered = resultOf(await tool($, 'setup_questionnaire'))

  expect(setup.asked).toEqual(['Merging', 'Approvals', 'Storage', 'Tracker', 'Attribution', 'QA', 'QA agent', 'Indicator'])
  expect(answered).toContain('Note: No Atlassian (Jira) server is connected to this session, so godmode could not read the board.')
})

test('a teammate\'s personal setup asks four questions and writes only the personal half (D61)', async ($, on) => {
  const world = webApp()
  world.files.set(`${REPO}/AGENTS.md`, '# Rules\n')
  const team = mount(on, world, { Merging: 'Merge when green', Indicator: 'Hint tag' })
  const shared = JSON.stringify({ godmodeVersion: '0.5.0', storage: 'committed', writtenAt: 'x', answers: { tracker: 'none' }, minimumModels: {}, conventions: [] })
  world.files.set(`${REPO}/.godmode/shared.json`, shared)

  const started = await godmode($)
  expect(started.context?.[0]).toContain('Scope: personal')
  await tool($, 'setup_questionnaire')
  expect((await tool($, 'setup_write_preset')).deny).toContain('personal setup')
  const done = resultOf(await tool($, 'setup_finish'))

  expect(done).toContain('\nQA mode: none (')
  expect(team.asked).toEqual(['Merging', 'Approvals', 'Attribution', 'Indicator'])
  expect(world.files.get(`${REPO}/.godmode/shared.json`)).toBe(shared)
  expect(personalNote(world).answers).toEqual({ autoMerge: true, prApproval: 'ask', attribution: false, indicator: 'hint' })
})

test('no git: /godmode offers git init, runs it on a yes, and starts setup (D54)', async ($, on) => {
  const world = webApp({ git: undefined })
  const setup = mount(on, world, { git: 'Run git init' })
  world.answer = run => {
    if (run.argv.join(' ') !== 'git init') return undefined
    world.git = { root: REPO }
    return { exitCode: 0, stdout: 'Initialized empty Git repository\n' }
  }

  const answer = await godmode($)

  expect(setup.asked).toEqual(['git'])
  expect(world.gitRuns).toContain('git init')
  expect(answer.text).toContain('godmode is setting up this project')
})

test('no git: a "Not now" leaves the folder untouched and godmode off', async ($, on) => {
  const world = webApp({ git: undefined })
  const setup = mount(on, world, { git: 'Not now' })

  const answer = await godmode($)

  expect(setup.asked).toEqual(['git'])
  expect(world.gitRuns).not.toContain('git init')
  expect(answer.text).toContain('`git init`')
  expect((await tool($, 'setup_scan')).deny).toContain('godmode is off')
})

// ---------------------------------------------------------------------------
// Messy answers, as people really type them (the live test's bug class)

/** A board in project APP with an issue in each of the usual statuses, so the mapping is guessed whole. */
const appBoard = (overrides: Parameters<typeof makeJira>[0] = {}) => {
  const jira = makeJira(overrides)
  for (const [index, status] of ['To Do', 'In Progress', 'Code Review', 'In QA', 'QA passed', 'Done'].entries()) {
    jira.issues.set(`APP-${index + 1}`, { key: `APP-${index + 1}`, summary: `Issue ${index + 1}`, status })
  }
  return jira
}

test('messy Jira answers: the wrapped site list picks its one site, a project link saves its key, and an unknown project or status is asked again with the reason', async ($, on) => {
  const jira = appBoard({ flavour: 'runner', sitesShape: 'wrapped' })
  const setup = mount(
    on,
    webApp({ gh: { login: 'me', prs: [], collaborators: ['alice'] } }),
    {
      Tracker: 'jira',
      'Jira project': ['  nope ', 'https://acme.atlassian.net/jira/software/c/projects/app/boards/133/backlog'],
      'Jira mapping': 'Keep it',
      QA: 'Yes, people test',
      'QA where': 'On the PR',
      'QA bot first': 'No',
      'QA waiting': ['Waiting for QA', ' "In QA" '],
      'QA signals': 'QA sometimes moves ticket to Done, sometimes approves or merges PR themselves. really depends.',
      'QA pass': 'QA passed',
      'QA approvers': ['@alice, bob', '@alice'],
    },
    beneath => mountJira(beneath, jira),
  )

  const done = await setUp($)

  // No "Jira site" question: the "Atlassian MCP" server's one site was read from its wrapped list.
  expect(setup.asked).toEqual([
    'Merging', 'Approvals', 'Storage', 'Tracker', 'Jira project', 'Jira project', 'Jira mapping', 'Attribution',
    'QA', 'QA where', 'QA bot first', 'QA waiting', 'QA waiting', 'QA signals', 'QA pass', 'QA approvers', 'QA approvers', 'Indicator',
  ])
  expect(setup.texts[5]).toContain('That answer could not be used: Jira has no project "NOPE"')
  expect(setup.texts[12]).toContain('That answer could not be used: "Waiting for QA" is not a status on')
  expect(setup.texts[16]).toContain('bob is not a collaborator on acme/app')
  expect(sharedNote(setup.world).answers).toMatchObject({
    jiraCloudId: '0c5e2f7a-1d3b-4e8f-9a6c-2b7d4e1f3a90',
    jiraProject: 'APP',
    qaWaitStatus: 'In QA',
    qaSignals: 'ticket-status,pr-approval,pr-merged',
    qaApprovers: 'alice',
  })
  // The report quotes what the note holds on disk.
  expect(done).toContain('Saved for the team: ')
  expect(done).toContain('jiraProject "APP"')
})

test('messy Jira answers: with no site listed, a bare site name is saved as its address, and a lower-case key as the key', async ($, on) => {
  const setup = mount(
    on,
    webApp(),
    { Tracker: 'Jira', 'Jira site': ' Acme ', 'Jira project': 'app', 'Jira mapping': 'Keep it', QA: 'No', 'QA agent': 'Off' },
    beneath => mountJira(beneath, appBoard({ sites: [] })),
  )

  await setUp($)

  expect(setup.asked.slice(3, 7)).toEqual(['Tracker', 'Jira site', 'Jira project', 'Jira mapping'])
  expect(sharedNote(setup.world).answers).toMatchObject({ jiraCloudId: 'acme.atlassian.net', jiraProject: 'APP' })
})

test('messy commands: a test command naming no script is asked again, and backticks and spaces are taken off', async ($, on) => {
  const world = webApp()
  world.files.set(`${REPO}/package.json`, packageJson({ dev: 'vite', unit: 'vitest run' }, { react: '18' }))
  const setup = mount(on, world, { Tests: ['pnpm editor:test', ' `npm run  unit` '], QA: 'No' })

  await setUp($)

  expect(setup.asked.slice(0, 2)).toEqual(['Tests', 'Tests'])
  expect(setup.texts[1]).toContain('`pnpm editor:test` runs `editor:test`, which is not a script in package.json')
  expect(sharedNote(setup.world).answers.testCommand).toBe('npm run unit')
})

test('setup_finish refuses a setting it cannot use or that names no script, saying which and why, and saves nothing', async ($, on) => {
  const setup = mount(on, webApp(), { QA: 'No' })
  await godmode($)
  await tool($, 'setup_questionnaire')
  resultOf(await tool($, 'setup_write_preset'))

  const unusable = await tool($, 'setup_finish', { answers: { branchPrefix: 'my prefix/' } })
  const missing = await tool($, 'setup_finish', { answers: { lintCommand: 'npm run lint' } })

  expect(unusable.deny).toContain('- branchPrefix: "my prefix/" is not a usable branch prefix')
  expect(missing.deny).toContain('- lintCommand "npm run lint": `npm run lint` runs `lint`, which is not a script in package.json')
  expect(setup.world.files.has(`${REPO}/.godmode/shared.json`)).toBe(false)
})

test('first setup on Jira: the setup agent learns the ticket rules from the board, and they join the conventions on finish', async ($, on) => {
  const setup = mount(
    on,
    webApp(),
    { Tracker: 'Jira', 'Jira project': 'APP (App)', 'Jira mapping': 'Keep it', QA: 'No', 'QA agent': 'Off', 'Ticket rules': ['Scan the board, then I confirm', 'Looks right', 'Save'] },
    beneath => mountJira(beneath, appBoard()),
  )
  await godmode($)
  await tool($, 'setup_questionnaire')

  const learned = resultOf(await tool($, 'ticket_rules'))
  resultOf(await tool($, 'setup_write_preset'))
  const done = resultOf(await tool($, 'setup_finish'))

  expect(learned).toContain('Saved docs/conventions/ticket-filing.md')
  expect(setup.world.files.get(`${REPO}/docs/conventions/ticket-filing.md`)).toContain('- Task: 6 of 6.')
  expect(sharedNote(setup.world).conventions.map(file => file.path)).toContain('docs/conventions/ticket-filing.md')
  expect(done).toContain('ticketRules "docs/conventions/ticket-filing.md"')
})
