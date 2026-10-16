import type { EngineInterface, ToolSpec } from 'claude-code'

import { readNote } from './storage'
import type { Answer } from './storage'

/** Where a ticket stands (D24). `done` tickets move to `tickets/done/`. */
export type TicketStatus = 'todo' | 'doing' | 'review' | 'done'

export const TICKET_STATUSES: readonly TicketStatus[] = ['todo', 'doing', 'review', 'done']

/** The tracker the setup chose (D23): `none` keeps markdown files, `jira` and `other` reach a real tracker. */
export type TrackerKind = 'none' | 'jira' | 'other'

export const TRACKERS: readonly TrackerKind[] = ['none', 'jira', 'other']

/** A ticket's short header: everything `list` reads, none of the body. */
export type TicketHeader = {
  /** `T-1`, `T-2`, ... for markdown tickets (D50); a tracker's own key elsewhere. */
  id: string
  title: string
  status: TicketStatus
  /** Ids of the tickets that must be done first. */
  blockedBy: string[]
  branch?: string
  /** The PR's number or link, or the branch under review on a host with no PRs (D54). */
  pr?: string
  /** Whether a user would see the change; QA runs only when it is true (D34, D36). */
  visibleChange: boolean
  /** Set only when the person said go for this ticket, so dispatch may start it (D52). */
  ready: boolean
  /** The day the ticket was filed, `YYYY-MM-DD`. */
  created: string
}

/** What a new ticket holds: the header's own fields and the ticket shape from the reference loop. */
export type TicketDraft = {
  title: string
  /** The person's ask, word for word. */
  ask: string
  /** Claims checked against the code or a run, each with its evidence. */
  measured?: string
  /** Hypotheses not checked yet. */
  inferred?: string
  /** A question to settle before building. */
  answerFirst?: string
  scopeIn?: string
  scopeOut?: string
  constraints?: string
  /** The tests to add, each shown failing without the change. */
  tests?: string
  refs?: string
  blockedBy?: string[]
  visibleChange: boolean
}

/** A change to a ticket's header; fields left out stay as they are. */
export type TicketChange = Partial<Pick<TicketHeader, 'status' | 'ready' | 'branch' | 'pr' | 'blockedBy' | 'visibleChange'>>

/** Which tickets `list` returns: absent `statuses`, every one not done. */
export type TicketFilter = { statuses?: readonly TicketStatus[] }

export type TicketComment = { author: string; text: string }

/**
 * What every tracker does for the four ticket tools (D24): the PM always says "move T-3
 * to review", and the backend the setup chose carries it out.
 */
export interface TicketBackend {
  readonly tracker: TrackerKind
  create(draft: TicketDraft): Promise<TicketHeader>
  move(id: string, change: TicketChange): Promise<TicketHeader>
  list(filter: TicketFilter): Promise<TicketHeader[]>
  comment(id: string, comment: TicketComment): Promise<TicketHeader>
}

/** A ticket call the model can correct: an unknown id, a bad field, a tracker not built yet. */
export class TicketError extends Error {}

export const TICKETS_FOLDER = 'tickets'
export const DONE_FOLDER = 'done'
/** Holds the next id, so an id stays used after its ticket is gone (D50). */
export const NEXT_ID_FILE = 'next-id'

/** `T-3`, `t-3`, `T3` or `3` as `T-3`; undefined when it is no markdown ticket id. */
export const normaliseId = (raw: string) => {
  const number = /^\s*(?:t-?)?0*(\d+)\s*$/i.exec(raw)?.[1]
  return number === undefined || number === '0' ? undefined : `T-${number}`
}

/** The file name's middle part: the title in lowercase ASCII words, at most 40 characters. */
export const slugOf = (title: string) =>
  title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 40)
    .replace(/-+$/, '') || 'ticket'

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim()

