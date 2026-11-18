import type { On } from 'claude-code'

import { FIRST_COMMIT, HOME } from './world'

/** An issue on the pretend board. */
export type FakeIssue = { key: string; summary: string; status: string; created?: string }

/** One `$.mcp.call` the plugin made. */
export type JiraCall = { server: string; tool: string; args: Record<string, unknown> }

/**
 * The two shapes of Atlassian's servers. `listing` has `getTransitionsForJiraIssue` and
 * `addCommentToJiraIssue`, and takes `issueTypeName` and `transition: { id }`. `runner` (the
 * "Atlassian MCP" server) lists transitions only through `executeRead`, has
 * `addOrEditJiraIssueComment`, and takes `issueType` and `transitionId`.
 */
export type JiraFlavour = 'listing' | 'runner'

/**
 * A pretend Atlassian server. `mountJira` lists its tools in `$.tool.list` and answers the
 * plugin's `$.mcp.call`s from it, beneath the plugin, as the Atlassian connector would.
 */
export type FakeJira = {
  /** The server's name as its tools spell it. */
  server: string
  flavour: JiraFlavour
  issues: Map<string, FakeIssue>
  /** The board's statuses and Jira's category for each. */
  statuses: { name: string; category: string }[]
  /** Calls that reached the server. */
  calls: JiraCall[]
  /** Comments on the board, oldest first; `author` is a tester's display name, absent for godmode's own. */
  comments: { key: string; body: string; author?: string }[]
  sites: { id: string; name: string; url: string }[]
  projects: { key: string; name: string }[]
  /** Statuses no transition leads to. */
  unreachable: string[]
  /** The board's automation: where an issue moved to `target` really lands. */
  lands?: (target: string) => string | undefined
  /** Issues a search silently leaves out, as Jira does for one the person may not browse. */
  hidden?: string[]
  /** Search rows give the status as its bare name, or leave it out. */
  statusShape?: 'object' | 'name' | 'none'
  /** Makes a tool answer `isError` with this text. */
  fail?: (tool: string) => string | undefined
  /** Makes a tool never answer. */
  hang?: (tool: string) => boolean
  /** Lists no tools at all and answers no call, as a session without the connector. */
  isDisconnected?: boolean
  /** Connected, but its tools are missing from `$.tool.list`, as deferred MCP tools are. */
  isDeferred?: boolean
}

export const SERVER = 'claude_ai_Atlassian'

/** The "Atlassian MCP" server's name as its tools spell it. */
export const RUNNER_SERVER = 'claude_ai_Atlassian_MCP'

export const BOARD = [
  { name: 'To Do', category: 'new' },
  { name: 'In Progress', category: 'indeterminate' },
  { name: 'Code Review', category: 'indeterminate' },
  { name: 'In QA', category: 'indeterminate' },
  { name: 'QA passed', category: 'indeterminate' },
  { name: 'Done', category: 'done' },
]

export const makeJira = (overrides: Partial<FakeJira> = {}): FakeJira => ({
  server: overrides.flavour === 'runner' ? RUNNER_SERVER : SERVER,
  flavour: 'listing',
  issues: new Map(),
  statuses: BOARD,
  calls: [],
  comments: [],
  sites: [{ id: 'site-1', name: 'acme', url: 'https://acme.atlassian.net' }],
  projects: [
    { key: 'APP', name: 'App' },
    { key: 'OPS', name: 'Ops' },
  ],
  unreachable: [],
  ...overrides,
})

/**
 * Each tool's arguments, per the real schemas (additionalProperties false); `required`
 * holds groups of which one must be given.
 */
