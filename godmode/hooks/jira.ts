import type { EngineInterface, McpToolResult, ToolInfo } from 'claude-code'

import type { Choice, Question } from './questionnaire'
import { readNote, trackerDirOf } from './storage'
import type { Answer, Project } from './storage'
import type { QaResult, TicketBackend, TicketChange, TicketComment, TicketDraft, TicketFilter, TicketHeader, TicketStatus } from './tickets'

/*
 * The Jira tracker (D23, D24): the four ticket tools mapped onto the Atlassian connector the
 * session has, called from hook code with `$.mcp.call` (spike 10), which asks no permission.
 * Server names differ per person, so the server is found among `$.tool.list()`'s tools, or
 * named by the person's setup answer when several are connected. Jira holds the title and
 * the status; what godmode keeps that Jira has no field for (branch, PR, ready, QA result,
 * fix-for, visible change, blockers) sits in one side file per issue, in godmode's personal
 * storage. Only types are imported from `tickets.ts` and `questionnaire.ts`, which import
 * this file. Every helper that takes `$` is a function declaration.
 */

/** A Jira failure the model can read; `tickets.ts` hands it on as a ticket error. */
export class JiraError extends Error {}

/** The tools godmode calls, by their names on an Atlassian server. */
export const JIRA_TOOLS = {
  read: 'getJiraIssue',
  search: 'searchJiraIssuesUsingJql',
  create: 'createJiraIssue',
  transition: 'transitionJiraIssue',
  transitions: 'getTransitionsForJiraIssue',
  sites: 'getAccessibleAtlassianResources',
  projects: 'getVisibleJiraProjects',
} as const

/** The comment tool, which Atlassian's servers name differently. */
const COMMENT_TOOLS: readonly string[] = ['addCommentToJiraIssue', 'addOrEditJiraIssueComment']

/**
 * The server with no transitions list reads them through its generic read runner, under an
 * operation name its `discover` tool gives; `transitionJiraIssue` there takes a transition id.
 */
const RUNNER = { read: 'executeRead', discover: 'discover', transitions: 'listJiraIssueTransitions' } as const

/** Each server's tools, for a server found by name alone, whose tools the tool list did not show. */
const LISTING_TOOLS: readonly string[] = [...Object.values(JIRA_TOOLS), 'addCommentToJiraIssue']
/**
 * Only the server with no transitions list has a comment list; the other gives an issue's
 * comments through `getJiraIssue` with the `comment` field.
 */
const COMMENT_LIST_TOOL = 'listJiraIssueComments'

const RUNNER_TOOLS: readonly string[] = [
  JIRA_TOOLS.read,
  JIRA_TOOLS.search,
  JIRA_TOOLS.create,
  JIRA_TOOLS.transition,
  JIRA_TOOLS.sites,
  'addOrEditJiraIssueComment',
  COMMENT_LIST_TOOL,
  RUNNER.read,
  RUNNER.discover,
]

/**
 * The names Atlassian's connectors usually have, tried when the tool list shows no Jira
 * server: deferred MCP tools, and an agent whose tool list leaves out mcp__ tools, are
 * missing from it while the server is connected.
 */
const KNOWN_SERVERS: readonly string[] = ['claude.ai Atlassian MCP', 'claude.ai Atlassian Rovo', 'claude.ai Atlassian', 'atlassian']

const NEEDED: readonly string[] = [JIRA_TOOLS.read, JIRA_TOOLS.search, JIRA_TOOLS.create, JIRA_TOOLS.transition]

/** A connected MCP server that has the Jira tools godmode needs, and the names of all its tools; none when it was found by name alone. */
export type JiraServer = { name: string; tools: ReadonlySet<string> }

/** How long the prompt hook waits for Jira, as for `gh` (build default). */
export const JIRA_CHECK_TIMEOUT_MS = 3_000

/** godmode's statuses in their order; `qa` maps onto the setup's waiting-for-QA status. */
const STATUSES: readonly TicketStatus[] = ['todo', 'doing', 'review', 'qa', 'done']

/** The setup answers that name each status on the board; `qa` is `qaWaitStatus` (D70). */
export const JIRA_STATUS_KEYS = {
  todo: 'jiraTodoStatus',
  doing: 'jiraDoingStatus',
  review: 'jiraReviewStatus',
  qa: 'qaWaitStatus',
  done: 'jiraDoneStatus',
} as const satisfies Record<TicketStatus, string>

/** Jira's own default names, used for a status the setup did not name. */
const DEFAULT_NAMES: Readonly<Partial<Record<TicketStatus, string>>> = { todo: 'To Do', doing: 'In Progress', review: 'In Review', done: 'Done' }

const DEFAULT_ISSUE_TYPE = 'Task'

/** Each godmode status's name on the board; `qa` has none until setup names the waiting status. */
export type StatusMap = Readonly<Partial<Record<TicketStatus, string>>>

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

const textOf = (value: unknown) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined)

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

const sameName = (a: string | undefined, b: string | undefined) => a !== undefined && b !== undefined && a.trim().toLowerCase() === b.trim().toLowerCase()

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim()

/** The status map a note's answers give (shared, then personal over them). */
export const statusMapOf = (answers: Readonly<Record<string, Answer>>): StatusMap =>
  Object.fromEntries(STATUSES.flatMap(status => {
    const name = textOf(answers[JIRA_STATUS_KEYS[status]]) ?? DEFAULT_NAMES[status]
    return name === undefined ? [] : [[status, name]]
  }))

/** A Jira status as godmode reads it: its name, and Jira's category (`new`, `indeterminate`, `done`). */
export type BoardStatus = { name: string; category?: string; isUnread?: boolean }

/** The status of an issue Jira answered without a readable one: listed, never dropped. */
export const UNKNOWN_STATUS: BoardStatus = { name: 'unknown', isUnread: true }

/**
 * The godmode status a board status means. A status two godmode statuses share keeps the one
 * godmode last recorded; an unmapped one (a tester's "QA passed") keeps the recorded one too,
 * and with none recorded follows Jira's category.
 */
export const godmodeStatusOf = (status: BoardStatus, map: StatusMap, recorded?: TicketStatus): TicketStatus => {
  if (status.isUnread === true) return recorded ?? 'todo'
  const matches = STATUSES.filter(candidate => sameName(map[candidate], status.name))
  if (recorded !== undefined && matches.includes(recorded)) return recorded
  const [first] = matches
  if (first !== undefined) return first
  if (recorded !== undefined) return recorded
  if (status.category === 'done') return 'done'
  return status.category === 'new' ? 'todo' : 'doing'
}

/** An issue key, upper-cased: `app-7` is `APP-7`; undefined for anything else. */
export const issueKeyOf = (raw: string) => {
  const key = raw.trim().toUpperCase()
  return /^[A-Z][A-Z0-9_]*-\d+$/.test(key) ? key : undefined
}

/** Issue keys ordered as they were filed: by project, then by number. */
const byKey = (a: string, b: string) => {
  const [projectA = '', numberA = '0'] = a.split('-')
  const [projectB = '', numberB = '0'] = b.split('-')
  return projectA === projectB ? Number(numberA) - Number(numberB) : projectA.localeCompare(projectB)
}

