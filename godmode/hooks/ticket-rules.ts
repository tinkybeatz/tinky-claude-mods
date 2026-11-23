import { atom, read, update } from 'claude-code'
import type { EngineInterface, ToolSpec } from 'claude-code'

import type { GodmodeMode, SetupRun } from '../types'
import { jiraBoardData, plainError } from './jira'
import type { BoardData, FieldMeta } from './jira'
import { trackerKindOf } from './tickets'
import { claudeDirOf, conventionsDirOf, fingerprintOf, notePath, projectOf, readNote, STORAGE_MODES, writeSharedNote } from './storage'
import type { Answer, Project, StorageMode } from './storage'
import { logLines, questionText } from './ui-text'

/*
 * The ticket-filing rules (D74, D76): the decisions godmode makes every time it files a Jira
 * ticket, as a fixed checklist, answered from the person's own latest tickets first and the
 * team's only where theirs do not settle an item, and kept as a plain conventions file,
 * `ticket-filing.md`, under the same headings. An item no ticket settles is "?" and asked,
 * never guessed. The `ticket_rules` tool asks the person and saves only on their yes. Every
 * helper that takes `$` is a function declaration.
 */

// The same state as `register.tsx`'s atoms: `validate` reads a state source only from this file.
const isOn = atom({ plugin: 'godmode', key: 'isOn' } as const, false)
const mode = atom({ plugin: 'godmode', key: 'mode' } as const, 'coding' as GodmodeMode)
const setupRun = atom({ plugin: 'godmode', key: 'setupRun' } as const, { consented: [], written: [] } as SetupRun)

/** The rules file's name in the conventions folder. */
export const TICKET_RULES_FILE = 'ticket-filing.md'

/** The setup answer that records where the rules file is, so `update` knows a note without one. */
export const TICKET_RULES_KEY = 'ticketRules'

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

const flat = (text: string) => text.replace(/\s+/g, ' ').trim()

// ---------------------------------------------------------------------------
// Reading a ticket

type Sprint = { name: string; state?: string }

/** One ticket as the checklist reads it: its type, title, parent, fields by name, and sprints. */
export type TicketRow = { type: string; isSubtask: boolean; title: string; parentType?: string; hasParent: boolean; fields: Record<string, unknown>; sprints: Sprint[] }

/** The text of an Atlassian document (`{ type: 'doc', content }`), its text nodes joined. */
const documentText = (value: unknown): string =>
  isRecord(value) ? `${typeof value.text === 'string' ? value.text : ''}${Array.isArray(value.content) ? value.content.map(documentText).join(' ') : ''}` : ''

/** A field's value as text people read: an option's value, a name, a list of them; undefined when empty. */
export const valueText = (value: unknown): string | undefined => {
  if (value === null || value === undefined) return undefined
  if (typeof value === 'string') return flat(value) === '' ? undefined : flat(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) {
    const parts = value.flatMap(item => valueText(item) ?? [])
    return parts.length === 0 ? undefined : parts.join(', ')
  }
  if (!isRecord(value)) return undefined
  if (value.type === 'doc') return valueText(documentText(value))
  for (const key of ['value', 'name', 'displayName', 'key']) if (typeof value[key] === 'string') return valueText(value[key])
  return undefined
}

/** Sprints in a field's value: `{ name, state }` objects, or bare names; none for anything else. */
const sprintsIn = (value: unknown): Sprint[] => {
  const items = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]
  return items.flatMap(item => {
    if (typeof item === 'string' && item.trim() !== '') return [{ name: item.trim() }]
    if (!isRecord(item) || typeof item.name !== 'string') return []
    return [{ name: item.name, ...(typeof item.state === 'string' ? { state: item.state.toLowerCase() } : {}) }]
  })
}

/** Whether a value holds sprints with states, as Jira's sprint field does. */
const isSprintValue = (value: unknown) => Array.isArray(value) && value.length > 0 && value.every(item => isRecord(item) && typeof item.name === 'string' && typeof item.state === 'string')

/**
 * Custom fields a server maps under `customFields`: by label, each `{ id, value }` (the
 * "Atlassian MCP" server: `"Sprint": { "id": "customfield_10001", "value": [...] }`), by label
 * with the bare value, or as `{ name, value }` rows.
 */
