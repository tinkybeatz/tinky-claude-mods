import type { EngineInterface } from 'claude-code'

import type { ScanFacts, ScannedCommands, ScannedGit, ScannedStack, StackId } from '../types'
import { chooseHost, remoteHostOf } from './host'
import type { Project } from './storage'

/*
 * The setup scan (D29): what the project's own files say, read by code because it is
 * cheap and certain (file names, `package.json` scripts, `Cargo.toml`, `go.mod`, git).
 * Anything that needs judgement (whether the conventions are solid, which of two test
 * commands is the real one) is left to the setup agent.
 */

/**
 * The files at the root whose text the scan reads. A project's other files are never
 * read: the scan stays a handful of small reads whatever the repo's size.
 */
export const MARKER_FILES: readonly string[] = [
  'package.json',
  'deno.json',
  'deno.jsonc',
  'pyproject.toml',
  'requirements.txt',
  'setup.py',
  'setup.cfg',
  'Pipfile',
  'Cargo.toml',
  'go.mod',
  'Gemfile',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'composer.json',
  'mix.exs',
  'pubspec.yaml',
  'Makefile',
]

/** Files below the root that change a stack's commands when they exist. */
export const NESTED_MARKERS: readonly string[] = ['src/main.rs', 'config/application.rb', 'bin/rails']

/** Single conventions files, by path from the root. */
export const CONVENTIONS_FILES: readonly string[] = [
  'AGENTS.md',
  'CLAUDE.md',
  'CLAUDE.local.md',
  '.claude/CLAUDE.md',
  'CONTRIBUTING.md',
  'docs/CONTRIBUTING.md',
  '.github/CONTRIBUTING.md',
  '.cursorrules',
  '.windsurfrules',
  '.github/copilot-instructions.md',
  '.github/pull_request_template.md',
  '.github/PULL_REQUEST_TEMPLATE.md',
  'STYLEGUIDE.md',
  'CODING_STANDARDS.md',
]

/** Folders whose markdown files are conventions: rules, standards, decision records. */
export const CONVENTIONS_FOLDERS: readonly string[] = [
  '.claude/rules',
  '.cursor/rules',
  '.godmode/conventions',
  'docs/adr',
  'docs/adrs',
  'docs/decisions',
  'docs/architecture/decisions',
  'doc/adr',
  'adr',
  'docs/standards',
  'docs/stds',
  'docs/conventions',
  'standards',
]

/** What the scan read: the root's entry names, the markers that exist, and their texts. */
export type Snapshot = {
  root: string
  /** Every entry directly in the root, files and folders. */
  names: ReadonlySet<string>
  /** Marker texts by path from the root; absent when the file is not there. */
  texts: Readonly<Record<string, string>>
  /** Nested markers that exist. */
  nested: ReadonlySet<string>
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const jsonOf = (text: string | undefined): Record<string, unknown> | undefined => {
  if (text === undefined) return undefined
  try {
    const value: unknown = JSON.parse(text)
    return isRecord(value) ? value : undefined
  } catch {
    return undefined
  }
}

const stringsOf = (value: unknown): Record<string, string> =>
  isRecord(value) ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) : {}

/** The default `npm init` test script, which runs no test. */
const isPlaceholderTest = (script: string) => /no test specified/i.test(script)

/** A word in a manifest's text, as a whole name: `react` but not `react-icons`. */
const mentions = (text: string | undefined, name: string) =>
  text !== undefined && new RegExp(`(^|[^A-Za-z0-9_@/-])${name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}($|[^A-Za-z0-9_-])`, 'mi').test(text)

/** The command answers' keys, as the note records them: `testCommand`, `startCommand`, ... */
export const commandKey = (key: string) => `${key}Command`

/** Every command the scan looks for. */
export const COMMAND_KEYS: readonly (keyof ScannedCommands)[] = ['install', 'build', 'test', 'start', 'lint', 'format', 'typecheck']

type Found = { stack: ScannedStack; commands: ScannedCommands; sources: Partial<Record<keyof ScannedCommands, string>>; ui?: string }

