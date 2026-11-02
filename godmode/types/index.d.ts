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
}

/** How the "godmode is on" indicator shows (D68): a footer mode label, a hint-line tag, or a band above the prompt. */
export type IndicatorStyle = 'mode' | 'hint' | 'band'

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
      indicator: 'mode' | 'hint' | 'band'
    }
  }
}
