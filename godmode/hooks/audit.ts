import type { EngineInterface } from 'claude-code'

import { topicOf } from './answers'
import type { AnswerRepair } from './answers'
import { pendingUpdates } from './change-setup'
import { COMMAND_KEYS, commandKey, scanProject } from './scan'
import { fingerprintOf, godmodeVersionOf, notePath } from './storage'
import type { Answer, NoteLookup, Project } from './storage'
import { TICKET_RULES_FILE, TICKET_RULES_KEY } from './ticket-rules'
import { verifyAnswers } from './verify'

/*
 * `/godmode audit` (D75): the saved setup checked against the project as it is now, in place,
 * mid-session, after an update and a `/reload-plugins` too. It reads only; the person picks
 * the fixes, and change-setup applies them on their yes. Every helper that takes `$` is a
 * function declaration: the engine follows `$` past an import only into those.
 */

type FoundNote = Extract<NoteLookup, { status: 'found' }>

/** A saved answer that does not hold: the answer rules' or the world's word, and the topic that asks it again. */
export type AnswerFinding = { key: string; problem: string; topic?: string }

/** One thing the audit found to fix, with how. */
export type AuditIssue = { what: string; fix: string }

/** What the audit found: how many checks hold, what to fix, and what to consider adding. */
export type AuditReport = { held: number; issues: AuditIssue[]; suggestions: string[]; version: string }

const answersOf = (found: FoundNote) => ({ ...found.shared.answers, ...(found.personal?.answers ?? {}) })

/**
 * The saved answers through the answer rules and the checks against the world: what the
 * rules repaired, each answer that does not hold with the topic that asks it again, and
 * the warnings. `/godmode setup`'s `check` and `/godmode audit` both read this.
 */
export async function answerFindings($: EngineInterface, project: Project, found: FoundNote): Promise<{ repairs: AnswerRepair[]; findings: AnswerFinding[]; warnings: string[] }> {
  const { problems, warnings } = await verifyAnswers($, project.root, answersOf(found))
  const findings = [...(found.issues ?? []).map(issue => ({ key: issue.key, problem: issue.problem })), ...problems].map(entry => {
    const topic = topicOf(entry.key)
    return topic === undefined ? entry : { ...entry, topic }
  })
  return { repairs: found.repairs ?? [], findings, warnings }
}

/** How an answer is set again: its topic, or a free setting the PM passes in setup_finish. */
const fixFor = (finding: AnswerFinding) =>
  finding.topic === undefined
    ? `ask the person for the right value, then pass it in setup_finish's \`answers\` (\`${finding.key}\`)`
    : `ask it again with setup_questionnaire, \`change: ["${finding.topic}"]\``

/** Whether a branch exists here or on `origin`: true, false, or undefined when git cannot tell. */
async function branchExists($: EngineInterface, root: string, branch: string): Promise<boolean | undefined> {
  const answers = await Promise.all(
    [`refs/heads/${branch}`, `refs/remotes/origin/${branch}`].map(ref => $.process.run(['git', 'show-ref', '--verify', '--quiet', ref], { cwd: root }).catch(() => undefined)),
  )
  if (answers.some(answer => answer?.exitCode === 0)) return true
  return answers.every(answer => answer?.exitCode === 1) ? false : undefined
}

/** The conventions files that are gone or edited by hand since the note took their fingerprints. */
async function conventionsIssues($: EngineInterface, project: Project, found: FoundNote): Promise<{ issues: AuditIssue[]; held: number }> {
  const issues: AuditIssue[] = []
  for (const file of found.shared.conventions) {
    const print = await fingerprintOf($, project, file.path)
    if (print === undefined) issues.push({ what: `the conventions file ${file.path} is gone`, fix: 'restore it, or drop it from the conventions (`/godmode setup`, then setup_finish)' })
    else if (print !== file.fingerprint) issues.push({ what: `${file.path} was edited by hand since setup`, fix: `read it, then save it as checked: setup_finish with \`conventions: ["${file.path}"]\`` })
  }
  return { issues, held: found.shared.conventions.length - issues.length }
}

/** The package manager a command runs with, when it is one. */
const runnerOf = (command: Answer | undefined) => (typeof command === 'string' ? /^(npm|pnpm|yarn|bun)\b/.exec(command.trim())?.[1] : undefined)

/**
 * `/godmode audit` (D75), read-only: every saved answer through the answer rules and the
 * live checks (as `check` does), then drift against the project as it is now (a base branch
 * gone, conventions files gone or edited, the ticket rules missing on Jira, a worktree folder
 * that cannot be made), what is new since the note's godmode version, and, from a fresh
 * scan, commands or a package manager the note does not cover, as suggestions.
 */
