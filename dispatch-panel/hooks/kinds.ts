import type { Dispatch } from '../types'

/**
 * What an agent is doing, each with its own colour. The colour follows the activity,
 * not the agent type: a `general-purpose` agent writing code and one updating Jira get
 * different colours. A small model picks the activity when the agent starts. The tag is
 * the short name shown in brackets after the agent's type.
 */
export const ACTIVITIES = [
  { label: 'writing or changing code', tag: 'code', color: '#3b82f6' },
  { label: 'reviewing or testing', tag: 'review', color: '#ef4444' },
  { label: 'updating tickets (Jira, issues)', tag: 'jira', color: '#22d3ee' },
  { label: 'git, branches or pull requests', tag: 'git', color: '#ec4899' },
  { label: 'searching or researching', tag: 'research', color: '#facc15' },
  { label: 'planning or designing', tag: 'plan', color: '#22c55e' },
  { label: 'writing docs or text', tag: 'docs', color: '#e5e5e5' },
  { label: 'configuring or setting up', tag: 'setup', color: '#a855f7' },
  { label: 'analysing data', tag: 'data', color: '#a3e635' },
  { label: 'something else', tag: 'other', color: '#f97316' },
] as const

export const ACTIVITY_LABELS = ACTIVITIES.map(activity => activity.label)

/** Shells, and agents whose activity is not known yet. */
export const NEUTRAL_COLOR = '#94a3b8'

/** The colour of a failed row's ✗ mark; its border keeps its activity's colour. */
export const FAILED_MARK_COLOR = '#ef4444'

export const activityColor = (row: Dispatch) =>
  ACTIVITIES.find(activity => activity.label === row.activity)?.color ?? NEUTRAL_COLOR

/** The short activity tag shown after the agent's type, once the classifier has picked one. */
export const activityTag = (row: Dispatch) => ACTIVITIES.find(activity => activity.label === row.activity)?.tag

/**
 * Words in an agent's description that name its activity outright. They settle it the
 * moment the agent starts, before any model call, and the classifier cannot overrule
 * them. Only unambiguous signals belong here: a ticket key alone does not, since dev
 * agents carry one too ("Build PROD-4888").
 */
const CLEAR_SIGNALS: ReadonlyArray<readonly [RegExp, (typeof ACTIVITIES)[number]['label']]> = [
  [/\b(jira|tickets?|backlog|sprint)\b/i, 'updating tickets (Jira, issues)'],
  [/\b(commit|push|rebase|cherry-pick)\b|\bpull requests?\b|\b(open|create|merge|arm)\b.*\bPRs?\b/i, 'git, branches or pull requests'],
]

/** The activity a description names outright, or undefined when the classifier has to decide. */
export const activityFromDescription = (description: string) =>
  CLEAR_SIGNALS.find(([pattern]) => pattern.test(description))?.[1]

/**
 * Notes for the classifier on the confusions it made in use: writing a ticket's text is
 * still updating tickets, not writing docs.
 */
export const CLASSIFIER_HINTS = [
  'Creating, editing, commenting on or moving Jira issues or tickets is "updating tickets (Jira, issues)", even when the work is writing text.',
  '"writing docs or text" is documentation, READMEs, notes and pages, not tickets.',
].join('\n')
