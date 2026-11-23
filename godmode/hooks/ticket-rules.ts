import { atom, read, update } from 'claude-code'
import type { EngineInterface, ToolSpec } from 'claude-code'

import type { GodmodeMode, SetupRun } from '../types'
import { jiraBoardData } from './jira'
import type { BoardData, FieldMeta } from './jira'
import { trackerKindOf } from './tickets'
import { claudeDirOf, conventionsDirOf, fingerprintOf, notePath, projectOf, readNote, STORAGE_MODES, writeSharedNote } from './storage'
import type { Answer, Project, StorageMode } from './storage'

/*
 * The ticket-filing rules (D74): how this team files Jira tickets, learned from a read-only
 * scan of the board that the person confirms, or from the person's own words, and kept as a
 * plain conventions file, `ticket-filing.md`, the PM follows when it files. The scan's
 * reading is plain functions; the `ticket_rules` tool asks the person, and saves the rules
 * only on their yes. Every helper that takes `$` is a function declaration.
 */

// The same state as `register.tsx`'s atoms: `validate` reads a state source only from this file.
const isOn = atom({ plugin: 'godmode', key: 'isOn' } as const, false)
const mode = atom({ plugin: 'godmode', key: 'mode' } as const, 'coding' as GodmodeMode)
const setupRun = atom({ plugin: 'godmode', key: 'setupRun' } as const, { consented: [], written: [] } as SetupRun)

/** The rules file's name in the conventions folder. */
export const TICKET_RULES_FILE = 'ticket-filing.md'

/** The setup answer that records where the rules file is, so `update` knows a note without one. */
export const TICKET_RULES_KEY = 'ticketRules'

/** How many of the latest issues a scan reads. */
export const SCAN_SIZE = 30

type Count = { value: string; count: number }

type Placement = 'active sprint' | 'next sprint' | 'backlog' | 'a sprint now closed'

/** How one issue type is used on the board. */
export type TypeUse = { name: string; count: number; placement: Partial<Record<Placement, number>>; withParent: number; parentTypes: string[]; priority?: Count }

/** A field the team usually sets, and the values it usually takes. */
export type FieldUse = { id: string; name: string; setIn: number; values: Count[] }

/** Text a field holds unchanged across issues, as a template left in place does. */
export type TemplateText = { field: string; excerpt: string; count: number }

/** What a board scan found. */
export type BoardScan = {
  project: string
  total: number
  /** How many of them the person created; absent when their account could not be read. */
  mine?: number
  types: TypeUse[]
  sprintField?: string
  labels: Count[]
  components: Count[]
  fields: FieldUse[]
  /** Each issue type's required fields beyond the ones godmode sets, as "Name (id)". */
  required: Record<string, string[]>
  templates: TemplateText[]
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

const flat = (text: string) => text.replace(/\s+/g, ' ').trim()

/** The text of an Atlassian document (`{ type: 'doc', content }`), its text nodes joined. */
const documentText = (value: unknown): string =>
  isRecord(value)
    ? `${typeof value.text === 'string' ? value.text : ''}${Array.isArray(value.content) ? value.content.map(documentText).join(' ') : ''}`
    : ''

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

/** Counts, most common first. */
const countsOf = (values: readonly string[]): Count[] => {
  const counts = new Map<string, number>()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  return [...counts].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
}

/** Whether a field holds sprints: a list of `{ name, state }`. */
const isSprintValue = (value: unknown) => Array.isArray(value) && value.length > 0 && value.every(item => isRecord(item) && typeof item.state === 'string' && typeof item.name === 'string')

const placementOf = (sprints: unknown): Placement => {
  const states = Array.isArray(sprints) ? sprints.flatMap(item => (isRecord(item) && typeof item.state === 'string' ? [item.state.toLowerCase()] : [])) : []
  if (states.includes('active')) return 'active sprint'
  if (states.includes('future')) return 'next sprint'
  return states.length > 0 ? 'a sprint now closed' : 'backlog'
}

/** Text that reads as a template's placeholder. */
const PLACEHOLDER = /\{\{[^}]*\}\}|<[A-Za-z][A-Za-z ]{2,30}>|\[(?:describe|add|insert|enter|fill|your)[^\]]*\]|\bTODO\b|\bfill (?:this|in)\b|\bdelete this\b/i

/** The fields godmode never reads as "usually set": the ones every issue has. */
const SYSTEM_FIELDS = new Set(['summary', 'status', 'issuetype', 'project', 'created', 'updated', 'reporter', 'creator', 'assignee', 'priority', 'labels', 'components', 'parent', 'description', 'statuscategorychangedate', 'lastViewed', 'watches', 'votes', 'workratio', 'resolution', 'resolutiondate', 'issuelinks', 'subtasks', 'attachment', 'comment', 'worklog', 'timetracking', 'progress', 'aggregateprogress', 'fixVersions', 'versions', 'environment', 'duedate', 'security', 'timespent', 'timeestimate', 'timeoriginalestimate', 'aggregatetimespent', 'aggregatetimeestimate', 'aggregatetimeoriginalestimate', 'statusCategory'])

