export type DispatchKind = 'agent' | 'shell'

export type DispatchTab = 'active' | 'finished'

export type Dispatch = {
  id: string
  kind: DispatchKind
  /** Agent type (`Explore`, `general-purpose`) or `bash`. */
  label: string
  /** The Agent call's description, or the Bash call's description or command. */
  purpose: string
  status: string
  startedAt: number
  endedAt?: number
  /** Input tokens of the agent's latest request (its context now, cache included); absent for shells. */
  inputTokens?: number
  /** Output tokens the agent has generated across all its requests; absent for shells. */
  outputTokens?: number
}

declare module 'claude-code' {
  interface PluginState {
    'dispatch-panel': { dispatches: Dispatch[]; now: number; tab: DispatchTab; isSized: boolean }
  }
}
