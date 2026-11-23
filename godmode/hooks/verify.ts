import type { EngineInterface } from 'claude-code'

import { peopleIn } from './answers'
import { JIRA_STATUS_ANSWERS, jiraAnswerProblems } from './jira'
import type { Answer } from './storage'

/*
 * Setup answers checked against the world before they are saved, read-only and cheap: the
 * Jira site, project and statuses through the Atlassian server, the repo and each named
 * approver through `gh`, and each package-manager command against the scripts in
 * `package.json`. No command is ever run. Only a definite "no" is a problem; an answer that
 * could not be checked (no server, `gh` signed out, no `package.json`) passes. Every helper
 * that takes `$` is a function declaration: the engine follows `$` past an import only into those.
 */

/** A saved answer that does not hold, and why. */
export type Finding = { key: string; problem: string }

/** How long one `gh` read may take. */
const GH_TIMEOUT_MS = 5_000

const JIRA_KEYS_CHECKED: readonly string[] = ['jiraCloudId', 'jiraProject', ...JIRA_STATUS_ANSWERS]

const RUNNERS: readonly string[] = ['npm', 'pnpm', 'yarn', 'bun']

/** Package-manager commands that are not scripts. */
const BUILT_INS: readonly string[] = [
  'install', 'i', 'ci', 'add', 'remove', 'rm', 'uninstall', 'exec', 'dlx', 'x', 'create', 'init', 'why', 'list', 'ls', 'outdated',
  'update', 'up', 'upgrade', 'link', 'publish', 'pack', 'audit', 'config', 'store', 'import', 'rebuild', 'prune', 'dedupe', 'help', 'version',
]

/** Flags that take a value and point the command at another package. */
const PACKAGE_FLAGS: readonly string[] = ['--filter', '-F', '--workspace', '-C', '--dir', '--prefix', '--cwd']

/** The script a package-manager command runs: its name, whether `run` named it, and whether it runs in another package. */
export type ScriptUse = { script: string; isRun: boolean; isElsewhere: boolean }

/**
 * The script a command line runs, when it is `npm`, `pnpm`, `yarn` or `bun` running one:
 * `pnpm editor:dev`, `npm run build`, `pnpm --filter web dev`. Undefined for any other
 * command, a built-in (`pnpm install`), or one that names no script.
 */
export const scriptUseOf = (command: string): ScriptUse | undefined => {
  const words = (command.split(/&&|\|\||;|\|/)[0] ?? '').trim().split(/\s+/).filter(word => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word))
  const [runner, ...rest] = words
  if (runner === undefined || !RUNNERS.includes(runner)) return undefined
  let isElsewhere = false
  let isRun = false
  for (let index = 0; index < rest.length; index += 1) {
    const word = rest[index] ?? ''
    if (PACKAGE_FLAGS.includes(word)) {
      isElsewhere = true
      index += 1
      continue
    }
    if (PACKAGE_FLAGS.some(flag => word.startsWith(`${flag}=`))) isElsewhere = true
    if (word.startsWith('-')) continue
    if (!isRun && (word === 'run' || word === 'run-script')) {
      isRun = true
      continue
    }
    if (isRun) return { script: word, isRun, isElsewhere }
    if (BUILT_INS.includes(word)) return undefined
    // `npm test` and `npm start` run scripts; any other bare npm word is npm's own command.
    if (runner === 'npm') return word === 'test' || word === 'start' || word === 'stop' || word === 'restart' ? { script: word, isRun: true, isElsewhere } : undefined
    return { script: word, isRun: false, isElsewhere }
  }
  return undefined
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** A `package.json`'s scripts and workspace patterns; undefined when it cannot be read. */
async function manifestAt($: EngineInterface, dir: string): Promise<{ scripts: Record<string, unknown>; workspaces: string[] } | undefined> {
  const text = await $.fs.read(`${dir}/package.json`).catch(() => undefined)
  if (text === undefined) return undefined
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isRecord(value)) return undefined
  const listed = Array.isArray(value.workspaces) ? value.workspaces : isRecord(value.workspaces) && Array.isArray(value.workspaces.packages) ? value.workspaces.packages : []
  return { scripts: isRecord(value.scripts) ? value.scripts : {}, workspaces: listed.filter((item): item is string => typeof item === 'string') }
}

