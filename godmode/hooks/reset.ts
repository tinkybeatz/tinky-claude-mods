import { atom, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { DispatchedAgent, GodmodeMode, PaneRow, PaneTicket, PendingReview, SetupRun, TryRun, Unlock } from '../types'
import { worktreePathOf } from './loop'
import { closeGodmodePane } from './pane'
import { PROJECT_RULES_FILE } from './project-rules'
import { isInside, normalisePath, settingsOf } from './rules'
import { claudeDirOf, noteDir, notePath, pathId, readNote, REPO_FOLDER } from './storage'
import type { NoteLookup, Project } from './storage'
import { TICKET_RULES_FILE } from './ticket-rules'
import { TRY_RECORDS_KEY } from './try'
import { logLines } from './ui-text'

/*
 * `/godmode reset` (0.8.2): every trace godmode left in the current project, listed first and
 * wiped only on the person's "Wipe". godmode's own folders (the note's folder, the outside
 * folder with the tracker's side files), the files setup wrote, the ignore lines it added, its
 * store keys and this session's state, a running try, and the worktrees it made when they hold
 * no work. Never the project's own files, its commits, pushed branches, PRs, tracker tickets,
 * or convention files the team already had. The person runs it, so no gate applies but the
 * question. Every helper that takes `$` is a function declaration.
 */

// The same state as the other files' atoms, each set back to its start.
const isOn = atom({ plugin: 'godmode', key: 'isOn' } as const, false)
const mode = atom({ plugin: 'godmode', key: 'mode' } as const, 'coding' as GodmodeMode)
const agents = atom({ plugin: 'godmode', key: 'agents' } as const, {} as Record<string, DispatchedAgent>)
const pendingReviews = atom({ plugin: 'godmode', key: 'pendingReviews' } as const, [] as PendingReview[])
const unlocks = atom({ plugin: 'godmode', key: 'unlocks' } as const, [] as Unlock[])
const mainThreadReads = atom({ plugin: 'godmode', key: 'mainThreadReads' } as const, 0)
const recheck = atom({ plugin: 'godmode', key: 'recheck' } as const, [] as string[])
const setupRun = atom({ plugin: 'godmode', key: 'setupRun' } as const, { consented: [], written: [] } as SetupRun)
const setupReport = atom({ plugin: 'godmode', key: 'setupReport' } as const, '')
const tryRun = atom({ plugin: 'godmode', key: 'tryRun' } as const, null as TryRun | null)
const paneRows = atom({ plugin: 'godmode', key: 'paneRows' } as const, [] as PaneRow[])
const paneTickets = atom({ plugin: 'godmode', key: 'paneTickets' } as const, [] as PaneTicket[])
const paneFallback = atom({ plugin: 'godmode', key: 'paneFallback' } as const, false)
const paneClosed = atom({ plugin: 'godmode', key: 'paneClosed' } as const, false)

/** A worktree godmode made for a ticket: its folder and branch, and whether it holds work. */
export type GodmodeWorktree = { path: string; branch: string; work?: string }

/** Everything `/godmode reset` found for this project. Paths are absolute. */
export type ResetPlan = {
  /** godmode's own folders: the note's folder in the repo, the folder outside it. */
  folders: string[]
  /** Files setup wrote outside those folders: templates, the rules file, the ticket rules. */
  files: string[]
  /** `.gitignore` and `.git/info/exclude`, where godmode added lines. */
  ignoreFiles: string[]
  /** godmode's store keys for this project. */
  storeKeys: string[]
  /** Records of `/godmode try` apps in this project, kept in the store. */
  tryRecords: number
  /** Worktrees godmode made: removed when clean and pushed, else kept. */
  worktrees: GodmodeWorktree[]
  /** Convention files the note lists that godmode did not write, or cannot tell it wrote: never touched. */
  teamFiles: string[]
  /** Whether a `/godmode try` app runs now. */
  isTrying: boolean
  /** Where godmode puts ticket worktrees for this project. */
  worktreeFolder: string
}

/** Whether a stored try record is of an app this project's worktrees ran. */
const isProjectTry = (record: unknown, folder: string) => {
  if (typeof record !== 'object' || record === null || !('worktree' in record)) return false
  return typeof record.worktree === 'string' && isInside(record.worktree, folder)
}

/** The comments godmode writes above its ignore lines, and the lines themselves. */
const IGNORE_COMMENTS: readonly string[] = ['# godmode: personal setup, never committed', '# godmode: setup kept on this machine only']
const IGNORE_LINES: readonly string[] = [`${REPO_FOLDER}/`, `${REPO_FOLDER}/personal.json`, `/${REPO_FOLDER}/`, `/${REPO_FOLDER}/personal.json`]

/**
 * An ignore file's text without the block godmode added: its comment and the lines under it
 * that are godmode's, and the blank line it put before the comment. Undefined when it holds none.
 */
export const withoutGodmodeLines = (text: string): string | undefined => {
  const lines = text.split('\n')
  const kept: string[] = []
  let isChanged = false
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (!IGNORE_COMMENTS.includes(line.trim())) {
      kept.push(line)
      continue
    }
    isChanged = true
    while (IGNORE_LINES.includes((lines[index + 1] ?? '').trim())) index += 1
    if (kept.length > 0 && kept.at(-1)?.trim() === '') kept.pop()
  }
  if (!isChanged) return undefined
  const joined = kept.join('\n')
  return joined.trim() === '' ? '' : `${joined.replace(/\n*$/, '')}\n`
}