const SCHEMAS: Record<JiraFlavour, Record<string, { allowed: string[]; required?: string[][] }>> = {
  listing: {
    getJiraIssue: { allowed: ['cloudId', 'issueIdOrKey', 'fields', 'responseContentFormat'] },
    searchJiraIssuesUsingJql: { allowed: ['cloudId', 'jql', 'fields', 'maxResults', 'nextPageToken'] },
    createJiraIssue: { allowed: ['cloudId', 'projectKey', 'issueTypeName', 'summary', 'description'], required: [['issueTypeName']] },
    transitionJiraIssue: { allowed: ['cloudId', 'issueIdOrKey', 'transition'], required: [['transition']] },
    getTransitionsForJiraIssue: { allowed: ['cloudId', 'issueIdOrKey'] },
    addCommentToJiraIssue: { allowed: ['cloudId', 'issueIdOrKey', 'commentBody'], required: [['commentBody']] },
    getAccessibleAtlassianResources: { allowed: [] },
    getVisibleJiraProjects: { allowed: ['cloudId'] },
  },
  runner: {
    getJiraIssue: { allowed: ['cloudId', 'issueIdOrKey', 'fields', 'responseContentFormat'] },
    searchJiraIssuesUsingJql: { allowed: ['cloudId', 'jql', 'fields', 'maxResults', 'nextPageToken'] },
    createJiraIssue: { allowed: ['cloudId', 'projectKey', 'issueType', 'summary', 'description'], required: [['issueType']] },
    listJiraIssueComments: { allowed: ['cloudId', 'issueIdOrKey', 'orderBy', 'maxResults', 'responseContentFormat'] },
    transitionJiraIssue: { allowed: ['cloudId', 'issueIdOrKey', 'transitionId', 'transitionName'], required: [['transitionId', 'transitionName']] },
    addOrEditJiraIssueComment: { allowed: ['cloudId', 'issueIdOrKey', 'commentBody'] },
    getAccessibleAtlassianResources: { allowed: [] },
    discover: { allowed: ['query'], required: [['query']] },
    executeRead: { allowed: ['cloudId', 'name', 'inputs'], required: [['name']] },
  },
}

/** The tools the pretend server has, as the Atlassian connector names them. */
export const JIRA_TOOL_NAMES = Object.keys(SCHEMAS.listing)

/** Where godmode keeps an issue's side file for the world's project. */
export const sidePath = (key: string) => `${HOME}/.claude/godmode/projects/${FIRST_COMMIT}/tracker/jira/${key}.json`

/** Where godmode archives the side file of an issue Jira no longer has. */
export const archivedPath = (key: string) => sidePath(key).replace(/\/jira\/([^/]+)$/, '/jira/archived/$1')

const issueRow = (jira: FakeJira, issue: FakeIssue) => {
  const category = jira.statuses.find(status => status.name === issue.status)?.category ?? 'indeterminate'
  const status = jira.statusShape === 'name' ? { status: issue.status } : jira.statusShape === 'none' ? {} : { status: { name: issue.status, statusCategory: { key: category } } }
  return { key: issue.key, fields: { summary: issue.summary, ...status, created: issue.created ?? '2026-10-16T09:00:00.000+0000' } }
}

/** An issue's comments as Jira gives them, oldest first, each dated a minute after the last. */
const commentRows = (jira: FakeJira, key: string) =>
  jira.comments
    .filter(comment => comment.key === key)
    .map((comment, index) => ({
      id: String(index + 1),
      body: comment.body,
      created: `2026-11-16T09:${String(index).padStart(2, '0')}:00.000+0000`,
      ...(comment.author === undefined ? {} : { author: { displayName: comment.author } }),
    }))

const listIn = (text: string) => text.split(',').map(part => part.trim()).filter(part => part !== '')

/** The issues a JQL query names: `key in (...)`, narrowed by `status = "..."` and `OR key in (...)`, or a project's. */
const search = (jira: FakeJira, jql: string) => {
  const project = /^project = "([^"]+)"/.exec(jql)?.[1]
  if (project !== undefined) return [...jira.issues.values()].filter(issue => issue.key.startsWith(`${project}-`))
  const scope = listIn(/^key in \(([^)]*)\)/.exec(jql)?.[1] ?? '').filter(key => jira.hidden?.includes(key) !== true)
  const missing = scope.find(key => !jira.issues.has(key))
  if (missing !== undefined) throw new Error(`An issue with key '${missing}' does not exist for field 'key'.`)
  const status = /status = "([^"]+)"/.exec(jql)?.[1]
  const also = listIn(/OR key in \(([^)]*)\)/.exec(jql)?.[1] ?? '')
  return scope.flatMap(key => {
    const issue = jira.issues.get(key)
    if (issue === undefined) return []
    return status === undefined || issue.status === status || also.includes(key) ? [issue] : []
  })
}