const customFieldsIn = (value: unknown): Record<string, unknown> => {
  const unwrapped = (entry: unknown) => (isRecord(entry) && typeof entry.id === 'string' && entry.id.startsWith('customfield_') && 'value' in entry ? entry.value : entry)
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([label, entry]) => [label, unwrapped(entry)]))
  if (!Array.isArray(value)) return {}
  return Object.fromEntries(
    value.flatMap(row => {
      if (!isRecord(row)) return []
      const name = [row.name, row.label, row.key, row.id].find(part => typeof part === 'string')
      return typeof name === 'string' ? [[name, 'value' in row ? row.value : row]] : []
    }),
  )
}

/**
 * A ticket from a search row, in either server's shape: `fields` with `customfield_*` keys
 * (named from the field metadata), or with custom fields under `customFields` by label. The
 * sprint is the field named Sprint, or any field holding sprints with states.
 */
export const ticketRowOf = (issue: unknown, names: ReadonlyMap<string, string>): TicketRow | undefined => {
  if (!isRecord(issue)) return undefined
  const raw = isRecord(issue.fields) ? issue.fields : issue
  const fields: Record<string, unknown> = {}
  for (const [key, value] of Object.entries({ ...raw, ...customFieldsIn(raw.customFields) })) {
    if (key !== 'customFields') fields[names.get(key) ?? key] = value
  }
  const type = isRecord(fields.issuetype) && typeof fields.issuetype.name === 'string' ? fields.issuetype.name : typeof fields.issuetype === 'string' ? fields.issuetype : undefined
  if (type === undefined) return undefined
  const sprintKey = Object.keys(fields).find(key => /^sprints?$/i.test(key)) ?? Object.keys(fields).find(key => isSprintValue(fields[key]))
  const sprints = sprintKey === undefined ? [] : sprintsIn(fields[sprintKey])
  if (sprintKey !== undefined) delete fields[sprintKey]
  const parent = isRecord(fields.parent) ? fields.parent : undefined
  const parentFields = parent !== undefined && isRecord(parent.fields) ? parent.fields : parent
  const parentType = parentFields !== undefined && isRecord(parentFields.issuetype) && typeof parentFields.issuetype.name === 'string' ? parentFields.issuetype.name : undefined
  return {
    type,
    isSubtask: isRecord(fields.issuetype) && fields.issuetype.subtask === true,
    title: typeof fields.summary === 'string' ? fields.summary : '',
    ...(parentType === undefined ? {} : { parentType }),
    hasParent: parent !== undefined,
    fields,
    sprints,
  }
}

// ---------------------------------------------------------------------------
// The checklist

/** The kinds of work godmode files, and the issue type names that usually mean each. */
const KINDS = [
  { key: 'bug', label: 'Bug', pattern: /bug|defect|incident/i },
  { key: 'feature', label: 'Feature or change', pattern: /story|feature|improvement|enhancement|change/i },
  { key: 'chore', label: 'Chore or maintenance', pattern: /task|chore|maintenance|tech.?debt/i },
  { key: 'piece', label: 'Piece of a bigger item', pattern: /sub-?task/i },
] as const

type Kind = (typeof KINDS)[number]['key']

/** The kind of work an issue type is; undefined for a type of none, which the checklist leaves out. */
const kindOf = (row: Pick<TicketRow, 'type' | 'isSubtask'>): Kind | undefined => {
  if (row.isSubtask || /sub-?task/i.test(row.type)) return 'piece'
  return KINDS.find(kind => kind.key !== 'piece' && kind.pattern.test(row.type))?.key
}

/** One checklist line: its heading, the item, the answer ("?" when nothing settles it), its source, and the question that asks it. */
export type ChecklistItem = { heading: string; item: string; answer: string; source?: string; question?: string }

/** Where an answer came from: the person's own tickets, or the team's when theirs do not settle it. */
type Evidence = { rows: TicketRow[]; source: 'yours' | 'team' }

const sourceOf = (evidence: Evidence, count: number) =>
  evidence.source === 'yours' ? `from ${count} of your tickets` : `from ${count} of the team's tickets; none of yours settle it`

/** The rows that settle an item: the person's own when any match, else the team's. */
const evidenceFor = (own: readonly TicketRow[], team: readonly TicketRow[], match: (row: TicketRow) => boolean): Evidence | undefined => {
  const mine = own.filter(match)
  if (mine.length > 0) return { rows: mine, source: 'yours' }
  const theirs = team.filter(match)
  return theirs.length > 0 ? { rows: theirs, source: 'team' } : undefined
}

type Count = { value: string; count: number }

