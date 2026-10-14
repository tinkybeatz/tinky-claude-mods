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

declare module 'claude-code' {
  interface PluginState {
    'dispatch-panel': {
      dispatches: Dispatch[]
      now: number
      tab: DispatchTab
      isSized: boolean
      /** Which sections the person collapsed, by kind. */
      collapsed: Record<DispatchKind, boolean>
    }
  }
}
