import type { EngineInterface } from 'claude-code'

/**
 * Where a project's godmode setup lives (D19): `committed` in the repo, shared with
 * everyone who clones it; `gitignored` in the repo but on this disk only (ignored through
 * `.git/info/exclude`, so the repo itself is untouched); `outside` under
 * Claude Code's configuration folder, the project folder untouched.
 */
export type StorageMode = 'committed' | 'gitignored' | 'outside'

export const STORAGE_MODES: readonly StorageMode[] = ['committed', 'gitignored', 'outside']

/**
 * The folder in the repo that holds godmode's own files in the committed and gitignored
 * modes. A dot folder like `.github/`, named after the mod so whoever finds it knows what
 * wrote it, and one folder is one ignore line in gitignored mode. Not under
 * `.claude/`: Claude Code reads that folder itself (settings, rules, agents, skills), so
 * a file there can change every session, and teams often keep it by hand.
 */
export const REPO_FOLDER = '.godmode'

/**
 * The note is two files (D61). The shared one is committed in committed mode; the
 * personal one never is. In the other two modes both are personal and sit side by side.
 * JSON, because only the mod writes them and the environment parses it with no code of
 * ours; pretty-printed, so a committed note's diff reads line by line.
 */
export const SHARED_NOTE = 'shared.json'
export const PERSONAL_NOTE = 'personal.json'

/** The roles godmode dispatches (D33). The PM is the main thread, on the session's model (D39). */
export type AgentRole = 'dev' | 'reviewer' | 'setup' | 'researcher' | 'qa'

export type ModelTier = 'haiku' | 'sonnet' | 'opus'

/** A questionnaire answer (D18, D19, D23, D15, D34); Step 3 names the questions. */
export type Answer = string | number | boolean

/** A conventions file the setup checked, and the fingerprint of the text it checked. */
export type ConventionsFile = {
  /** Relative to the project root, or absolute for a file outside the repo. */
  path: string
  /** `sha256:<hex>` of the file's text; see `fingerprint`. */
  fingerprint: string
}

/** What the whole team shares in committed mode (D61): everything quality depends on. */
export type SharedNote = {
  /** The godmode version that wrote the conventions; an older one prompts the update notice (D60). */
  godmodeVersion: string
  storage: StorageMode
  /** When the note was written, ISO 8601. */
  writtenAt: string
  /** Shared answers: tracker choice, start command, QA on or off. */
  answers: Record<string, Answer>
  /** The lowest model each role may run on (D62); personal settings raise it, never lower it. */
  minimumModels: Partial<Record<AgentRole, ModelTier>>
  conventions: ConventionsFile[]
}

/** What stays one person's (D61): permissions, attribution, models, caps, tracker identity. */
export type PersonalNote = {
  writtenAt: string
  answers: Record<string, Answer>
  /** The models this person picked per role (D39); below a shared minimum they are raised to it. */
  models: Partial<Record<AgentRole, ModelTier>>
}

/** A project, named so its note is found in every storage mode (D20). */
export type Project = {
  /**
   * The repo's first commit hash: the same in every clone and worktree, and it survives a
   * move or rename of the folder. Without git, or before the first commit, `path-` and the
   * folder path. D54 refuses a folder with no git; naming it must still not fail.
   */
  id: string
  /** The main working tree's root, so a session in a worktree finds the same note; without git, the session's root. */
  root: string
  hasGit: boolean
}

/** What `readNote` found. `personal` is absent for a teammate who has not answered yet (D61). */
export type NoteLookup =
  | { status: 'none'; project: Project }
  | { status: 'unreadable'; project: Project; path: string; reason: string }
  | { status: 'found'; project: Project; dir: string; shared: SharedNote; personal?: PersonalNote }

/** The default model per role (D39). */
export const DEFAULT_MODELS: Readonly<Record<AgentRole, ModelTier>> = {
  dev: 'sonnet',
  reviewer: 'opus',
  setup: 'opus',
  researcher: 'sonnet',
  qa: 'sonnet',
}