const countsOf = (values: readonly string[]): Count[] => {
  const counts = new Map<string, number>()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  return [...counts].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
}

/** The most common value when it holds for at least `share` of `total`; undefined otherwise. */
const settled = (values: readonly string[], total: number, share = 0.6) => {
  const [top] = countsOf(values)
  return top !== undefined && top.count >= Math.max(1, Math.ceil(total * share)) ? top : undefined
}

const placementOf = (sprints: readonly Sprint[]) => {
  const states = sprints.flatMap(sprint => sprint.state ?? [])
  if (states.includes('active')) return 'the active sprint'
  if (states.includes('future')) return 'the next sprint'
  if (sprints.length > 0 && states.length === 0) return 'a sprint'
  return sprints.length > 0 ? 'a sprint now closed' : 'the backlog'
}

/** A sprint name's pattern, its numbers as `<n>`: "Web - Cooldown 12.2" is "Web - Cooldown <n>.<n>". */
const sprintPattern = (name: string) => name.replace(/\d+/g, '<n>')

/** A title's prefix, its numbers as `<n>`: "P3 - Export fails" is "P<n> - ", "[Editor] x" is "[Editor] ". */
const titlePrefix = (title: string) => {
  const found = /^(\[[^\]]{1,24}\]\s*|[A-Za-z0-9]{1,10}\s*[-–:|]\s+)/.exec(title)?.[1]
  return found === undefined ? undefined : found.replace(/\d+/g, '<n>')
}

/** Headings in a description: markdown headings, bold lines, and short lines ending in a colon. */
const headingsOf = (value: unknown): string[] => {
  if (isRecord(value) && value.type === 'doc') {
    const found: string[] = []
    const walk = (node: unknown) => {
      if (!isRecord(node)) return
      if (node.type === 'heading') found.push(flat(documentText(node)))
      if (Array.isArray(node.content)) node.content.forEach(walk)
    }
    walk(value)
    return found.filter(text => text !== '')
  }
  if (typeof value !== 'string') return []
  return value
    .split('\n')
    .map(line => line.trim())
    .flatMap(line => {
      const heading = /^#{1,6}\s+(.+)$/.exec(line)?.[1] ?? /^\*\*(.{2,40})\*\*:?$/.exec(line)?.[1] ?? /^([A-Z][^.:]{1,38}):$/.exec(line)?.[1]
      return heading === undefined ? [] : [flat(heading.replace(/:$/, ''))]
    })
}

/** Text that reads as a template's placeholder. */
const PLACEHOLDER = /\{\{[^}]*\}\}|<[A-Za-z][A-Za-z ]{2,30}>|\[(?:describe|add|insert|enter|fill|your)[^\]]*\]|\bTODO\b|\bfill (?:this|in)\b|\bdelete this\b/i

/** The fields every ticket has, which say nothing about how a team files; the priority is read on purpose. */
const SYSTEM_FIELDS = new Set([
  'summary', 'status', 'issuetype', 'project', 'created', 'updated', 'reporter', 'creator', 'assignee', 'parent', 'labels', 'components', 'description',
  'key', 'id', 'self', 'webUrl', 'statuscategorychangedate', 'lastViewed', 'watches', 'votes', 'workratio', 'resolution', 'resolutiondate', 'issuelinks',
  'subtasks', 'attachment', 'comment', 'worklog', 'timetracking', 'progress', 'aggregateprogress', 'fixVersions', 'versions', 'environment', 'duedate',
  'security', 'timespent', 'timeestimate', 'timeoriginalestimate', 'aggregatetimespent', 'aggregatetimeestimate', 'aggregatetimeoriginalestimate', 'statusCategory', 'Rank',
  // The parent under its older names: the Parent line already says it, and its value is one ticket's own.
  'Epic Link', 'Parent Link',
])

/** The fields godmode always sets itself, which no rule needs to name. */
const GODMODE_SET: readonly string[] = ['summary', 'description', 'issuetype', 'project', 'reporter']