/** The worktrees `git worktree list --porcelain` names, each with its branch. */
export const worktreesIn = (porcelain: string) =>
  porcelain
    .split(/\n\s*\n/)
    .flatMap(block => {
      const path = /^worktree (.+)$/m.exec(block)?.[1]
      const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1]
      return path === undefined || branch === undefined ? [] : [{ path, branch }]
    })

/** The store keys that are this project's: keyed by its id, or a Jira creator of its project. */
export const projectStoreKeys = (keys: readonly string[], project: Project, jiraProject: string | undefined) =>
  keys.filter(key => {
    if (key.split(':').includes(project.id) || key.split(':').includes(pathId(project.root))) return true
    return jiraProject !== undefined && key.startsWith('jiraCreator:') && new RegExp(`:${jiraProject.replace(/[^A-Za-z0-9_]/g, '')}-\\d+$`, 'i').test(key)
  })

/** What a worktree holds that is not on any remote: uncommitted changes, or commits not pushed. Undefined when it is clean and pushed. */
async function workIn($: EngineInterface, path: string) {
  const status = await $.process.run(['git', 'status', '--porcelain'], { cwd: path }).catch(() => undefined)
  if (status?.exitCode !== 0) return 'its state could not be read'
  if (status.stdout.trim() !== '') return 'uncommitted changes'
  const pushed = await $.process.run(['git', 'branch', '-r', '--contains', 'HEAD'], { cwd: path }).catch(() => undefined)
  if (pushed?.exitCode !== 0 || pushed.stdout.trim() === '') return 'commits not pushed'
  return undefined
}

/** Whether a path exists; a failed check counts as absent. */
async function exists($: EngineInterface, path: string) {
  return $.fs.exists(path).catch(() => false)
}

/** The files the note lists that godmode wrote, and the team's own it never touches. */
function filesOf(found: NoteLookup | undefined, project: Project, folders: readonly string[]) {
  if (found?.status !== 'found') return { files: [] as string[], teamFiles: [] as string[] }
  const absolute = (path: string) => (path.startsWith('/') ? path : `${project.root}/${path}`)
  const written = new Set((found.shared.written ?? []).map(absolute))
  const isOwnName = (path: string) => [PROJECT_RULES_FILE, TICKET_RULES_FILE].some(name => path.endsWith(`/${name}`))
  const files: string[] = []
  const teamFiles: string[] = []
  for (const listed of [...new Set([...found.shared.conventions.map(file => absolute(file.path)), ...written])]) {
    if (folders.some(folder => isInside(listed, folder))) continue
    if (written.has(listed) || isOwnName(listed)) files.push(listed)
    else teamFiles.push(listed)
  }
  return { files, teamFiles }
}

