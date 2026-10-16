import type { EngineInterface } from 'claude-code'

import type { Answer, Project } from './storage'

/**
 * Where PRs live (D54, D55): `github` through `gh`; `local` with no PR host, where a
 * branch stands for its PR and review runs on it; `other` for a host the setup maps
 * (`glab`, a connector), not built yet.
 */
export type HostKind = 'github' | 'local' | 'other'

export const HOST_KINDS: readonly HostKind[] = ['github', 'local', 'other']

/** How a PR lands: GitHub takes all three; the local host only `merge` (a fast-forward when it can be one). */
export type MergeMethod = 'merge' | 'squash' | 'rebase'

/** An open PR as the contention sweep and the verdict checks read it (D47, D53). */
export type PullRequest = {
  /** The host's own reference: the PR number on GitHub, the branch on the local host. */
  ref: string
  url?: string
  title: string
  branch: string
  base: string
  /** Who opened it: a GitHub login, or the git email that recorded a local review. */
  author: string
  isDraft: boolean
  /** Every path the PR changes, relative to the repo root. */
  files: string[]
  /** The commit the PR's branch points at; a verdict counts only at this commit (D53). */
  headCommit: string
}

export type DraftRequest = { branch: string; base: string; title: string; body: string }

/** The PR actions the loop takes (D55), the same on every host. */
export interface GitHost {
  readonly kind: HostKind
  /** Opens a draft PR for a pushed branch (PRs are always drafts first, D53). */
  openDraft(request: DraftRequest): Promise<{ ref: string; url?: string }>
  comment(ref: string, body: string): Promise<void>
  markReady(ref: string): Promise<void>
  merge(ref: string, method: MergeMethod): Promise<void>
  listOpen(): Promise<PullRequest[]>
  headCommit(ref: string): Promise<string>
}

/** A host action that failed or cannot run: a failed command, a host not built yet. */
export class HostError extends Error {}

/** What `/godmode` says in a folder with no git (D54): it does not start, and it offers `git init`. */
export const NO_GIT_LINE =
  'godmode needs git, and this folder is not a git repository. Run `git init` here (or ask for it) and make a first commit, then `/godmode` again.'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** The PR number at the end of a GitHub PR link, as `gh pr create` prints it. */
export const prNumberOf = (url: string) => /\/pull\/(\d+)\b/.exec(url)?.[1]

/**
 * The open PRs in `gh pr list --json` output. A malformed entry throws, so a sweep
 * never reads a half-parsed list as "nothing held".
 */
export const parseGhPullRequests = (stdout: string): PullRequest[] => {
  let value: unknown
  try {
    value = JSON.parse(stdout)
  } catch {
    throw new HostError(`gh pr list did not answer JSON: ${stdout.slice(0, 200)}`)
  }
  if (!Array.isArray(value)) throw new HostError('gh pr list did not answer a list.')
  return value.map(entry => {
    if (!isRecord(entry) || typeof entry.number !== 'number' || typeof entry.headRefName !== 'string') {
      throw new HostError(`gh pr list answered an entry godmode cannot read: ${JSON.stringify(entry).slice(0, 200)}`)
    }
    const files = Array.isArray(entry.files) ? entry.files : []
    return {
      ref: String(entry.number),
      url: typeof entry.url === 'string' ? entry.url : undefined,
      title: typeof entry.title === 'string' ? entry.title : '',
      branch: entry.headRefName,
      base: typeof entry.baseRefName === 'string' ? entry.baseRefName : '',
      author: isRecord(entry.author) && typeof entry.author.login === 'string' ? entry.author.login : '',
      isDraft: entry.isDraft === true,
      files: files.flatMap(file => (isRecord(file) && typeof file.path === 'string' ? [file.path] : [])),
      headCommit: typeof entry.headRefOid === 'string' ? entry.headRefOid : '',
    }
  })
}

/** The host of a git remote URL, `https://`, `ssh://` or `user@host:path` alike. */
export const remoteHostOf = (url: string) => {
  const trimmed = url.trim()
  const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/\/)/.exec(trimmed)
  if (scp !== null && !/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return scp[1]?.toLowerCase()
  return /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?([^:/]+)/i.exec(trimmed)?.[1]?.toLowerCase()
}

const isGitHub = (url: string) => ['github.com', 'ssh.github.com', 'www.github.com'].includes(remoteHostOf(url) ?? '')

/** The failure line of a command, for an error the model reads. */
const failure = (argv: readonly string[], result: { exitCode: number; stdout: string; stderr: string }) =>
  `\`${argv.slice(0, 3).join(' ')}\` failed (exit ${result.exitCode}): ${(result.stderr.trim() || result.stdout.trim()).slice(0, 500)}`

/*
 * Helpers that take `$` are function declarations: the engine follows `$` past an import
 * only into those.
 */