/** A type's fields: required by Jira (with the usual value where tickets show one), set by habit, or left holding template text. */
const fieldsAnswer = (rows: readonly TicketRow[], meta: readonly FieldMeta[]) => {
  const named = rows.map(row => row.fields)
  const required = meta.filter(field => field.isRequired && !field.hasDefault && !GODMODE_SET.includes(field.id)).map(field => field.name)
  const usual = (name: string) => settled(named.flatMap(fields => valueText(fields[name]) ?? []), rows.length)?.value
  const parts = required.map(name => `${name} (required by Jira${usual(name) === undefined ? '' : `, usually ${usual(name)}`})`)
  const templates: string[] = []
  const candidates = [...new Set(named.flatMap(fields => Object.keys(fields)))].filter(name => !SYSTEM_FIELDS.has(name) && !required.includes(name))
  for (const name of candidates) {
    const texts = named.flatMap(fields => valueText(fields[name]) ?? [])
    const repeated = settled(texts, rows.length, 0.4)
    if (texts.some(text => PLACEHOLDER.test(text)) || (repeated !== undefined && repeated.value.length >= 40 && repeated.count >= 2)) {
      templates.push(name)
      continue
    }
    const habit = settled(texts, rows.length)
    if (habit !== undefined && habit.value.length <= 40) parts.push(`${name === 'priority' ? 'Priority' : name} = ${habit.value} (habit, ${habit.count} of ${rows.length})`)
  }
  if (templates.length > 0) parts.push(`fill or leave: ${templates.join(', ')} (template text)`)
  return parts.length === 0 ? 'none' : parts.join('; ')
}

/** The kinds of work with the issue type the evidence settles for each, and that type's own tickets. */
type Chosen = { type: string; evidence: Evidence }

/**
 * Where a type's new tickets go, with the naming pattern of the sprints they go in when one
 * shows ("Web - Cooldown <n>.<n>"): a team's active and next sprints are often named
 * apart, so the pattern is read per type and placement, never across the board.
 */
const placementItems = (chosen: readonly Chosen[]): ChecklistItem[] =>
  chosen.map(({ type, evidence }) => {
    const where = evidence.rows.map(row => placementOf(row.sprints))
    const top = settled(where, where.length)
    if (top === undefined) {
      return { heading: 'Placement', item: type, answer: `? (${countsOf(where).map(entry => `${entry.value} ${entry.count}`).join(', ')})`, question: `Where does a new ${type} go: the active sprint, the next sprint, or the backlog? Name the sprint if it follows a pattern.` }
    }
    const open = evidence.rows.filter(row => placementOf(row.sprints) === top.value).flatMap(row => row.sprints.filter(sprint => sprint.state !== 'closed'))
    const pattern = settled(open.map(sprint => sprintPattern(sprint.name)), open.length)
    const example = open.find(sprint => pattern !== undefined && sprintPattern(sprint.name) === pattern.value)?.name
    const named = pattern === undefined || example === undefined ? '' : `, named like "${pattern.value}" (e.g. "${example}")`
    return { heading: 'Placement', item: type, answer: `${top.value}${named}`, source: sourceOf(evidence, top.count) }
  })

/**
 * Whether a type's tickets have a parent, and of which type, read per type: a team's tasks may
 * always sit under an epic while its bugs never do. Which parent is the person's call each
 * time, unless the answer is none.
 */
const parentItems = (chosen: readonly Chosen[]): ChecklistItem[] =>
  chosen.map(({ type, evidence }): ChecklistItem => {
    const rows = evidence.rows
    const withParent = rows.filter(row => row.hasParent)
    const parentType = countsOf(withParent.flatMap(row => row.parentType ?? []))[0]?.value ?? 'parent'
    const article = /^[aeiou]/i.test(parentType) ? 'an' : 'a'
    const answer =
      withParent.length >= Math.ceil(rows.length * 0.9)
        ? `${article} ${parentType}; ask the person which one each time`
        : withParent.length === 0
          ? 'none'
          : `sometimes ${article} ${parentType} (${withParent.length} of ${rows.length}); ask the person each time`
    return { heading: 'Parent', item: type, answer, source: sourceOf(evidence, rows.length) }
  })