/** The header as the file's front matter: one `key: value` per line between `---` lines. */
export const renderHeader = (header: TicketHeader) =>
  [
    '---',
    `id: ${header.id}`,
    `title: ${oneLine(header.title)}`,
    `status: ${header.status}`,
    `ready: ${header.ready ? 'yes' : 'no'}`,
    `visibleChange: ${header.visibleChange ? 'yes' : 'no'}`,
    `blockedBy: ${header.blockedBy.join(', ')}`,
    `branch: ${oneLine(header.branch ?? '')}`,
    `pr: ${oneLine(header.pr ?? '')}`,
    `created: ${header.created}`,
    '---',
    '',
  ]
    .map(line => line.trimEnd())
    .join('\n')

const isStatus = (value: string): value is TicketStatus => TICKET_STATUSES.includes(value as TicketStatus)

/**
 * Splits a ticket file into its header and the rest; a string says what is wrong with it.
 * Only the front matter is parsed, so listing never depends on the body.
 */
export const parseTicket = (text: string): { header: TicketHeader; body: string } | string => {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (match === null) return 'it has no header between `---` lines'
  const fields = new Map<string, string>()
  for (const line of (match[1] ?? '').split(/\r?\n/)) {
    const pair = /^([A-Za-z]+):\s?(.*)$/.exec(line)
    if (pair !== null) fields.set(pair[1] ?? '', (pair[2] ?? '').trim())
  }
  const id = fields.get('id') ?? ''
  const status = fields.get('status') ?? ''
  if (id === '') return 'its header has no id'
  if (!isStatus(status)) return `its status \`${status}\` is not one of ${TICKET_STATUSES.join(', ')}`
  const optional = (key: string) => (fields.get(key) ?? '') || undefined
  return {
    header: {
      id,
      title: fields.get('title') ?? '',
      status,
      blockedBy: (fields.get('blockedBy') ?? '').split(',').map(part => part.trim()).filter(part => part !== ''),
      branch: optional('branch'),
      pr: optional('pr'),
      visibleChange: fields.get('visibleChange') === 'yes',
      ready: fields.get('ready') === 'yes',
      created: fields.get('created') ?? '',
    },
    body: text.slice(match[0].length),
  }
}

/** The body: the ticket shape (The ask, Measured, Inferred, Scope, ...), empty sections left out, then `## Comments`. */
export const renderBody = (id: string, draft: TicketDraft) => {
  const section = (heading: string, text?: string) =>
    text === undefined || text.trim() === '' ? [] : [`## ${heading}`, '', text.trim(), '']
  const scope = [
    ...(draft.scopeIn?.trim() ? [`**In:** ${draft.scopeIn.trim()}`, ''] : []),
    ...(draft.scopeOut?.trim() ? [`**Out:** ${draft.scopeOut.trim()}`, ''] : []),
  ]
  return [
    `# ${id} ${oneLine(draft.title)}`,
    '',
    ...section('The ask', draft.ask),
    ...section('Measured', draft.measured),
    ...section('Inferred', draft.inferred),
    ...section('Answer this first', draft.answerFirst),
    ...(scope.length === 0 ? [] : ['## Scope', '', ...scope]),
    ...section('Constraints', draft.constraints),
    ...section('Tests', draft.tests),
    ...section('Refs', draft.refs),
    '## Comments',
    '',
  ].join('\n')
}

/** `text` with a comment added at its end, under `## Comments` (added first when missing). */
export const withComment = (body: string, comment: TicketComment, at: number) => {
  const stamp = new Date(at).toISOString().slice(0, 16).replace('T', ' ')
  const head = body.endsWith('\n') ? body : `${body}\n`
  const heading = /^## Comments\s*$/m.test(head) ? '' : '\n## Comments\n'
  return `${head}${heading}\n### ${stamp} UTC, ${oneLine(comment.author)}\n\n${comment.text.trim()}\n`
}

/** One line per ticket, the way the model reads a list. */
export const describeTicket = (header: TicketHeader) =>
  [
    header.id,
    header.status,
    ...(header.ready && header.status !== 'done' ? ['ready'] : []),
    header.title,
    ...(header.blockedBy.length === 0 ? [] : [`blocked by ${header.blockedBy.join(', ')}`]),
    ...(header.branch === undefined ? [] : [`branch ${header.branch}`]),
    ...(header.pr === undefined ? [] : [`PR ${header.pr}`]),
    `visible change: ${header.visibleChange ? 'yes' : 'no'}`,
  ].join(' | ')