/** Runs a command with no shell; rejects with a HostError when it cannot start or exits non-zero. */
async function run($: EngineInterface, argv: string[], cwd: string, stdin?: string) {
  const result = await $.process.run(argv, { cwd, stdin, timeoutMs: 120_000 }).catch((error: unknown) => {
    throw new HostError(`\`${argv[0]}\` could not run: ${error instanceof Error ? error.message : String(error)}`)
  })
  if (result.exitCode !== 0) throw new HostError(failure(argv, result))
  return result.stdout
}

/** GitHub through `gh`, run in the repo's main working tree. Nothing pushes: a dev agent pushes its branch. */
export function githubHost($: EngineInterface, cwd: string): GitHost {
  const gh = (args: string[], stdin?: string) => run($, ['gh', ...args], cwd, stdin)
  return {
    kind: 'github',
    openDraft: async ({ branch, base, title, body }) => {
      const out = await gh(['pr', 'create', '--draft', '--base', base, '--head', branch, '--title', title, '--body-file', '-'], body)
      const url = out.trim().split('\n').at(-1)?.trim() ?? ''
      const ref = prNumberOf(url)
      if (ref === undefined) throw new HostError(`gh opened a PR but printed no PR link: ${out.slice(0, 200)}`)
      return { ref, url }
    },
    comment: async (ref, body) => void (await gh(['pr', 'comment', ref, '--body-file', '-'], body)),
    markReady: async ref => void (await gh(['pr', 'ready', ref])),
    merge: async (ref, method) => void (await gh(['pr', 'merge', ref, `--${method}`])),
    listOpen: async () =>
      parseGhPullRequests(
        await gh([
          'pr',
          'list',
          '--state',
          'open',
          '--limit',
          '200',
          '--json',
          'number,url,title,headRefName,baseRefName,author,isDraft,files,headRefOid',
        ]),
      ),
    headCommit: async ref => {
      const value: unknown = JSON.parse(await gh(['pr', 'view', ref, '--json', 'headRefOid']))
      if (!isRecord(value) || typeof value.headRefOid !== 'string') throw new HostError(`gh pr view ${ref} answered no head commit.`)
      return value.headRefOid
    },
  }
}

/** One branch under review on the local host: what "open PR" records (D54). */
export type LocalReview = {
  branch: string
  base: string
  title: string
  body: string
  author: string
  isDraft: boolean
  openedAt: string
  comments: { at: string; body: string }[]
}

export const LOCAL_REVIEWS = 'local-reviews.json'

const isLocalReview = (value: unknown): value is LocalReview =>
  isRecord(value) &&
  typeof value.branch === 'string' &&
  typeof value.base === 'string' &&
  typeof value.isDraft === 'boolean' &&
  Array.isArray(value.comments)

/** The branch checked out in each working tree, from `git worktree list --porcelain`. */
export const checkedOutBranches = (porcelain: string) =>
  new Map(
    porcelain.split(/\n\s*\n/).flatMap(block => {
      const path = /^worktree (.+)$/m.exec(block)?.[1]
      const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1]
      return path === undefined || branch === undefined ? [] : [[branch, path] as const]
    }),
  )

/**
 * No PR host (D54): branches only. "Open PR" records the branch for review in the note's
 * folder `dir`; review comments are kept with it; merge brings it into the base branch,
 * a fast-forward when it can be one.
 */
