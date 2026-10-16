import { mock } from 'claude-code/testing'
import type { EngineInterface, On } from 'claude-code'

import { writeNote } from '../hooks/storage'
import type { NoteDraft } from '../hooks/storage'

/** What a command answers in the world. */
export type RunAnswer = { exitCode: number; stdout: string; stderr?: string }

/** One command the plugin ran: its argv, folder and standard input. */
export type Run = { argv: string[]; cwd?: string; stdin?: string }

/** An open PR on the pretend GitHub. */
export type GhPr = { number: number; title: string; branch: string; author: string; files: string[]; head: string; isDraft?: boolean }

/** A pretend GitHub: `origin` points there, `gh` is signed in as `login`, and these PRs are open. */
export type Gh = { login: string; prs: GhPr[] }

/**
 * A pretend disk and git repo, in memory. `mountWorld` answers the plugin's `$.fs`,
 * `$.process.run`, `$.env`, `$.clock`, `$.tool.register` and `$.session.root` calls from
 * it beneath the plugin; `worldEngine` hands the helpers a `$` over the same world, since
 * a test's own `$` has no `fs` or `process` noun.
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
  /** Every command run, joined with spaces. */
  gitRuns: string[]
  /** Every command run, with its folder and standard input. */
  runs: Run[]
  /** Answers a command before the world's own git does; undefined passes it on. */
  answer?: (run: Run) => RunAnswer | undefined
  /** The tools the plugin declared, by short name. */
  tools: string[]
  /** GitHub, when the repo's `origin` is there; absent, the project has no PR host. */
  gh?: Gh
  /** Local branches, which `git worktree add -b` adds to. */
  branches: string[]
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
  runs: [],
  tools: [],
  branches: ['main'],
  ...overrides,
})

/** What the world's clock reads: 2026-10-16 09:30 UTC. */
export const NOW = Date.UTC(2026, 9, 16, 9, 30)

const isManifest = (path: string) => path.endsWith('/.claude-plugin/plugin.json')

const read = (world: World, path: string) => {
  if (isManifest(path)) return JSON.stringify({ name: 'godmode', version: world.pluginVersion })
  const text = world.files.get(path)
  if (text === undefined) throw new Error(`ENOENT: ${path}`)
  return text
}

const exists = (world: World, path: string) =>
  world.files.has(path) || [...world.files.keys()].some(file => file.startsWith(`${path}/`))

/** The files and folders directly in `path`, as `$.fs.list` answers them. */
const list = (world: World, path: string) => {
  const prefix = `${path.replace(/\/+$/, '')}/`
  const names = new Map<string, 'file' | 'dir'>()
  for (const file of world.files.keys()) {
    if (!file.startsWith(prefix)) continue
    const [name = '', ...rest] = file.slice(prefix.length).split('/')
    names.set(name, rest.length === 0 ? 'file' : 'dir')
  }
  if (names.size === 0 && !exists(world, path)) throw new Error(`ENOENT: ${path}`)
  return [...names].map(([name, kind]) => ({ name, kind, size: 0, mtimeMs: 0, isLink: false }))
}

/** `mv` and `mkdir -p` on the world's files: what the markdown tickets need. */
const shell = (world: World, argv: readonly string[]): RunAnswer | undefined => {
  if (argv[0] === 'mkdir') return { exitCode: 0, stdout: '' }
  if (argv[0] !== 'mv') return undefined
  const [from = '', to = ''] = argv.slice(1)
  const text = world.files.get(from)
  if (text === undefined) return { exitCode: 1, stdout: '', stderr: `mv: ${from}: No such file or directory` }
  world.files.delete(from)
  world.files.set(to, text)
  return { exitCode: 0, stdout: '' }
}

/** What `gh pr list --json ...` prints for the world's open PRs. */
const ghList = (gh: Gh) =>
  JSON.stringify(
    gh.prs.map(pr => ({
      number: pr.number,
      url: `https://github.com/acme/app/pull/${pr.number}`,
      title: pr.title,
      headRefName: pr.branch,
      baseRefName: 'main',
      author: { login: pr.author },
      isDraft: pr.isDraft ?? true,
      files: pr.files.map(path => ({ path, additions: 1, deletions: 0 })),
      headRefOid: pr.head,
    })),
  )