const NODE_UI = ['next', 'nuxt', '@sveltejs/kit', 'svelte', '@angular/core', 'vue', 'react-dom', 'react-native', 'expo', 'solid-js', 'preact', 'astro', '@remix-run/react', 'electron', 'vite', 'react']

const node = (snapshot: Snapshot): Found | undefined => {
  const manifest = jsonOf(snapshot.texts['package.json'])
  if (manifest === undefined) return undefined
  const { names } = snapshot
  const declared = typeof manifest.packageManager === 'string' ? manifest.packageManager.split('@')[0] : undefined
  const packageManager =
    declared ??
    (names.has('pnpm-lock.yaml') ? 'pnpm' : names.has('yarn.lock') ? 'yarn' : names.has('bun.lockb') || names.has('bun.lock') ? 'bun' : 'npm')
  const scripts = stringsOf(manifest.scripts)
  const dependencies = { ...stringsOf(manifest.dependencies), ...stringsOf(manifest.devDependencies) }
  const run = (script: string) => {
    if (packageManager === 'npm') return script === 'test' || script === 'start' ? `npm ${script}` : `npm run ${script}`
    if (packageManager === 'bun') return `bun run ${script}`
    return `${packageManager} ${script}`
  }
  const commands: ScannedCommands = {}
  const sources: Found['sources'] = {}
  const take = (key: keyof ScannedCommands, script: string) => {
    if (commands[key] !== undefined || scripts[script] === undefined) return
    if (key === 'test' && isPlaceholderTest(scripts[script] ?? '')) return
    commands[key] = run(script)
    sources[key] = `package.json scripts.${script}`
  }
  take('build', 'build')
  take('test', 'test')
  take('start', 'dev')
  take('start', 'start')
  take('lint', 'lint')
  take('format', 'format:check')
  take('format', 'format')
  take('typecheck', 'typecheck')
  take('typecheck', 'type-check')
  commands.install = `${packageManager} install`
  sources.install = 'package.json'
  const framework = NODE_UI.find(name => name in dependencies)
  const isTypeScript = names.has('tsconfig.json') || 'typescript' in dependencies
  return {
    stack: { id: 'node', language: isTypeScript ? 'TypeScript' : 'JavaScript', marker: 'package.json', packageManager, framework },
    commands,
    sources,
    ui: framework !== undefined && commands.start !== undefined ? `${framework} app with a ${sources.start ?? 'start'} script` : undefined,
  }
}

const deno = (snapshot: Snapshot): Found | undefined => {
  const marker = snapshot.texts['deno.json'] !== undefined ? 'deno.json' : snapshot.texts['deno.jsonc'] !== undefined ? 'deno.jsonc' : undefined
  if (marker === undefined) return undefined
  const tasks = stringsOf(jsonOf(snapshot.texts[marker])?.tasks)
  const start = tasks.dev !== undefined ? 'deno task dev' : tasks.start !== undefined ? 'deno task start' : undefined
  return {
    stack: { id: 'deno', language: 'TypeScript', marker },
    commands: { test: 'deno test', lint: 'deno lint', ...(start === undefined ? {} : { start }) },
    sources: { test: marker, lint: marker, ...(start === undefined ? {} : { start: `${marker} tasks` }) },
  }
}

const PYTHON_MARKERS = ['pyproject.toml', 'requirements.txt', 'setup.py', 'setup.cfg', 'Pipfile']