export function localHost($: EngineInterface, project: Project, dir: string): GitHost {
  const path = `${dir.replace(/[\\/]+$/, '')}/${LOCAL_REVIEWS}`
  const git = (args: string[], cwd = project.root) => run($, ['git', ...args], cwd)

  const load = async (): Promise<LocalReview[]> => {
    if (!(await $.fs.exists(path))) return []
    const value: unknown = JSON.parse(await $.fs.read(path))
    if (!isRecord(value) || !Array.isArray(value.reviews) || !value.reviews.every(isLocalReview)) {
      throw new HostError(`${path} is not a list of local reviews.`)
    }
    return value.reviews
  }
  const save = (reviews: LocalReview[]) => $.fs.write(path, `${JSON.stringify({ reviews }, null, 2)}\n`)
  const branchHead = (branch: string) => git(['rev-parse', '--verify', `refs/heads/${branch}^{commit}`]).then(out => out.trim())
  const find = async (ref: string) => {
    const reviews = await load()
    const review = reviews.find(candidate => candidate.branch === ref)
    if (review === undefined) throw new HostError(`No branch \`${ref}\` is open for review.`)
    return { reviews, review }
  }

  return {
    kind: 'local',
    openDraft: async ({ branch, base, title, body }) => {
      await branchHead(branch)
      await branchHead(base)
      const reviews = await load()
      if (reviews.some(review => review.branch === branch)) return { ref: branch }
      const author = (await git(['config', 'user.email']).catch(() => '')).trim()
      const openedAt = new Date(await $.clock.now()).toISOString()
      await save([...reviews, { branch, base, title, body, author, isDraft: true, openedAt, comments: [] }])
      return { ref: branch }
    },
    comment: async (ref, body) => {
      const { reviews, review } = await find(ref)
      review.comments.push({ at: new Date(await $.clock.now()).toISOString(), body })
      await save(reviews)
    },
    markReady: async ref => {
      const { reviews, review } = await find(ref)
      review.isDraft = false
      await save(reviews)
    },
    merge: async (ref, method) => {
      if (method !== 'merge') throw new HostError(`The local host merges with \`merge\` only, not \`${method}\`.`)
      const { reviews, review } = await find(ref)
      if (review.isDraft) throw new HostError(`\`${ref}\` is still a draft: mark it ready before merging.`)
      const where = checkedOutBranches(await git(['worktree', 'list', '--porcelain'])).get(review.base)
      if (where === undefined) {
        // The base is checked out nowhere: move its ref, which git allows only as a fast-forward.
        await git(['fetch', '.', `refs/heads/${review.branch}:refs/heads/${review.base}`]).catch((error: unknown) => {
          throw new HostError(
            `\`${review.branch}\` is not a fast-forward of \`${review.base}\`, and \`${review.base}\` is checked out nowhere to merge in. Check it out, then merge again. (${error instanceof Error ? error.message : String(error)})`,
          )
        })
      } else {
        await git(['merge', '--no-edit', review.branch], where).catch(async (error: unknown) => {
          await $.process.run(['git', 'merge', '--abort'], { cwd: where }).catch(() => undefined)
          throw error
        })
      }
      await save(reviews.filter(candidate => candidate !== review))
    },
    listOpen: async () => {
      const open: PullRequest[] = []
      for (const review of await load()) {
        // A branch deleted by hand holds no files any more.
        const headCommit = await branchHead(review.branch).catch(() => undefined)
        if (headCommit === undefined) continue
        const files = await git(['diff', '--name-only', `${review.base}...${review.branch}`])
        open.push({
          ref: review.branch,
          title: review.title,
          branch: review.branch,
          base: review.base,
          author: review.author,
          isDraft: review.isDraft,
          files: files.split('\n').map(line => line.trim()).filter(line => line !== ''),
          headCommit,
        })
      }
      return open
    },
    headCommit: async ref => {
      await find(ref)
      return branchHead(ref)
    },
  }
}

/** Another host (D55), mapped at setup: not built yet. It says so rather than falling back unasked. */
export function otherHost(): GitHost {
  throw new HostError(
    'The "Other" git host is not built yet: godmode still needs the mapping the setup finds (`glab`, a connector) for opening, commenting on, readying and merging PRs. Nothing was done on any host.',
  )
}

/** Which host serves a project, and why, so the reason can be said once. */
export type HostChoice = { kind: HostKind; reason: string }

/**
 * Picks the host (D54, D55): the note's `gitHost` answer when it names one, else GitHub
 * when the `origin` remote is on github.com and `gh` is signed in, else local branches.
 */
export async function chooseHost($: EngineInterface, project: Project, answers: Readonly<Record<string, Answer>> = {}): Promise<HostChoice> {
  if (!project.hasGit) throw new HostError(NO_GIT_LINE)
  const asked = answers.gitHost
  if (asked === 'other') return { kind: 'other', reason: 'the setup note names another git host' }
  if (asked === 'local') return { kind: 'local', reason: 'the setup note asks for local branches' }
  const origin = await $.process.run(['git', 'remote', 'get-url', 'origin'], { cwd: project.root }).catch(() => undefined)
  if (origin?.exitCode !== 0 || origin.stdout.trim() === '') return { kind: 'local', reason: 'the repo has no `origin` remote' }
  if (!isGitHub(origin.stdout)) return { kind: 'local', reason: `\`origin\` is not on github.com (${origin.stdout.trim()})` }
  const auth = await $.process.run(['gh', 'auth', 'status', '--hostname', 'github.com'], { cwd: project.root }).catch(() => undefined)
  if (auth === undefined) return { kind: 'local', reason: '`gh` is not installed' }
  if (auth.exitCode !== 0) return { kind: 'local', reason: '`gh` is not signed in to github.com' }
  return { kind: 'github', reason: '`origin` is on github.com and `gh` is signed in' }
}

/** The host for a choice; `dir` is the note's folder, where the local host records its reviews. */
export function hostFor($: EngineInterface, kind: HostKind, project: Project, dir: string): GitHost {
  if (kind === 'other') return otherHost()
  if (kind === 'github') return githubHost($, project.root)
  return localHost($, project, dir)
}