/** Everything godmode left in this project, found without changing anything. */
export async function resetPlan($: EngineInterface, project: Project, isTrying: boolean): Promise<ResetPlan> {
  const found = await readNote($, project).catch(() => undefined)
  const claudeDir = await claudeDirOf($)
  const candidates = [noteDir(project, 'committed', claudeDir), noteDir(project, 'outside', claudeDir), noteDir({ ...project, id: pathId(project.root) }, 'outside', claudeDir)]
  const folders: string[] = []
  for (const folder of candidates) if (folder !== undefined && !folders.includes(folder) && (await exists($, folder))) folders.push(folder)
  const { files: listed, teamFiles } = filesOf(found, project, folders)
  const files: string[] = []
  for (const file of listed) if (await exists($, file)) files.push(file)
  const ignoreFiles: string[] = []
  const commonDir = (await $.process.run(['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: project.root }).catch(() => undefined))?.stdout.trim()
  for (const path of [`${project.root}/.gitignore`, ...(commonDir === undefined || commonDir === '' ? [] : [`${commonDir}/info/exclude`])]) {
    const text = (await exists($, path)) ? await $.fs.read(path).catch(() => '') : ''
    if (withoutGodmodeLines(text) !== undefined) ignoreFiles.push(path)
  }
  const answers = found?.status === 'found' ? { ...found.shared.answers, ...(found.personal?.answers ?? {}) } : {}
  const jiraProject = typeof answers.jiraProject === 'string' ? answers.jiraProject : undefined
  const storeKeys = projectStoreKeys(await $.store.keys().catch(() => []), project, jiraProject)
  const settings = settingsOf(answers)
  const worktreeFolder = worktreePathOf(project, settings, 'x').replace(/\/x$/, '')
  const records: unknown = await $.store.get(TRY_RECORDS_KEY).catch(() => undefined)
  const tryRecords = Array.isArray(records) ? records.filter(record => isProjectTry(record, worktreeFolder)).length : 0
  const listing = await $.process.run(['git', 'worktree', 'list', '--porcelain'], { cwd: project.root }).catch(() => undefined)
  const worktrees: GodmodeWorktree[] = []
  for (const tree of worktreesIn(listing?.exitCode === 0 ? listing.stdout : '')) {
    if (!isInside(tree.path, worktreeFolder) || normalisePath(tree.path) === normalisePath(project.root) || !tree.branch.startsWith(settings.branchPrefix)) continue
    const work = await workIn($, tree.path)
    worktrees.push(work === undefined ? tree : { ...tree, work })
  }
  return { folders, files, ignoreFiles, storeKeys, tryRecords, worktrees, teamFiles, isTrying, worktreeFolder }
}

/** Whether the plan finds anything to wipe. */
export const isEmptyPlan = (plan: ResetPlan) =>
  plan.folders.length + plan.files.length + plan.ignoreFiles.length + plan.storeKeys.length + plan.tryRecords + plan.worktrees.length === 0 && !plan.isTrying

/** The list the person reads before the question, one log line each. */
export const planLines = (plan: ResetPlan, project: Project) => {
  const shown = (path: string) => notePath(project, path)
  return [
    'godmode would wipe from this project:',
    ...plan.folders.map(folder => `- ${shown(folder)}/ (godmode's folder: its note, tickets, records and side files)`),
    ...plan.files.map(file => `- ${shown(file)} (written by godmode's setup)`),
    ...plan.ignoreFiles.map(file => `- the lines godmode added to ${shown(file)}`),
    ...(plan.storeKeys.length === 0 ? [] : [`- godmode's records for this project: ${plan.storeKeys.join(', ')}`]),
    ...(plan.tryRecords === 0 ? [] : [`- ${plan.tryRecords} record${plan.tryRecords === 1 ? '' : 's'} of /godmode try apps`]),
    ...(plan.isTrying ? ['- the app /godmode try is running (it is stopped)'] : []),
    '- this session\'s godmode state (agents, asks, the side pane); godmode turns off',
    ...plan.worktrees.filter(tree => tree.work === undefined).map(tree => `- worktree ${tree.path} and its local branch ${tree.branch} (clean and pushed)`),
    ...plan.worktrees.filter(tree => tree.work !== undefined).map(tree => `Kept, it holds work: ${tree.path} (${tree.work})`),
    ...plan.teamFiles.map(file => `Kept, the project's own: ${shown(file)}`),
    'Never touched: the project\'s own files, commits, pushed branches, PRs and tracker tickets.',
  ]
}

/** Removes a path godmode owns; refuses anything outside the project or godmode's own folder. */
async function remove($: EngineInterface, project: Project, path: string) {
  const claudeDir = await claudeDirOf($)
  const isOurs = isInside(path, project.root) || (claudeDir !== undefined && isInside(path, `${claudeDir}/godmode/projects`))
  if (!isOurs || normalisePath(path) === normalisePath(project.root)) return false
  const result = await $.process.run(['rm', '-rf', path], { cwd: project.root }).catch(() => undefined)
  return result?.exitCode === 0
}

/** The files among `paths` that git tracks: their deletion is left for the person to commit. */
async function trackedOf($: EngineInterface, project: Project, paths: readonly string[]) {
  const inside = paths.filter(path => isInside(path, project.root)).map(path => notePath(project, path))
  if (inside.length === 0) return []
  const listed = await $.process.run(['git', 'ls-files', '--', ...inside], { cwd: project.root }).catch(() => undefined)
  return listed?.exitCode === 0 ? listed.stdout.split('\n').map(line => line.trim()).filter(line => line !== '') : []
}

/**
 * Wipes what the plan found: a running try first, then the worktrees that hold no work and
 * their local branches, godmode's folders and files, its ignore lines, its store keys and this
 * session's state; godmode turns off and the side pane closes. Commits nothing. Resolves the
 * lines that say what was left for the person.
 */
export async function wipe($: EngineInterface, project: Project, plan: ResetPlan, stopTry: () => Promise<unknown>) {
  const notes: string[] = []
  if (plan.isTrying) await stopTry().catch(() => undefined)
  for (const tree of plan.worktrees) {
    if (tree.work !== undefined) continue
    const removed = await $.process.run(['git', 'worktree', 'remove', tree.path], { cwd: project.root }).catch(() => undefined)
    if (removed?.exitCode !== 0) {
      notes.push(`Kept, git would not remove it: ${tree.path}`)
      continue
    }
    await $.process.run(['git', 'branch', '-D', tree.branch], { cwd: project.root }).catch(() => undefined)
  }
  const tracked = await trackedOf($, project, [...plan.folders, ...plan.files])
  for (const path of [...plan.folders, ...plan.files]) if (!(await remove($, project, path))) notes.push(`Could not remove ${notePath(project, path)}; delete it by hand.`)
  for (const path of plan.ignoreFiles) {
    const cleaned = withoutGodmodeLines(await $.fs.read(path).catch(() => ''))
    if (cleaned !== undefined) await $.fs.write(path, cleaned).catch(() => notes.push(`Could not edit ${path}; remove godmode's lines by hand.`))
  }
  for (const key of plan.storeKeys) await $.store.delete(key).catch(() => undefined)
  if (plan.tryRecords > 0) {
    const records: unknown = await $.store.get(TRY_RECORDS_KEY).catch(() => undefined)
    const left = Array.isArray(records) ? records.filter(record => !isProjectTry(record, plan.worktreeFolder)) : []
    await $.store.set(TRY_RECORDS_KEY, left).catch(() => undefined)
  }
  await closeGodmodePane($).catch(() => undefined)
  await update($, isOn, () => false)
  await update($, mode, () => 'coding')
  await update($, agents, () => ({}))
  await update($, pendingReviews, () => [])
  await update($, unlocks, () => [])
  await update($, mainThreadReads, () => 0)
  await update($, recheck, () => [])
  await update($, setupRun, () => ({ consented: [], written: [] }))
  await update($, setupReport, () => '')
  await update($, tryRun, () => null)
  await update($, paneRows, () => [])
  await update($, paneTickets, () => [])
  await update($, paneFallback, () => false)
  await update($, paneClosed, () => false)
  if (tracked.length > 0) notes.push(`These deletions are in the working tree, not committed: ${tracked.join(', ')}. Commit them when you are ready.`)
  return notes
}

/** The question before anything goes. */
export const WIPE = 'Wipe'
export const CANCEL = 'Cancel'

/**
 * `/godmode reset`: the list, one question, and the wipe on "Wipe". A project godmode never
 * touched has nothing to wipe, and a partial setup wipes what it left. Resolves the command's text.
 */
export async function runReset($: EngineInterface, project: Project, isTrying: boolean, stopTry: () => Promise<unknown>) {
  const plan = await resetPlan($, project, isTrying)
  if (isEmptyPlan(plan)) return 'godmode has nothing to wipe in this project: it was never set up here.'
  logLines($, planLines(plan, project).join('\n'))
  let answer: string
  try {
    answer = await $.ui.ask('Wipe all of this?', { options: [WIPE, CANCEL], header: 'Reset' })
  } catch {
    answer = CANCEL
  }
  if (answer !== WIPE) return 'Nothing was wiped: godmode is as it was.'
  const notes = await wipe($, project, plan, stopTry)
  return [...notes, 'godmode is gone from this project. `/godmode` starts a fresh setup.'].join('\n')
}