const python = (snapshot: Snapshot): Found | undefined => {
  const marker = PYTHON_MARKERS.find(name => snapshot.texts[name] !== undefined)
  if (marker === undefined) return undefined
  const { names } = snapshot
  const text = PYTHON_MARKERS.map(name => snapshot.texts[name] ?? '').join('\n')
  const runner = names.has('uv.lock') ? 'uv run ' : names.has('poetry.lock') ? 'poetry run ' : names.has('Pipfile') ? 'pipenv run ' : ''
  const packageManager = runner === '' ? 'pip' : runner.trim().split(' ')[0]
  const commands: ScannedCommands = {}
  const sources: Found['sources'] = {}
  if (mentions(text, 'pytest') || names.has('pytest.ini') || names.has('conftest.py')) {
    commands.test = `${runner}pytest`
    sources.test = `pytest in ${marker}`
  } else if (names.has('tests') || names.has('test')) {
    commands.test = `${runner}python -m unittest`
    sources.test = 'a tests folder and no pytest'
  }
  if (mentions(text, 'ruff')) {
    commands.lint = `${runner}ruff check .`
    commands.format = `${runner}ruff format --check .`
    sources.lint = `ruff in ${marker}`
    sources.format = `ruff in ${marker}`
  }
  if (mentions(text, 'mypy')) {
    commands.typecheck = `${runner}mypy .`
    sources.typecheck = `mypy in ${marker}`
  }
  const install =
    runner === 'uv run ' ? 'uv sync' : runner === 'poetry run ' ? 'poetry install' : runner === 'pipenv run ' ? 'pipenv install' : snapshot.texts['requirements.txt'] !== undefined ? 'pip install -r requirements.txt' : undefined
  if (install !== undefined) {
    commands.install = install
    sources.install = marker
  }
  let framework: string | undefined
  let ui: string | undefined
  if (names.has('manage.py')) {
    framework = 'django'
    commands.start = `${runner}python manage.py runserver`
    sources.start = 'manage.py'
    ui = 'Django app (manage.py)'
  } else if (mentions(text, 'flask')) {
    framework = 'flask'
    commands.start = `${runner}flask run`
    sources.start = `flask in ${marker}`
    ui = 'Flask app'
  } else {
    framework = ['streamlit', 'gradio', 'dash', 'fastapi'].find(name => mentions(text, name))
    if (framework !== undefined && framework !== 'fastapi') ui = `${framework} app`
  }
  return { stack: { id: 'python', language: 'Python', marker, packageManager, framework }, commands, sources, ui }
}

const RUST_UI = ['tauri', 'leptos', 'yew', 'dioxus', 'eframe', 'iced', 'slint']

const rust = (snapshot: Snapshot): Found | undefined => {
  const text = snapshot.texts['Cargo.toml']
  if (text === undefined) return undefined
  const hasBinary = snapshot.nested.has('src/main.rs') || /^\[\[bin\]\]/m.test(text)
  const framework = RUST_UI.find(name => mentions(text, name))
  return {
    stack: { id: 'rust', language: 'Rust', marker: 'Cargo.toml', packageManager: 'cargo', framework },
    commands: { build: 'cargo build', test: 'cargo test', lint: 'cargo clippy', format: 'cargo fmt --check', ...(hasBinary ? { start: 'cargo run' } : {}) },
    sources: { build: 'Cargo.toml', test: 'Cargo.toml', lint: 'Cargo.toml', format: 'Cargo.toml', ...(hasBinary ? { start: 'src/main.rs' } : {}) },
    ui: framework !== undefined && hasBinary ? `${framework} app` : undefined,
  }
}

const go = (snapshot: Snapshot): Found | undefined => {
  if (snapshot.texts['go.mod'] === undefined) return undefined
  const hasMain = snapshot.names.has('main.go')
  return {
    stack: { id: 'go', language: 'Go', marker: 'go.mod', packageManager: 'go' },
    commands: { install: 'go mod download', build: 'go build ./...', test: 'go test ./...', lint: 'go vet ./...', format: 'gofmt -l .', ...(hasMain ? { start: 'go run .' } : {}) },
    sources: { install: 'go.mod', build: 'go.mod', test: 'go.mod', lint: 'go.mod', format: 'go.mod', ...(hasMain ? { start: 'main.go' } : {}) },
  }
}

const ruby = (snapshot: Snapshot): Found | undefined => {
  const text = snapshot.texts.Gemfile
  if (text === undefined) return undefined
  const isRails = snapshot.nested.has('config/application.rb') || mentions(text, 'rails')
  const commands: ScannedCommands = { install: 'bundle install' }
  const sources: Found['sources'] = { install: 'Gemfile' }
  if (snapshot.names.has('spec') || mentions(text, 'rspec')) {
    commands.test = 'bundle exec rspec'
    sources.test = 'rspec'
  } else {
    commands.test = isRails ? 'bin/rails test' : 'bundle exec rake test'
    sources.test = 'Gemfile'
  }
  if (mentions(text, 'rubocop')) {
    commands.lint = 'bundle exec rubocop'
    sources.lint = 'rubocop in Gemfile'
  }
  if (isRails) {
    commands.start = 'bin/rails server'
    sources.start = 'Rails'
  }
  return {
    stack: { id: 'ruby', language: 'Ruby', marker: 'Gemfile', packageManager: 'bundler', framework: isRails ? 'rails' : undefined },
    commands,
    sources,
    ui: isRails ? 'Rails app' : undefined,
  }
}