/** A JQL string literal. */
const jqlText = (text: string) => `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

// ---------------------------------------------------------------------------
// The server and its answers

/** The servers among `tools` that have every Jira tool godmode needs, by the name `$.mcp.call` takes. */
export const jiraServersIn = (tools: readonly ToolInfo[]): JiraServer[] => {
  const byServer = new Map<string, Set<string>>()
  for (const tool of tools) {
    if (!tool.mcp || !tool.name.startsWith('mcp__')) continue
    const at = tool.name.lastIndexOf('__')
    if (at <= 3) continue
    const server = tool.name.slice(5, at)
    const named = byServer.get(server) ?? new Set<string>()
    named.add(tool.name.slice(at + 2))
    byServer.set(server, named)
  }
  return [...byServer]
    .filter(([, named]) => NEEDED.every(tool => named.has(tool)) && COMMENT_TOOLS.some(tool => named.has(tool)))
    .map(([name, named]) => ({ name, tools: named }))
}

/** A server name as `/mcp` lists it or as its tools spell it: `claude.ai Atlassian` is `claude_ai_Atlassian`. */
const serverSpelling = (name: string) => name.trim().replace(/[^A-Za-z0-9_-]+/g, '_').toLowerCase()

/** The Jira servers the session's tool list shows; none when it cannot be read. */
async function listedJiraServers($: EngineInterface): Promise<JiraServer[]> {
  const tools: unknown = await $.tool.list().catch(() => [])
  return Array.isArray(tools) ? jiraServersIn(tools as ToolInfo[]) : []
}

/**
 * The Jira servers connected now: those the tool list shows, else those of the known names
 * that answer a read, each tried for at most `timeoutMs`.
 */
async function jiraServers($: EngineInterface, timeoutMs = JIRA_CHECK_TIMEOUT_MS): Promise<JiraServer[]> {
  const listed = await listedJiraServers($)
  if (listed.length > 0) return listed
  const answers = await Promise.all(KNOWN_SERVERS.map(name => callJira($, name, JIRA_TOOLS.sites, {}, timeoutMs).then(() => true, () => false)))
  return KNOWN_SERVERS.filter((_name, index) => answers[index] === true).map(name => ({ name, tools: new Set<string>() }))
}

/**
 * The server to call. The one the person's setup named is called directly, whether or not
 * the tool list shows it; else the only one connected; a string says what is missing.
 */
async function findServer($: EngineInterface, named: Answer | undefined, timeoutMs?: number): Promise<JiraServer | string> {
  const wanted = textOf(named)
  if (wanted === undefined) return pickServer(await jiraServers($, timeoutMs), undefined)
  const listed = await listedJiraServers($)
  return listed.find(server => serverSpelling(server.name) === serverSpelling(wanted)) ?? { name: wanted, tools: new Set<string>() }
}

/**
 * The tools of a server found by name alone. The server with a transitions list answers
 * `getVisibleJiraProjects`, which the other lacks.
 */
async function probeTools($: EngineInterface, server: string, cloudId: string): Promise<ReadonlySet<string>> {
  const isListing = await callJira($, server, JIRA_TOOLS.projects, { cloudId }).then(
    () => true,
    () => false,
  )
  return new Set(isListing ? LISTING_TOOLS : RUNNER_TOOLS)
}

/**
 * The server to call: the one the person's setup named, else the only one connected; a
 * string says what is missing (D25: never a silent fallback).
 */
export const pickServer = (servers: readonly JiraServer[], named: Answer | undefined): JiraServer | string => {
  const wanted = textOf(named)
  const picked = wanted === undefined ? undefined : servers.find(server => serverSpelling(server.name) === serverSpelling(wanted))
  if (picked !== undefined) return picked
  const [only] = servers
  if (servers.length === 1 && only !== undefined) return only
  if (servers.length === 0) {
    return `No Atlassian (Jira) server is connected to this session${wanted === undefined ? '' : ` (the setup named ${wanted})`}, so godmode cannot reach Jira. Connect the Atlassian connector (\`/mcp\`), then try again.`
  }
  return `Several Atlassian servers are connected (${servers.map(server => server.name).join(', ')})${wanted === undefined ? '' : `, and none is the ${wanted} the setup named`}. Pick one with \`/godmode setup\`.`
}

/** The text an MCP result carries. */
const resultText = (result: McpToolResult) =>
  result.content
    .map(block => (typeof block.text === 'string' ? block.text : ''))
    .join('\n')
    .trim()