/** A type's title prefix and description template, when its tickets show one. */
const writingItems = (chosen: readonly Chosen[]): ChecklistItem[] => [
  ...chosen.map(({ type, evidence }): ChecklistItem => {
    const prefix = settled(evidence.rows.flatMap(row => titlePrefix(row.title) ?? []), evidence.rows.length)
    if (prefix !== undefined) return { heading: 'Title', item: type, answer: `starts "${prefix.value}"`, source: sourceOf(evidence, prefix.count) }
    return evidence.rows.length >= 3
      ? { heading: 'Title', item: type, answer: 'no fixed prefix', source: sourceOf(evidence, evidence.rows.length) }
      : { heading: 'Title', item: type, answer: '?', question: `Does a ${type} title follow a pattern, like a "P3 - " prefix?` }
  }),
  ...chosen.map(({ type, evidence }): ChecklistItem => {
    const fields = [...new Set(evidence.rows.flatMap(row => Object.keys(row.fields)))].filter(name => /description/i.test(name))
    const found = fields.flatMap(name => {
      const headings = evidence.rows.map(row => new Set(headingsOf(row.fields[name])))
      const common = [...new Set(headings.flatMap(set => [...set]))].filter(heading => headings.filter(set => set.has(heading)).length >= Math.ceil(evidence.rows.length * 0.6))
      return common.length === 0 ? [] : [`${name === 'description' ? 'Description' : name}: ${common.join(', ')}`]
    })
    if (found.length > 0) return { heading: 'Description', item: type, answer: found.join('; '), source: sourceOf(evidence, evidence.rows.length) }
    return evidence.rows.length >= 3
      ? { heading: 'Description', item: type, answer: 'free text', source: sourceOf(evidence, evidence.rows.length) }
      : { heading: 'Description', item: type, answer: '?', question: `Does a ${type} description follow a template, and which headings?` }
  }),
]

/** Labels and components, only when the tickets actually use them. */
const tagItems = (own: readonly TicketRow[], team: readonly TicketRow[]): ChecklistItem[] => {
  const all: Evidence = own.length > 0 ? { rows: [...own], source: 'yours' } : { rows: [...team], source: 'team' }
  return (['labels', 'components'] as const).flatMap(key => {
    const used = all.rows.filter(row => valueText(row.fields[key]) !== undefined)
    if (used.length === 0 || used.length < Math.ceil(all.rows.length * 0.3)) return []
    const values = countsOf(used.flatMap(row => (valueText(row.fields[key]) ?? '').split(', '))).slice(0, 4).map(entry => entry.value)
    return [{ heading: 'Labels and components', item: key === 'labels' ? 'Labels' : 'Components', answer: values.join(', '), source: sourceOf(all, used.length) }]
  })
}

/**
 * The checklist (D76): the decisions godmode makes each time it files a Jira ticket, each
 * answered from the person's own tickets first and the team's only where theirs say nothing,
 * each with its source; an item nothing settles is "?". Counts of issue types across the
 * board are never part of it.
 */
export const checklistOf = (data: Pick<BoardData, 'own' | 'team' | 'typeFields'>): ChecklistItem[] => {
  const names = new Map<string, string>()
  for (const meta of Object.values(data.typeFields)) for (const field of meta) names.set(field.id, field.name)
  const own = data.own.flatMap(issue => ticketRowOf(issue, names) ?? [])
  const team = data.team.flatMap(issue => ticketRowOf(issue, names) ?? [])
  const chosen: Chosen[] = []
  const types = KINDS.map((kind): ChecklistItem => {
    const evidence = evidenceFor(own, team, row => kindOf(row) === kind.key)
    const top = evidence === undefined ? undefined : countsOf(evidence.rows.map(row => row.type))[0]
    if (evidence === undefined || top === undefined) return { heading: 'Issue type', item: kind.label, answer: '?', question: `Which issue type does a ${kind.label.toLowerCase()} get?` }
    chosen.push({ type: top.value, evidence: { ...evidence, rows: evidence.rows.filter(row => row.type === top.value) } })
    return { heading: 'Issue type', item: kind.label, answer: top.value, source: sourceOf(evidence, top.count) }
  })
  return [
    ...types,
    ...placementItems(chosen),
    ...parentItems(chosen),
    { heading: 'Assignee', item: 'Assignee', answer: 'you, unless you say otherwise', source: 'godmode\'s default' },
    ...chosen.map(({ type, evidence }): ChecklistItem => ({ heading: 'Fields', item: type, answer: fieldsAnswer(evidence.rows, data.typeFields[type] ?? []), source: sourceOf(evidence, evidence.rows.length) })),
    ...writingItems(chosen),
    ...tagItems(own, team),
  ]
}

/** One checklist line, as shown and as saved: "item: answer (source)". */
export const checklistLine = (item: ChecklistItem) => `- ${item.item}: ${item.answer}${item.source === undefined ? '' : ` (${item.source})`}`

/** The checklist as the person reads it: each heading on a line of its own, then its items, one line each. */
export const checklistLines = (items: readonly ChecklistItem[]) =>
  [...new Set(items.map(item => item.heading))].flatMap(heading => [`${heading}:`, ...items.filter(item => item.heading === heading).map(checklistLine)])