const java = (snapshot: Snapshot): Found | undefined => {
  const pom = snapshot.texts['pom.xml']
  const gradleMarker = snapshot.texts['build.gradle.kts'] !== undefined ? 'build.gradle.kts' : snapshot.texts['build.gradle'] !== undefined ? 'build.gradle' : undefined
  if (pom === undefined && gradleMarker === undefined) return undefined
  if (pom !== undefined) {
    const isBoot = mentions(pom, 'spring-boot-starter-web') || mentions(pom, 'spring-boot-starter-webflux')
    return {
      stack: { id: 'java', language: mentions(pom, 'kotlin-maven-plugin') ? 'Kotlin' : 'Java', marker: 'pom.xml', packageManager: 'maven', framework: isBoot ? 'spring-boot' : undefined },
      commands: { build: 'mvn package', test: 'mvn test', ...(isBoot ? { start: 'mvn spring-boot:run' } : {}) },
      sources: { build: 'pom.xml', test: 'pom.xml', ...(isBoot ? { start: 'spring-boot in pom.xml' } : {}) },
    }
  }
  const text = snapshot.texts[gradleMarker ?? ''] ?? ''
  const gradle = snapshot.names.has('gradlew') ? './gradlew' : 'gradle'
  const isAndroid = mentions(text, 'com.android.application')
  return {
    stack: {
      id: 'java',
      language: gradleMarker === 'build.gradle.kts' || mentions(text, 'kotlin') ? 'Kotlin' : 'Java',
      marker: gradleMarker ?? 'build.gradle',
      packageManager: 'gradle',
      framework: isAndroid ? 'android' : undefined,
    },
    commands: { build: `${gradle} build`, test: `${gradle} test` },
    sources: { build: gradleMarker, test: gradleMarker },
    ui: isAndroid ? 'Android app' : undefined,
  }
}

const php = (snapshot: Snapshot): Found | undefined => {
  const manifest = jsonOf(snapshot.texts['composer.json'])
  if (manifest === undefined) return undefined
  const text = snapshot.texts['composer.json'] ?? ''
  const scripts = stringsOf(manifest.scripts)
  const isLaravel = snapshot.names.has('artisan')
  const test = scripts.test !== undefined ? 'composer test' : mentions(text, 'phpunit/phpunit') ? 'vendor/bin/phpunit' : undefined
  return {
    stack: { id: 'php', language: 'PHP', marker: 'composer.json', packageManager: 'composer', framework: isLaravel ? 'laravel' : undefined },
    commands: { ...(test === undefined ? {} : { test }), ...(isLaravel ? { start: 'php artisan serve' } : {}) },
    sources: { ...(test === undefined ? {} : { test: 'composer.json' }), ...(isLaravel ? { start: 'artisan' } : {}) },
    ui: isLaravel ? 'Laravel app' : undefined,
  }
}

const elixir = (snapshot: Snapshot): Found | undefined => {
  const text = snapshot.texts['mix.exs']
  if (text === undefined) return undefined
  const isPhoenix = mentions(text, ':phoenix')
  return {
    stack: { id: 'elixir', language: 'Elixir', marker: 'mix.exs', packageManager: 'mix', framework: isPhoenix ? 'phoenix' : undefined },
    commands: { build: 'mix compile', test: 'mix test', ...(isPhoenix ? { start: 'mix phx.server' } : {}) },
    sources: { build: 'mix.exs', test: 'mix.exs', ...(isPhoenix ? { start: 'phoenix in mix.exs' } : {}) },
    ui: isPhoenix ? 'Phoenix app' : undefined,
  }
}