/*
 * Writes run one at a time: the model can call several ticket tools at once, and two
 * agents filing tickets together must not take the same id.
 */
let tail: Promise<unknown> = Promise.resolve()
const serially = <T>(work: () => Promise<T>) => {
  const run = tail.then(work, work)
  tail = run.catch(() => undefined)
  return run
}

type TicketFile = { number: number; path: string; isDone: boolean }

const TICKET_FILE = /^T-(\d+)(?:-.*)?\.md$/

/**
 * The markdown backend, tracker "None" (D24): one file per ticket in `<dir>/tickets/`,
 * named `T-<n>-<slug>.md`, done tickets in `tickets/done/`. `dir` is the note's folder,
 * so tickets sit in the storage the setup chose (D19). `$.fs` has no rename, so a ticket
 * moves between folders with `mv`.
 */
export function markdownBackend($: EngineInterface, dir: string): TicketBackend {
  const folder = `${dir.replace(/[\\/]+$/, '')}/${TICKETS_FOLDER}`
  const doneFolder = `${folder}/${DONE_FOLDER}`

  const filesIn = async (path: string, isDone: boolean): Promise<TicketFile[]> => {
    if (!(await $.fs.exists(path))) return []
    const entries = await $.fs.list(path)
    return entries.flatMap(entry => {
      const number = entry.kind === 'file' ? TICKET_FILE.exec(entry.name)?.[1] : undefined
      return number === undefined ? [] : [{ number: Number(number), path: `${path}/${entry.name}`, isDone }]
    })
  }
  const allFiles = async () => [...(await filesIn(folder, false)), ...(await filesIn(doneFolder, true))]

  const find = async (raw: string) => {
    const id = normaliseId(raw)
    if (id === undefined) throw new TicketError(`\`${raw}\` is not a ticket id; ids look like T-3.`)
    const number = Number(id.slice(2))
    const file = (await allFiles()).find(candidate => candidate.number === number)
    if (file === undefined) throw new TicketError(`There is no ticket ${id}.`)
    const parsed = parseTicket(await $.fs.read(file.path))
    if (typeof parsed === 'string') throw new TicketError(`${id} cannot be read (${file.path}): ${parsed}.`)
    return { ...file, id, ...parsed }
  }

  /** Blockers as ids, each an existing ticket, so a typo is caught when it is written. */
  const checkBlockers = async (raw: readonly string[], self?: string) => {
    const known = new Set((await allFiles()).map(file => `T-${file.number}`))
    return raw.map(entry => {
      const id = normaliseId(entry)
      if (id === undefined) throw new TicketError(`\`${entry}\` in blockedBy is not a ticket id; ids look like T-3.`)
      if (id === self) throw new TicketError(`${id} cannot block itself.`)
      if (!known.has(id)) throw new TicketError(`blockedBy names ${id}, and there is no such ticket.`)
      return id
    })
  }

  const mv = async (from: string, to: string) => {
    const target = to.slice(0, to.lastIndexOf('/'))
    const made = await $.process.run(['mkdir', '-p', target])
    const moved = made.exitCode === 0 ? await $.process.run(['mv', from, to]) : made
    if (moved.exitCode !== 0) throw new TicketError(`Could not move ${from} to ${to}: ${moved.stderr.trim()}`)
  }

  return {
    tracker: 'none',

    create: draft =>
      serially(async () => {
        const files = await allFiles()
        const counterPath = `${folder}/${NEXT_ID_FILE}`
        const counter = (await $.fs.exists(counterPath)) ? Number.parseInt(await $.fs.read(counterPath), 10) || 1 : 1
        const number = Math.max(counter, ...files.map(file => file.number + 1))
        const header: TicketHeader = {
          id: `T-${number}`,
          title: oneLine(draft.title),
          status: 'todo',
          blockedBy: await checkBlockers(draft.blockedBy ?? []),
          visibleChange: draft.visibleChange,
          ready: false,
          created: new Date(await $.clock.now()).toISOString().slice(0, 10),
        }
        await $.fs.write(`${folder}/T-${number}-${slugOf(draft.title)}.md`, `${renderHeader(header)}\n${renderBody(header.id, draft)}`)
        await $.fs.write(counterPath, `${number + 1}\n`)
        return header
      }),

    move: (id, change) =>
      serially(async () => {
        const ticket = await find(id)
        const blockedBy = change.blockedBy === undefined ? ticket.header.blockedBy : await checkBlockers(change.blockedBy, ticket.id)
        const header: TicketHeader = { ...ticket.header, ...change, blockedBy }
        await $.fs.write(ticket.path, `${renderHeader(header)}\n${ticket.body.replace(/^\n+/, '')}`)
        const name = ticket.path.slice(ticket.path.lastIndexOf('/') + 1)
        if (header.status === 'done' && !ticket.isDone) await mv(ticket.path, `${doneFolder}/${name}`)
        if (header.status !== 'done' && ticket.isDone) await mv(ticket.path, `${folder}/${name}`)
        return header
      }),

    list: async filter => {
      const statuses = filter.statuses ?? TICKET_STATUSES.filter(status => status !== 'done')
      const files = statuses.includes('done') ? await allFiles() : await filesIn(folder, false)
      const headers: TicketHeader[] = []
      for (const file of files.sort((a, b) => a.number - b.number)) {
        const parsed = parseTicket(await $.fs.read(file.path))
        if (typeof parsed === 'string') throw new TicketError(`${file.path} cannot be read: ${parsed}.`)
        if (statuses.includes(parsed.header.status)) headers.push(parsed.header)
      }
      return headers
    },

    comment: (id, comment) =>
      serially(async () => {
        const ticket = await find(id)
        const text = await $.fs.read(ticket.path)
        await $.fs.write(ticket.path, withComment(text, comment, await $.clock.now()))
        return ticket.header
      }),
  }
}

