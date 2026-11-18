import type { EngineInterface } from 'claude-code'

import type { Answer } from './storage'

/*
 * The PM's role for the main thread (D63, D64). `agents/pm.md` is written like the other
 * role prompts, but the PM is the main thread, never a dispatched agent: the module hides
 * its agent type and hands its body to the main thread through the channels that run on
 * every kind of account, `command.run`'s context when `/godmode` switches on and
 * `prompt.submit`'s context after a setup and as a one-line reminder on each prompt.
 * `prompt.compose`, which an organisation's security plugin can pass over, is not used.
 */

/** The PM's agent type, hidden from the model's list of agents. */
export const PM_AGENT = 'godmode:pm'

/** A role file's body: the text after its front matter. */
export const bodyOf = (text: string) => text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim()

/**
 * A role file's body with `${CLAUDE_PLUGIN_ROOT}` made the plugin's folder. The engine
 * expands it in an agent's prompt and a skill's body, but not in a file a hook reads.
 */
export const expandRoot = (text: string, root: string) => text.split('${CLAUDE_PLUGIN_ROOT}').join(root.replace(/[\\/]+$/, ''))

/** The one line each prompt carries while godmode is on in coding mode, so the role survives compaction. */
export const pmReminder = (root: string) =>
  `godmode is on: you are its PM. Keep this thread for talking, tickets and dispatch; agents do the work. If your role is no longer in view, read ${root.replace(/[\\/]+$/, '')}/agents/pm.md.`

/** The PM's role, ready for the main thread; undefined when the file cannot be read. */
export async function pmRoleOf($: EngineInterface) {
  const text = await $.fs.read(`${$.plugin.root}/agents/pm.md`).catch(() => undefined)
  if (text === undefined || bodyOf(text) === '') return undefined
  return expandRoot(bodyOf(text), $.plugin.root)
}

/** The four QA modes (D69): people test the PR, people test on staging, the QA agent tests, or no QA. */
export const QA_MODES = ['human-pr', 'human-staging', 'bot', 'none'] as const

export type QaMode = (typeof QA_MODES)[number]

/** What each mode means for the PM, until `agents/pm.md` gives the flow per mode (Step 13.4). */
const QA_MODE_MEANING: Readonly<Record<QaMode, string>> = {
  'human-pr': 'people test the PR before merge; it is not marked ready until QA passed',
  'human-staging': 'people test on staging after merge; the ticket waits in qa until they close it',
  bot: 'QA is on: a godmode:qa agent tests each visible change after a clean review',
  none: 'QA is off: a clean review goes straight to ready',
}

const modeIn = (value: Answer | undefined) => QA_MODES.find(qaMode => qaMode === value)

/**
 * The project's QA mode from the note's shared answers (D69): the `qaMode` answer setup
 * records. A note written before the four modes holds QA on or off (D34) instead: on
 * reads as `bot`, off or no answer as `none`, so an update never breaks a project.
 */
export const qaModeOf = (answers: Readonly<Record<string, Answer>>): QaMode => {
  const recorded = modeIn(answers.qaMode)
  if (recorded !== undefined) return recorded
  if (answers.qa === true) return 'bot'
  return modeIn(answers.qa) ?? 'none'
}

/**
 * The pass signals setup can add in the human modes (D70); being told always counts and
 * is not among them. `ticket-status`: the ticket moved to the board's pass status (Jira
 * or Other). `pr-approval`: an approval on the PR from the named people (GitHub, `human-pr`).
 */
export const QA_SIGNALS = ['ticket-status', 'pr-approval'] as const

export type QaSignal = (typeof QA_SIGNALS)[number]

/** The signals a `qaSignals` answer names, comma-joined as setup records them. */
export const qaSignalsOf = (answers: Readonly<Record<string, Answer>>): QaSignal[] => {
  const named = String(answers.qaSignals ?? '').split(',').map(part => part.trim())
  return QA_SIGNALS.filter(signal => named.includes(signal))
}

const textOf = (value: Answer | undefined) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined)

/** How people test, in a human mode: the bot pass first (D71), the board's waiting status and the pass signals (D70). */
const humanQaDetails = (answers: Readonly<Record<string, Answer>>) => {
  const waiting = textOf(answers.qaWaitStatus)
  const signals = qaSignalsOf(answers).map(signal =>
    signal === 'ticket-status'
      ? `the ticket moved to "${textOf(answers.qaPassStatus) ?? 'no status named yet'}"`
      : `a PR approval from ${textOf(answers.qaApprovers) ?? 'nobody named yet'}`,
  )
  return [
    `The QA agent tests first: ${answers.qaBotFirst === true ? 'yes' : 'no'}.`,
    ...(waiting === undefined ? [] : [`Waiting-for-QA status: "${waiting}".`]),
    `Pass signals: ${['being told', ...signals].join(', ')}.`,
  ].join(' ')
}

/** The line that tells the PM the QA mode, on a coding-mode `/godmode` and in the setup report. */
export const qaModeLine = (answers: Readonly<Record<string, Answer>>) => {
  const qaMode = qaModeOf(answers)
  const line = `QA mode: ${qaMode} (${QA_MODE_MEANING[qaMode]}).`
  return qaMode === 'human-pr' || qaMode === 'human-staging' ? `${line} ${humanQaDetails(answers)}` : line
}
