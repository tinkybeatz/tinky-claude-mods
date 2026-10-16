import { expect, test } from 'claude-code/testing'

import {
  checkedOutBranches,
  chooseHost,
  githubHost,
  hostFor,
  LOCAL_REVIEWS,
  localHost,
  NO_GIT_LINE,
  parseGhPullRequests,
  prNumberOf,
  remoteHostOf,
} from '../hooks/host'
import type { Project } from '../hooks/storage'
import { FIRST_COMMIT, makeWorld, REPO, worldEngine } from './world'
import type { Run, RunAnswer, World } from './world'

const PROJECT: Project = { id: FIRST_COMMIT, root: REPO, hasGit: true }
const DIR = `${REPO}/.godmode`
const ok = (stdout = ''): RunAnswer => ({ exitCode: 0, stdout })

/** The message a promise rejects with, or undefined when it resolves. */
const errorOf = async (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  )

/** What `gh pr list --json number,url,...` prints for two open PRs. */
const GH_LIST = JSON.stringify([
  {
    number: 12,
    url: 'https://github.com/acme/app/pull/12',
    title: 'T-3 Export button',
    headRefName: 't-3-export',
    baseRefName: 'main',
    author: { id: 'U_1', is_bot: false, login: 'octocat', name: 'Mona' },
    isDraft: true,
    files: [
      { path: 'src/report.tsx', additions: 10, deletions: 2 },
      { path: 'src/report.test.tsx', additions: 30, deletions: 0 },
    ],
    headRefOid: 'a1b2c3d4',
  },
  {
    number: 9,
    url: 'https://github.com/acme/app/pull/9',
    title: 'Bump deps',
    headRefName: 'deps',
    baseRefName: 'main',
    author: { login: 'teammate' },
    isDraft: false,
    files: [],
    headRefOid: 'e5f6a7b8',
  },
])

test('gh pr list JSON reads as open PRs with their files, author and head commit', () => {
  const prs = parseGhPullRequests(GH_LIST)

  expect(prs).toEqual([
    {
      ref: '12',
      url: 'https://github.com/acme/app/pull/12',
      title: 'T-3 Export button',
      branch: 't-3-export',
      base: 'main',
      author: 'octocat',
      isDraft: true,
      files: ['src/report.tsx', 'src/report.test.tsx'],
      headCommit: 'a1b2c3d4',
    },
    {
      ref: '9',
      url: 'https://github.com/acme/app/pull/9',
      title: 'Bump deps',
      branch: 'deps',
      base: 'main',
      author: 'teammate',
      isDraft: false,
      files: [],
      headCommit: 'e5f6a7b8',
    },
  ])
  expect(parseGhPullRequests('[]')).toEqual([])
  expect(() => parseGhPullRequests('gh: not logged in')).toThrow('did not answer JSON')
  expect(() => parseGhPullRequests('[{"title":"no number"}]')).toThrow('cannot read')
})

/** A world whose `gh` answers from `answers`, keyed by its first two arguments. */
const ghWorld = (answers: Record<string, RunAnswer>) =>
  makeWorld({ answer: (run: Run) => (run.argv[0] === 'gh' ? (answers[run.argv.slice(1, 3).join(' ')] ?? { exitCode: 1, stdout: '', stderr: 'unexpected' }) : undefined) })

const ghRuns = (world: World) => world.runs.filter(run => run.argv[0] === 'gh')

test('GitHub lists open PRs through gh, in the repo, with no shell', async () => {
  const world = ghWorld({ 'pr list': ok(GH_LIST) })

  const prs = await githubHost(worldEngine(world), REPO).listOpen()

  expect(prs.map(pr => `${pr.ref} ${pr.author} ${pr.files.length}`)).toEqual(['12 octocat 2', '9 teammate 0'])
  expect(ghRuns(world)).toEqual([
    {
      argv: ['gh', 'pr', 'list', '--state', 'open', '--limit', '200', '--json', 'number,url,title,headRefName,baseRefName,author,isDraft,files,headRefOid'],
      cwd: REPO,
      stdin: undefined,
    },
  ])
})