const dotnet = (snapshot: Snapshot): Found | undefined => {
  const marker = [...snapshot.names].sort().find(name => /\.(sln|csproj|fsproj|vbproj)$/i.test(name))
  if (marker === undefined) return undefined
  return {
    stack: { id: 'dotnet', language: /\.fsproj$/i.test(marker) ? 'F#' : 'C#', marker, packageManager: 'dotnet' },
    commands: { build: 'dotnet build', test: 'dotnet test' },
    sources: { build: marker, test: marker },
  }
}

const dart = (snapshot: Snapshot): Found | undefined => {
  const text = snapshot.texts['pubspec.yaml']
  if (text === undefined) return undefined
  const isFlutter = /^\s*flutter:/m.test(text)
  return {
    stack: { id: 'dart', language: 'Dart', marker: 'pubspec.yaml', packageManager: isFlutter ? 'flutter' : 'dart', framework: isFlutter ? 'flutter' : undefined },
    commands: isFlutter ? { test: 'flutter test', start: 'flutter run', lint: 'flutter analyze' } : { test: 'dart test', lint: 'dart analyze' },
    sources: isFlutter ? { test: 'pubspec.yaml', start: 'pubspec.yaml', lint: 'pubspec.yaml' } : { test: 'pubspec.yaml', lint: 'pubspec.yaml' },
    ui: isFlutter ? 'Flutter app' : undefined,
  }
}

/** Each stack's reader, in the order a project with several is described. */
const READERS: readonly ((snapshot: Snapshot) => Found | undefined)[] = [node, deno, python, rust, go, ruby, java, php, elixir, dotnet, dart]

/** `make <target>` for the targets a Makefile declares. */
const makeTargets = (text: string | undefined) => new Set([...(text ?? '').matchAll(/^([A-Za-z][A-Za-z0-9_-]*)\s*:(?!=)/gm)].map(match => match[1] ?? ''))

/** The stacks, commands and runnable UI a snapshot shows. */
export const analyse = (snapshot: Snapshot): Pick<ScanFacts, 'stacks' | 'commands' | 'commandSources' | 'hasUi' | 'uiReason'> => {
  const found = READERS.flatMap(reader => {
    const result = reader(snapshot)
    return result === undefined ? [] : [result]
  })
  const commands: ScannedCommands = {}
  const commandSources: ScanFacts['commandSources'] = {}
  // The first stack's commands win: it is the project's main one in the order above.
  for (const { commands: own, sources } of found) {
    for (const key of COMMAND_KEYS) {
      if (commands[key] === undefined && own[key] !== undefined) {
        commands[key] = own[key]
        commandSources[key] = sources[key]
      }
    }
  }
  // A Makefile fills what no manifest said.
  const targets = makeTargets(snapshot.texts.Makefile)
  const fromMake: [keyof ScannedCommands, string[]][] = [
    ['build', ['build']],
    ['test', ['test', 'check']],
    ['start', ['run', 'dev', 'start', 'serve']],
    ['lint', ['lint']],
  ]
  for (const [key, names] of fromMake) {
    const target = names.find(name => targets.has(name))
    if (commands[key] === undefined && target !== undefined) {
      commands[key] = `make ${target}`
      commandSources[key] = `Makefile target ${target}`
    }
  }
  const ui = found.find(entry => entry.ui !== undefined)?.ui
  return { stacks: found.map(entry => entry.stack), commands, commandSources, hasUi: ui !== undefined, uiReason: ui }
}

/** The preset folder names that could hold a stack's coding notes, most specific first. */
export const presetNamesFor = (stack: ScannedStack): string[] => {
  const language = stack.language.toLowerCase().replace('#', 'sharp')
  const byStack: Record<StackId, string[]> = {
    node: [language, stack.framework ?? '', 'node', 'javascript', 'typescript', 'js', 'ts'],
    deno: ['deno', 'typescript', 'ts'],
    python: [stack.framework ?? '', 'python', 'py'],
    rust: ['rust'],
    go: ['go', 'golang'],
    ruby: [stack.framework ?? '', 'ruby'],
    java: [stack.framework ?? '', language, 'java', 'jvm', 'kotlin'],
    php: [stack.framework ?? '', 'php'],
    elixir: [stack.framework ?? '', 'elixir'],
    dotnet: [language, 'dotnet', 'csharp'],
    dart: [stack.framework ?? '', 'dart', 'flutter'],
  }
  return [...new Set(byStack[stack.id].filter(name => name !== ''))]
}

