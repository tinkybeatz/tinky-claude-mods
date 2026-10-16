import { mock } from 'claude-code/testing'
import type { EngineInterface, On } from 'claude-code'

import { writeNote } from '../hooks/storage'
import type { NoteDraft } from '../hooks/storage'

/**
 * A pretend disk and git repo, in memory. `mountWorld` answers the plugin's `$.fs`,
 * `$.process.run`, `$.env` and `$.session.root` calls from it beneath the plugin;
 * `worldEngine` hands the storage helpers a `$` over the same world, since a test's own
 * `$` has no `fs` or `process` noun.
 */
export type World = {
  files: Map<string, string>
  /** Where the session started. */
  sessionRoot: string
  /** The main working tree and its first commit; absent for a folder with no git. */
  git?: { root: string; firstCommit?: string }
  env: Record<string, string>
  /** The version `plugin.json` answers with. */
  pluginVersion: string
  /** Every git command run, joined with spaces. */
  gitRuns: string[]
}

export const HOME = '/home/dev'
export const REPO = '/work/app'
export const FIRST_COMMIT = '3f2a9c1e5b7d4a6f8e0c2b4d6f8a0c2e4b6d8f0a'

export const makeWorld = (overrides: Partial<World> = {}): World => ({
  files: new Map(),
  sessionRoot: REPO,
  git: { root: REPO, firstCommit: FIRST_COMMIT },
  env: { HOME },
  pluginVersion: '0.2.0',
  gitRuns: [],
  ...overrides,
})

const isManifest = (path: string) => path.endsWith('/.claude-plugin/plugin.json')

const read = (world: World, path: string) => {
  if (isManifest(path)) return JSON.stringify({ name: 'godmode', version: world.pluginVersion })
  const text = world.files.get(path)
  if (text === undefined) throw new Error(`ENOENT: ${path}`)
  return text
}

const exists = (world: World, path: string) =>
  world.files.has(path) || [...world.files.keys()].some(file => file.startsWith(`${path}/`))

const run = (world: World, argv: readonly string[]) => {
  const answer = (exitCode: number, stdout: string) => ({
    exitCode,
    stdout,
    stderr: exitCode === 0 ? '' : 'fatal: not a git repository',
    isStdoutTruncated: false,
    isStderrTruncated: false,
  })
  world.gitRuns.push(argv.join(' '))
  if (argv[0] !== 'git' || world.git === undefined) return answer(128, '')
  const args = argv.slice(1).join(' ')
  if (args === 'worktree list --porcelain') {
    return answer(0, `worktree ${world.git.root}\nHEAD ${world.git.firstCommit ?? '0'.repeat(40)}\nbranch refs/heads/main\n\n`)
  }
  if (args === 'rev-parse --path-format=absolute --git-common-dir') return answer(0, `${world.git.root}/.git\n`)
  if (args === 'rev-list --max-parents=0 HEAD') {
    return world.git.firstCommit === undefined ? answer(128, '') : answer(0, `${world.git.firstCommit}\n`)
  }
  return answer(1, '')
}

/** Answers the plugin's calls from `world`, beneath the plugin. */
export const mountWorld = (on: On, world: World) => {
  on('fs.read', (_$, e) => {
    try {
      return { value: read(world, e.path) }
    } catch (error) {
      return { deny: (error as Error).message } as never
    }
  })
  on('fs.exists', (_$, e) => ({ value: exists(world, e.path) }))
  on('fs.write', (_$, e) => {
    world.files.set(e.path, e.text)
    return { value: undefined } as never
  })
  on('process.run', (_$, e) => ({ value: run(world, e.argv) }))
  on('session.root', () => ({ value: world.sessionRoot }))
  mock.env(on, world.env)
}

/** A `$` over `world` for calling the storage helpers directly. */
export const worldEngine = (world: World) =>
  ({
    plugin: { name: 'godmode', root: '/plugins/godmode' },
    fs: {
      read: async (path: string) => read(world, path),
      write: async (path: string, text: string) => void world.files.set(path, text),
      exists: async (path: string) => exists(world, path),
    },
    process: { run: async (argv: readonly string[]) => run(world, argv) },
    env: { get: async (name: string) => world.env[name] },
    session: { root: async () => world.sessionRoot },
    clock: { now: async () => Date.UTC(2026, 9, 16, 9, 30) },
  }) as unknown as EngineInterface

export const draft = (overrides: Partial<NoteDraft> = {}): NoteDraft => ({
  storage: 'committed',
  sharedAnswers: { tracker: 'none', qa: true },
  minimumModels: { reviewer: 'opus' },
  conventions: ['AGENTS.md'],
  personalAnswers: { permissions: 'free', attribution: false },
  models: { dev: 'sonnet' },
  ...overrides,
})

/**
 * Sets a project up the way Step 3's setup will: a conventions file on disk and a note
 * written by `version` in `draft`'s storage.
 */
export const setUpProject = async (world: World, overrides: Partial<NoteDraft> = {}, version = world.pluginVersion) => {
  if (!world.files.has(`${REPO}/AGENTS.md`)) world.files.set(`${REPO}/AGENTS.md`, '# Agent rules\n')
  const current = world.pluginVersion
  world.pluginVersion = version
  const dir = await writeNote(worldEngine(world), draft(overrides))
  world.pluginVersion = current
  return dir
}