test('GitHub opens a draft with the body on standard input, and reads its number from the link', async () => {
  const world = ghWorld({ 'pr create': ok('Warning: 1 uncommitted change\nhttps://github.com/acme/app/pull/13\n') })

  const opened = await githubHost(worldEngine(world), REPO).openDraft({ branch: 't-4-fix', base: 'main', title: 'T-4 Fix', body: 'Closes T-4.\n\n`code`' })

  expect(opened).toEqual({ ref: '13', url: 'https://github.com/acme/app/pull/13' })
  const [create] = ghRuns(world)
  expect(create?.argv).toEqual(['gh', ...['pr', 'create'], '--draft', '--base', 'main', '--head', 't-4-fix', '--title', 'T-4 Fix', '--body-file', '-'])
  expect(create?.stdin).toBe('Closes T-4.\n\n`code`')
})

test('GitHub comments, marks ready, merges and reads the head commit with the matching gh calls', async () => {
  const world = ghWorld({ 'pr comment': ok(), 'pr ready': ok(), 'pr merge': ok(), 'pr view': ok('{"headRefOid":"a1b2c3d4"}\n') })
  const host = githubHost(worldEngine(world), REPO)

  await host.comment('12', 'clean-to-merge at a1b2c3d4')
  await host.markReady('12')
  await host.merge('12', 'squash')
  const head = await host.headCommit('12')

  expect(head).toBe('a1b2c3d4')
  expect(ghRuns(world).map(run => run.argv.slice(1).join(' '))).toEqual([
    'pr comment 12 --body-file -',
    'pr ready 12',
    'pr merge 12 --squash',
    'pr view 12 --json headRefOid',
  ])
  expect(ghRuns(world)[0]?.stdin).toBe('clean-to-merge at a1b2c3d4')
})

test('a failed gh call is an error naming the command and what gh said', async () => {
  const world = ghWorld({ 'pr ready': { exitCode: 1, stdout: '', stderr: 'GraphQL: Pull request #12 is not a draft\n' } })

  const message = await errorOf(githubHost(worldEngine(world), REPO).markReady('12'))

  expect(message).toBe('`gh pr ready` failed (exit 1): GraphQL: Pull request #12 is not a draft')
})

test('remote URLs and PR links are read in every spelling', () => {
  expect(remoteHostOf('git@github.com:acme/app.git')).toBe('github.com')
  expect(remoteHostOf('https://github.com/acme/app.git\n')).toBe('github.com')
  expect(remoteHostOf('https://token@GitHub.com/acme/app')).toBe('github.com')
  expect(remoteHostOf('ssh://git@ssh.github.com:443/acme/app.git')).toBe('ssh.github.com')
  expect(remoteHostOf('git@gitlab.com:acme/app.git')).toBe('gitlab.com')
  expect(prNumberOf('https://github.com/acme/app/pull/42')).toBe('42')
  expect(prNumberOf('https://github.com/acme/app')).toBeUndefined()
})

/** A world whose `origin` remote and `gh auth status` answer as given; `gh` undefined is not installed. */
const hostWorld = (origin: string | undefined, gh: 'signed-in' | 'signed-out' | undefined) =>
  makeWorld({
    answer: (run: Run) => {
      if (run.argv.join(' ') === 'git remote get-url origin') {
        return origin === undefined ? { exitCode: 2, stdout: '', stderr: 'error: No such remote' } : ok(`${origin}\n`)
      }
      if (run.argv[0] !== 'gh') return undefined
      if (gh === undefined) throw new Error('spawn gh ENOENT')
      return gh === 'signed-in' ? ok() : { exitCode: 1, stdout: '', stderr: 'You are not logged into any GitHub hosts.' }
    },
  })

test('GitHub is chosen when origin is on github.com and gh is signed in; local otherwise (D54, D55)', async () => {
  const choose = (world: World) => chooseHost(worldEngine(world), PROJECT)

  expect(await choose(hostWorld('git@github.com:acme/app.git', 'signed-in'))).toEqual({
    kind: 'github',
    reason: '`origin` is on github.com and `gh` is signed in',
  })
  expect((await choose(hostWorld('git@github.com:acme/app.git', 'signed-out'))).reason).toBe('`gh` is not signed in to github.com')
  expect((await choose(hostWorld('git@github.com:acme/app.git', undefined))).reason).toBe('`gh` is not installed')
  expect((await choose(hostWorld('git@gitlab.com:acme/app.git', 'signed-in'))).kind).toBe('local')
  expect((await choose(hostWorld(undefined, 'signed-in'))).reason).toBe('the repo has no `origin` remote')
})

