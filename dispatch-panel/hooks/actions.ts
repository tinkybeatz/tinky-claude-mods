/**
 * Turns one tool call into a short phrase of what the agent is doing right now
 * ("reading register.tsx", "committing", "running tests"). Pure and synchronous:
 * it reads only the call's own input, so it costs nothing per call.
 */

const MAX_DETAIL = 28

const clip = (text: string, max = MAX_DETAIL) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

const baseName = (path: unknown) => (typeof path === 'string' ? (path.split('/').pop() ?? path) : '')

const field = (input: Record<string, unknown>, name: string) => {
  const value = input[name]
  return typeof value === 'string' ? value : ''
}

/** Recognised shell commands, checked in order; the first match names the action. */
const SHELL_ACTIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bgit\s+commit\b/, 'committing'],
  [/\bgit\s+push\b/, 'pushing'],
  [/\bgit\s+(pull|fetch)\b/, 'pulling'],
  [/\bgit\s+rebase\b/, 'rebasing'],
  [/\bgit\s+merge\b/, 'merging'],
  [/\bgit\s+(checkout|switch|branch|worktree)\b/, 'switching branches'],
  [/\bgit\s+(add|stash|reset|restore)\b/, 'staging changes'],
  [/\bgit\s+(diff|status|log|show|blame)\b/, 'checking changes'],
  [/\bgh\s+pr\s+create\b/, 'opening a PR'],
  [/\bgh\s+pr\s+(comment|review)\b/, 'commenting on a PR'],
  [/\bgh\s+pr\s+(merge|ready)\b/, 'merging a PR'],
  [/\bgh\s+(pr|run)\s+(checks|watch|view)\b/, 'checking CI'],
  [/\bgh\s+pr\b/, 'checking a PR'],
  [/\b(vitest|jest|playwright|pytest)\b|\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b/, 'running tests'],
  [/\btsc\b|\btypecheck\b/, 'type-checking'],
  [/\b(eslint|oxlint|biome|lint)\b/, 'linting'],
  [/\b(prettier|oxfmt)\b|\bformat\b/, 'formatting'],
  [/\b(npm|pnpm|yarn|bun)\s+(install|i|add)\b/, 'installing dependencies'],
  [/\bbuild\b/, 'building'],
  [/\b(curl|wget)\b/, 'fetching a URL'],
  [/\b(rg|grep|find|fd)\b/, 'searching files'],
  [/\b(cat|head|tail|less|sed\s+-n)\b/, 'reading files'],
]

const shellAction = (input: Record<string, unknown>) => {
  const command = field(input, 'command')
  for (const [pattern, action] of SHELL_ACTIONS) if (pattern.test(command)) return action
  const description = field(input, 'description')
  if (description) return clip(description.charAt(0).toLowerCase() + description.slice(1), 36)
  const program = command.trim().split(/\s+/)[0] ?? ''
  return program ? `running ${clip(baseName(program))}` : 'running a command'
}

/** What an MCP tool call does, from its server and tool names. */
const mcpAction = (tool: string) => {
  const [, server = '', name = ''] = tool.split('__')
  const isWrite = /create|update|edit|add|transition|comment|post|send|write|delete|move/i.test(name)
  const service = /jira|atlassian/i.test(server + name)
    ? 'Jira'
    : /slack/i.test(server)
      ? 'Slack'
      : /notion/i.test(server)
        ? 'Notion'
        : /figma/i.test(server)
          ? 'Figma'
          : /drive|docs|sheets|gmail|calendar/i.test(server)
            ? 'Google'
            : server.replace(/^claude_ai_/, '').replace(/_/g, ' ')
  return isWrite ? `updating ${service}` : `reading ${service}`
}

export const describeAction = (tool: string, input: Record<string, unknown>): string => {
  if (tool.startsWith('mcp__')) return mcpAction(tool)
  switch (tool) {
    case 'Bash':
      return shellAction(input)
    case 'Read':
      return `reading ${clip(baseName(input.file_path))}`
    case 'Edit':
    case 'MultiEdit':
      return `editing ${clip(baseName(input.file_path))}`
    case 'Write':
      return `writing ${clip(baseName(input.file_path))}`
    case 'NotebookEdit':
      return `editing ${clip(baseName(input.notebook_path))}`
    case 'Grep':
      return `searching for "${clip(field(input, 'pattern'), 20)}"`
    case 'Glob':
      return 'finding files'
    case 'WebFetch': {
      const url = field(input, 'url')
      const host = /^https?:\/\/([^/]+)/.exec(url)?.[1] ?? 'a page'
      return `reading ${clip(host)}`
    }
    case 'WebSearch':
      return 'searching the web'
    case 'Agent':
      return 'dispatching an agent'
    case 'Skill':
      return `using skill ${clip(field(input, 'skill'))}`
    case 'TodoWrite':
    case 'TaskCreate':
    case 'TaskUpdate':
      return 'updating its tasks'
    case 'ToolSearch':
      return 'loading tools'
    default:
      return `using ${clip(tool)}`
  }
}

/** Shown between tool calls, while the agent's model is writing its next step. */
export const THINKING = 'thinking'

/**
 * A background shell's title when its call gave no description: the action its command
 * is recognised as ("checking a PR", "running tests"), else the command's first line.
 * A raw loop such as `until [ "$(gh pr view 1233 ...` reads as noise in a card.
 */
export const shellTitle = (command: string) => {
  const action = shellAction({ command })
  if (!action.startsWith('running ') || action === 'running tests') return action.charAt(0).toUpperCase() + action.slice(1)
  return command.split('\n')[0]?.trim() ?? ''
}