/**
 * Jira (D23): reached through the Atlassian connector once it is built. Until then it says
 * what is missing and never falls back to markdown (D25).
 */
export function jiraBackend(): TicketBackend {
  throw new TicketError(
    'The Jira tracker is not built yet: godmode still needs its mapping of create, move, list and comment onto the Atlassian connector. No ticket was written, and nothing fell back to markdown tickets.',
  )
}

/** "Other" (D25): the mapping found at setup (a connector or a CLI), not built yet; never a silent fallback. */
export function otherBackend(): TicketBackend {
  throw new TicketError(
    'The "Other" tracker is not built yet: godmode still needs the mapping the setup finds (a connector or a command-line tool) and saves in the note. No ticket was written, and nothing fell back to markdown tickets.',
  )
}

/** The tracker a note's answers name; no answer is "None", the default. */
export const trackerOf = (answers: Readonly<Record<string, Answer>>): TrackerKind => {
  const value = answers.tracker
  if (value === undefined) return 'none'
  const name = String(value).toLowerCase()
  if (TRACKERS.includes(name as TrackerKind)) return name as TrackerKind
  throw new TicketError(`The setup note names the tracker \`${String(value)}\`, which godmode does not know (${TRACKERS.join(', ')}). Fix it with \`/godmode setup\`.`)
}

/** The backend for a tracker, its markdown files kept in the note's folder `dir`. */
export function backendFor($: EngineInterface, tracker: TrackerKind, dir: string): TicketBackend {
  if (tracker === 'jira') return jiraBackend()
  if (tracker === 'other') return otherBackend()
  return markdownBackend($, dir)
}

/** The project's ticket backend, from its setup note. */
export async function ticketBackendOf($: EngineInterface): Promise<TicketBackend> {
  const found = await readNote($)
  if (found.status === 'none') {
    throw new TicketError('godmode is not set up in this project yet, so it has nowhere to keep tickets. Finish the setup first.')
  }
  if (found.status === 'unreadable') throw new TicketError(`godmode cannot read its setup note at ${found.path}: ${found.reason}.`)
  return backendFor($, trackerOf(found.shared.answers), found.dir)
}