/** The rules file, under the checklist's headings, so a hand edit is easy and the PM reads it the same way. */
export const checklistFile = (items: readonly ChecklistItem[], project: string, how: string) => {
  const headings = [...new Set(items.map(item => item.heading))]
  return [
    '# Ticket filing',
    '',
    `How godmode files a ticket in Jira project ${project}: ${how}. Edit any line. "?" means ask the person.`,
    '',
    ...headings.flatMap(heading => [`## ${heading}`, '', ...items.filter(item => item.heading === heading).map(checklistLine), '']),
    '## When nothing fits',
    '',
    '- Ask the person how to file the ticket, then add the rule (`ticket_rules`).',
    '',
  ].join('\n')
}

/** The checklist when the person answers it themselves, under the same headings. */
const EXPLAINED: readonly ChecklistItem[] = [
  ...KINDS.map(kind => ({ heading: 'Issue type', item: kind.label, answer: '?', question: `Which issue type does a ${kind.label.toLowerCase()} get?` })),
  { heading: 'Placement', item: 'Placement', answer: '?', question: 'Where does each new ticket go: the active sprint, the next sprint, or the backlog? Name the sprint if it follows a pattern.' },
  { heading: 'Parent', item: 'Parent', answer: '?', question: 'Does a new ticket need a parent (an epic or a story), and how is it chosen?' },
  { heading: 'Fields', item: 'Fields', answer: '?', question: 'Which fields does each type need, with which usual values (a team, a priority, a flag)?' },
  { heading: 'Title', item: 'Title', answer: '?', question: 'Does a title follow a pattern, like a "P3 - " prefix on bugs?' },
  { heading: 'Description', item: 'Description', answer: '?', question: 'Does a description follow a template, and which headings?' },
  { heading: 'Labels and components', item: 'Labels and components', answer: '?', question: 'Which labels or components does a ticket get, if any?' },
]

// ---------------------------------------------------------------------------
// The tool

/** The `ticket_rules` tool: read, learn or change how the person files Jira tickets. */
export const TICKET_RULES_TOOL: ToolSpec & { name: 'ticket_rules' } = {
  name: 'ticket_rules',
  description:
    'The project\'s Jira ticket-filing rules (ticket-filing.md), a checklist: issue type per kind of work, placement, parent, assignee, fields, title, description, labels and components. With no arguments while coding: answers the rules as they stand; read them before every ticket_create on Jira, and ask the person for any "?" item. With no arguments in setup or in /godmode setup: asks the person whether to scan their tickets (read-only) and confirm, or answer the checklist themselves; saves only on their yes. With `rules` (the whole file, same headings): shows the rules to the person and saves them on their yes. Use it when the person gives a new filing rule ("from now on bugs go in the next sprint"): read the rules, change that line, call it with the whole file.',
  inputSchema: {
    type: 'object',
    properties: { rules: { type: 'string', description: 'The whole rules file, under the checklist headings.' } },
  },
  isDeferred: false,
}

type Place = { project: Project; dir: string; answers: Readonly<Record<string, Answer>>; isSetup: boolean }

/** Where the rules go and the answers that reach Jira: the setup run's in setup mode, the note's otherwise. */
async function placeOf($: EngineInterface, current: GodmodeMode): Promise<Place | string> {
  const project = await projectOf($)
  const claudeDir = await claudeDirOf($)
  if (current === 'setup') {
    const answers = (await read($, setupRun)).answers ?? {}
    const storage = answers.storage
    if (!STORAGE_MODES.includes(storage as StorageMode)) return 'Run setup_questionnaire first: the storage answer says where the rules go.'
    const dir = conventionsDirOf(project, storage as StorageMode, claudeDir)
    return dir === undefined ? 'No home folder to keep the rules outside the repo.' : { project, dir, answers, isSetup: true }
  }
  const found = await readNote($, project)
  if (found.status !== 'found') return 'godmode is not set up in this project yet, so it has no ticket rules.'
  const dir = conventionsDirOf(project, found.shared.storage, claudeDir)
  if (dir === undefined) return 'No home folder holds this project\'s conventions.'
  return { project, dir, answers: { ...found.shared.answers, ...(found.personal?.answers ?? {}) }, isSetup: false }
}