test('the note can name the host, and "Other" says it is not built yet', async () => {
  const world = hostWorld('git@github.com:acme/app.git', 'signed-in')
  const $ = worldEngine(world)

  const other = await chooseHost($, PROJECT, { gitHost: 'other' })
  const local = await chooseHost($, PROJECT, { gitHost: 'local' })

  expect(other.kind).toBe('other')
  expect(local.kind).toBe('local')
  expect(() => hostFor($, 'other', PROJECT, DIR)).toThrow('The "Other" git host is not built yet')
  expect(hostFor($, 'github', PROJECT, DIR).kind).toBe('github')
  expect(hostFor($, 'local', PROJECT, DIR).kind).toBe('local')
  expect(await errorOf(chooseHost($, { ...PROJECT, hasGit: false }))).toBe(NO_GIT_LINE)
})

/**
 * A git repo for the local host: branches and the commit each points at, the branch each
 * worktree has checked out, and the files each branch changes against its base.
 */
const gitWorld = (options: { checkedOut?: Record<string, string>; mergeFails?: boolean; fastForward?: boolean } = {}) => {
  const branches: Record<string, string> = { main: 'c0', 't-5-cache': 'c5', 't-6-docs': 'c6' }
  const checkedOut = options.checkedOut ?? { main: REPO, 't-5-cache': '/work/app-worktrees/T-5' }
  const world = makeWorld({
    answer: (run: Run) => {
      const [tool, ...args] = run.argv
      if (tool !== 'git') return undefined
      const command = args.join(' ')
      const verify = /^rev-parse --verify refs\/heads\/(.+)\^\{commit\}$/.exec(command)?.[1]
      if (verify !== undefined) {
        const commit = branches[verify]
        return commit === undefined ? { exitCode: 128, stdout: '', stderr: 'fatal: Needed a single revision' } : ok(`${commit}\n`)
      }
      if (command === 'config user.email') return ok('dev@example.com\n')
      if (command === 'worktree list --porcelain') {
        return ok(Object.entries(checkedOut).map(([branch, path]) => `worktree ${path}\nHEAD 0\nbranch refs/heads/${branch}\n`).join('\n'))
      }
      if (command === 'diff --name-only main...t-5-cache') return ok('src/cache.ts\nsrc/cache.test.ts\n')
      if (command === 'diff --name-only main...t-6-docs') return ok('README.md\n')
      if (command.startsWith('merge --no-edit ')) {
        if (options.mergeFails === true) return { exitCode: 1, stdout: 'CONFLICT (content): Merge conflict in src/cache.ts', stderr: '' }
        branches.main = branches[args[2] ?? ''] ?? ''
        return ok()
      }
      if (command === 'merge --abort') return ok()
      if (command.startsWith('fetch . ')) {
        if (options.fastForward === false) return { exitCode: 1, stdout: '', stderr: ' ! [rejected] t-5-cache -> main (non-fast-forward)' }
        branches.main = branches['t-5-cache'] ?? ''
        return ok()
      }
      return { exitCode: 1, stdout: '', stderr: `unexpected git ${command}` }
    },
  })
  return { world, branches, host: localHost(worldEngine(world), PROJECT, DIR) }
}

const gitCalls = (world: World) => world.runs.filter(run => run.argv[0] === 'git').map(run => `${run.argv.slice(1).join(' ')} @ ${run.cwd}`)

test('the local host records a branch for review and lists it with its files, author and head', async () => {
  const { world, host } = gitWorld()

  const opened = await host.openDraft({ branch: 't-5-cache', base: 'main', title: 'T-5 Cache', body: 'Closes T-5.' })
  const again = await host.openDraft({ branch: 't-5-cache', base: 'main', title: 'T-5 Cache', body: 'Closes T-5.' })
  await host.openDraft({ branch: 't-6-docs', base: 'main', title: 'T-6 Docs', body: '' })
  const open = await host.listOpen()

  expect(opened).toEqual({ ref: 't-5-cache' })
  expect(again).toEqual({ ref: 't-5-cache' })
  expect(open).toEqual([
    {
      ref: 't-5-cache',
      title: 'T-5 Cache',
      branch: 't-5-cache',
      base: 'main',
      author: 'dev@example.com',
      isDraft: true,
      files: ['src/cache.ts', 'src/cache.test.ts'],
      headCommit: 'c5',
    },
    { ref: 't-6-docs', title: 'T-6 Docs', branch: 't-6-docs', base: 'main', author: 'dev@example.com', isDraft: true, files: ['README.md'], headCommit: 'c6' },
  ])
  expect(JSON.parse(world.files.get(`${DIR}/${LOCAL_REVIEWS}`) ?? '{}').reviews).toHaveLength(2)
})

