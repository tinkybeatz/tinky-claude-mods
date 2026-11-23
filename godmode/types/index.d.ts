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
  /** The name it was dispatched with (`Agent({ name })`), which SendMessage may address it by. */
  name?: string
  /** True for a dev agent a workflow launched: the workflow, not a resume, carries its ticket on. */
  isWorkflow?: boolean
}

/** A draft PR a dev agent opened, waiting for the PM to be told to start its review (D35). */
export interface PendingReview {
  /** The PR's number, or the branch on a host with no PRs. */
  pr: string
  url?: string
  /** The dev agent that opened it. */
  agentId: string
  ticket?: string
  /** The line for the PM about the ticket: the move to review to mirror in a tracker godmode cannot reach (Other), or what to do by hand when recording the PR or the move failed. */
  mirror?: string
}

/** A stack the setup scan recognises from the files at the project's root (D29). */
export type StackId = 'node' | 'deno' | 'python' | 'rust' | 'go' | 'ruby' | 'java' | 'php' | 'elixir' | 'dotnet' | 'dart'

export interface ScannedStack {
  id: StackId
  /** `TypeScript`, `Python`, `Kotlin`, ...: what the code is written in. */
  language: string
  /** The file that told: `package.json`, `Cargo.toml`, ... */
  marker: string
  packageManager?: string
  /** A framework seen in the dependencies: `next`, `django`, `rails`, ... */
  framework?: string
}

/** The project's commands, as the scan found them; each absent when nothing said. */
export interface ScannedCommands {
  install?: string
  build?: string
  test?: string
  start?: string
  lint?: string
  format?: string
  typecheck?: string
}

/** The git side of the scan (D54, D55). */
export interface ScannedGit {
  hasGit: boolean
  /** The `origin` remote's URL. */
  origin?: string
  /** The host of `origin`: `github.com`, `gitlab.com`, ... */
  remoteHost?: string
  /** Where PRs would go with no answer given: `github`, or `local` branches. */
  host: 'github' | 'local' | 'other'
  hostReason: string
  baseBranch?: string
}

/** What the setup scan found (D29): the deterministic part, judged further by the setup agent. */
export interface ScanFacts {
  root: string
  /** The folder's name, for templates. */
  name: string
  stacks: ScannedStack[]
  commands: ScannedCommands
  /** Where each command came from: `package.json scripts.test`, `Cargo.toml`, `Makefile`, ... */
  commandSources: Partial<Record<keyof ScannedCommands, string>>
  /** Whether there is an app to click through, so QA defaults on (D34). */
  hasUi: boolean
  uiReason?: string
  git: ScannedGit
  /** Existing conventions files, relative to the root: `CLAUDE.md`, `.claude/rules/x.md`, ADRs, ... */
  conventions: string[]
}

/** Where a setup run stands between its tool calls (Step 3). */
export interface SetupRun {
  /** The scan, once `setup_scan` ran. */
  facts?: ScanFacts
  /** The questionnaire's answers by key, once it ran. */
  answers?: Record<string, string | number | boolean>
  /** Existing conventions files the person said yes to improving in place (D32), absolute. */
  consented: string[]
  /** Files `setup_write_preset` wrote, absolute, with the template each came from. */
  written: { template: string; path: string }[]
  /**
   * A change-setup's round (D22), until `setup_finish` saves it: the topics asked, the
   * recorded keys they replace, the person's answers, and whether it answers an update (D60).
   */
  change?: { topics: string[]; dropped: string[]; answers: Record<string, string | number | boolean>; isUpdate: boolean }
}

/** The app `/godmode try` started for the person (D49): one at a time. */
export interface TryRun {
  ticket: string
  /** The free port godmode gave the app in `PORT`; what listens there is freed when the try stops. */
  port: number
  /** The link the person was given: that port, or the one the app's output printed when it ignores `PORT`. */
  url: string
  /** The project's start command, as the setup note holds it. */
  command: string
  /** The ticket's worktree, absolute, where the command runs. */
  worktree: string
}