export type TicketToolName = 'ticket_create' | 'ticket_move' | 'ticket_list' | 'ticket_comment'

const text = (description: string) => ({ type: 'string', description })
const statusSchema = { type: 'string', enum: [...TICKET_STATUSES] }
const idSchema = text('The ticket id, e.g. T-3.')
const blockedBySchema = { type: 'array', items: { type: 'string' }, description: 'Ids of the tickets that must be done first, e.g. ["T-2"].' }
const visibleChangeSchema = { type: 'boolean', description: 'Whether a user would see the change. QA runs only when it is true.' }

/** The four ticket tools (D24), listed in the prompt rather than behind ToolSearch. */
export const TICKET_TOOLS: readonly (ToolSpec & { name: TicketToolName })[] = [
  {
    name: 'ticket_create',
    description:
      'File a new ticket in the project\'s tracker. Filing never starts work. Tickets are read and changed only through the ticket tools, never by editing files.',
    inputSchema: {
      type: 'object',
      properties: {
        title: text('A short title.'),
        ask: text('The person\'s ask, word for word.'),
        measured: text('Claims checked against the code or a run, each with its evidence.'),
        inferred: text('Hypotheses not checked yet.'),
        answerFirst: text('A question to settle before building, if any.'),
        scopeIn: text('What the ticket covers.'),
        scopeOut: text('What it leaves out.'),
        constraints: text('Rules the change must keep.'),
        tests: text('The tests to add, each to be shown failing without the change.'),
        refs: text('Links, files and decisions the work relies on.'),
        blockedBy: blockedBySchema,
        visibleChange: visibleChangeSchema,
      },
      required: ['title', 'ask', 'visibleChange'],
    },
    isDeferred: false,
  },
  {
    name: 'ticket_move',
    description:
      'Change a ticket\'s status (todo, doing, review, done) or header: branch, PR, blockers, visible change. `ready` marks a ticket the person said go for; only the main thread may set it.',
    inputSchema: {
      type: 'object',
      properties: {
        id: idSchema,
        status: statusSchema,
        ready: { type: 'boolean', description: 'True only once the person said go for this ticket.' },
        branch: text('The ticket\'s branch.'),
        pr: text('The PR number or link.'),
        blockedBy: blockedBySchema,
        visibleChange: visibleChangeSchema,
      },
      required: ['id'],
    },
    isDeferred: false,
  },
  {
    name: 'ticket_list',
    description: 'List tickets, headers only (id, status, ready, title, blockers, branch, PR). By default every ticket not done.',
    inputSchema: {
      type: 'object',
      properties: { status: { type: 'array', items: statusSchema, description: 'Only tickets in these statuses.' } },
    },
    isDeferred: false,
  },
  {
    name: 'ticket_comment',
    description: 'Add a comment to a ticket: a finding, a verdict, a decision. Comments are kept in order under the ticket.',
    inputSchema: {
      type: 'object',
      properties: { id: idSchema, text: text('The comment, in markdown.'), author: text('Who is writing, e.g. PM, dev, reviewer.') },
      required: ['id', 'text'],
    },
    isDeferred: false,
  },
]

export const TICKET_TOOL_NAMES: readonly TicketToolName[] = TICKET_TOOLS.map(tool => tool.name)

/** Who made a tool call: `agentId` is absent on the main thread, where the PM runs. */
export type TicketCaller = { agentId?: string }

const stringField = (input: Record<string, unknown>, key: string, isRequired = false) => {
  const value = input[key]
  if (value === undefined || value === null) {
    if (isRequired) throw new TicketError(`\`${key}\` is required.`)
    return undefined
  }
  if (typeof value !== 'string') throw new TicketError(`\`${key}\` must be text.`)
  if (isRequired && value.trim() === '') throw new TicketError(`\`${key}\` must not be empty.`)
  return value
}