test('the local host refuses a branch that does not exist, and a ref not open for review', async () => {
  const { host } = gitWorld()

  expect(await errorOf(host.openDraft({ branch: 'nope', base: 'main', title: 'x', body: '' }))).toContain('fatal: Needed a single revision')
  expect(await errorOf(host.comment('t-5-cache', 'x'))).toBe('No branch `t-5-cache` is open for review.')
})

test('the local host keeps comments, and its head commit is the branch\'s', async () => {
  const { world, host } = gitWorld()
  await host.openDraft({ branch: 't-5-cache', base: 'main', title: 'T-5 Cache', body: '' })

  await host.comment('t-5-cache', 'change-request: cache never expires')
  await host.comment('t-5-cache', 'clean-to-merge at c5')

  const reviews = JSON.parse(world.files.get(`${DIR}/${LOCAL_REVIEWS}`) ?? '{}').reviews
  expect(reviews[0].comments).toEqual([
    { at: '2026-10-16T09:30:00.000Z', body: 'change-request: cache never expires' },
    { at: '2026-10-16T09:30:00.000Z', body: 'clean-to-merge at c5' },
  ])
  expect(await host.headCommit('t-5-cache')).toBe('c5')
})

test('the local host merges a ready branch in the worktree that has the base checked out', async () => {
  const { world, branches, host } = gitWorld()
  await host.openDraft({ branch: 't-5-cache', base: 'main', title: 'T-5 Cache', body: '' })

  expect(await errorOf(host.merge('t-5-cache', 'merge'))).toBe('`t-5-cache` is still a draft: mark it ready before merging.')
  await host.markReady('t-5-cache')
  expect(await errorOf(host.merge('t-5-cache', 'squash'))).toBe('The local host merges with `merge` only, not `squash`.')
  await host.merge('t-5-cache', 'merge')

  expect(branches.main).toBe('c5')
  expect(gitCalls(world)).toContain(`merge --no-edit t-5-cache @ ${REPO}`)
  expect(await host.listOpen()).toEqual([])
})

test('the local host fast-forwards a base checked out nowhere, and says so when it cannot', async () => {
  const moved = gitWorld({ checkedOut: { 't-5-cache': '/work/app-worktrees/T-5' } })
  await moved.host.openDraft({ branch: 't-5-cache', base: 'main', title: 'T-5', body: '' })
  await moved.host.markReady('t-5-cache')
  await moved.host.merge('t-5-cache', 'merge')

  const stuck = gitWorld({ checkedOut: {}, fastForward: false })
  await stuck.host.openDraft({ branch: 't-5-cache', base: 'main', title: 'T-5', body: '' })
  await stuck.host.markReady('t-5-cache')
  const message = await errorOf(stuck.host.merge('t-5-cache', 'merge'))

  expect(moved.branches.main).toBe('c5')
  expect(gitCalls(moved.world)).toContain(`fetch . refs/heads/t-5-cache:refs/heads/main @ ${REPO}`)
  expect(message).toContain('is not a fast-forward of `main`')
  expect((await stuck.host.listOpen()).map(pr => pr.ref)).toEqual(['t-5-cache'])
})

test('a local merge that conflicts is aborted, and the branch stays open', async () => {
  const { world, host } = gitWorld({ mergeFails: true })
  await host.openDraft({ branch: 't-5-cache', base: 'main', title: 'T-5', body: '' })
  await host.markReady('t-5-cache')

  const message = await errorOf(host.merge('t-5-cache', 'merge'))

  expect(message).toContain('Merge conflict in src/cache.ts')
  expect(gitCalls(world)).toContain(`merge --abort @ ${REPO}`)
  expect((await host.listOpen()).map(pr => pr.ref)).toEqual(['t-5-cache'])
})

test('worktree porcelain reads as the branch each worktree has checked out', () => {
  const porcelain = `worktree ${REPO}\nHEAD c0\nbranch refs/heads/main\n\nworktree /work/app-worktrees/T-5\nHEAD c5\nbranch refs/heads/t-5/cache\n\nworktree /work/detached\nHEAD c9\ndetached\n`

  expect([...checkedOutBranches(porcelain)]).toEqual([
    ['main', REPO],
    ['t-5/cache', '/work/app-worktrees/T-5'],
  ])
})