/**
 * The person's explicit ask for one controlled action on one target (D74), recorded by the PM
 * with `allow_once`. It is used once, and lapses after an hour.
 */
export interface Unlock {
  action: string
  target: string
  /** The person's words, as the PM quoted them. */
  ask: string
  /** When it was recorded, in epoch milliseconds. */
  at: number
}

/** How the "godmode is on" indicator shows (D68): a footer mode label, a hint-line tag, a band above the prompt, or the side pane. */
export type IndicatorStyle = 'mode' | 'hint' | 'band' | 'pane'

/** What the side pane tracks, as the dispatch panel does: an agent or a background shell. */
export type PaneRowKind = 'agent' | 'shell'

/** The side pane's tabs. */
export type PaneTab = 'active' | 'finished'

/** One agent or background shell the side pane lists, with its purpose, tokens and duration. */
export interface PaneRow {
  id: string
  kind: PaneRowKind
  /** Agent type (`Explore`, `godmode:dev`) or `bash`. */
  label: string
  /** The Agent call's description, or the Bash call's description or command. */
  purpose: string
  status: string
  startedAt: number
  endedAt?: number
  /** Input tokens the agent has sent across all its requests, cache reads and writes included; absent for shells. */
  inputTokens?: number
  /** Output tokens the agent has generated across all its requests; absent for shells. */
  outputTokens?: number
  /** The start of the agent's prompt, kept so its activity can be classified. */
  brief?: string
  /** What the agent is doing, one of the activity labels; absent until classified. */
  activity?: string
  /** True once classification was tried, so a failed attempt is not repeated. */
  isClassified?: boolean
  /** What a running agent is doing right now ("reading register.tsx", "committing"). */
  action?: string
  /** The agent that started this agent or shell; absent when the main thread did. */
  parentId?: string
}

/** One of the account's rate-limit windows, as the last API response reported it. */
export interface PaneLimit {
  /** `five_hour`, `seven_day`, or a gateway's `spend_limit`. */
  kind: string
  /** How much of the window is used, 0 to 100. */
  percentUsed: number
  /** When the window resets, as an ISO 8601 timestamp. */
  resetsAt?: string
}

/** One open ticket as the side pane lists it, and what it waits on from the person, if anything. */
export interface PaneTicket {
  id: string
  title: string
  status: string
  /** `merge go`, `QA`, `go to start`, `fix-round go`: what the person is waited on for; absent when nothing. */
  waits?: string
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
      /** The setup run in progress: its scan, answers, consents and written files (Step 3). */
      setupRun: SetupRun
      /** What the PM is told on its next prompt once setup finished; empty when nothing waits. */
      setupReport: string
      /** The style of the on-indicator (D68), a personal answer; `mode` unless the note says otherwise. */
      indicator: 'mode' | 'hint' | 'band' | 'pane'
      /** The side pane's agents and shells, as the dispatch panel tracks them. */
      paneRows: PaneRow[]
      /** The clock as the side pane last drew it, so running rows' durations move. */
      paneNow: number
      /** The side pane's tab. */
      paneTab: PaneTab
      /** Whether the side pane's width was set this session. */
      paneSized: boolean
      /** The sections of the side pane the person folded, by kind. */
      paneCollapsed: Record<PaneRowKind, boolean>
      /** The account's rate-limit windows, the side pane's footer bars. */
      paneLimits: PaneLimit[]
      /** Open tickets and what each waits on from the person, read on each prompt and after each ticket change. */
      paneTickets: PaneTicket[]
      /** The side pane could not be placed (a narrow terminal), so the band shows that godmode is on. */
      paneFallback: boolean
      /** The person closed the side pane by hand: it stays closed until godmode is next switched on. */
      paneClosed: boolean
      /** Whether Fable answered the PM in this session: untried, it works, or the PM runs on Opus (D74). */
      pmModel: 'untried' | 'fable' | 'opus'
      /** The person's asks that unlock one controlled action each (D74). */
      unlocks: Unlock[]
      /** The app `/godmode try` runs, until `/godmode try stop`, the next try or the session's end; null when none. */
      tryRun: TryRun | null
    }
  }
}