const MODEL_RANK: Readonly<Record<ModelTier, number>> = { haiku: 0, sonnet: 1, opus: 2 }

/**
 * The model a role runs on: the person's pick, or the default, raised to the shared
 * minimum when below it (D62). Only committed mode has a minimum anyone else set.
 */
export const effectiveModel = (
  role: AgentRole,
  note?: { shared?: Pick<SharedNote, 'minimumModels'>; personal?: Pick<PersonalNote, 'models'> },
): ModelTier => {
  const picked = note?.personal?.models[role] ?? DEFAULT_MODELS[role]
  const minimum = note?.shared?.minimumModels[role]
  return minimum !== undefined && MODEL_RANK[minimum] > MODEL_RANK[picked] ? minimum : picked
}

/**
 * A file's fingerprint: SHA-256 through `crypto.subtle`, which the hooks environment has
 * (there is no Node `crypto`). Line endings are made `\n` first, so a checkout that turns
 * them into `\r\n` does not count as an edit.
 */
export const fingerprint = async (text: string) => {
  const bytes = new TextEncoder().encode(text.replace(/\r\n/g, '\n'))
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return `sha256:${[...digest].map(byte => byte.toString(16).padStart(2, '0')).join('')}`
}

/** Whether version `a` is older than `b`, comparing the numbers of `major.minor.patch`. */
export const isOlderVersion = (a: string, b: string) => {
  const numbers = (version: string) => version.split(/[.+-]/).slice(0, 3).map(part => Number.parseInt(part, 10) || 0)
  const [left, right] = [numbers(a), numbers(b)]
  for (let index = 0; index < 3; index += 1) {
    if ((left[index] ?? 0) !== (right[index] ?? 0)) return (left[index] ?? 0) < (right[index] ?? 0)
  }
  return false
}

const isAbsolute = (path: string) => path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path)

const join = (folder: string, path: string) => (isAbsolute(path) ? path : `${folder.replace(/[\\/]+$/, '')}/${path}`)

/*
 * Every helper that takes `$` is a function declaration, not an arrow function: the
 * engine follows `$` past an import only into a function declaration, and refuses to load
 * the module otherwise.
 */

/** Runs git in `cwd`; its standard output, or undefined when git is missing or fails. */
async function git($: EngineInterface, cwd: string, args: string[]) {
  const result = await $.process.run(['git', ...args], { cwd }).catch(() => undefined)
  return result?.exitCode === 0 ? result.stdout : undefined
}

const pathId = (root: string) => `path-${root.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`

/** The project the session runs in (see `Project`). */
export async function projectOf($: EngineInterface): Promise<Project> {
  const base = await $.session.root()
  const worktrees = await git($, base, ['worktree', 'list', '--porcelain'])
  if (worktrees === undefined) return { id: pathId(base), root: base, hasGit: false }

  // The first entry is the main working tree; a bare main has none, so keep the session's.
  const main = worktrees.split(/\n\s*\n/)[0] ?? ''
  const root = /^bare$/m.test(main) ? base : (/^worktree (.+)$/m.exec(main)?.[1] ?? base)
  // A history merged from elsewhere has several roots; git lists the newest first.
  const firstCommit = (await git($, root, ['rev-list', '--max-parents=0', 'HEAD']))?.trim().split('\n').at(-1)
  return { id: firstCommit !== undefined && firstCommit !== '' ? firstCommit : pathId(root), root, hasGit: true }
}

/** Claude Code's configuration folder: `CLAUDE_CONFIG_DIR`, else `~/.claude`; undefined with no home. */
export async function claudeDirOf($: EngineInterface) {
  const configured = await $.env.get('CLAUDE_CONFIG_DIR')
  if (configured !== undefined && configured !== '') return configured
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'))
  return home === undefined || home === '' ? undefined : `${home}/.claude`
}

/** The folder holding a project's note in a storage mode; undefined for `outside` with no home. */
export const noteDir = (project: Project, mode: StorageMode, claudeDir: string | undefined) => {
  if (mode !== 'outside') return `${project.root}/${REPO_FOLDER}`
  return claudeDir === undefined ? undefined : `${claudeDir}/godmode/projects/${project.id}`
}