export async function auditNote($: EngineInterface, project: Project, found: FoundNote): Promise<AuditReport> {
  const answers = answersOf(found)
  const issues: AuditIssue[] = []
  const { repairs, findings, warnings } = await answerFindings($, project, found)
  issues.push(
    ...repairs.map(repair => ({
      what: `the setup's ${repair.key} ${JSON.stringify(repair.from)} is read as ${JSON.stringify(repair.to)}`,
      fix: 'save the repaired value: setup_questionnaire with `change: ["check"]`, then setup_finish',
    })),
  )
  issues.push(...findings.map(finding => ({ what: `${finding.key} ${JSON.stringify(answers[finding.key] ?? '')} does not hold: ${finding.problem}`, fix: fixFor(finding) })))
  issues.push(...warnings.map(warning => ({ what: warning, fix: 'the person signs in; nothing to save' })))

  const base = typeof answers.baseBranch === 'string' ? answers.baseBranch : undefined
  if (base !== undefined && (await branchExists($, project.root, base)) === false) {
    issues.push({ what: `the base branch ${base} no longer exists`, fix: 'ask the person which branch replaced it, then pass it in setup_finish\'s `answers` (`baseBranch`)' })
  }
  const conventions = await conventionsIssues($, project, found)
  issues.push(...conventions.issues)
  if (answers.tracker === 'jira') {
    const rules = typeof answers[TICKET_RULES_KEY] === 'string' ? String(answers[TICKET_RULES_KEY]) : undefined
    const isThere = rules !== undefined && (await $.fs.exists(rules.startsWith('/') ? rules : `${project.root}/${rules}`).catch(() => false))
    if (!isThere) issues.push({ what: `${TICKET_RULES_FILE} is missing for this Jira project`, fix: 'learn the ticket rules: setup_questionnaire with `change: ["tickets"]`, then ticket_rules' })
  }
  const folder = typeof answers.worktreeFolder === 'string' ? answers.worktreeFolder : undefined
  if (folder !== undefined) {
    const path = folder.startsWith('/') ? folder : `${project.root}/${folder}`
    const parent = path.replace(/\/+$/, '').replace(/\/[^/]*$/, '')
    if (!(await $.fs.exists(path).catch(() => true)) && !(await $.fs.exists(parent).catch(() => true))) {
      issues.push({ what: `the worktree folder ${folder} cannot be made: ${parent} does not exist`, fix: 'pass a folder that exists in setup_finish\'s `answers` (`worktreeFolder`)' })
    }
  }
  const version = await godmodeVersionOf($).catch(() => found.shared.godmodeVersion)
  for (const entry of pendingUpdates(found.shared.godmodeVersion, version, answers)) {
    issues.push({ what: `new since godmode ${found.shared.godmodeVersion}: ${entry.what}`, fix: 'setup_questionnaire with `change: ["update"]`' })
  }

  const suggestions: string[] = []
  const facts = await scanProject($, project).catch(() => undefined)
  for (const key of facts === undefined ? [] : COMMAND_KEYS) {
    const scanned = facts?.commands[key]
    if (key === 'install' || scanned === undefined || answers[commandKey(key)] !== undefined) continue
    suggestions.push(`the project now has a ${key} command, \`${scanned}\`: add it with setup_finish's \`answers\` (\`${commandKey(key)}\`)`)
  }
  const manager = facts?.stacks[0]?.packageManager
  const runners = [...new Set(COMMAND_KEYS.flatMap(key => runnerOf(answers[commandKey(key)]) ?? []))]
  if (manager !== undefined && runners.length > 0 && !runners.includes(manager)) {
    suggestions.push(`the project now uses ${manager}, and the saved commands use ${runners.join(', ')}: update them with setup_finish's \`answers\``)
  }

  const checked = Object.keys(answers).length + found.shared.conventions.length
  const held = Math.max(0, checked - findings.length - repairs.length - (conventions.issues.length))
  return { held, issues, suggestions, version }
}

/** The report the person reads: the checks that hold as a count, then each issue with its fix; one line when all is well. */
export const auditText = (report: AuditReport, where: string) => {
  if (report.issues.length === 0 && report.suggestions.length === 0) return `godmode audit: all ${report.held} checks hold for godmode ${report.version}.`
  return [
    `godmode audit of ${where}: ${report.held} checks hold; ${report.issues.length} to fix${report.suggestions.length === 0 ? '' : `, ${report.suggestions.length} to consider`}.`,
    ...report.issues.map((issue, index) => `${index + 1}. ${issue.what}. Fix: ${issue.fix}.`),
    ...report.suggestions.map(suggestion => `- Consider: ${suggestion}.`),
    'Nothing has changed. Say which fixes to apply; each is saved only on your yes.',
  ].join('\n')
}

/** What the PM is told after an audit with findings: apply only the fixes the person picks, through change-setup. */
export const auditBrief = (report: AuditReport) =>
  [
    'godmode is in change-setup mode for the audit above. Apply only the fixes the person picks, each the way its "Fix" says: setup_questionnaire with `change` for a topic (it asks them), setup_finish with `answers` for a free setting and `conventions` for a file re-checked, ticket_rules for the ticket rules. setup_finish shows the person every change and saves only on their yes. When they pick none, call setup_finish with nothing: it ends the change unsaved.',
    ...report.issues.map((issue, index) => `${index + 1}. ${issue.what}. Fix: ${issue.fix}.`),
    ...report.suggestions.map(suggestion => `- Consider: ${suggestion}.`),
  ].join('\n')

/** The store key that remembers which loaded godmode version the person was told about, per project. */
export const auditNoticeKey = (project: Project) => `auditNotice:${project.id}`

/**
 * The one line that suggests `/godmode audit` after an update (D75): when the godmode loaded
 * now differs from the note's version, once per loaded version. A `/reload-plugins` may not
 * start a session, so the prompt hook asks this; it never runs the audit itself.
 */
export async function auditNotice($: EngineInterface, project: Project, found: FoundNote): Promise<string | undefined> {
  const version = await godmodeVersionOf($).catch(() => undefined)
  if (version === undefined || version === found.shared.godmodeVersion) return undefined
  const told: unknown = await $.store.get(auditNoticeKey(project)).catch(() => undefined)
  if (told === version) return undefined
  await $.store.set(auditNoticeKey(project), version).catch(() => undefined)
  return `godmode ${version} is loaded, and this project's setup (${notePath(project, found.dir)}) was written by ${found.shared.godmodeVersion}: \`/godmode audit\` checks it against the project and the new version.`
}