/** Refuses arguments the tool's schema lacks, and a missing required one, as the real servers do. */
const checkArgs = (jira: FakeJira, tool: string, args: Record<string, unknown>) => {
  const schema = SCHEMAS[jira.flavour][tool]
  if (schema === undefined) throw new Error(`Unknown tool ${tool}`)
  const extra = Object.keys(args).filter(name => !schema.allowed.includes(name))
  if (extra.length > 0) throw new Error(`Invalid arguments for ${tool}: must NOT have additional properties (${extra.join(', ')})`)
  const absent = (schema.required ?? []).find(group => group.every(name => args[name] === undefined))
  if (absent !== undefined) throw new Error(`Invalid arguments for ${tool}: must have required property '${absent.join("' or '")}'`)
}

/** The transitions an issue can take now. */
const transitionsOf = (jira: FakeJira, issue: FakeIssue) =>
  jira.statuses
    .filter(status => status.name !== issue.status && !jira.unreachable.includes(status.name))
    .map(status => ({ id: String(jira.statuses.indexOf(status) + 1), name: `Go to ${status.name}`, to: { name: status.name } }))

/** Moves an issue by a transition id; resolves where it landed, after any automation. */
const moveBy = (jira: FakeJira, issue: FakeIssue, id: number) => {
  const target = jira.statuses[id - 1]
  if (target === undefined || jira.unreachable.includes(target.name)) throw new Error(`Transition id ${id} is not valid for this issue.`)
  issue.status = jira.lands?.(target.name) ?? target.name
  return issue.status
}

const answerRunner = (jira: FakeJira, tool: string, args: Record<string, unknown>, issue: FakeIssue | undefined): unknown => {
  if (tool === 'listJiraIssueComments') {
    if (issue === undefined) throw new Error(`Issue does not exist or you do not have permission to see it: ${String(args.issueIdOrKey)}`)
    const rows = commentRows(jira, issue.key)
    const ordered = args.orderBy === '-created' ? rows.reverse() : rows
    return { comments: ordered.slice(0, Number(args.maxResults ?? 100)), total: rows.length }
  }
  if (tool === 'discover') return { results: [{ name: 'listJiraIssueTransitions', tool: 'executeRead', inputs: { issueIdOrKey: 'string' } }] }
  if (tool === 'executeRead') {
    const inputs = (args.inputs ?? {}) as Record<string, unknown>
    if (args.name !== 'listJiraIssueTransitions') throw new Error(`Unknown operation ${String(args.name)}`)
    const found = jira.issues.get(String(inputs.issueIdOrKey ?? ''))
    if (found === undefined) throw new Error('Issue does not exist or you do not have permission to see it.')
    return { transitions: transitionsOf(jira, found) }
  }
  if (issue === undefined) throw new Error(`Issue does not exist or you do not have permission to see it: ${String(args.issueIdOrKey)}`)
  if (tool === 'transitionJiraIssue') {
    const byName = transitionsOf(jira, issue).find(way => way.name === args.transitionName)
    const landed = moveBy(jira, issue, Number(args.transitionId ?? byName?.id ?? 0))
    // This server answers the status the issue landed in.
    return { issueKey: issue.key, status: landed }
  }
  return undefined
}