/** `gh`, and the git calls of a GitHub-hosted repo with ticket worktrees. */
const github = (world: World, argv: readonly string[]): RunAnswer | undefined => {
  const command = argv.join(' ')
  const gh = world.gh
  if (command === 'git remote get-url origin') {
    return gh === undefined ? { exitCode: 2, stdout: '', stderr: 'error: No such remote' } : { exitCode: 0, stdout: 'git@github.com:acme/app.git\n' }
  }
  if (argv[0] === 'gh') {
    if (gh === undefined) return { exitCode: 1, stdout: '', stderr: 'not signed in' }
    if (argv[1] === 'auth') return { exitCode: 0, stdout: '' }
    if (argv[1] === 'api' && argv[2] === 'user') return { exitCode: 0, stdout: `${gh.login}\n` }
    if (argv[1] === 'pr' && argv[2] === 'list') return { exitCode: 0, stdout: ghList(gh) }
    if (argv[1] === 'pr' && argv[2] === 'view') {
      const pr = gh.prs.find(candidate => String(candidate.number) === argv[3])
      return pr === undefined
        ? { exitCode: 1, stdout: '', stderr: `no pull requests found for ${argv[3]}` }
        : { exitCode: 0, stdout: JSON.stringify({ headRefOid: pr.head }) }
    }
    return undefined
  }
  if (command === 'git symbolic-ref --quiet --short refs/remotes/origin/HEAD') {
    return gh === undefined ? { exitCode: 1, stdout: '' } : { exitCode: 0, stdout: 'origin/main\n' }
  }
  const verify = /^git rev-parse --verify --quiet refs\/heads\/(.+)$/.exec(command)
  if (verify !== null) return world.branches.includes(verify[1] ?? '') ? { exitCode: 0, stdout: 'abc\n' } : { exitCode: 1, stdout: '' }
  if (argv[1] === 'worktree' && argv[2] === 'add') {
    const isNew = argv[3] === '-b'
    // `worktree add -b <branch> <path> <base>`, or `worktree add <path> <branch>`.
    const branch = argv[4] ?? ''
    const path = (isNew ? argv[5] : argv[3]) ?? ''
    if (isNew && world.branches.includes(branch)) return { exitCode: 128, stdout: '', stderr: `fatal: a branch named '${branch}' already exists` }
    if (isNew) world.branches.push(branch)
    world.files.set(`${path}/.git`, `gitdir: ${world.git?.root ?? REPO}/.git/worktrees/${branch}\n`)
    return { exitCode: 0, stdout: '' }
  }
  return undefined
}

const run = (world: World, argv: readonly string[], init: { cwd?: string; stdin?: string } = {}) => {
  const answer = (exitCode: number, stdout: string, stderr?: string) => ({
    exitCode,
    stdout,
    stderr: stderr ?? (exitCode === 0 ? '' : 'fatal: not a git repository'),
    isStdoutTruncated: false,
    isStderrTruncated: false,
  })
  const call: Run = { argv: [...argv], cwd: init.cwd, stdin: init.stdin }
  world.gitRuns.push(argv.join(' '))
  world.runs.push(call)
  const custom = world.answer?.(call) ?? shell(world, argv) ?? github(world, argv)
  if (custom !== undefined) return answer(custom.exitCode, custom.stdout, custom.stderr)
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
  on('fs.list', (_$, e) => {
    try {
      return { value: list(world, e.path ?? world.sessionRoot) }
    } catch (error) {
      return { deny: (error as Error).message } as never
    }
  })
  on('fs.write', (_$, e) => {
    world.files.set(e.path, e.text)
    return { value: undefined } as never
  })
  on('process.run', (_$, e) => ({ value: run(world, e.argv, e.init) }))
  on('session.root', () => ({ value: world.sessionRoot }))
  on('tool.register', (_$, e) => {
    world.tools.push(e.name)
    return { value: { tool: `mcp__godmode__${e.name}` } } as never
  })
  mock.env(on, world.env)
  mock.clock(on, { now: NOW })
}

/** A `$` over `world` for calling the storage helpers directly. */
export const worldEngine = (world: World) =>
  ({
    plugin: { name: 'godmode', root: '/plugins/godmode' },
    fs: {
      read: async (path: string) => read(world, path),
      write: async (path: string, text: string) => void world.files.set(path, text),
      exists: async (path: string) => exists(world, path),
      list: async (path: string) => list(world, path),
    },
    process: { run: async (argv: readonly string[], init?: { cwd?: string; stdin?: string }) => run(world, argv, init) },
    env: { get: async (name: string) => world.env[name] },
    session: { root: async () => world.sessionRoot },
    clock: { now: async () => NOW },
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