/** The folders that hold no stack's notes but anyone's: tried when no stack matched. */
export const GENERIC_PRESETS: readonly string[] = ['generic', 'base', 'default', 'any']

/**
 * The preset folders for the scanned stacks, one per stack that has one, in the stacks'
 * order (a project with several languages gets each one's notes); a generic folder when
 * none matched.
 */
export const presetFoldersFor = (stacks: readonly ScannedStack[], available: readonly string[]) => {
  const have = new Map(available.map(name => [name.toLowerCase(), name]))
  const folders: string[] = []
  for (const stack of stacks) {
    const folder = presetNamesFor(stack).map(name => have.get(name)).find(name => name !== undefined)
    if (folder !== undefined && !folders.includes(folder)) folders.push(folder)
  }
  if (folders.length > 0) return folders
  const generic = GENERIC_PRESETS.map(name => have.get(name)).find(name => name !== undefined)
  return generic === undefined ? [] : [generic]
}

const baseNameOf = (path: string) => path.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) ?? 'project'

/*
 * Helpers that take `$` are function declarations: the engine follows `$` past an import
 * only into those.
 */

/** Reads what `analyse` needs from the project's root. */
async function snapshotOf($: EngineInterface, root: string): Promise<Snapshot> {
  const entries = await $.fs.list(root).catch(() => [])
  const names = new Set(entries.map(entry => entry.name))
  const texts: Record<string, string> = {}
  for (const name of MARKER_FILES) {
    if (!names.has(name)) continue
    const text = await $.fs.read(`${root}/${name}`).catch(() => undefined)
    if (text !== undefined) texts[name] = text
  }
  const nested = new Set<string>()
  for (const path of NESTED_MARKERS) if (await $.fs.exists(`${root}/${path}`).catch(() => false)) nested.add(path)
  return { root, names, texts, nested }
}

/** The existing conventions files, relative to the root (D3, D30). */
async function conventionsOf($: EngineInterface, root: string) {
  const found: string[] = []
  for (const path of CONVENTIONS_FILES) if (await $.fs.exists(`${root}/${path}`).catch(() => false)) found.push(path)
  for (const folder of CONVENTIONS_FOLDERS) {
    const entries = await $.fs.list(`${root}/${folder}`).catch(() => [])
    for (const entry of entries) {
      if (entry.kind === 'file' && /\.(md|mdc|txt)$/i.test(entry.name)) found.push(`${folder}/${entry.name}`)
    }
  }
  return found
}

/** The git side: origin, where PRs would go with no answer, and the base branch (D54, D55). */
async function gitOf($: EngineInterface, project: Project): Promise<ScannedGit> {
  if (!project.hasGit) return { hasGit: false, host: 'local', hostReason: 'the folder has no git' }
  const git = async (args: string[]) => {
    const result = await $.process.run(['git', ...args], { cwd: project.root }).catch(() => undefined)
    return result?.exitCode === 0 ? result.stdout.trim() : undefined
  }
  const origin = (await git(['remote', 'get-url', 'origin'])) || undefined
  const choice = await chooseHost($, project).catch((error: unknown) => ({ kind: 'local' as const, reason: error instanceof Error ? error.message : String(error) }))
  const fromOrigin = (await git(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']))?.replace(/^origin\//, '')
  const baseBranch = fromOrigin || (await git(['symbolic-ref', '--quiet', '--short', 'HEAD'])) || undefined
  return {
    hasGit: true,
    origin,
    remoteHost: origin === undefined ? undefined : remoteHostOf(origin),
    host: choice.kind,
    hostReason: choice.reason,
    baseBranch,
  }
}

/** The whole scan (D29). */
export async function scanProject($: EngineInterface, project: Project): Promise<ScanFacts> {
  const snapshot = await snapshotOf($, project.root)
  return {
    root: project.root,
    name: baseNameOf(project.root),
    ...analyse(snapshot),
    git: await gitOf($, project),
    conventions: await conventionsOf($, project.root),
  }
}
