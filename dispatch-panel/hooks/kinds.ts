import type { Dispatch } from '../types'

/**
 * What an agent is doing, each with its own colour. The colour follows the activity,
 * not the agent type: a `general-purpose` agent writing code and one updating Jira get
 * different colours. A small model picks the activity when the agent starts.
 */
export const ACTIVITIES = [
  { label: 'writing or changing code', color: '#3b82f6' },
  { label: 'reviewing or testing', color: '#ef4444' },
  { label: 'updating tickets (Jira, issues)', color: '#22d3ee' },
  { label: 'git, branches or pull requests', color: '#ec4899' },
  { label: 'searching or researching', color: '#facc15' },
  { label: 'planning or designing', color: '#22c55e' },
  { label: 'writing docs or text', color: '#e5e5e5' },
  { label: 'configuring or setting up', color: '#a855f7' },
  { label: 'analysing data', color: '#a3e635' },
  { label: 'something else', color: '#f97316' },
] as const

export const ACTIVITY_LABELS = ACTIVITIES.map(activity => activity.label)

/** Shells, and agents whose activity is not known yet. */
export const NEUTRAL_COLOR = '#94a3b8'

/** The colour of a failed row's ✗ mark; its border keeps its activity's colour. */
export const FAILED_MARK_COLOR = '#ef4444'

export const activityColor = (row: Dispatch) =>
  ACTIVITIES.find(activity => activity.label === row.activity)?.color ?? NEUTRAL_COLOR