/** The workspace patterns `pnpm-workspace.yaml` lists under `packages:`. */
export const pnpmWorkspacesIn = (yaml: string) => {
  const block = /^packages:\s*\n((?:[ \t]*-.*\n?|[ \t]*#.*\n?|[ \t]*\n)*)/m.exec(yaml)?.[1] ?? ''
  return [...block.matchAll(/^[ \t]*-[ \t]*['"]?([^'"#\n]+?)['"]?[ \t]*(?:#.*)?$/gm)].map(match => (match[1] ?? '').trim()).filter(pattern => pattern !== '' && !pattern.startsWith('!'))
}

/** The scripts of every workspace package, from patterns like `apps/*` or `packages/web`. */
async function workspaceScripts($: EngineInterface, root: string, patterns: readonly string[]): Promise<Record<string, unknown>[]> {
  const dirs: string[] = []
  for (const pattern of patterns) {
    const clean = pattern.replace(/^\.\//, '').replace(/\/+$/, '')
    const star = clean.indexOf('*')
    if (star === -1) {
      dirs.push(`${root}/${clean}`)
      continue
    }
    const parent = clean.slice(0, star).replace(/\/+$/, '')
    for (const entry of await $.fs.list(`${root}/${parent}`).catch(() => [])) if (entry.kind === 'dir') dirs.push(`${root}/${parent}/${entry.name}`)
  }
  const manifests = await Promise.all(dirs.map(dir => manifestAt($, dir)))
  return manifests.flatMap(manifest => (manifest === undefined ? [] : [manifest.scripts]))
}

/**
 * Whether a package-manager command names a script that exists: in the root `package.json`,
 * or, pointed at another package, in a workspace package. A bare word that is no script may be
 * a tool the project installed (`pnpm vitest`), found in `node_modules/.bin`. Undefined when it
 * holds or cannot be told.
 */
async function commandProblem($: EngineInterface, root: string, value: Answer): Promise<string | undefined> {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const use = scriptUseOf(value)
  if (use === undefined) return undefined
  const manifest = await manifestAt($, root)
  if (manifest === undefined) return undefined
  if (use.script in manifest.scripts) return undefined
  const yaml = await $.fs.read(`${root}/pnpm-workspace.yaml`).catch(() => '')
  const patterns = [...manifest.workspaces, ...pnpmWorkspacesIn(yaml)]
  if (use.isElsewhere) {
    if (patterns.length === 0) return undefined
    const scripts = await workspaceScripts($, root, patterns)
    if (scripts.some(found => use.script in found)) return undefined
  }
  if (!use.isRun && (await $.fs.exists(`${root}/node_modules/.bin/${use.script}`).catch(() => true))) return undefined
  const where = use.isElsewhere ? 'the root package.json or any workspace package' : 'package.json'
  return `\`${value.trim()}\` runs \`${use.script}\`, which is not a script in ${where}: name a script that exists`
}

/** The repo `gh` reads here, as `owner/name`; undefined when `gh` cannot read it. */
async function ghRepo($: EngineInterface, root: string): Promise<{ repo: string } | { error: string }> {
  const result = await $.process.run(['gh', 'repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], { cwd: root, timeoutMs: GH_TIMEOUT_MS }).catch(
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  )
  if (typeof result === 'string') return { error: result }
  const repo = result.stdout.trim()
  if (result.exitCode === 0 && /^[^/\s]+\/[^/\s]+$/.test(repo)) return { repo }
  return { error: (result.stderr.trim() || result.stdout.trim()).slice(0, 200) || `exit ${result.exitCode}` }
}

/**
 * Each named approver login checked as a collaborator on the repo; a team is not checked, as
 * GitHub answers 404 both for a missing team and one `gh` may not see. Undefined when every
 * login holds or none could be checked.
 */
async function approversProblem($: EngineInterface, root: string, value: Answer): Promise<string | undefined> {
  const logins = peopleIn(value).filter(part => !part.includes('/'))
  if (logins.length === 0) return undefined
  const repo = await ghRepo($, root)
  if ('error' in repo) return undefined
  const answers = await Promise.all(
    logins.map(login =>
      $.process.run(['gh', 'api', `repos/${repo.repo}/collaborators/${login}`], { cwd: root, timeoutMs: GH_TIMEOUT_MS }).catch(() => undefined),
    ),
  )
  const missing = logins.filter((_login, index) => {
    const answer = answers[index]
    return answer !== undefined && answer.exitCode !== 0 && /\b404\b|not found/i.test(`${answer.stderr} ${answer.stdout}`)
  })
  if (missing.length === 0) return undefined
  return `${missing.join(', ')} ${missing.length === 1 ? 'is not a collaborator' : 'are not collaborators'} on ${repo.repo}: name people who can review its PRs`
}

/**
 * One answer checked against the world as it is given, with the answers known so far (the
 * Jira site and server a project check needs). Resolves the problem, or undefined.
 */
export async function verifyAnswer($: EngineInterface, root: string, key: string, value: Answer, known: Readonly<Record<string, Answer>>): Promise<string | undefined> {
  if (typeof value === 'string' && value.trim() === '') return undefined
  if (key.endsWith('Command')) return commandProblem($, root, value)
  if (key === 'qaApprovers') return approversProblem($, root, value)
  const isJira = key === 'jiraCloudId' || key === 'jiraProject' || (JIRA_STATUS_ANSWERS.includes(key) && known.tracker === 'jira')
  if (!isJira) return undefined
  const problems = await jiraAnswerProblems($, { ...known, [key]: value })
  return problems[key]
}

/**
 * Every answer checked against the world, before a note is saved or on `/godmode setup`'s
 * check: `problems` must be fixed before saving; `warnings` are told, not blocking (a repo
 * `gh` cannot read yet, as after "I will sign in"). `keys`, when given, limits the checks to
 * those answers.
 */
export async function verifyAnswers($: EngineInterface, root: string, answers: Readonly<Record<string, Answer>>, keys?: ReadonlySet<string>) {
  const wanted = (key: string) => (keys === undefined || keys.has(key)) && answers[key] !== undefined
  const problems: Finding[] = []
  const warnings: string[] = []
  const commands = Object.keys(answers).filter(key => key.endsWith('Command') && wanted(key))
  const found = await Promise.all(commands.map(key => commandProblem($, root, answers[key] ?? '')))
  commands.forEach((key, index) => {
    const problem = found[index]
    if (problem !== undefined) problems.push({ key, problem })
  })
  const isGitHub = answers.gitHost === 'github' || (answers.gitHost === undefined && wanted('qaApprovers'))
  if (isGitHub && (keys === undefined || keys.has('gitHost'))) {
    const repo = await ghRepo($, root)
    if ('error' in repo) warnings.push(`gh cannot read this repo yet (${repo.error}): sign in with \`gh auth login\`, or the PR steps and approvals stay unchecked.`)
  }
  if (wanted('qaApprovers')) {
    const problem = await approversProblem($, root, answers.qaApprovers ?? '')
    if (problem !== undefined) problems.push({ key: 'qaApprovers', problem })
  }
  if (answers.tracker === 'jira' && JIRA_KEYS_CHECKED.some(wanted)) {
    const jira = await jiraAnswerProblems($, answers)
    for (const [key, problem] of Object.entries(jira)) problems.push({ key, problem })
  }
  return { problems, warnings }
}
