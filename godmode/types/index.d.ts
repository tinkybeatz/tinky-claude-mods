/**
 * What godmode is doing while it is on (D9, D22): `setup` scans the project and asks the
 * questionnaire, `change-setup` discusses a change to an earlier setup, `coding` runs the
 * PM loop.
 */
export type GodmodeMode = 'setup' | 'change-setup' | 'coding'

/**
 * How much of the setup runs: `full` on a project with no note, `personal` when a
 * teammate's committed note is there and only this person's answers are missing (D61).
 */
export type SetupScope = 'full' | 'personal'

/** The roles godmode dispatches (D33); the PM is the main thread. */
export type GodmodeRole = 'dev' | 'reviewer' | 'setup' | 'researcher' | 'qa'

/** An agent godmode saw start, by the role its type names (Step 7). */
export interface DispatchedAgent {
  role: GodmodeRole
  /** The ticket a dev agent builds. */
  ticket?: string
  /** The worktree a dev agent works in, absolute; its edits stay inside it (D38). */
  worktree?: string
  /** The dev agent's branch: an open PR on it is its own, not a held file's owner (D48). */
  branch?: string
}

/** A draft PR a dev agent opened, waiting for the PM to be told to start its review (D35). */
export interface PendingReview {
  /** The PR's number, or the branch on a host with no PRs. */
  pr: string
  url?: string
  /** The dev agent that opened it. */
  agentId: string
  ticket?: string
}

declare module 'claude-code' {
  interface PluginState {
    godmode: {
      /** True between `/godmode` and `/godmode off`; off, the session is plain Claude Code (D12). */
      isOn: boolean
      /** The mode godmode runs in; read only while `isOn`. */
      mode: GodmodeMode
      /** Which questions setup asks; read only in `setup` mode. */
      setupScope: SetupScope
      /** Conventions files edited since the setup note was written, each re-checked alone (D20). */
      recheck: string[]
      /** The godmode agents started this session, by agent id. */
      agents: Record<string, DispatchedAgent>
      /** Draft PRs whose review the PM has not been told to start yet. */
      pendingReviews: PendingReview[]
      /** Files the main thread read since the person's last prompt (D63). */
      mainThreadReads: number
    }
  }
}