const answer = (jira: FakeJira, tool: string, args: Record<string, unknown>): unknown => {
  checkArgs(jira, tool, args)
  const key = String(args.issueIdOrKey ?? '')
  const issue = jira.issues.get(key)
  if (tool === 'getAccessibleAtlassianResources') return jira.sites
  if (tool === 'getVisibleJiraProjects') return { values: jira.projects }
  if (tool === 'searchJiraIssuesUsingJql') return { issues: search(jira, String(args.jql)).map(found => issueRow(jira, found)) }
  if (tool === 'createJiraIssue') {
    const number = jira.issues.size + 1
    const created: FakeIssue = { key: `${String(args.projectKey)}-${number}`, summary: String(args.summary), status: 'To Do' }
    jira.issues.set(created.key, created)
    return { id: String(10_000 + number), key: created.key }
  }
  if (tool === 'addCommentToJiraIssue' || tool === 'addOrEditJiraIssueComment') {
    if (issue === undefined) throw new Error(`Issue does not exist or you do not have permission to see it: ${key}`)
    jira.comments.push({ key, body: String(args.commentBody) })
    return { id: '1' }
  }
  if (jira.flavour === 'runner' && tool !== 'getJiraIssue') return answerRunner(jira, tool, args, issue)
  if (issue === undefined) throw new Error(`Issue does not exist or you do not have permission to see it: ${key}`)
  if (tool === 'getJiraIssue') {
    const row = issueRow(jira, issue)
    // This server embeds the comments when asked for the `comment` field; the other only counts them.
    const isAsked = Array.isArray(args.fields) && args.fields.includes('comment') && jira.flavour === 'listing'
    return isAsked ? { ...row, fields: { ...row.fields, comment: { comments: commentRows(jira, issue.key), total: commentRows(jira, issue.key).length } } } : row
  }
  if (tool === 'getTransitionsForJiraIssue') return { transitions: transitionsOf(jira, issue) }
  if (tool === 'transitionJiraIssue') {
    moveBy(jira, issue, Number((args.transition as { id?: string } | undefined)?.id ?? 0))
    return { ok: true }
  }
  throw new Error(`Unknown tool ${tool}`)
}

/** A server name as `/mcp` lists it or as its tools spell it, compared alike. */
const spelling = (name: string) => name.trim().replace(/[^A-Za-z0-9_-]+/g, '_').toLowerCase()

/** Lists the pretend server's tools and answers its calls, beneath the plugin. */
export const mountJira = (on: On, jira: FakeJira) => {
  on('tool.list', () => ({
    value:
      jira.isDisconnected === true || jira.isDeferred === true
        ? [{ name: 'Bash', description: 'Runs a command', mcp: false }]
        : Object.keys(SCHEMAS[jira.flavour]).map(tool => ({ name: `mcp__${jira.server}__${tool}`, description: tool, mcp: true })),
  }))
  on('mcp.call', (_$, e) => {
    const answered = callJira(jira, e.server, e.tool, e.args ?? {})
    return answered === 'not connected' ? ({ deny: `MCP server "${e.server}" is not connected` } as never) : answered.then(value => ({ value }))
  })
}

/**
 * One call to the pretend server, as `$.mcp.call` answers it: the tool's result, or "not
 * connected" for a server the session lacks. A hanging tool never settles.
 */
export const callJira = (jira: FakeJira, server: string, tool: string, args: Record<string, unknown>) => {
  if (jira.isDisconnected === true || spelling(server) !== spelling(jira.server)) return 'not connected' as const
  jira.calls.push({ server, tool, args })
  if (jira.hang?.(tool) === true) return new Promise<never>(() => undefined)
  const refusal = jira.fail?.(tool)
  const text = (body: unknown) => [{ type: 'text' as const, text: typeof body === 'string' ? body : JSON.stringify(body) }]
  if (refusal !== undefined) return Promise.resolve({ content: text(refusal), isError: true })
  try {
    return Promise.resolve({ content: text(answer(jira, tool, args)), isError: false })
  } catch (error) {
    return Promise.resolve({ content: text((error as Error).message), isError: true })
  }
}

/** The tools the plugin called on Jira, in order. */
export const toolsCalled = (jira: FakeJira) => jira.calls.map(call => call.tool)