/**
 * What the board's latest issues say about how the team files tickets (D74): the issue types
 * in use and where each goes (active sprint, next sprint, backlog), parents, labels and
 * components, the custom fields usually set with their usual values, each type's required
 * fields, and text left unchanged from a template.
 */
export const scanBoard = (data: BoardData): BoardScan => {
  const rows = data.issues.flatMap(issue => (isRecord(issue) && isRecord(issue.fields) ? [issue.fields] : []))
  const names = new Map<string, string>()
  for (const meta of Object.values(data.typeFields)) for (const field of meta) names.set(field.id, field.name)
  const sprintField = [...new Set(rows.flatMap(fields => Object.keys(fields).filter(key => isSprintValue(fields[key]))))][0]
  const typeOf = (fields: Record<string, unknown>) => (isRecord(fields.issuetype) && typeof fields.issuetype.name === 'string' ? fields.issuetype.name : 'unknown')
  const types: TypeUse[] = countsOf(rows.map(typeOf)).map(({ value: name, count }) => {
    const own = rows.filter(fields => typeOf(fields) === name)
    const placement: TypeUse['placement'] = {}
    for (const fields of own) {
      const where = placementOf(sprintField === undefined ? undefined : fields[sprintField])
      placement[where] = (placement[where] ?? 0) + 1
    }
    const parents = own.flatMap(fields => (isRecord(fields.parent) ? [fields.parent] : []))
    const parentTypes = countsOf(parents.flatMap(parent => (isRecord(parent.fields) && isRecord(parent.fields.issuetype) && typeof parent.fields.issuetype.name === 'string' ? [parent.fields.issuetype.name] : []))).map(entry => entry.value)
    const [priority] = countsOf(own.flatMap(fields => valueText(fields.priority) ?? []))
    return { name, count, placement, withParent: parents.length, parentTypes, ...(priority === undefined || priority.count * 10 < own.length * 6 ? {} : { priority }) }
  })
  const custom = [...new Set(rows.flatMap(fields => Object.keys(fields)))].filter(key => !SYSTEM_FIELDS.has(key) && key !== sprintField)
  const fields: FieldUse[] = custom
    .map(id => {
      const values = rows.flatMap(fields => valueText(fields[id]) ?? [])
      return { id, name: names.get(id) ?? id, setIn: values.length, values: countsOf(values).filter(entry => entry.value.length <= 60).slice(0, 3) }
    })
    .filter(field => field.setIn >= Math.max(2, Math.ceil(rows.length * 0.4)) && field.values.length > 0)
    .sort((a, b) => b.setIn - a.setIn)
    .slice(0, 8)
  const texts = new Map<string, { field: string; text: string; count: number }>()
  for (const fields of rows) {
    for (const [id, value] of Object.entries(fields)) {
      const text = typeof value === 'string' || (isRecord(value) && value.type === 'doc') ? valueText(value) : undefined
      if (text === undefined || text.length < 20) continue
      const key = `${id}\n${text}`
      texts.set(key, { field: names.get(id) ?? id, text, count: (texts.get(key)?.count ?? 0) + 1 })
    }
  }
  const templates = [...texts.values()]
    .filter(entry => (entry.count >= 2 && entry.text.length >= 40) || PLACEHOLDER.test(entry.text))
    .map(entry => ({ field: entry.field, excerpt: entry.text.length > 70 ? `${entry.text.slice(0, 67)}...` : entry.text, count: entry.count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5)
  const isGodmodeSet = (field: FieldMeta) => ['summary', 'description', 'issuetype', 'project', 'reporter'].includes(field.id)
  const required = Object.fromEntries(
    Object.entries(data.typeFields).map(([type, meta]) => [type, meta.filter(field => field.isRequired && !field.hasDefault && !isGodmodeSet(field)).map(field => `${field.name} (${field.id})`)]),
  )
  const creators = data.account === undefined ? undefined : rows.filter(fields => isRecord(fields.creator) && fields.creator.accountId === data.account).length
  return {
    project: data.project,
    total: rows.length,
    ...(creators === undefined ? {} : { mine: creators }),
    types,
    ...(sprintField === undefined ? {} : { sprintField }),
    labels: countsOf(rows.flatMap(fields => (Array.isArray(fields.labels) ? fields.labels.filter((label): label is string => typeof label === 'string') : []))).slice(0, 6),
    components: countsOf(rows.flatMap(fields => (Array.isArray(fields.components) ? fields.components.flatMap(item => valueText(item) ?? []) : []))).slice(0, 6),
    fields,
    required,
    templates,
  }
}

/** Why a scan says nothing clear enough to propose rules; undefined when it does. */
export const unclearScan = (scan: BoardScan) => {
  if (scan.total === 0) return `${scan.project} has no issues yet`
  if (scan.total < 3) return `${scan.project} has only ${scan.total} issue${scan.total === 1 ? '' : 's'}, too few to see a pattern`
  return undefined
}

const counted = (entries: readonly Count[]) => entries.map(entry => `${entry.value} (${entry.count})`).join(', ')

const placementLine = (type: TypeUse) =>
  Object.entries(type.placement)
    .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
    .map(([where, count]) => `${where} ${count}`)
    .join(', ')

/** The scan as rules, one plain line each, for the person to read and the PM to follow. */
export const scanLines = (scan: BoardScan) => [
  `Read from the latest ${scan.total} issues in ${scan.project}${scan.mine === undefined ? '' : `, ${scan.mine} of them yours`}.`,
  ...scan.types.map(type => {
    const parent = type.withParent === 0 ? 'no parent' : `a parent on ${type.withParent} of ${type.count}${type.parentTypes.length === 0 ? '' : ` (${type.parentTypes.join(', ')})`}`
    const priority = type.priority === undefined ? '' : `, usually priority ${type.priority.value}`
    return `- ${type.name}: ${type.count} of ${scan.total}. Goes to: ${placementLine(type)}. ${parent[0]?.toUpperCase()}${parent.slice(1)}${priority}.`
  }),
  scan.sprintField === undefined ? '- No sprint field found: tickets go to the backlog.' : `- The sprint field is ${scan.sprintField}.`,
  ...(scan.labels.length === 0 ? [] : [`- Labels used: ${counted(scan.labels)}.`]),
  ...(scan.components.length === 0 ? [] : [`- Components used: ${counted(scan.components)}.`]),
  ...scan.fields.map(field => `- ${field.name}${field.name === field.id ? '' : ` (${field.id})`} is set on ${field.setIn} of ${scan.total}, usually ${counted(field.values)}.`),
  ...Object.entries(scan.required).flatMap(([type, fields]) => (fields.length === 0 ? [] : [`- A ${type} requires ${fields.join(', ')}.`])),
  ...scan.templates.map(entry => `- ${entry.field} still holds template text on ${entry.count} issue${entry.count === 1 ? '' : 's'} ("${entry.excerpt}"): write the real content instead.`),
]

/** The rules file as written from a confirmed scan. */
export const rulesFromScan = (scan: BoardScan, date: string) =>
  [
    '# Ticket filing',
    '',
    `How tickets are filed in Jira project ${scan.project}. godmode wrote this from a scan of the board on ${date}, and the person confirmed it. Edit it freely: godmode reads it as it stands.`,
    '',
    '## What the board shows',
    '',
    ...scanLines(scan),
    '',
    '## Filing a ticket',
    '',
    '- Pick the issue type, the sprint, the parent, the labels, the components and the fields above, and pass them to `ticket_create` in `jira`.',
    '- A field the issue type requires that these rules do not cover: ask the person, never guess.',
    '- A ticket that fits no rule here: ask the person how to file it, then add the rule (`ticket_rules`).',
    '',
  ].join('\n')

// ---------------------------------------------------------------------------
// The tool

/** The `ticket_rules` tool: read, learn or change how the team files Jira tickets. */
export const TICKET_RULES_TOOL: ToolSpec & { name: 'ticket_rules' } = {
  name: 'ticket_rules',
  description:
    'The project\'s Jira ticket-filing rules (ticket-filing.md). With no arguments while coding: answers the rules as they stand; read them before every ticket_create on Jira. With no arguments in setup or in /godmode setup: asks the person whether to scan the board (read-only) and confirm, or explain the flow in their words; saves only on their yes. With `rules` (the whole file, in plain lines): shows the rules to the person and saves them on their yes. Use it when the person gives a new filing rule ("from now on bugs go in the next sprint"): read the rules, add theirs, call it with the whole file.',
  inputSchema: {
    type: 'object',
    properties: { rules: { type: 'string', description: 'The whole rules file, as plain markdown lines.' } },
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

/** Asks one question; undefined when nobody could answer. */
async function ask($: EngineInterface, question: string, options: string[], header: string): Promise<string | undefined> {
  try {
    return await $.ui.ask(question, { options, header })
  } catch {
    return undefined
  }
}

const NOBODY = 'godmode could not ask the person (a headless run, or the question was dismissed). Nothing was saved. Ask them in plain words how their team files tickets, then call ticket_rules with `rules`.'

/**
 * Saves the rules file on the person's yes: in setup mode for `setup_finish` to fingerprint
 * with the other conventions, otherwise straight into the note's conventions with a new
 * fingerprint, so a hand edit later is seen like any conventions edit.
 */
async function saveRules($: EngineInterface, place: Place, rules: string): Promise<string> {
  const answer = await ask($, `Save these ticket-filing rules?\n\n${rules.trim()}`, ['Save', 'Not yet'], 'Ticket rules')
  if (answer === undefined) return NOBODY
  if (answer !== 'Save') return 'The person did not save these rules. Ask what to change, then call ticket_rules with the new `rules`.'
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
  if (found.status !== 'found') return `Saved ${relative}, but the setup note could not be read, so its fingerprint was not taken. Run \`/godmode setup\` with topic \`check\`.`
  const print = await fingerprintOf($, place.project, relative)
  const conventions = [...found.shared.conventions.filter(file => file.path !== relative), ...(print === undefined ? [] : [{ path: relative, fingerprint: print }])]
  await writeSharedNote($, found.dir, { ...found.shared, answers: { ...found.shared.answers, [TICKET_RULES_KEY]: relative }, conventions })
  return `Saved ${relative}, and it is among the conventions the loop follows. Follow it from the next ticket on.`
}

const toModel = (what: string, said: string, draft?: string) =>
  [
    `The person ${what}, in their words:`,
    `"${said.trim()}"`,
    draft === undefined
      ? 'Turn it into plain filing rules: issue types and when each is used, where new tickets go (active sprint, next sprint, backlog), parents, labels, components, fields to set with their values, and what to do when no rule fits (ask the person). Then call ticket_rules with `rules` holding the whole file; godmode shows it to them and saves it on their yes.'
      : 'Rewrite the rules below with their corrections (theirs win; keep what they did not correct), then call ticket_rules with `rules` holding the whole file; godmode shows it to them and saves it on their yes.',
    ...(draft === undefined ? [] : ['', draft]),
  ].join('\n')

/** The person explains the flow in their words; resolves the tool's answer. */
async function explain($: EngineInterface, project: string, why?: string): Promise<string> {
  const answer = await ask(
    $,
    `${why === undefined ? '' : `${why}. `}How does your team file tickets in ${project}? Type it under Other: which issue type for what, where new tickets go (active sprint, next sprint, backlog), parents, labels, components, and fields to set.`,
    ['Skip for now', 'Decide later'],
    'Ticket rules',
  )
  if (answer === undefined) return NOBODY
  if (answer === 'Skip for now' || answer === 'Decide later') return 'The person skipped the ticket rules: nothing was saved. `/godmode setup` with topic `tickets` adds them later.'
  return toModel('explained how their team files tickets', answer)
}

/** Scans the board, shows what it found, and saves it on "Looks right"; corrections go back to the model. */
async function scanAndConfirm($: EngineInterface, place: Place): Promise<string> {
  const data = await jiraBoardData($, place.answers, SCAN_SIZE)
  const project = typeof place.answers.jiraProject === 'string' ? place.answers.jiraProject : 'the project'
  if (typeof data === 'string') return explain($, project, `godmode could not read the board (${data})`)
  const scan = scanBoard(data)
  const unclear = unclearScan(scan)
  if (unclear !== undefined) return explain($, data.project, `The scan found nothing clear: ${unclear}`)
  const draft = rulesFromScan(scan, new Date(await $.clock.now()).toISOString().slice(0, 10))
  const seen = await ask($, `Here is how your team seems to file tickets:\n${scanLines(scan).join('\n')}\nIs that right? Pick "Correct it", or type what to change under Other.`, ['Looks right', 'Correct it'], 'Ticket rules')
  if (seen === undefined) return NOBODY
  if (seen === 'Looks right') return saveRules($, place, draft)
  if (seen !== 'Correct it') return toModel('corrected the scan', seen, draft)
  const correction = await ask($, 'What should change? Type it under Other.', ['Keep the scan as it is', 'I\'ll explain it myself'], 'Ticket rules')
  if (correction === undefined) return NOBODY
  if (correction === 'Keep the scan as it is') return saveRules($, place, draft)
  if (correction === 'I\'ll explain it myself') return explain($, data.project)
  return toModel('corrected the scan', correction, draft)
}

/** Serves `ticket_rules` (D74): the main thread in any mode, the setup agent in setup mode. */
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
  const how = await ask($, 'How should godmode learn how your team files tickets?', ['Scan the board, then I confirm', 'I\'ll explain it myself'], 'Ticket rules')
  if (how === undefined) return { result: NOBODY }
  return { result: how === 'I\'ll explain it myself' ? await explain($, project) : await scanAndConfirm($, place) }
}
