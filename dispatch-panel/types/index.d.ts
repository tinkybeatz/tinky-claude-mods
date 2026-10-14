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
export type UsageLimit = {
  /** `five_hour`, `seven_day`, or a gateway's `spend_limit`. */
  kind: string
  /** How much of the window is used, 0 to 100. */
  percentUsed: number
  /** When the window resets, as an ISO 8601 timestamp. */
  resetsAt?: string
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
      /** The account's rate-limit windows, drawn as bars in the footer; empty off a subscription. */
      limits: UsageLimit[]
    }
  }
}
