import type { On } from 'claude-code'

import { FIRST_COMMIT, HOME } from './world'

/** An issue on the pretend board. */
export type FakeIssue = {
  key: string
  summary: string
  status: string
  created?: string
  creator?: string
  /** What a board scan reads, with every field asked for (`*all`). */
  type?: string
  sprint?: { name: string; state: 'active' | 'future' | 'closed' }[]
  parent?: { key: string; type: string }
  labels?: string[]
  components?: string[]
  priority?: string
  description?: string
  custom?: Record<string, unknown>
}

/** The id of the pretend board's sprint field. */
export const SPRINT_FIELD = 'customfield_10020'

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
  /**
   * How `getAccessibleAtlassianResources` answers: a bare list, one row per product (the
   * "Rovo" servers), or `{ data: { resources: [{ cloudId, url }] } }` (the "Atlassian MCP" server).
   */
  sitesShape?: 'list' | 'per-product' | 'wrapped'
  projects: { key: string; name: string }[]
  /** Statuses no transition leads to. */
  unreachable: string[]
  /** The board's automation: where an issue moved to `target` really lands. */
  lands?: (target: string) => string | undefined
  /** Issues a search silently leaves out, as Jira does for one the person may not browse. */
  hidden?: string[]
  /** Search rows give the status as its bare name, or leave it out. */
  statusShape?: 'object' | 'name' | 'none'
  /** The project's issue types, as the metadata tools list them. */
  issueTypes?: string[]
  /** Each issue type's fields, as `getJiraIssueTypeMetaWithFields` answers them. */
  fieldsMeta?: Record<string, { fieldId: string; name: string; required: boolean }[]>
  /** Search rows as `{ issues: { nodes, pageInfo } }`, the "Atlassian MCP" server's shape. */
  isNodes?: boolean
  /** A search the session finds too large: answered with the saved-file notice, not the result. */
  isTooLarge?: (args: Record<string, unknown>) => boolean
  /** The person's Atlassian account id, as `atlassianUserInfo` answers it; absent, the call fails. */
  account?: string
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
  sites: [{ id: '0c5e2f7a-1d3b-4e8f-9a6c-2b7d4e1f3a90', name: 'acme', url: 'https://acme.atlassian.net' }],
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
    createJiraIssue: { allowed: ['cloudId', 'projectKey', 'issueTypeName', 'summary', 'description', 'parent', 'additional_fields'], required: [['issueTypeName']] },
    transitionJiraIssue: { allowed: ['cloudId', 'issueIdOrKey', 'transition'], required: [['transition']] },
    getTransitionsForJiraIssue: { allowed: ['cloudId', 'issueIdOrKey'] },
    addCommentToJiraIssue: { allowed: ['cloudId', 'issueIdOrKey', 'commentBody'], required: [['commentBody']] },
    getAccessibleAtlassianResources: { allowed: [] },
    getVisibleJiraProjects: { allowed: ['cloudId'] },
    atlassianUserInfo: { allowed: [] },
    getJiraProjectIssueTypesMetadata: { allowed: ['cloudId', 'projectIdOrKey'] },
    getJiraIssueTypeMetaWithFields: { allowed: ['cloudId', 'projectIdOrKey', 'issueTypeId', 'requiredFieldsOnly'] },
  },
  runner: {
    getJiraIssue: { allowed: ['cloudId', 'issueIdOrKey', 'fields', 'responseContentFormat'] },
    searchJiraIssuesUsingJql: { allowed: ['cloudId', 'jql', 'fields', 'maxResults', 'nextPageToken', 'view'] },
    createJiraIssue: {
      allowed: ['cloudId', 'projectKey', 'issueType', 'summary', 'description', 'labels', 'parent', 'priority', 'additional_fields', 'assignToSprint'],
      required: [['issueType']],
    },
    listJiraIssueComments: { allowed: ['cloudId', 'issueIdOrKey', 'orderBy', 'maxResults', 'responseContentFormat'] },
    transitionJiraIssue: { allowed: ['cloudId', 'issueIdOrKey', 'transitionId', 'transitionName'], required: [['transitionId', 'transitionName']] },
    addOrEditJiraIssueComment: { allowed: ['cloudId', 'issueIdOrKey', 'commentBody'] },
    getAccessibleAtlassianResources: { allowed: [] },
    atlassianUserInfo: { allowed: [] },
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

/** Every field a scan reads, as Jira gives them with `*all`. */
/** The id the "Atlassian MCP" server gives a custom field's label: stable for the run. */
const runnerIds = new Map<string, string>()
export const runnerIdOf = (label: string) => {
  if (!runnerIds.has(label)) runnerIds.set(label, `customfield_${11000 + runnerIds.size}`)
  return runnerIds.get(label) ?? ''
}

/**
 * The "Atlassian MCP" server's custom fields: under `customFields` by label, each
 * `{ id, value }`, only the ones holding a value. With an explicit field list, only the ids
 * it names; with none (the "evidence" view), all of them.
 */
const runnerCustom = (issue: FakeIssue, named?: readonly unknown[]) =>
  Object.fromEntries(
    Object.entries(issue.custom ?? {}).flatMap(([label, value]) => {
      const id = runnerIdOf(label)
      return named === undefined || named.includes(id) ? [[label, { id, value }]] : []
    }),
  )

const allFields = (issue: FakeIssue, isMapped = false) => ({
  issuetype: { name: issue.type ?? 'Task' },
  ...(issue.sprint === undefined ? {} : { [SPRINT_FIELD]: issue.sprint.map((sprint, index) => ({ id: index + 1, ...sprint })) }),
  ...(issue.parent === undefined ? {} : { parent: { key: issue.parent.key, fields: { issuetype: { name: issue.parent.type } } } }),
  labels: issue.labels ?? [],
  components: (issue.components ?? []).map(name => ({ name })),
  ...(issue.priority === undefined ? {} : { priority: { name: issue.priority } }),
  description: issue.description ?? null,
  // The "Atlassian MCP" server maps custom fields to their labels under `customFields`.
  ...(isMapped ? { customFields: issue.custom ?? {} } : issue.custom),
})

/** The saved-file notice the session answers in place of a result too large for it. */
export const TOO_LARGE_TEXT =
  'Error: result (349,076 characters) exceeds maximum allowed tokens. Output has been saved to /home/dev/.claude/projects/x/tool-results/mcp-claude_ai_Atlassian_MCP-searchJiraIssuesUsingJql-1.txt. Format: JSON with schema: {issues: {nodes: [{...}], webUrl: string, pageInfo: {...}}} Use offset and limit parameters to read specific portions of the file, and jq to query it.'

const issueRow = (jira: FakeJira, issue: FakeIssue, isAll = false, isMapped = false) => {
  const category = jira.statuses.find(status => status.name === issue.status)?.category ?? 'indeterminate'
  const status = jira.statusShape === 'name' ? { status: issue.status } : jira.statusShape === 'none' ? {} : { status: { name: issue.status, statusCategory: { key: category } } }
  const creator = issue.creator === undefined ? {} : { creator: { accountId: issue.creator, displayName: issue.creator } }
  return { key: issue.key, fields: { summary: issue.summary, ...status, ...creator, created: issue.created ?? '2026-10-16T09:00:00.000+0000', ...(isAll ? allFields(issue, isMapped) : {}) } }
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
  // As Jira does, a JQL value it does not know refuses the whole search, naming each one.
  const unknown = [
    ...(project === undefined || jira.projects.some(known => known.key === project) ? [] : [`The value '${project}' does not exist for the field 'project'.`]),
    ...listIn(/status in \(([^)]*)\)/.exec(jql)?.[1] ?? '')
      .map(name => name.replace(/^"|"$/g, ''))
      .filter(name => !jira.statuses.some(status => status.name === name))
      .map(name => `The value '${name}' does not exist for the field 'status'.`),
  ]
  if (unknown.length > 0) throw new Error(unknown.join(' '))
  const skipped = listIn(/key not in \(([^)]*)\)/.exec(jql)?.[1] ?? '')
  // `currentUser()` is the person whose token the server uses: their account.
  const isMine = (issue: FakeIssue) => !/currentUser\(\)/.test(jql) || (jira.account !== undefined && issue.creator === jira.account)
  if (project !== undefined) return [...jira.issues.values()].filter(issue => issue.key.startsWith(`${project}-`) && !skipped.includes(issue.key) && isMine(issue))
  const scope = listIn(/^key in \(([^)]*)\)/.exec(jql)?.[1] ?? /^key = (\S+)/.exec(jql)?.[1] ?? '').filter(key => jira.hidden?.includes(key) !== true)
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
  if (tool === 'getAccessibleAtlassianResources') {
    if (jira.sitesShape === 'wrapped') return { data: { resources: jira.sites.map(site => ({ cloudId: site.id, url: site.url, products: [{ id: 'jira' }] })) } }
    return jira.sitesShape === 'per-product' ? jira.sites.flatMap(site => [{ ...site, scopes: ['read:confluence'] }, { ...site, scopes: ['read:jira-work'] }]) : jira.sites
  }
  if (tool === 'getVisibleJiraProjects') return { values: jira.projects }
  if (tool === 'atlassianUserInfo') {
    if (jira.account === undefined) throw new Error('Unauthorized: the token cannot read the user')
    return jira.flavour === 'runner' ? { data: { accountId: jira.account } } : { account_id: jira.account, name: 'Me' }
  }
  if (tool === 'searchJiraIssuesUsingJql') {
    // A scan names the fields it needs; every field comes with it, as the fake has few.
    const isAll = Array.isArray(args.fields) && (args.fields.includes('*all') || args.fields.includes('issuetype'))
    const isRunner = jira.flavour === 'runner'
    const fields = Array.isArray(args.fields) ? (args.fields as unknown[]) : undefined
    const rows = search(jira, String(args.jql))
      .slice(0, typeof args.maxResults === 'number' ? args.maxResults : undefined)
      .map(found => {
        if (!isRunner || (fields === undefined && args.view !== 'evidence')) return issueRow(jira, found, isAll)
        // This server returns a custom field only when named by id, or every one in the "evidence" view.
        const row = issueRow(jira, found, true)
        const base: Record<string, unknown> = { ...row.fields, ...allFields(found, true) }
        delete base.customFields
        const custom = runnerCustom(found, fields)
        return { ...row, fields: { ...base, ...(Object.keys(custom).length === 0 ? {} : { customFields: custom }) } }
      })
    return jira.isNodes === true ? { issues: { nodes: rows, pageInfo: { hasNextPage: false } } } : { issues: rows }
  }
  if (tool === 'getJiraProjectIssueTypesMetadata') return { issueTypes: (jira.issueTypes ?? ['Task', 'Bug', 'Story']).map((name, index) => ({ id: String(10_000 + index), name })) }
  if (tool === 'getJiraIssueTypeMetaWithFields') {
    const name = (jira.issueTypes ?? ['Task', 'Bug', 'Story'])[Number(args.issueTypeId) - 10_000] ?? ''
    const fields = (jira.fieldsMeta?.[name] ?? []).filter(field => args.requiredFieldsOnly !== true || field.required)
    return { fields: fields.map(field => ({ ...field, hasDefaultValue: false })) }
  }
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
  if (tool === 'searchJiraIssuesUsingJql' && jira.isTooLarge?.(args) === true) return Promise.resolve({ content: text(TOO_LARGE_TEXT), isError: false })
  try {
    return Promise.resolve({ content: text(answer(jira, tool, args)), isError: false })
  } catch (error) {
    return Promise.resolve({ content: text((error as Error).message), isError: true })
  }
}

/** The tools the plugin called on Jira, in order. */
export const toolsCalled = (jira: FakeJira) => jira.calls.map(call => call.tool)
