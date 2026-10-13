import type { Dispatch } from '../types'

/** The colour of each group of work: primaries and secondaries, chosen to read clearly on a dark background. */
export const GROUP_COLORS = {
  code: '#3b82f6',
  review: '#ef4444',
  explore: '#facc15',
  plan: '#22c55e',
  helper: '#a855f7',
  shell: '#f97316',
  unknown: '#e5e5e5',
} as const

export type Group = keyof typeof GROUP_COLORS

/** The colour of a failed row's ✗ mark; its border keeps its group's colour. */
export const FAILED_MARK_COLOR = '#ef4444'

/**
 * Which group each agent type belongs to, by the exact `subagent_type` the dispatch names
 * (compared in lower case). Nothing is guessed: a type missing here is drawn as `unknown`
 * (white) until it is added. Add a line per new agent type.
 */
export const AGENT_GROUPS: Readonly<Record<string, Group>> = {
  // Code: general workers that write and change code.
  'general-purpose': 'code',
  claude: 'code',
  dev: 'code',
  // Review: agents that verify, test or review work.
  test: 'review',
  // Explore: read-only search across files.
  explore: 'explore',
  // Plan: design and implementation plans.
  plan: 'plan',
  // Helper: documentation and configuration helpers.
  'claude-code-guide': 'helper',
  'statusline-setup': 'helper',
}

export const groupOf = (row: Dispatch): Group =>
  row.kind === 'shell' ? 'shell' : (AGENT_GROUPS[row.label.toLowerCase()] ?? 'unknown')

export const groupColor = (row: Dispatch) => GROUP_COLORS[groupOf(row)]