/**
 * The ignore lines a storage mode needs: committed mode ignores the personal note alone
 * (D61) in `.gitignore`, for every clone; gitignored mode the whole folder, in
 * `.git/info/exclude` (see `ensureExcluded`).
 */
export const gitignoreLines = (mode: StorageMode): string[] => {
  if (mode === 'committed') return [`${REPO_FOLDER}/${PERSONAL_NOTE}`]
  if (mode === 'gitignored') return [`${REPO_FOLDER}/`]
  return []
}

/**
 * `.gitignore`'s text with `lines` added under a godmode comment, or undefined when each is
 * already there (as written, or anchored with a leading `/`).
 */
export const withGitignoreLines = (
  current: string,
  lines: readonly string[],
  comment = 'godmode: personal setup, never committed',
) => {
  const present = new Set(current.split(/\r?\n/).map(line => line.trim().replace(/^\//, '')))
  const missing = lines.filter(line => !present.has(line.replace(/^\//, '')))
  if (missing.length === 0) return undefined
  const head = current === '' || current.endsWith('\n') ? current : `${current}\n`
  const gap = head === '' ? '' : '\n'
  return `${head}${gap}# ${comment}\n${missing.join('\n')}\n`
}

/** Adds `lines` to the project's `.gitignore` once; true when it wrote. */
export async function ensureGitignore($: EngineInterface, project: Project, lines: readonly string[]) {
  if (lines.length === 0) return false
  const path = `${project.root}/.gitignore`
  const current = (await $.fs.exists(path)) ? await $.fs.read(path) : ''
  const updated = withGitignoreLines(current, lines)
  if (updated === undefined) return false
  await $.fs.write(path, updated)
  return true
}

/**
 * Adds `lines` to the repo's `.git/info/exclude` once; true when it wrote. Gitignored mode
 * uses it rather than `.gitignore`, a tracked file whose edit would show as a change and
 * could be committed by mistake. The exclude file lives in git's common folder, so every
 * worktree of the repo honours it.
 */
export async function ensureExcluded($: EngineInterface, project: Project, lines: readonly string[]) {
  if (lines.length === 0 || !project.hasGit) return false
  const commonDir = (await git($, project.root, ['rev-parse', '--path-format=absolute', '--git-common-dir']))?.trim()
  if (commonDir === undefined || commonDir === '') return false
  const path = `${commonDir}/info/exclude`
  const current = (await $.fs.exists(path)) ? await $.fs.read(path) : ''
  const updated = withGitignoreLines(current, lines, 'godmode: setup kept on this machine only')
  if (updated === undefined) return false
  await $.fs.write(path, updated)
  return true
}

/** The version in this mod's `plugin.json`, the one a new note records. */
export async function godmodeVersionOf($: EngineInterface) {
  const manifest = JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`)) as { version?: unknown }
  return typeof manifest.version === 'string' ? manifest.version : '0.0.0'
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isSharedNote = (value: unknown): value is SharedNote =>
  isRecord(value) &&
  typeof value.godmodeVersion === 'string' &&
  STORAGE_MODES.includes(value.storage as StorageMode) &&
  typeof value.writtenAt === 'string' &&
  isRecord(value.answers) &&
  isRecord(value.minimumModels) &&
  Array.isArray(value.conventions) &&
  value.conventions.every(file => isRecord(file) && typeof file.path === 'string' && typeof file.fingerprint === 'string')

const isPersonalNote = (value: unknown): value is PersonalNote =>
  isRecord(value) && typeof value.writtenAt === 'string' && isRecord(value.answers) && isRecord(value.models)

const parse = <T>(text: string, check: (value: unknown) => value is T): T | string => {
  try {
    const value: unknown = JSON.parse(text)
    return check(value) ? value : 'it is not a godmode note'
  } catch (error) {
    return `it is not valid JSON (${error instanceof Error ? error.message : String(error)})`
  }
}

/**
 * Finds the project's note: in the repo's `.godmode/` first (committed or gitignored, the
 * note says which), then outside the repo. The personal half sits beside the shared one.
 */
export async function readNote($: EngineInterface, project?: Project): Promise<NoteLookup> {
  const at = project ?? (await projectOf($))
  const claudeDir = await claudeDirOf($)
  const dirs = [noteDir(at, 'committed', claudeDir), noteDir(at, 'outside', claudeDir)]
  for (const dir of dirs) {
    if (dir === undefined || !(await $.fs.exists(`${dir}/${SHARED_NOTE}`))) continue
    const sharedPath = `${dir}/${SHARED_NOTE}`
    const shared = parse(await $.fs.read(sharedPath), isSharedNote)
    if (typeof shared === 'string') return { status: 'unreadable', project: at, path: sharedPath, reason: shared }
    const personalPath = `${dir}/${PERSONAL_NOTE}`
    if (!(await $.fs.exists(personalPath))) return { status: 'found', project: at, dir, shared }
    const personal = parse(await $.fs.read(personalPath), isPersonalNote)
    if (typeof personal === 'string') return { status: 'unreadable', project: at, path: personalPath, reason: personal }
    return { status: 'found', project: at, dir, shared, personal }
  }
  return { status: 'none', project: at }
}

/** What the setup hands `writeNote`; the version and the date are stamped on writing. */
export type NoteDraft = {
  storage: StorageMode
  sharedAnswers: Record<string, Answer>
  minimumModels: Partial<Record<AgentRole, ModelTier>>
  /** Paths of the conventions files the setup checked; their fingerprints are taken now. */
  conventions: string[]
  personalAnswers: Record<string, Answer>
  models: Partial<Record<AgentRole, ModelTier>>
}

/**
 * Writes both halves of the note in the draft's storage and adds the mode's ignore
 * lines. Step 3 calls it when setup ends; resolves the folder written to.
 */
export async function writeNote($: EngineInterface, draft: NoteDraft, project?: Project) {
  const at = project ?? (await projectOf($))
  const dir = noteDir(at, draft.storage, await claudeDirOf($))
  if (dir === undefined) throw new Error('no home folder to keep the note outside the repo')
  const writtenAt = new Date(await $.clock.now()).toISOString()
  const conventions: ConventionsFile[] = []
  for (const path of draft.conventions) {
    const fileFingerprint = await fingerprintOf($, at, path)
    if (fileFingerprint !== undefined) conventions.push({ path, fingerprint: fileFingerprint })
  }
  const shared: SharedNote = {
    godmodeVersion: await godmodeVersionOf($),
    storage: draft.storage,
    writtenAt,
    answers: draft.sharedAnswers,
    minimumModels: draft.minimumModels,
    conventions,
  }
  const personal: PersonalNote = { writtenAt, answers: draft.personalAnswers, models: draft.models }
  if (draft.storage === 'gitignored') await ensureExcluded($, at, gitignoreLines(draft.storage))
  else await ensureGitignore($, at, gitignoreLines(draft.storage))
  await $.fs.write(`${dir}/${SHARED_NOTE}`, `${JSON.stringify(shared, null, 2)}\n`)
  await $.fs.write(`${dir}/${PERSONAL_NOTE}`, `${JSON.stringify(personal, null, 2)}\n`)
  return dir
}

/** A conventions file's fingerprint now, or undefined when it is gone. */
export async function fingerprintOf($: EngineInterface, project: Project, path: string) {
  const full = join(project.root, path)
  if (!(await $.fs.exists(full))) return undefined
  return fingerprint(await $.fs.read(full))
}

/** The conventions files edited or removed since the note was written; each is re-checked alone (D20). */
export async function changedConventions($: EngineInterface, project: Project, conventions: readonly ConventionsFile[]) {
  const changed: string[] = []
  for (const file of conventions) {
    if ((await fingerprintOf($, project, file.path)) !== file.fingerprint) changed.push(file.path)
  }
  return changed
}