/** An MCP result as data: its structured content, else its text read as JSON, else the text. */
const payloadOf = (result: McpToolResult): unknown => {
  if (result.structuredContent !== undefined) return result.structuredContent
  const text = resultText(result)
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/**
 * Calls one Jira tool. With `timeoutMs`, a call that has not answered by then fails, and
 * the wait ends as soon as it answers. A failure throws a `JiraError` saying which tool and
 * why.
 */
async function callJira($: EngineInterface, server: string, tool: string, args: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
  const calling = $.mcp.call(server, tool, args).catch((error: unknown) => {
    throw new JiraUnreachable(`Jira's ${tool} could not be called on ${server}: ${messageOf(error)}`)
  })
  let result: McpToolResult
  if (timeoutMs === undefined) {
    result = await calling
  } else {
    const stop = new AbortController()
    const timer = $.clock.sleep(timeoutMs, { signal: stop.signal }).then(
      () => 'timeout' as const,
      () => 'stopped' as const,
    )
    try {
      const first = await Promise.race([calling, timer])
      if (first === 'timeout' || first === 'stopped') throw new JiraTimeout(`Jira's ${tool} did not answer within ${timeoutMs / 1000} s`)
      result = first
    } finally {
      stop.abort()
    }
  }
  if (result.isError) {
    const said = resultText(result).slice(0, 300)
    throw new JiraRefused(`Jira's ${tool} failed: ${said || 'no reason given'}`, said)
  }
  return payloadOf(result)
}

/** A call that ran out of time: Jira is slow or away, so the other calls of the moment are skipped. */
class JiraTimeout extends JiraError {}

/** A call the session could not make at all: the server is not connected. */
class JiraUnreachable extends JiraError {}

/** A call Jira answered with an error; `said` is Jira's own text. */
class JiraRefused extends JiraError {
  constructor(
    message: string,
    readonly said: string,
  ) {
    super(message)
  }
}

/** Whether Jira's error says an issue does not exist (deleted, or hidden from this person). */
const saysMissing = (said: string) => /does not exist|doesn't exist|no longer exists|not found/i.test(said)

/** The issue keys Jira's error says do not exist, as it quotes them: `An issue with key 'APP-6' does not exist`. */
export const missingKeysIn = (said: string) =>
  saysMissing(said) ? [...new Set([...said.matchAll(/['"]([A-Za-z][A-Za-z0-9_]*-\d+)['"]/g)].flatMap(match => issueKeyOf(match[1] ?? '') ?? []))] : []

// ---------------------------------------------------------------------------
// Reading Jira's answers, leniently: Atlassian's servers shape them a little differently

/** An issue as godmode reads it. */
export type JiraIssue = { key: string; summary: string; status: BoardStatus; created?: string }

const statusIn = (value: unknown): BoardStatus | undefined => {
  // One server answers the status as its bare name.
  if (typeof value === 'string') return value.trim() === '' ? undefined : { name: value.trim() }
  if (!isRecord(value) || typeof value.name !== 'string') return undefined
  const category = isRecord(value.statusCategory) && typeof value.statusCategory.key === 'string' ? value.statusCategory.key : undefined
  return { name: value.name, ...(category === undefined ? {} : { category }) }
}

/** An issue from `getJiraIssue` or a search row; undefined when it has no key. One with no readable status has the status "unknown". */
export const issueIn = (value: unknown): JiraIssue | undefined => {
  const issue = isRecord(value) && isRecord(value.issue) ? value.issue : value
  if (!isRecord(issue) || typeof issue.key !== 'string') return undefined
  const fields = isRecord(issue.fields) ? issue.fields : issue
  const status = statusIn(fields.status) ?? UNKNOWN_STATUS
  const created = typeof fields.created === 'string' ? fields.created.slice(0, 10) : undefined
  return { key: issue.key.toUpperCase(), summary: typeof fields.summary === 'string' ? fields.summary : '', status, ...(created === undefined ? {} : { created }) }
}

/** The rows of a list answer: the array itself, or the first array under a usual field. */
const rowsIn = (value: unknown, fields: readonly string[]): unknown[] => {
  if (Array.isArray(value)) return value
  if (!isRecord(value)) return []
  for (const field of fields) {
    const rows = value[field]
    if (Array.isArray(rows)) return rows
    if (isRecord(rows) && Array.isArray(rows.nodes)) return rows.nodes
  }
  return []
}

const issuesIn = (value: unknown) => rowsIn(value, ['issues', 'values', 'results']).flatMap(row => issueIn(row) ?? [])

/** The new issue's key in `createJiraIssue`'s answer. */
const createdKeyIn = (value: unknown) => {
  const candidates = isRecord(value) ? [value.key, value.issueKey, isRecord(value.issue) ? value.issue.key : undefined] : [value]
  for (const candidate of candidates) {
    const key = typeof candidate === 'string' ? (issueKeyOf(candidate) ?? /\b([A-Z][A-Z0-9_]*-\d+)\b/.exec(candidate)?.[1]) : undefined
    if (key !== undefined) return key
  }
  return undefined
}

/** An answer's payload, under the `result` or `data` field a generic runner may wrap it in. */
const unwrapped = (value: unknown): unknown => {
  if (!isRecord(value)) return value
  const inner = [value.result, value.data].find(field => isRecord(field) || Array.isArray(field))
  return inner ?? value
}

type Transition = { id: string; name: string; to: string }

const transitionsIn = (value: unknown): Transition[] =>
  rowsIn(Array.isArray(value) || (isRecord(value) && ('transitions' in value || 'values' in value)) ? value : unwrapped(value), ['transitions', 'values']).flatMap(row => {
    if (!isRecord(row) || (typeof row.id !== 'string' && typeof row.id !== 'number')) return []
    const to = isRecord(row.to) && typeof row.to.name === 'string' ? row.to.name : typeof row.name === 'string' ? row.name : ''
    return [{ id: String(row.id), name: typeof row.name === 'string' ? row.name : to, to }]
  })

/** An operation name in `discover`'s answer that reads an issue's transitions. */
const transitionsOperationIn = (value: unknown) =>
  rowsIn(unwrapped(value), ['results', 'operations', 'values'])
    .flatMap(row => (isRecord(row) && typeof row.name === 'string' ? [row.name] : []))
    .find(name => /transition/i.test(name) && name !== JIRA_TOOLS.transition)

/**
 * The status an issue landed in, from a transition's answer: a status object anywhere usual,
 * or a bare name that is one of the board's `known` names (a bare `status` field may be the
 * call's own outcome, such as "success").
 */
const landedStatusIn = (value: unknown, known: readonly string[]): string | undefined => {
  const answer = unwrapped(value)
  if (!isRecord(answer)) return undefined
  for (const field of ['landedStatus', 'currentStatus', 'newStatus', 'toStatus', 'status', 'to']) {
    const raw = answer[field]
    const found = typeof raw === 'string' ? (known.some(name => sameName(name, raw)) ? raw.trim() : undefined) : statusIn(raw)?.name
    if (found !== undefined) return found
  }
  const issue = issueIn(answer)
  return issue === undefined || issue.status.isUnread === true ? undefined : issue.status.name
}

type Site = { id: string; name: string; url?: string }

const sitesIn = (value: unknown): Site[] =>
  rowsIn(value, ['resources', 'sites', 'values']).flatMap(row =>
    isRecord(row) && typeof row.id === 'string'
      ? [{ id: row.id, name: typeof row.name === 'string' ? row.name : row.id, ...(typeof row.url === 'string' ? { url: row.url } : {}) }]
      : [],
  )

type JiraProject = { key: string; name: string }

const projectsIn = (value: unknown): JiraProject[] =>
  rowsIn(value, ['values', 'projects', 'results']).flatMap(row =>
    isRecord(row) && typeof row.key === 'string' ? [{ key: row.key, name: typeof row.name === 'string' ? row.name : row.key }] : [],
  )

// ---------------------------------------------------------------------------
// Side files: what godmode keeps that Jira has no field for

/** One issue's side file, keyed by its key. */
export type JiraSide = {
  title?: string
  /** The godmode status last recorded, so an unmapped board status keeps its meaning. */
  status?: TicketStatus
  blockedBy: string[]
  branch?: string
  pr?: string
  visibleChange: boolean
  ready: boolean
  qaResult?: QaResult
  fixFor?: string
  created?: string
}

export const JIRA_SIDE_FOLDER = 'jira'

/** The folder of the side files: godmode's personal tracker folder, `jira/`. */
export async function jiraSideDirOf($: EngineInterface, project?: Project) {
  return `${await trackerDirOf($, project)}/${JIRA_SIDE_FOLDER}`
}

const isStatus = (value: unknown): value is TicketStatus => STATUSES.some(status => status === value)

const sideIn = (value: unknown): JiraSide | undefined => {
  if (!isRecord(value)) return undefined
  const strings = (field: unknown) => (Array.isArray(field) ? field.filter((item): item is string => typeof item === 'string') : [])
  const recorded = isRecord(value.qaResult) ? value.qaResult : {}
  const word = recorded.result === 'passed' || recorded.result === 'failed' ? recorded.result : undefined
  const qa: QaResult | undefined = word !== undefined && typeof recorded.commit === 'string' ? { result: word, commit: recorded.commit } : undefined
  const optional = (key: string) => (typeof value[key] === 'string' && value[key] !== '' ? { [key]: value[key] } : {})
  return {
    ...optional('title'),
    ...(isStatus(value.status) ? { status: value.status } : {}),
    blockedBy: strings(value.blockedBy),
    ...optional('branch'),
    ...optional('pr'),
    visibleChange: value.visibleChange !== false,
    ready: value.ready === true,
    ...(qa === undefined ? {} : { qaResult: qa }),
    ...optional('fixFor'),
    ...optional('created'),
  }
}

/** One side file; undefined when there is none or it cannot be read, as for an issue godmode never saw. */
async function readSide($: EngineInterface, dir: string, key: string): Promise<JiraSide | undefined> {
  const text = await $.fs.read(`${dir}/${key}.json`).catch(() => undefined)
  try {
    return text === undefined ? undefined : sideIn(JSON.parse(text))
  } catch {
    return undefined
  }
}

/** Every side file in `dir`, by key. */
async function readSides($: EngineInterface, dir: string): Promise<Map<string, JiraSide>> {
  const sides = new Map<string, JiraSide>()
  if (!(await $.fs.exists(dir).catch(() => false))) return sides
  for (const entry of await $.fs.list(dir).catch(() => [])) {
    const key = entry.kind === 'file' && entry.name.endsWith('.json') ? issueKeyOf(entry.name.slice(0, -5)) : undefined
    const side = key === undefined ? undefined : await readSide($, dir, key)
    if (key !== undefined && side !== undefined) sides.set(key, side)
  }
  return sides
}

/** Where the side files of issues Jira no longer has go, so they stop breaking every search. */
export const ARCHIVED_FOLDER = 'archived'

/** Moves the side files of `keys` into `archived/`; resolves why it could not, or undefined. */
async function archiveSides($: EngineInterface, dir: string, keys: readonly string[]): Promise<string | undefined> {
  if (keys.length === 0) return undefined
  // `$.fs` has no move: `mkdir -p` and `mv`, as the markdown tickets' done folder does.
  const made = await $.process.run(['mkdir', '-p', `${dir}/${ARCHIVED_FOLDER}`]).catch((error: unknown) => messageOf(error))
  if (typeof made === 'string') return made
  if (made.exitCode !== 0) return made.stderr.trim() || `mkdir exited ${made.exitCode}`
  for (const key of keys) {
    const moved = await $.process.run(['mv', `${dir}/${key}.json`, `${dir}/${ARCHIVED_FOLDER}/${key}.json`]).catch((error: unknown) => messageOf(error))
    if (typeof moved === 'string') return moved
    if (moved.exitCode !== 0) return moved.stderr.trim() || `mv exited ${moved.exitCode}`
  }
  return undefined
}

/** The PM's line for side-file keys Jira did not return. */
const missingLine = (keys: readonly string[], kept: string) => `Not found in Jira: ${keys.join(', ')}; ${keys.length === 1 ? 'its side file was' : 'their side files were'} ${kept}.`

const sideOf = (header: TicketHeader): JiraSide => ({
  title: header.title,
  status: header.status,
  blockedBy: header.blockedBy,
  ...(header.branch === undefined ? {} : { branch: header.branch }),
  ...(header.pr === undefined ? {} : { pr: header.pr }),
  visibleChange: header.visibleChange,
  ready: header.ready,
  ...(header.qaResult === undefined ? {} : { qaResult: header.qaResult }),
  ...(header.fixFor === undefined ? {} : { fixFor: header.fixFor }),
  ...(header.created === '' ? {} : { created: header.created }),
})

/** A ticket header from Jira's issue and godmode's side file. An issue godmode never saw counts as a visible change, so QA is not skipped by default. */
export const headerOf = (issue: JiraIssue, side: JiraSide | undefined, map: StatusMap): TicketHeader => ({
  id: issue.key,
  title: issue.summary || side?.title || '',
  status: godmodeStatusOf(issue.status, map, side?.status),
  trackerStatus: issue.status.name,
  blockedBy: side?.blockedBy ?? [],
  ...(side?.branch === undefined ? {} : { branch: side.branch }),
  ...(side?.pr === undefined ? {} : { pr: side.pr }),
  visibleChange: side?.visibleChange ?? true,
  ready: side?.ready ?? false,
  ...(side?.qaResult === undefined ? {} : { qaResult: side.qaResult }),
  ...(side?.fixFor === undefined ? {} : { fixFor: side.fixFor }),
  created: side?.created ?? issue.created ?? '',
})

// ---------------------------------------------------------------------------
// The setup note's Jira answers

/** Where the board is: the site (a cloud id or the site's address) and the project's key. */
export type JiraSettings = { cloudId: string; project: string; issueType: string; statuses: StatusMap }

/** The Jira settings in a note's answers; a string says which answer is missing. */
export const jiraSettingsOf = (answers: Readonly<Record<string, Answer>>): JiraSettings | string => {
  const cloudId = textOf(answers.jiraCloudId)
  const project = textOf(answers.jiraProject)?.toUpperCase()
  if (cloudId === undefined || project === undefined) {
    const missing = [cloudId === undefined ? 'Atlassian site' : undefined, project === undefined ? 'Jira project' : undefined].filter(part => part !== undefined)
    return `The setup recorded no ${missing.join(' and no ')} for the Jira tracker, so godmode does not know where to file tickets. Record ${missing.length === 1 ? 'it' : 'them'} with \`/godmode setup\`.`
  }
  return { cloudId, project, issueType: textOf(answers.jiraIssueType) ?? DEFAULT_ISSUE_TYPE, statuses: statusMapOf(answers) }
}

/** Shared answers, then personal ones over them (D61). */
async function noteAnswersOf($: EngineInterface): Promise<Record<string, Answer>> {
  const found = await readNote($)
  if (found.status === 'none') throw new JiraError('godmode is not set up in this project yet, so it has nowhere to keep tickets. Finish the setup first.')
  if (found.status === 'unreadable') throw new JiraError(`godmode cannot read its setup note at ${found.path}: ${found.reason}.`)
  return { ...found.shared.answers, ...(found.personal?.answers ?? {}) }
}

/** What every Jira call needs: the server, the board, and where the side files are. */
type Jira = { server: JiraServer; settings: JiraSettings; sideDir: string }

async function openJira($: EngineInterface, answers: Readonly<Record<string, Answer>>, project?: Project, timeoutMs?: number): Promise<Jira> {
  const settings = jiraSettingsOf(answers)
  if (typeof settings === 'string') throw new JiraError(settings)
  const server = await findServer($, answers.jiraServer, timeoutMs)
  if (typeof server === 'string') throw new JiraError(server)
  return { server, settings, sideDir: await jiraSideDirOf($, project) }
}

/** What a search over side-file keys found, and the keys Jira says do not exist. */
type KeyedSearch = { issues: JiraIssue[]; gone: string[] }

type SearchKeys = { jqlOf: (keys: readonly string[]) => string; fields: string[]; timeoutMs?: number; isPerKey: boolean }

/** One JQL search over `keys`. */
async function searchOnce($: EngineInterface, jira: Jira, keys: readonly string[], options: SearchKeys): Promise<JiraIssue[]> {
  const args = { cloudId: jira.settings.cloudId, jql: options.jqlOf(keys), fields: options.fields, maxResults: 100 }
  return issuesIn(await callJira($, jira.server.name, JIRA_TOOLS.search, args, options.timeoutMs))
}

/** Each key searched alone; a key Jira says does not exist is gone, any other failure is thrown. */
async function searchEach($: EngineInterface, jira: Jira, keys: readonly string[], options: SearchKeys): Promise<KeyedSearch> {
  const found: KeyedSearch = { issues: [], gone: [] }
  for (const key of keys) {
    try {
      found.issues.push(...(await searchOnce($, jira, [key], options)))
    } catch (error) {
      if (!(error instanceof JiraRefused) || !saysMissing(error.said)) throw error
      found.gone.push(key)
    }
  }
  return found
}

/**
 * Searches `keys` with the JQL `jqlOf` builds. One issue Jira no longer has (deleted, or
 * hidden from this person) makes it refuse the whole `key in (...)` search, so a refusal
 * that names such keys is made again without them. When it names none, each key is searched
 * alone if `isPerKey`, else the refusal is thrown. Any other failure is thrown.
 */
async function searchKeys($: EngineInterface, jira: Jira, keys: readonly string[], options: SearchKeys): Promise<KeyedSearch> {
  const gone: string[] = []
  let rest = [...keys]
  while (rest.length > 0) {
    try {
      return { issues: await searchOnce($, jira, rest, options), gone }
    } catch (error) {
      if (!(error instanceof JiraRefused) || !saysMissing(error.said)) throw error
      const named = missingKeysIn(error.said).filter(key => rest.includes(key))
      if (named.length === 0 && !options.isPerKey) throw error
      if (named.length === 0) {
        const each = await searchEach($, jira, rest, options)
        return { issues: each.issues, gone: [...gone, ...each.gone] }
      }
      gone.push(...named)
      rest = rest.filter(key => !named.includes(key))
    }
  }
  return { issues: [], gone }
}

/**
 * The keys a filter's `around` adds whatever their status: the ticket itself and, with
 * `withFixes`, those its side files say fix it. Read from the side files alone, so no done
 * ticket but these is searched.
 */
const aroundKeys = (sides: ReadonlyMap<string, JiraSide>, around: TicketFilter['around']) => {
  const key = around === undefined ? undefined : issueKeyOf(around.id)
  if (key === undefined) return new Set<string>()
  const fixes = around?.withFixes === true ? [...sides].filter(([, side]) => side.fixFor?.toUpperCase() === key).map(([fix]) => fix) : []
  return new Set([key, ...fixes])
}

/** `keys` in batches of `size`. */
const batchesOf = <T>(keys: readonly T[], size: number) => Array.from({ length: Math.ceil(keys.length / size) }, (_unused, index) => keys.slice(index * size, (index + 1) * size))

/** Jira's searches return 100 issues at most. */
const SEARCH_BATCH = 100

// ---------------------------------------------------------------------------
// The backend

/** A ticket's draft as the issue's description: the ticket shape, without godmode's heading or comments. */
export const descriptionOf = (draft: TicketDraft) => {
  const section = (heading: string, text?: string) => (text === undefined || text.trim() === '' ? [] : [`## ${heading}`, '', text.trim(), ''])
  const scope = [
    ...(draft.scopeIn?.trim() ? [`**In:** ${draft.scopeIn.trim()}`, ''] : []),
    ...(draft.scopeOut?.trim() ? [`**Out:** ${draft.scopeOut.trim()}`, ''] : []),
  ]
  return [
    ...section('The ask', draft.ask),
    ...section('Measured', draft.measured),
    ...section('Inferred', draft.inferred),
    ...section('Answer this first', draft.answerFirst),
    ...(scope.length === 0 ? [] : ['## Scope', '', ...scope]),
    ...section('Constraints', draft.constraints),
    ...section('Tests', draft.tests),
    ...section('Refs', draft.refs),
  ]
    .join('\n')
    .trim()
}

/** Keys checked as issue keys, each upper-cased; a ticket cannot block itself. */
const keysIn = (raw: readonly string[], field: string, self?: string) =>
  raw.map(entry => {
    const key = issueKeyOf(entry)
    if (key === undefined) throw new JiraError(`\`${entry}\` in ${field} is not a Jira issue key; keys look like APP-12.`)
    if (key === self) throw new JiraError(`${key} cannot block itself.`)
    return key
  })

/**
 * The Jira backend (D24): Jira holds each ticket's title and status, its side file the
 * rest. `list` reads the tickets godmode filed or moved, never the whole board. The note's
 * answers come in `answers`, or are read on the first call.
 */
export function jiraBackend($: EngineInterface, answers?: Readonly<Record<string, Answer>>): TicketBackend {
  let opened: Promise<Jira> | undefined
  const jira = () => {
    opened ??= (async () => openJira($, answers ?? (await noteAnswersOf($))))()
    return opened
  }
  let probed: Promise<ReadonlySet<string>> | undefined
  /** The server's tools, which tell its two shapes apart: probed once when the tool list did not show them. */
  const toolsOf = () => {
    probed ??= (async () => {
      const { server, settings } = await jira()
      return server.tools.size > 0 ? server.tools : probeTools($, server.name, settings.cloudId)
    })()
    return probed
  }
  const call = async (tool: string, args: Record<string, unknown>) => {
    const { server, settings } = await jira()
    return callJira($, server.name, tool, { cloudId: settings.cloudId, ...args })
  }
  const sideFor = async (key: string) => readSide($, (await jira()).sideDir, key)
  const writeSide = async (header: TicketHeader) => $.fs.write(`${(await jira()).sideDir}/${header.id}.json`, `${JSON.stringify(sideOf(header), null, 2)}\n`)

  const keyFor = (raw: string) => {
    const key = issueKeyOf(raw)
    if (key === undefined) throw new JiraError(`\`${raw}\` is not a Jira issue key; keys look like APP-12.`)
    return key
  }
  const readIssue = async (key: string) => {
    const issue = issueIn(await call(JIRA_TOOLS.read, { issueIdOrKey: key }))
    if (issue === undefined) throw new JiraError(`Jira answered no issue ${key} with a status.`)
    return issue
  }

  /** The transitions an issue can take now, from whichever read the server offers. */
  const transitionsOf = async (key: string): Promise<Transition[]> => {
    if ((await toolsOf()).has(JIRA_TOOLS.transitions)) return transitionsIn(await call(JIRA_TOOLS.transitions, { issueIdOrKey: key }))
    const { server } = await jira()
    const viaRunner = (name: string) => call(RUNNER.read, { name, inputs: { issueIdOrKey: key } })
    const answer = await viaRunner(RUNNER.transitions).catch(async (error: unknown) => {
      // The operation's name is the server's to give: ask its discover tool, which takes no site.
      const found = transitionsOperationIn(await callJira($, server.name, RUNNER.discover, { query: 'list the transitions available for a jira issue' }).catch(() => undefined))
      if (found === undefined || found === RUNNER.transitions) throw error
      return viaRunner(found)
    })
    return transitionsIn(answer)
  }

  /** Moves an issue on the board to the status godmode's `status` maps to; resolves the status it landed in. */
  const transition = async (issue: JiraIssue, status: TicketStatus) => {
    const { settings } = await jira()
    const target = settings.statuses[status]
    if (target === undefined) {
      throw new JiraError(
        `No board status is set for godmode's ${status}${status === 'qa' ? ' (the setup\'s waiting-for-QA status)' : ''}, so ${issue.key} cannot move there. Name it with \`/godmode setup\`. Nothing changed.`,
      )
    }
    const transitions = await transitionsOf(issue.key)
    const way = transitions.find(candidate => sameName(candidate.to, target)) ?? transitions.find(candidate => sameName(candidate.name, target))
    if (way === undefined) {
      const reachable = [...new Set(transitions.map(candidate => `"${candidate.to}"`))].join(', ') || 'nowhere'
      throw new JiraError(
        `${issue.key} cannot move from "${issue.status.name}" to "${target}" on the board: its workflow leads to ${reachable} from there. Move it by hand, or change the mapping with \`/godmode setup\`. Nothing changed.`,
      )
    }
    // One server takes `transition: { id }`, the other `transitionId`.
    const isListing = (await toolsOf()).has(JIRA_TOOLS.transitions)
    const answer = await call(JIRA_TOOLS.transition, { issueIdOrKey: issue.key, ...(isListing ? { transition: { id: way.id } } : { transitionId: way.id }) })
    // Automation can move it on at once: the status it landed in is Jira's to say, not the target.
    const known = [target, issue.status.name, ...transitions.map(candidate => candidate.to)]
    return landedStatusIn(answer, known) ?? (await readIssue(issue.key)).status.name
  }

  const listNoted = async (filter: TicketFilter) => {
    const board = await jira()
    const statuses = filter.statuses ?? STATUSES.filter(status => status !== 'done')
    const sides = await readSides($, board.sideDir)
    const around = aroundKeys(sides, filter.around)
    const keys = [...sides].filter(([key, side]) => statuses.includes('done') || side.status !== 'done' || around.has(key)).map(([key]) => key).sort(byKey)
    const headers: TicketHeader[] = []
    const gone: string[] = []
    const unseen: string[] = []
    for (const batch of batchesOf(keys, SEARCH_BATCH)) {
      const found = await searchKeys($, board, batch, { jqlOf: scope => `key in (${scope.join(', ')}) ORDER BY key ASC`, fields: ['summary', 'status', 'created'], isPerKey: true })
      for (const issue of found.issues) headers.push(headerOf(issue, sides.get(issue.key), board.settings.statuses))
      const returned = new Set(found.issues.map(issue => issue.key))
      gone.push(...found.gone)
      unseen.push(...batch.filter(key => !returned.has(key) && !found.gone.includes(key)))
    }
    const notes: string[] = []
    if (gone.length > 0) {
      const failed = await archiveSides($, board.sideDir, gone)
      notes.push(missingLine(gone, failed === undefined ? `archived (moved to ${ARCHIVED_FOLDER}/ beside the others)` : `kept, as archiving failed (${failed})`))
    }
    if (unseen.length > 0) notes.push(missingLine(unseen, 'kept'))
    return { headers: headers.filter(header => statuses.includes(header.status) || around.has(header.id)).sort((a, b) => byKey(a.id, b.id)), notes }
  }

  return {
    tracker: 'jira',

    create: async draft => {
      const { settings } = await jira()
      const blockedBy = keysIn(draft.blockedBy ?? [], 'blockedBy')
      const [fixFor] = draft.fixFor === undefined ? [] : keysIn([draft.fixFor], 'fixFor')
      // One server takes the type as `issueTypeName`, the other as `issueType`.
      const typeField = (await toolsOf()).has(JIRA_TOOLS.transitions) ? 'issueTypeName' : 'issueType'
      const answer = await call(JIRA_TOOLS.create, {
        projectKey: settings.project,
        summary: oneLine(draft.title),
        [typeField]: settings.issueType,
        description: descriptionOf(draft),
      })
      const key = createdKeyIn(answer)
      if (key === undefined) throw new JiraError(`Jira filed the issue but answered no key godmode could read, so it keeps no record of it. Find it in ${settings.project} and move it with ticket_move.`)
      const header: TicketHeader = {
        id: key,
        title: oneLine(draft.title),
        status: 'todo',
        blockedBy,
        visibleChange: draft.visibleChange,
        ready: false,
        ...(fixFor === undefined ? {} : { fixFor }),
        created: new Date(await $.clock.now()).toISOString().slice(0, 10),
      }
      await writeSide(header)
      return header
    },

    move: async (id, change: TicketChange) => {
      const key = keyFor(id)
      const issue = await readIssue(key)
      const { statuses } = (await jira()).settings
      const current = headerOf(issue, await sideFor(key), statuses)
      const blockedBy = change.blockedBy === undefined ? current.blockedBy : keysIn(change.blockedBy, 'blockedBy', key)
      const isOnBoard = change.status === undefined || sameName(statuses[change.status], issue.status.name)
      const landed = isOnBoard ? issue.status.name : await transition(issue, change.status ?? current.status)
      const header: TicketHeader = { ...current, ...change, blockedBy, trackerStatus: landed }
      await writeSide(header)
      return header
    },

    list: async (filter: TicketFilter) => (await listNoted(filter)).headers,

    listNoted,

    comment: async (id, comment: TicketComment) => {
      const key = keyFor(id)
      const issue = await readIssue(key)
      const { settings } = await jira()
      const tools = await toolsOf()
      const tool = COMMENT_TOOLS.find(name => tools.has(name)) ?? COMMENT_TOOLS[0] ?? ''
      await call(tool, { issueIdOrKey: key, commentBody: `**${oneLine(comment.author)}:** ${comment.text.trim()}` })
      return headerOf(issue, await sideFor(key), settings.statuses)
    },
  }
}

// ---------------------------------------------------------------------------
// The prompt hook's QA check (D73)

/** A ticket waiting on QA in Jira, with its board status when the read answered; `missing` when Jira no longer has it. */
export type JiraWaiting = { id: string; title?: string; status?: string; pr?: string; qaResult?: QaResult; missing?: string }

/** godmode's open Jira tickets, from the side files alone: those still watched, those it moved to qa, and each one's waiting entry. */
async function watchedSides($: EngineInterface, project: Project) {
  const sideDir = await jiraSideDirOf($, project)
  const sides = await readSides($, sideDir)
  const fixed = new Set([...sides.values()].flatMap(side => (side.fixFor === undefined ? [] : [side.fixFor.toUpperCase()])))
  const watched = [...sides].filter(([key, side]) => side.status !== 'done' && !fixed.has(key))
  const inQa = watched.filter(([, side]) => side.status === 'qa').map(([key]) => key).sort(byKey)
  const fromSides = (key: string): JiraWaiting => {
    const side = sides.get(key)
    return { id: key, ...(side?.title === undefined ? {} : { title: side.title }), ...(side?.pr === undefined ? {} : { pr: side.pr }), ...(side?.qaResult === undefined ? {} : { qaResult: side.qaResult }) }
  }
  return { sideDir, sides, watched, inQa, fromSides }
}

/**
 * The Jira tickets godmode moved to qa, from its side files alone, with no call to Jira: in
 * a QA mode where nobody tests by hand, nothing on the board is watched, and a ticket left
 * in qa from an earlier mode is only listed.
 */
export async function jiraMovedToQa($: EngineInterface, project: Project): Promise<JiraWaiting[]> {
  const { inQa, fromSides } = await watchedSides($, project)
  return inQa.map(fromSides)
}

/**
 * The Jira tickets waiting on QA, oldest first: those godmode moved to qa (their side files
 * say so) and those of its tickets the board shows in the waiting status, from JQL reads of
 * 100 keys each, side by side, each stopping after 3 seconds. A staging original whose fix
 * ticket is filed is not watched. `unreadable` says why the board could not be read: then
 * each ticket's status is the PM's to check (D73). An issue Jira says does not exist has its
 * side file archived and is searched around; a search Jira refused otherwise leaves each
 * ticket to be read alone.
 */
export async function jiraWaiting(
  $: EngineInterface,
  context: { project: Project; answers: Readonly<Record<string, Answer>> },
  waitStatus: string,
): Promise<{ tickets: JiraWaiting[]; unreadable?: string }> {
  const { sideDir, sides, watched, inQa, fromSides } = await watchedSides($, context.project)
  if (watched.length === 0) return { tickets: [] }
  let jira: Jira
  try {
    jira = await openJira($, context.answers, context.project, JIRA_CHECK_TIMEOUT_MS)
  } catch (error) {
    return { tickets: inQa.map(fromSides), unreadable: messageOf(error) }
  }
  const jqlOf = (scope: readonly string[]) => {
    const moved = inQa.filter(key => scope.includes(key))
    return `key in (${scope.join(', ')}) AND (status = ${jqlText(waitStatus)}${moved.length === 0 ? '' : ` OR key in (${moved.join(', ')})`}) ORDER BY key ASC`
  }
  const batches = batchesOf(watched.map(([key]) => key).sort(byKey), SEARCH_BATCH)
  let found: KeyedSearch[]
  try {
    found = await Promise.all(batches.map(batch => searchKeys($, jira, batch, { jqlOf, fields: ['summary', 'status'], timeoutMs: JIRA_CHECK_TIMEOUT_MS, isPerKey: false })))
  } catch (error) {
    if (error instanceof JiraTimeout || error instanceof JiraUnreachable) return { tickets: inQa.map(fromSides), unreadable: error.message }
    // Jira refused the search without naming the issue at fault: each ticket is read alone.
    return { tickets: inQa.map(fromSides) }
  }
  const gone = found.flatMap(batch => batch.gone)
  const failed = await archiveSides($, sideDir, gone)
  const missing = gone.filter(key => inQa.includes(key)).map(key => ({ ...fromSides(key), missing: missingLine([key], failed === undefined ? 'archived' : `kept, as archiving failed (${failed})`) }))
  const read = found.flatMap(batch => batch.issues).map(issue => ({
    ...fromSides(issue.key),
    title: issue.summary || sides.get(issue.key)?.title,
    ...(issue.status.isUnread === true ? {} : { status: issue.status.name }),
  }))
  return { tickets: [...read, ...missing].sort((a, b) => byKey(a.id, b.id)) }
}

/** One Jira ticket's board status, read within 3 seconds; undefined when it could not be read. */
export async function jiraStatusOf($: EngineInterface, context: { project: Project; answers: Readonly<Record<string, Answer>> }, key: string) {
  try {
    const jira = await openJira($, context.answers, context.project, JIRA_CHECK_TIMEOUT_MS)
    const answer = await callJira($, jira.server.name, JIRA_TOOLS.read, { cloudId: jira.settings.cloudId, issueIdOrKey: key }, JIRA_CHECK_TIMEOUT_MS)
    const status = issueIn(answer)?.status
    return status === undefined || status.isUnread === true ? undefined : status.name
  } catch {
    return undefined
  }
}

/** An issue's latest comment as godmode reads it: its text on one line, and who wrote it when Jira says. */
export type JiraComment = { text: string; author?: string }

/** A comment body as plain text: markdown or HTML as given, or the text nodes of Atlassian's document format. */
export const commentTextOf = (body: unknown): string => {
  if (typeof body === 'string') return body.replace(/<[^>]*>/g, ' ')
  if (Array.isArray(body)) return body.map(commentTextOf).join(' ')
  if (!isRecord(body)) return ''
  return typeof body.text === 'string' ? body.text : commentTextOf(body.content)
}

const commentIn = (row: unknown): JiraComment | undefined => {
  if (!isRecord(row)) return undefined
  const text = oneLine(commentTextOf(row.body))
  if (text === '') return undefined
  const author = isRecord(row.author) && typeof row.author.displayName === 'string' && row.author.displayName.trim() !== '' ? row.author.displayName : undefined
  return { text, ...(author === undefined ? {} : { author }) }
}

/**
 * The latest comment in a comment list's answer or in `getJiraIssue`'s `comment` field: the
 * one created last when every row has a date, else the first of a list asked newest first,
 * or the last of the issue's own list, which Jira gives oldest first.
 */
export const latestCommentIn = (value: unknown, isNewestFirst: boolean): JiraComment | undefined => {
  const answer = unwrapped(value)
  const issue = isRecord(answer) && isRecord(answer.issue) ? answer.issue : answer
  const fields = isRecord(issue) && isRecord(issue.fields) ? issue.fields : issue
  const holder = isRecord(fields) && isRecord(fields.comment) ? fields.comment : answer
  const rows = rowsIn(holder, ['comments', 'values', 'results']).filter(isRecord)
  const isDated = rows.length > 0 && rows.every(row => typeof row.created === 'string')
  const latest = isDated ? rows.reduce((last, row) => (String(row.created) > String(last.created) ? row : last)) : isNewestFirst ? rows[0] : rows.at(-1)
  return commentIn(latest)
}

/**
 * The latest comment on one issue, for the prompt hook's line on a QA fail (a tester's
 * reason is usually there), read within 3 seconds from the same server the ticket tools
 * use. It never throws: "none" when the issue has no comment, "unreadable" when the read
 * failed or was slow.
 */
export async function jiraLatestComment(
  $: EngineInterface,
  context: { project: Project; answers: Readonly<Record<string, Answer>> },
  key: string,
): Promise<JiraComment | 'none' | 'unreadable'> {
  try {
    const jira = await openJira($, context.answers, context.project, JIRA_CHECK_TIMEOUT_MS)
    const { name, tools } = jira.server
    const base = { cloudId: jira.settings.cloudId, issueIdOrKey: key, responseContentFormat: 'markdown' }
    const viaList = async () => latestCommentIn(await callJira($, name, COMMENT_LIST_TOOL, { ...base, orderBy: '-created', maxResults: 1 }, JIRA_CHECK_TIMEOUT_MS), true)
    const viaIssue = async () => latestCommentIn(await callJira($, name, JIRA_TOOLS.read, { ...base, fields: ['comment'] }, JIRA_CHECK_TIMEOUT_MS), false)
    let found: JiraComment | undefined
    if (tools.has(COMMENT_LIST_TOOL)) found = await viaList()
    else if (tools.size > 0) found = await viaIssue()
    else {
      // A server found by name has unseen tools: both reads are tried side by side, within the same 3 seconds.
      const [listed, read] = await Promise.allSettled([viaList(), viaIssue()])
      if (listed.status === 'rejected' && read.status === 'rejected') return 'unreadable'
      const valueOf = (result: PromiseSettledResult<JiraComment | undefined>) => (result.status === 'fulfilled' ? result.value : undefined)
      found = valueOf(listed) ?? valueOf(read)
    }
    return found ?? 'none'
  } catch {
    return 'unreadable'
  }
}

// ---------------------------------------------------------------------------
// Setup: which server, which site, which project, and the board's statuses

/** Asks one question (or takes the person's earlier answer); undefined when nobody could answer. */
export type JiraAsk = (question: Question) => Promise<Record<string, Answer> | undefined>

/** What the Jira part of the setup found: the answers to record, notes for the agent, and the board's statuses. */
export type JiraSetup = { answers: Record<string, Answer>; notes: string[]; boardStatuses: string[] }

const LATER: Choice[] = [
  { label: 'Decide later', value: '' },
  { label: 'Skip for now', value: '' },
]

/** Up to four found choices; with fewer than two, padded with "decide later". */
const withLater = (found: readonly Choice[]): Choice[] => (found.length >= 2 ? found.slice(0, 4) : [...found, ...LATER].slice(0, Math.max(2, found.length + 1)))

/** The person's server, when several Atlassian servers are connected; a personal answer, as names differ per person. */
export const serverQuestion = (servers: readonly JiraServer[]): Question => ({
  key: 'jiraServer',
  header: 'Jira server',
  question: 'Several Atlassian servers are connected to this session. Which one should godmode use for Jira?',
  choices: servers.slice(0, 4).map(server => ({ label: server.name, value: server.name })),
  half: 'personal',
  freeText: text => ({ jiraServer: text.trim() }),
})

/** A teammate's own question on a team's Jira: their server, when several are connected. */
export async function personalJiraQuestions($: EngineInterface): Promise<Question[]> {
  const servers = await jiraServers($)
  return servers.length > 1 ? [serverQuestion(servers)] : []
}

const siteQuestion = (sites: readonly Site[]): Question => ({
  key: 'jiraCloudId',
  header: 'Jira site',
  question: `Which Atlassian site holds the board?${sites.length === 0 ? ' godmode could not list them: type its address (acme.atlassian.net) under Other.' : ' Pick one, or type its address under Other.'}`,
  choices: withLater(sites.map(site => ({ label: site.url === undefined ? site.name : `${site.name} (${site.url.replace(/^https?:\/\//, '')})`, value: site.id }))),
  half: 'shared',
  freeText: text => ({ jiraCloudId: text.trim() }),
})

const projectQuestion = (projects: readonly JiraProject[]): Question => ({
  key: 'jiraProject',
  header: 'Jira project',
  question: `Which Jira project should godmode file tickets in?${projects.length > 4 ? ` Its projects include ${projects.slice(4, 12).map(project => project.key).join(', ')}.` : ''} Pick one, or type its key under Other.`,
  choices: withLater(projects.map(project => ({ label: `${project.key} (${project.name.replace(/,/g, ' ')})`, value: project.key }))),
  half: 'shared',
  freeText: text => ({ jiraProject: text.trim().toUpperCase() }),
})

/** What each godmode status means, for the mapping questions. */
const STATUS_MEANING: Readonly<Record<Exclude<TicketStatus, 'qa'>, string>> = {
  todo: 'filed, not started',
  doing: 'a dev agent is building it',
  review: 'its PR is in review',
  done: 'finished',
}

const MAPPED: readonly Exclude<TicketStatus, 'qa'>[] = ['todo', 'doing', 'review', 'done']

/** The board status each godmode status most likely is, by its name, then by Jira's category. */
export const guessMapping = (board: readonly BoardStatus[]): Partial<Record<Exclude<TicketStatus, 'qa'>, string>> => {
  const named = (pattern: RegExp) => board.find(status => pattern.test(status.name))
  const inCategory = (category: string, unless?: RegExp) => board.find(status => status.category === category && (unless === undefined || !unless.test(status.name)))
  const guesses = {
    todo: named(/^(to ?do|open|backlog|selected)/i) ?? inCategory('new'),
    doing: named(/progress|doing|develop/i) ?? inCategory('indeterminate', /review|qa|test/i),
    review: named(/review/i),
    done: named(/^(done|closed|resolved|complete)/i) ?? inCategory('done'),
  }
  return Object.fromEntries(Object.entries(guesses).flatMap(([status, found]) => (found === undefined ? [] : [[status, found.name]])))
}

/** One godmode status's board name: the guess first, then the board's other statuses. */
const statusQuestion = (status: Exclude<TicketStatus, 'qa'>, board: readonly string[], guess: string | undefined): Question => {
  const names = board.length === 0 ? [DEFAULT_NAMES[status] ?? status] : [...(guess === undefined ? [] : [guess]), ...board.filter(name => name !== guess)]
  const listed = board.length === 0 ? '' : ` The board's statuses: ${board.join(', ')}.`
  return {
    key: JIRA_STATUS_KEYS[status],
    header: `Jira ${status}`,
    question: `Which status on the board is godmode's "${status}" (${STATUS_MEANING[status]})?${listed} Pick one, or type its exact name under Other.`,
    choices: withLater(names.map(name => ({ label: name.replace(/,/g, ' '), value: name }))),
    half: 'shared',
    freeText: text => ({ [JIRA_STATUS_KEYS[status]]: text.trim() }),
  }
}

/** The statuses the project's issues are in now, from its latest 100. */
async function boardStatuses($: EngineInterface, server: string, cloudId: string, project: string): Promise<BoardStatus[]> {
  const answer = await callJira($, server, JIRA_TOOLS.search, { cloudId, jql: `project = ${jqlText(project)} ORDER BY updated DESC`, fields: ['status'], maxResults: 100 }).catch(() => undefined)
  const found = new Map<string, BoardStatus>()
  for (const row of rowsIn(answer, ['issues', 'values'])) {
    const status = statusIn(isRecord(row) && isRecord(row.fields) ? row.fields.status : undefined)
    if (status !== undefined && !found.has(status.name.toLowerCase())) found.set(status.name.toLowerCase(), status)
  }
  return [...found.values()]
}

/**
 * The Jira part of a setup, after the tracker answer: the server (asked only when several
 * are connected), the site, the project, and the board's names for godmode's statuses,
 * offered from the statuses its issues are in. It stops at the first question nobody could
 * answer; the setup lists that one for the PM.
 */
export async function jiraSetup($: EngineInterface, given: Readonly<Record<string, Answer>>, ask: JiraAsk): Promise<JiraSetup> {
  const result: JiraSetup = { answers: {}, notes: [], boardStatuses: [] }
  const servers = await jiraServers($)
  if (servers.length === 0) {
    result.notes.push(
      'No Atlassian (Jira) server is connected to this session, so godmode could not read the board. Connect the Atlassian connector (`/mcp`), then run `/godmode setup` again: until then the ticket tools say what is missing.',
    )
    return result
  }
  const picked = servers.length === 1 ? { jiraServer: servers[0]?.name ?? '' } : await ask(serverQuestion(servers))
  if (picked === undefined) return result
  const server = pickServer(servers, picked.jiraServer)
  if (typeof server === 'string') {
    result.notes.push(server)
    return result
  }
  result.answers.jiraServer = server.name

  const sites = textOf(given.jiraCloudId) === undefined ? sitesIn(await callJira($, server.name, JIRA_TOOLS.sites, {}).catch(() => [])) : []
  const [onlySite] = sites
  const site = textOf(given.jiraCloudId) !== undefined || sites.length !== 1 || onlySite === undefined ? await ask(siteQuestion(sites)) : { jiraCloudId: onlySite.id }
  const cloudId = textOf(site?.jiraCloudId)
  if (cloudId === undefined) {
    if (site !== undefined) result.notes.push('The Jira site is left for later: the ticket tools say so until `/godmode setup` records it.')
    return result
  }
  result.answers.jiraCloudId = cloudId

  // A server found by name alone has unseen tools: its project list is simply tried.
  const projects = textOf(given.jiraProject) === undefined && (server.tools.size === 0 || server.tools.has(JIRA_TOOLS.projects))
    ? projectsIn(await callJira($, server.name, JIRA_TOOLS.projects, { cloudId }).catch(() => []))
    : []
  const projectAnswer = await ask(projectQuestion(projects))
  const project = textOf(projectAnswer?.jiraProject)?.toUpperCase()
  if (project === undefined) {
    if (projectAnswer !== undefined) result.notes.push('The Jira project is left for later: the ticket tools say so until `/godmode setup` records it.')
    return result
  }
  result.answers.jiraProject = project

  const board = await boardStatuses($, server.name, cloudId, project)
  result.boardStatuses = board.map(status => status.name)
  const guess = guessMapping(board)
  const open = MAPPED.filter(status => textOf(given[JIRA_STATUS_KEYS[status]]) === undefined)
  for (const status of MAPPED) {
    const named = textOf(given[JIRA_STATUS_KEYS[status]])
    if (named !== undefined) result.answers[JIRA_STATUS_KEYS[status]] = named
  }
  // A full guess from the board is offered whole: one question instead of four.
  const isGuessed = board.length > 0 && open.every(status => guess[status] !== undefined)
  if (open.length > 0 && isGuessed) {
    const mapping = open.map(status => `${status} is "${guess[status] ?? ''}"`).join('; ')
    const kept = await ask({
      key: 'jiraStatusMap',
      header: 'Jira mapping',
      question: `godmode reads the board's statuses as: ${mapping}. Keep this mapping?`,
      choices: [
        { label: 'Keep it', value: 'keep' },
        { label: 'Pick each', value: 'pick' },
      ],
      half: 'shared',
    })
    if (kept === undefined) return result
    if (kept.jiraStatusMap === 'keep') {
      for (const status of open) result.answers[JIRA_STATUS_KEYS[status]] = guess[status] ?? ''
      return result
    }
  }
  for (const status of open) {
    const answer = await ask(statusQuestion(status, result.boardStatuses, guess[status]))
    if (answer === undefined) return result
    const name = textOf(answer[JIRA_STATUS_KEYS[status]])
    if (name !== undefined) result.answers[JIRA_STATUS_KEYS[status]] = name
  }
  return result
}