/** Asks one question, on one line; undefined when nobody could answer. */
async function ask($: EngineInterface, question: string, options: string[], header: string): Promise<string | undefined> {
  try {
    return await $.ui.ask(questionText(question), { options, header })
  } catch {
    return undefined
  }
}

const NOBODY = 'godmode could not ask the person (a headless run, or the question was dismissed). Nothing was saved. Ask them the ticket-filing checklist in plain words, then call ticket_rules with `rules`.'

/** Writes the rules file and records it: in the setup run, or straight into the note's conventions with a new fingerprint. */
async function writeRules($: EngineInterface, place: Place, rules: string): Promise<string> {
  const path = `${place.dir}/${TICKET_RULES_FILE}`
  const relative = notePath(place.project, path)
  await $.fs.write(path, `${rules.trim()}\n`)
  if (place.isSetup) {
    await update($, setupRun, run => ({
      ...run,
      answers: { ...(run.answers ?? {}), [TICKET_RULES_KEY]: relative },
      written: [...run.written.filter(entry => entry.path !== path), { template: TICKET_RULES_FILE, path }],
    }))
    return `Saved ${relative}. setup_finish adds it to the conventions the loop follows.`
  }
  const found = await readNote($, place.project)
  if (found.status !== 'found') return `Saved ${relative}, but the setup note could not be read, so its fingerprint was not taken. Run \`/godmode audit\`.`
  const print = await fingerprintOf($, place.project, relative)
  const conventions = [...found.shared.conventions.filter(file => file.path !== relative), ...(print === undefined ? [] : [{ path: relative, fingerprint: print }])]
  await writeSharedNote($, found.dir, { ...found.shared, answers: { ...found.shared.answers, [TICKET_RULES_KEY]: relative }, conventions })
  return `Saved ${relative}, and it is among the conventions the loop follows. Follow it from the next ticket on.`
}

/** Shows rules one line per log line and saves them on the person's yes. */
async function saveRules($: EngineInterface, place: Place, rules: string): Promise<string> {
  logLines($, rules)
  const answer = await ask($, 'Save the ticket-filing rules shown above?', ['Save', 'Not yet'], 'Ticket rules')
  if (answer === undefined) return NOBODY
  if (answer !== 'Save') return 'The person did not save these rules. Ask what to change, then call ticket_rules with the new `rules`.'
  return writeRules($, place, rules)
}

const toModel = (said: string, draft: string) =>
  [
    'The person corrected the checklist, in their words:',
    `"${said.trim()}"`,
    'Rewrite the rules below with their corrections (theirs win; keep what they did not correct; an item still unknown stays "?"), then call ticket_rules with `rules` holding the whole file; godmode shows it to them and saves it on their yes.',
    '',
    draft,
  ].join('\n')

const ASK_EACH_TIME = 'Ask me each time'
const LEAVE_OUT = 'Leave it out'

/** Asks each item with a question in turn: the person types the answer, or picks "ask me each time" or "leave it out". Undefined when nobody could answer. */
async function askItems($: EngineInterface, items: readonly ChecklistItem[]): Promise<ChecklistItem[] | undefined> {
  const answered: ChecklistItem[] = []
  for (const item of items) {
    const { question, ...rest } = item
    if (question === undefined) {
      answered.push(rest)
      continue
    }
    const said = await ask($, `${question} Type it under Other.`, [ASK_EACH_TIME, LEAVE_OUT], 'Ticket rules')
    if (said === undefined) return undefined
    if (said === LEAVE_OUT) continue
    answered.push({ ...rest, answer: said === ASK_EACH_TIME ? 'ask the person each time' : flat(said), source: 'your answer' })
  }
  return answered
}

/** The person answers the checklist themselves, item by item; resolves the tool's answer. */
async function explain($: EngineInterface, place: Place, project: string): Promise<string> {
  const items = await askItems($, EXPLAINED)
  if (items === undefined) return NOBODY
  if (items.length === 0) return 'The person left every item out: nothing was saved. `/godmode setup` with topic `tickets` asks again.'
  return saveRules($, place, checklistFile(items, project, 'the person answered the checklist'))
}

const EXPLAIN = 'I\'ll explain it myself'
const TRY_AGAIN = 'Try the scan again'

