import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { AgentSpawnInput, On } from 'claude-code'

import type { ScanFacts } from '../types'
import { gapQuestions, questionsFor, resolveAnswer } from '../hooks/questionnaire'
import { analyse, presetFoldersFor, scanProject } from '../hooks/scan'
import type { Snapshot } from '../hooks/scan'
import { fillTemplate, notesKey } from '../hooks/setup'
import { projectOf } from '../hooks/storage'
import { trackerOf } from '../hooks/tickets'
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
  expect(questionsFor(facts(), 'full').map(question => question.key)).toEqual(['permissions', 'storage', 'tracker', 'attribution', 'qa', 'indicator'])
})

test('questionnaire: each gap the scan left becomes one question, first', () => {
  const gaps = facts({
    stacks: [],
    commands: {},
    hasUi: true,
    git: { hasGit: true, origin: 'git@gitlab.com:acme/app.git', remoteHost: 'gitlab.com', host: 'local', hostReason: '`origin` is not on github.com' },
  })
  expect(gapQuestions(gaps).map(question => question.key)).toEqual(['stack', 'testCommand', 'startCommand', 'gitHost'])
  expect(questionsFor(gaps, 'full').map(question => question.key).slice(0, 5)).toEqual(['stack', 'testCommand', 'startCommand', 'gitHost', 'permissions'])
  const host = gapQuestions(gaps).find(question => question.key === 'gitHost')
  expect(host?.choices.map(choice => choice.value)).toEqual(['local', 'other'])
})

test('questionnaire: GitHub with gh not signed in asks; no origin at all asks nothing (local branches, D54)', () => {
  const unsigned = facts({ git: { hasGit: true, origin: 'https://github.com/acme/app', remoteHost: 'github.com', host: 'local', hostReason: '`gh` is not signed in to github.com' } })
  expect(gapQuestions(unsigned).map(question => question.choices.map(choice => choice.value))).toEqual([['github', 'local']])
  const none = facts({ git: { hasGit: true, host: 'local', hostReason: 'the repo has no `origin` remote' } })
  expect(gapQuestions(none)).toEqual([])
})

test('questionnaire: QA defaults on only with a runnable UI (D34)', () => {
  const qaOf = (hasUi: boolean) => questionsFor(facts({ hasUi, uiReason: 'React app' }), 'full').find(question => question.key === 'qa')
  expect(qaOf(true)?.choices[0]).toEqual({ label: 'On (default)', value: true })
  expect(qaOf(false)?.choices[0]).toEqual({ label: 'Off (default)', value: false })
})

test('questionnaire: a personal setup asks only the personal questions (D61)', () => {
  expect(questionsFor(facts({ commands: {} }), 'personal').map(question => question.key)).toEqual(['permissions', 'attribution', 'indicator'])
})

test('questionnaire: answers by label, by value, and typed under Other', () => {
  const [, , tracker] = questionsFor(facts(), 'full')
  if (tracker === undefined) throw new Error('no tracker question')
  expect(resolveAnswer(tracker, 'None (markdown)').values).toEqual({ tracker: 'none' })
  expect(resolveAnswer(tracker, 'jira').values).toEqual({ tracker: 'jira' })
  expect(resolveAnswer(tracker, 'no tracker').values).toEqual({ tracker: 'none' })
  expect(resolveAnswer(tracker, 'Linear').values).toEqual({ tracker: 'other', trackerName: 'Linear' })
  const [permissions] = questionsFor(facts(), 'full')
  if (permissions === undefined) throw new Error('no permissions question')
  const unclear = resolveAnswer(permissions, 'whatever')
  expect(unclear.values).toEqual({ permissions: 'full-freedom' })
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
  /** The person's answer per chip; absent, the first option; `null` dismisses it. */
  answers: Record<string, string | null>
  /** Edits that got past the plugin. */
  edited: string[]
  spawned: AgentSpawnInput[]
  contexts: (readonly string[] | undefined)[]
}

const godmode = ($: Engine, args = '') => $.command.run({ command: 'godmode', args } as Parameters<typeof $.command.run>[0])

/** Mounts the world and the person beneath the plugin; registers every hook before the first `$` call. */
const mount = (on: On, world: World, answers: Setup['answers'] = {}, beneath?: (on: On) => void): Setup => {
  const setup: Setup = { world, asked: [], answers, edited: [], spawned: [], contexts: [] }
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
      const answer = setup.answers[header]
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
  const setup = mount(on, webApp(), { Permissions: 'Free', Indicator: 'Band' })

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
  expect(setup.asked).toEqual(['Permissions', 'Storage', 'Tracker', 'Attribution', 'QA', 'Indicator'])
  expect(answers).toContain('- qa: true')

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
    qa: true,
  })
  expect(personalNote(setup.world).answers).toEqual({ permissions: 'free', attribution: false, indicator: 'band' })
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
      given: { tracker: 'no tracker', storage: 'outside' },
    }),
  )
  expect(setup.asked).toEqual(['Tests', 'e2eCommand', 'Permissions', 'Attribution', 'QA', 'Indicator'])
  expect(answers).toContain('- testCommand: "pytest -q"')
  expect(answers).toContain('- tracker: "none"')
  expect(answers).toContain('- e2eCommand: "None"')
})

test('setup that cannot ask stops, saying which questions are left for the PM to relay', async ($, on) => {
  const setup = mount(on, webApp(), { Storage: null })
  await godmode($)

  const stopped = await tool($, 'setup_questionnaire')

  expect(stopped.deny).toContain('could not ask the person')
  expect(stopped.deny).toContain('- storage:')
  expect(stopped.deny).toContain('- indicator:')
  expect(stopped.deny).not.toContain('- permissions:')
  expect(setup.asked).toEqual(['Permissions', 'Storage'])
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
  const setup = mount(on, webApp(), { Storage: 'Outside the repo', Permissions: 'Free' })
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

test('a teammate\'s personal setup asks three questions and writes only the personal half (D61)', async ($, on) => {
  const world = webApp()
  world.files.set(`${REPO}/AGENTS.md`, '# Rules\n')
  const team = mount(on, world, { Permissions: 'Locked', Indicator: 'Hint tag' })
  const shared = JSON.stringify({ godmodeVersion: '0.5.0', storage: 'committed', writtenAt: 'x', answers: { tracker: 'none' }, minimumModels: {}, conventions: [] })
  world.files.set(`${REPO}/.godmode/shared.json`, shared)

  const started = await godmode($)
  expect(started.context?.[0]).toContain('Scope: personal')
  await tool($, 'setup_questionnaire')
  expect((await tool($, 'setup_write_preset')).deny).toContain('personal setup')
  resultOf(await tool($, 'setup_finish'))

  expect(team.asked).toEqual(['Permissions', 'Attribution', 'Indicator'])
  expect(world.files.get(`${REPO}/.godmode/shared.json`)).toBe(shared)
  expect(personalNote(world).answers).toEqual({ permissions: 'locked', attribution: false, indicator: 'hint' })
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