const booleanField = (input: Record<string, unknown>, key: string, isRequired = false) => {
  const value = input[key]
  if (value === undefined || value === null) {
    if (isRequired) throw new TicketError(`\`${key}\` is required: true or false.`)
    return undefined
  }
  if (value === 'yes' || value === 'no') return value === 'yes'
  if (typeof value !== 'boolean') throw new TicketError(`\`${key}\` must be true or false.`)
  return value
}

const listField = (input: Record<string, unknown>, key: string) => {
  const value = input[key]
  if (value === undefined || value === null) return undefined
  const items = typeof value === 'string' ? value.split(',') : value
  if (!Array.isArray(items) || !items.every(item => typeof item === 'string')) throw new TicketError(`\`${key}\` must be a list of ticket ids.`)
  return items.map(item => item.trim()).filter(item => item !== '')
}

const statusField = (value: unknown) => {
  if (typeof value === 'string' && isStatus(value)) return value
  throw new TicketError(`\`${String(value)}\` is not a status; use one of ${TICKET_STATUSES.join(', ')}.`)
}

/**
 * Serves one ticket tool call on any backend: checks the model's input, routes it, and
 * answers the text the model reads. A `TicketError` is the caller's to show as an error.
 */
export const runTicketTool = async (
  backend: TicketBackend,
  name: TicketToolName,
  input: Record<string, unknown>,
  caller: TicketCaller,
): Promise<string> => {
  if (name === 'ticket_create') {
    const header = await backend.create({
      title: stringField(input, 'title', true) ?? '',
      ask: stringField(input, 'ask', true) ?? '',
      measured: stringField(input, 'measured'),
      inferred: stringField(input, 'inferred'),
      answerFirst: stringField(input, 'answerFirst'),
      scopeIn: stringField(input, 'scopeIn'),
      scopeOut: stringField(input, 'scopeOut'),
      constraints: stringField(input, 'constraints'),
      tests: stringField(input, 'tests'),
      refs: stringField(input, 'refs'),
      blockedBy: listField(input, 'blockedBy'),
      visibleChange: booleanField(input, 'visibleChange', true) ?? false,
    })
    return `Filed ${describeTicket(header)}`
  }
  if (name === 'ticket_move') {
    const id = stringField(input, 'id', true) ?? ''
    const change: TicketChange = {}
    if (input.status !== undefined) change.status = statusField(input.status)
    const ready = booleanField(input, 'ready')
    if (ready !== undefined) {
      // Readiness is the person's go (D52), heard only by the main thread.
      if (caller.agentId !== undefined) throw new TicketError('Only the main thread marks a ticket ready, once the person said go for it.')
      change.ready = ready
    }
    for (const key of ['branch', 'pr'] as const) {
      const value = stringField(input, key)
      if (value !== undefined) change[key] = value.trim() === '' ? undefined : value.trim()
    }
    const blockedBy = listField(input, 'blockedBy')
    if (blockedBy !== undefined) change.blockedBy = blockedBy
    const visibleChange = booleanField(input, 'visibleChange')
    if (visibleChange !== undefined) change.visibleChange = visibleChange
    if (Object.keys(change).length === 0) throw new TicketError('Nothing to change: give a status or a header field.')
    return `Updated ${describeTicket(await backend.move(id, change))}`
  }
  if (name === 'ticket_list') {
    const raw = input.status
    const statuses = raw === undefined || raw === null ? undefined : (Array.isArray(raw) ? raw : [raw]).map(statusField)
    const headers = await backend.list({ statuses })
    if (headers.length === 0) return statuses === undefined ? 'No open tickets.' : `No tickets in ${statuses.join(', ')}.`
    return headers.map(describeTicket).join('\n')
  }
  const id = stringField(input, 'id', true) ?? ''
  const body = stringField(input, 'text', true) ?? ''
  const author = stringField(input, 'author')?.trim() || (caller.agentId === undefined ? 'PM' : `agent ${caller.agentId}`)
  const header = await backend.comment(id, { author, text: body })
  return `Commented on ${header.id}.`
}