/** The scan could not help: says why in one plain sentence, and offers explaining first, then another try. */
async function scanFailed($: EngineInterface, place: Place, project: string, why: string, tries: number): Promise<string> {
  const options = tries < 2 ? [EXPLAIN, TRY_AGAIN] : [EXPLAIN, 'Skip for now']
  // The reason is cut, never the question: a dialog shows a long text cut off.
  const reason = why.length > 150 ? `${why.slice(0, 147)}...` : why
  const answer = await ask($, `${reason.replace(/\.$/, '')}. How should godmode learn your team's ticket rules?`, options, 'Ticket rules')
  if (answer === undefined) return NOBODY
  if (answer === TRY_AGAIN) return scanAndConfirm($, place, tries + 1)
  if (answer === 'Skip for now') return 'The person skipped the ticket rules: nothing was saved. `/godmode setup` with topic `tickets` adds them later.'
  return explain($, place, project)
}

/**
 * Scans the person's tickets (the team's where theirs say nothing), shows the checklist one
 * line each, and on "Looks right" asks each "?" item, then saves. A correction typed instead
 * goes back to the model with the checklist, to rewrite.
 */
async function scanAndConfirm($: EngineInterface, place: Place, tries = 1): Promise<string> {
  const data = await jiraBoardData($, place.answers)
  const project = typeof place.answers.jiraProject === 'string' ? place.answers.jiraProject : 'the project'
  if (typeof data === 'string') return scanFailed($, place, project, plainError(data), tries)
  if (data.own.length === 0 && data.team.length === 0) return scanFailed($, place, data.project, `The scan found nothing to read: ${data.project} has no issues yet`, tries)
  const items = checklistOf(data)
  const how = data.own.length > 0 ? `read from ${data.own.length} of your latest tickets` : `read from the team's latest ${data.team.length} tickets, as you have none in ${data.project}`
  logLines($, [`How you file tickets in ${data.project}, ${how}:`, ...checklistLines(items)].join('\n'))
  const seen = await ask($, 'Is this checklist right? Items marked "?" are asked next. Pick "Correct it", or type the fixes under Other.', ['Looks right', 'Correct it'], 'Ticket rules')
  if (seen === undefined) return NOBODY
  const draft = checklistFile(items, data.project, `${how}, then confirmed by the person`)
  if (seen === 'Correct it') {
    const fixes = await ask($, 'What should change? Type it under Other.', ['Keep it as it is', EXPLAIN], 'Ticket rules')
    if (fixes === undefined) return NOBODY
    if (fixes === EXPLAIN) return explain($, place, data.project)
    if (fixes !== 'Keep it as it is') return toModel(fixes, draft)
  } else if (seen !== 'Looks right') return toModel(seen, draft)
  const answered = await askItems($, items)
  if (answered === undefined) return NOBODY
  return writeRules($, place, checklistFile(answered, data.project, `${how}, then confirmed by the person`))
}

/** Serves `ticket_rules` (D74, D76): the main thread in any mode, the setup agent in setup mode. */
export async function serveTicketRules($: EngineInterface, e: { agentId?: string } & Record<string, unknown>) {
  if ((await read($, isOn)) !== true) return { deny: 'godmode is off, so it keeps no ticket rules. The person switches it on with `/godmode`.' }
  const current = await read($, mode)
  if (e.agentId !== undefined && current !== 'setup') return { deny: 'Only the PM changes the ticket rules. Report the rule you need to the PM. Nothing was saved.' }
  const place = await placeOf($, current)
  if (typeof place === 'string') return { deny: place }
  if (trackerKindOf(String(place.answers.tracker ?? '')) !== 'jira') return { deny: 'Ticket rules are for a Jira tracker; this project files tickets elsewhere.' }
  const rules = typeof e.rules === 'string' ? e.rules.trim() : ''
  if (rules !== '') return { result: await saveRules($, place, rules) }
  if (current === 'coding') {
    const text = await $.fs.read(`${place.dir}/${TICKET_RULES_FILE}`).catch(() => undefined)
    return {
      result:
        text === undefined
          ? 'This project has no ticket rules yet: file with the setup\'s default issue type, and ask the person where a ticket goes when it is not clear. `/godmode setup` with topic `tickets` learns the rules.'
          : `The ticket-filing rules (${TICKET_RULES_FILE}):\n\n${text}`,
    }
  }
  const project = typeof place.answers.jiraProject === 'string' ? place.answers.jiraProject : 'the project'
  const how = await ask($, 'How should godmode learn how you file tickets?', ['Scan my tickets, then I confirm', EXPLAIN], 'Ticket rules')
  if (how === undefined) return { result: NOBODY }
  return { result: how === EXPLAIN ? await explain($, place, project) : await scanAndConfirm($, place) }
}
