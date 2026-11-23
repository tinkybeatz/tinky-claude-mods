import { atom, read, update } from 'claude-code'
import type { AgentInfo, AgentSpawnInput, EngineInterface, On, TurnStepResult } from 'claude-code'

import type { DispatchedAgent, GodmodeMode, IndicatorStyle, PaneLimit, PaneRow, PaneRowKind, PaneTab, PaneTicket, TryRun } from '../types'
import { jiraRecorded } from './jira'
import { allowedOf, loopContextOf, readFixRounds, readVerdicts } from './loop'
import type { LoopCache } from './loop'
import { describeAction, shellTitle, THINKING } from './pane-actions'
import { ACTIVITY_LABELS, activityColor, activityFromDescription, activityTag, CLASSIFIER_HINTS, FAILED_MARK_COLOR } from './pane-kinds'
import { buildTree, descendantsOf, dropFinishedTrees, liveRootIds } from './pane-tree'
import type { Descendant } from './pane-tree'
import { isHumanQaMode } from './rules'
import { backendFor, OPEN_STATUSES, trackerOf } from './tickets'

/*
 * godmode's side pane, the "Side pane" on-indicator (D68): a red GODMODE header, godmode's
 * own sections (open tickets, what waits on the person, a running `/godmode try`), then the
 * agents and background shells with their purpose, tokens and duration and the account's
 * usage bars, as the dispatch panel in this repo shows them. It is independent of that
 * plugin: its own pane id, state keys and copies of the code it needs. It stays open while
 * godmode is on, in every mode, closes when godmode turns off, and falls back to the band
 * when it cannot be placed. Every helper that takes `$` is a function declaration.
 */

/** The pane's id: the dispatch panel's is `dispatches`, so the two never clash. */
export const PANE_ID = 'godmode'
const TITLE = 'godmode'
const MAX_ROWS = 100
const OUTER_X = 2
const OUTER_Y = 1
const INNER_X = 1
const ROW_GAP = 0
const ACTION_BACKGROUND = '#3a3a3a'
const WIDTH_SHARE = 2 / 3
const MIN_COLUMNS = 24
/** The pane's remembered width, in godmode's own store. */
const COLUMNS_KEY = 'paneColumns'
const LIMIT_NAMES: Readonly<Record<string, string>> = { five_hour: 'Session (5h)', seven_day: 'Week', spend_limit: 'Spend' }
const LIMIT_EMPTY_COLOR = '#3a3a3a'
const limitColor = (percent: number) => (percent >= 90 ? '#ef4444' : percent >= 70 ? '#facc15' : '#22c55e')
/** Catch-all agent types: the card's subtitle names an agent's type only when it is not one of these. */
const GENERIC_TYPES = new Set(['general-purpose', 'claude', 'agent'])
/** The header's red, the same as the other indicators'. */
const HEADER_COLOR = '#e5484d'
const WAITS_COLOR = '#facc15'
/** At most this many tickets show; the rest are counted. */
const TICKETS_SHOWN = 8

const ENDED = new Set(['completed', 'failed', 'killed', 'done'])

const panelStatus = (agent: AgentInfo) => {
  const isTeammate = agent.teammateId !== undefined || agent.type === 'teammate'
  return agent.status === 'idle' && !isTeammate ? 'done' : agent.status
}

// godmode's own state keys, declared in its contract; the same keys as the other files' atoms.
const isOn = atom({ plugin: 'godmode', key: 'isOn' } as const, false)
const mode = atom({ plugin: 'godmode', key: 'mode' } as const, 'coding' as GodmodeMode)
const indicator = atom({ plugin: 'godmode', key: 'indicator' } as const, 'pane' as IndicatorStyle)
const agents = atom({ plugin: 'godmode', key: 'agents' } as const, {} as Record<string, DispatchedAgent>)
const tryRun = atom({ plugin: 'godmode', key: 'tryRun' } as const, null as TryRun | null)
const rows = atom({ plugin: 'godmode', key: 'paneRows' } as const, [] as PaneRow[])
const now = atom({ plugin: 'godmode', key: 'paneNow' } as const, 0)
const tab = atom({ plugin: 'godmode', key: 'paneTab' } as const, 'active' as PaneTab)
const isSized = atom({ plugin: 'godmode', key: 'paneSized' } as const, false)
const limits = atom({ plugin: 'godmode', key: 'paneLimits' } as const, [] as PaneLimit[])
const collapsed = atom({ plugin: 'godmode', key: 'paneCollapsed' } as const, { agent: false, shell: false } as Record<PaneRowKind, boolean>)
const tickets = atom({ plugin: 'godmode', key: 'paneTickets' } as const, [] as PaneTicket[])
const fallback = atom({ plugin: 'godmode', key: 'paneFallback' } as const, false)
const closed = atom({ plugin: 'godmode', key: 'paneClosed' } as const, false)

/** The docked pane's width as last drawn; the render hook records it, since no `$` call reports it. */
let measuredColumns: number | undefined

const isRunning = (row: PaneRow) => !ENDED.has(row.status)

const TASK_NOTIFICATION = /<task-id>([^<]+)<\/task-id>[\s\S]*?<status>([^<]+)<\/status>/g
const NOTIFIED_STATUS: Readonly<Record<string, string>> = { completed: 'done', failed: 'failed', killed: 'killed' }

const firstLine = (text: string) => text.split('\n')[0]?.trim() ?? ''

/** Whether the pane is godmode's indicator now: godmode on, and the person picked it. */
async function isPaneOn($: EngineInterface) {
  return (await read($, isOn)) === true && (await read($, indicator)) === 'pane'
}

async function upsert($: EngineInterface, id: string, patch: (row: PaneRow | undefined) => PaneRow | undefined) {
  await update($, rows, list => {
    const found = list.find(row => row.id === id)
    const next = patch(found)
    if (next === undefined) return list
    if (found === undefined) return [...list, next].slice(-MAX_ROWS)
    return list.map(row => (row.id === id ? next : row))
  })
}

/** Ends each tracked row a task notification in `raw` reports on, with the status it reports. */
async function applyNotifications($: EngineInterface, raw: string) {
  if (!raw.includes('<task-notification>')) return
  const at = await $.clock.now()
  for (const match of raw.matchAll(TASK_NOTIFICATION)) {
    const [, id, status] = match
    if (id === undefined || status === undefined) continue
    const ended = NOTIFIED_STATUS[status] ?? 'done'
    await upsert($, id, row => (row === undefined || (!isRunning(row) && row.status !== 'done') ? undefined : { ...row, status: ended, endedAt: row.endedAt ?? at }))
  }
}

const formatCount = (count: number) => {
  if (count < 1000) return `${count}`
  if (count < 1_000_000) return `${(count / 1000).toFixed(1)}k`
  return `${(count / 1_000_000).toFixed(2)}M`
}

async function storedColumns($: EngineInterface) {
  const stored = await $.store.get(COLUMNS_KEY).catch(() => undefined)
  return typeof stored === 'number' ? stored : undefined
}

/**
 * Opens the pane when it is godmode's indicator: at every switch-on, in any mode. When the
 * surface cannot place it (an unasked pane seats from 144 columns), the band stands in, so the
 * person always sees that godmode is on. Resolves whether it was placed.
 */
export async function openGodmodePane($: EngineInterface) {
  if (!(await isPaneOn($))) return false
  await update($, closed, () => false)
  const columns = await storedColumns($)
  const opened = await $.ui.open({ id: PANE_ID, title: TITLE, ...(columns === undefined ? {} : { columns }) }).catch(() => ({ isPlaced: false }))
  await update($, fallback, () => !opened.isPlaced)
  return opened.isPlaced
}

/** Closes the pane as godmode turns off. */
export async function closeGodmodePane($: EngineInterface) {
  await update($, fallback, () => false)
  if ((await $.ui.panes().catch(() => [])).some(pane => pane.id === PANE_ID)) await $.ui.close({ id: PANE_ID }).catch(() => undefined)
}

/** Narrows the dock once per session to the remembered width, or two thirds of the width it was first drawn at. */
async function fitWidth($: EngineInterface) {
  if (measuredColumns === undefined || (await read($, isSized))) return
  const panes = await $.ui.panes()
  if (!panes.some(pane => pane.id === PANE_ID && pane.isPlaced)) return
  const columns = (await storedColumns($)) ?? Math.max(MIN_COLUMNS, Math.round(measuredColumns * WIDTH_SHARE))
  await $.store.set(COLUMNS_KEY, columns)
  await update($, isSized, () => true)
  await $.ui.open({ id: PANE_ID, title: TITLE, columns })
}

/** A pane that waited undrawn may be placed later (a wider terminal): the band then steps aside. */
async function syncPlacement($: EngineInterface) {
  if (!(await read($, fallback))) return
  const panes = await $.ui.panes()
  if (panes.some(pane => pane.id === PANE_ID && pane.isPlaced)) await update($, fallback, () => false)
}

const formatDuration = (ms: number) => {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`
  if (m > 0) return `${m}m${String(s).padStart(2, '0')}s`
  return `${s}s`
}

const formatUntil = (iso: string | undefined, at: number) => {
  const resets = iso === undefined ? Number.NaN : Date.parse(iso)
  if (Number.isNaN(resets) || resets <= at) return ''
  const minutes = Math.ceil((resets - at) / 60_000)
  const d = Math.floor(minutes / 1440)
  const h = Math.floor((minutes % 1440) / 60)
  const m = minutes % 60
  if (d > 0) return `${d}d${String(h).padStart(2, '0')}h`
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`
  return `${m}m`
}

/** Reads the account's rate-limit windows, as the status line has them; the atom is written only when a window moved. */
async function syncLimits($: EngineInterface) {
  const { rateLimits } = await $.session.usage()
  const fresh = rateLimits.map(({ kind, percentUsed, resetsAt }) => ({ kind, percentUsed, resetsAt }))
  if (JSON.stringify(fresh) !== JSON.stringify(await read($, limits))) await update($, limits, () => fresh)
}

const statusMark = (status: string) => {
  if (status === 'failed') return '✗'
  if (status === 'killed') return '■'
  if (status === 'idle' || status === 'waiting') return '◌'
  if (ENDED.has(status)) return '✓'
  return '●'
}

/** Reconciles tracked agents with the engine's own list, and finds any the spawn hook missed. */
async function syncAgents($: EngineInterface, at: number) {
  const listed = await $.agent.list()
  for (const agent of listed) {
    const status = panelStatus(agent)
    await upsert($, agent.id, row => {
      if (row === undefined) {
        if (ENDED.has(status)) return undefined
        const signalled = activityFromDescription(agent.description)
        return {
          id: agent.id,
          kind: 'agent',
          label: agent.type,
          purpose: agent.description,
          status,
          startedAt: at,
          parentId: agent.parentId,
          ...(signalled === undefined ? {} : { activity: signalled, isClassified: true }),
        }
      }
      const parentId = row.parentId ?? agent.parentId
      if (row.status === status && row.parentId === parentId) return undefined
      return { ...row, status, parentId, endedAt: ENDED.has(status) ? (row.endedAt ?? at) : undefined }
    })
  }
  // An agent the engine no longer lists is over, whatever its row last said.
  const ids = new Set(listed.map(agent => agent.id))
  await update($, rows, list => list.map(row => (row.kind === 'agent' && isRunning(row) && !ids.has(row.id) ? { ...row, status: 'done', endedAt: at } : row)))
}

/** Ends the running shells of an agent that has ended: their notice goes to a queue nobody reads. */
async function endOrphanShells($: EngineInterface, at: number) {
  await update($, rows, list => {
    const byId = new Map(list.map(row => [row.id, row]))
    return list.map(row => {
      const owner = row.parentId === undefined ? undefined : byId.get(row.parentId)
      if (row.kind !== 'shell' || !isRunning(row) || owner === undefined || isRunning(owner)) return row
      return { ...row, status: owner.status === 'killed' ? 'killed' : 'done', endedAt: owner.endedAt ?? at }
    })
  })
}

/** Classifies one agent's activity per tick, outside any hook, so a slow model call never holds up a spawn. */
async function classifyNext($: EngineInterface) {
  const row = (await read($, rows)).find(one => one.kind === 'agent' && one.isClassified !== true)
  if (row === undefined) return
  await upsert($, row.id, found => (found === undefined ? undefined : { ...found, isClassified: true }))
  const text = [`agent type: ${row.label}`, `task: ${row.purpose}`, row.brief ? `prompt: ${row.brief}` : '', CLASSIFIER_HINTS].filter(Boolean).join('\n')
  const activity = await $.model.classify(text, ACTIVITY_LABELS).catch(() => undefined)
  await upsert($, row.id, found => (found === undefined ? undefined : { ...found, activity: activity ?? 'something else' }))
}

/** The pane's second: only while it is godmode's indicator, so nothing runs for a person who did not pick it. */
async function tick($: EngineInterface) {
  if (!(await isPaneOn($))) return
  const at = await $.clock.now()
  await syncAgents($, at)
  await endOrphanShells($, at)
  await classifyNext($)
  await fitWidth($)
  await syncPlacement($)
  await syncLimits($).catch(() => undefined)
  if ((await read($, rows)).some(isRunning)) await update($, now, () => at)
}

/** Starts the pane's clock, once per load of the module, at session start. */
export function startPaneClock($: EngineInterface) {
  $.clock.every(1000, () => void tick($).catch(() => undefined))
}

/** What one ticket waits on from the person, from what godmode already keeps; undefined when nothing. */
const waitsOf = (ticket: { status: string; ready?: boolean }, extra: { isQaByPeople: boolean; isClean: boolean; isPastLimit: boolean; isAutoMerge: boolean }) => {
  if (extra.isPastLimit) return 'fix-round go'
  if (ticket.status === 'todo' && ticket.ready === false) return 'go to start'
  if (ticket.status === 'qa' && extra.isQaByPeople) return 'QA'
  if (ticket.status === 'review' && extra.isClean && !extra.isAutoMerge) return 'merge go'
  return undefined
}

/**
 * Reads the open tickets for the pane, from godmode's own records with no call to a tracker:
 * the markdown tickets, or the side files of the Jira tickets godmode filed. Run on each
 * prompt and after each ticket change, only while the pane is godmode's indicator.
 */
export async function refreshPaneTickets($: EngineInterface, cache: LoopCache) {
  if (!(await isPaneOn($))) return
  const context = await loopContextOf($, cache)
  if (context === undefined) return
  const tracker = trackerOf(context.note.shared.answers)
  const open =
    tracker === 'jira'
      ? (await jiraRecorded($, context.project, OPEN_STATUSES)).map(found => ({ id: found.id, title: found.title ?? '', status: found.status ?? 'todo', pr: found.pr, ready: undefined }))
      : (await backendFor($, tracker, context.note.dir, context.answers).list({ statuses: OPEN_STATUSES })).map(header => ({
          id: header.id,
          title: header.title,
          status: header.status,
          pr: header.pr,
          ready: header.ready,
        }))
  const verdicts = await readVerdicts($, context.project)
  const listed: PaneTicket[] = []
  for (const ticket of open) {
    const pr = ticket.pr === undefined ? undefined : (/\/pull\/(\d+)/.exec(ticket.pr)?.[1] ?? ticket.pr.replace(/^#/, ''))
    const entry = await readFixRounds($, context.project, ticket.id)
    const waits = waitsOf(ticket, {
      isQaByPeople: isHumanQaMode(context.settings.qaMode),
      isClean: pr !== undefined && verdicts[pr]?.verdict === 'clean',
      isPastLimit: entry.count >= allowedOf(context.settings, entry) && entry.count > 0,
      isAutoMerge: context.settings.isAutoMergeOn,
    })
    listed.push({ id: ticket.id, title: ticket.title, status: ticket.status, ...(waits === undefined ? {} : { waits }) })
  }
  if (JSON.stringify(listed) !== JSON.stringify(await read($, tickets))) await update($, tickets, () => listed)
}

/** Records a spawned agent's row (godmode's `agent.spawn` hook calls it once the agent started). */
export async function paneSpawned($: EngineInterface, e: AgentSpawnInput, agentId: string, startedAt: number) {
  if (!(await isPaneOn($))) return
  const signalled = activityFromDescription(e.description)
  await upsert($, agentId, row => ({
    id: agentId,
    kind: 'agent',
    label: e.subagentType || 'agent',
    purpose: e.description || firstLine(e.prompt),
    brief: e.prompt.slice(0, 600),
    activity: row?.activity ?? signalled,
    isClassified: row?.isClassified ?? (signalled === undefined ? undefined : true),
    action: row?.action ?? 'starting',
    status: row?.status ?? 'running',
    startedAt: row?.startedAt ?? startedAt,
    endedAt: row?.endedAt,
    inputTokens: row?.inputTokens,
    outputTokens: row?.outputTokens,
    parentId: e.parentAgentId ?? row?.parentId,
  }))
}

/** Adds one of an agent's requests to its token counts (godmode's `turn.step` hook calls it). */
export async function paneStep($: EngineInterface, agentId: string | undefined, usage: TurnStepResult['usage']) {
  if (agentId === undefined || usage === null || !(await isPaneOn($))) return
  const inputTokens = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
  await upsert($, agentId, row => (row === undefined ? undefined : { ...row, inputTokens: (row.inputTokens ?? 0) + inputTokens, outputTokens: (row.outputTokens ?? 0) + usage.output_tokens }))
}

/** An agent's current action, as one of its tool calls starts (`label`), or `thinking` once it ended. */
export async function paneAction($: EngineInterface, agentId: string | undefined, tool: string, input: Record<string, unknown>, isDone: boolean) {
  if (agentId === undefined || !(await isPaneOn($))) return
  const label = isDone ? THINKING : describeAction(tool, input)
  await upsert($, agentId, row => (row === undefined || !isRunning(row) ? undefined : { ...row, action: label }))
}

/** Ends the rows a delivered task notification reports on (godmode's `session.receive` hook calls it). */
export async function paneReceived($: EngineInterface, text: string) {
  await applyNotifications($, text)
}

/** The pane's own hooks (as the dispatch panel's, those godmode already hooks aside), its close hook and its drawing. */
export function registerPane(on: On) {
  // The person's close mark: the pane stays closed until godmode is next switched on, and the band stands in.
  on('ui.close', async ($, e, next) => {
    if (e.id === PANE_ID && e.origin.kind === 'person') await update($, closed, () => true)
    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (e.tool !== 'Bash') return next(e)
    const startedAt = await $.clock.now()
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError || !(await isPaneOn($))) return ran
    const taskId = ran.result.backgroundTaskId
    if (taskId !== undefined) {
      const purpose = e.description || shellTitle(e.command)
      await upsert($, taskId, row => row ?? { id: taskId, kind: 'shell', label: 'bash', purpose, status: 'running', startedAt, parentId: e.agentId })
    }
    return ran
  })

  on('tool.call', { tool: 'TaskStop' }, async ($, e, next) => {
    if (e.tool !== 'TaskStop') return next(e)
    const ran = await next(e)
    const taskId = e.task_id ?? e.shell_id
    if (taskId !== undefined && ran.deny === undefined && !ran.isError) {
      const at = await $.clock.now()
      await upsert($, taskId, row => (row === undefined || !isRunning(row) ? undefined : { ...row, status: 'killed', endedAt: at }))
    }
    return ran
  })

  on('session.append', async ($, e, next) => {
    const appended = await next(e)
    await applyNotifications($, JSON.stringify(e.message.content)).catch(() => undefined)
    return appended
  })

  // At each stop the engine lists the background work still in flight: any shell missing from it has finished.
  on('classic.Stop', async ($, e, next) => {
    if (!(await isPaneOn($))) return next(e)
    const inFlight = e.background_tasks ?? []
    const at = await $.clock.now()
    const liveShells = new Set(inFlight.filter(task => task.type === 'shell').map(task => task.id))
    await update($, rows, list => list.map(row => (row.kind === 'shell' && isRunning(row) && !liveShells.has(row.id) ? { ...row, status: 'done', endedAt: at } : row)))
    for (const task of inFlight) {
      if (task.type !== 'shell') continue
      await upsert($, task.id, row => row ?? { id: task.id, kind: 'shell', label: 'bash', purpose: task.description || shellTitle(task.command ?? ''), status: 'running', startedAt: at })
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const list = await read($, rows)
    const at = await read($, now)
    const shownTab = await read($, tab)
    const roles = await read($, agents)
    const width = Math.max(10, e.props.bodyColumns)
    const stripColumns = Math.max(4, width - 2 * OUTER_X - 2 - 2 * INNER_X)
    const lineColumns = Math.max(4, width - 2 * OUTER_X)
    if (e.props.placement === 'dock') measuredColumns = e.props.bodyColumns
    const tree = buildTree(list)
    const live = liveRootIds(list, isRunning)
    const roots = list.filter(row => tree.rootIdOf(row) === row.id)
    const active = roots.filter(row => live.has(row.id))
    const finished = roots.filter(row => !live.has(row.id)).reverse()
    const shown = shownTab === 'active' ? active : finished
    const showTab = (next: PaneTab) => () => void update($, tab, () => next)
    const elapsedOf = (row: PaneRow) => (row.endedAt ?? Math.max(at, row.startedAt)) - row.startedAt
    const markColorOf = (row: PaneRow) => (row.status === 'failed' ? FAILED_MARK_COLOR : activityColor(row))
    /** A godmode agent's role and ticket, which the card names in place of the agent type. */
    const roleOf = (row: PaneRow) => {
      const known = roles[row.id]
      return known === undefined ? undefined : [known.role, known.ticket].filter(part => part !== undefined).join(' · ')
    }

    const childLine = ({ row, depth, isLast }: Descendant) => {
      const running = isRunning(row)
      const color = activityColor(row)
      const tag = row.kind === 'shell' ? 'shell' : activityTag(row)
      return (
        <Box key={row.id} flexDirection="row" gap={1}>
          <Box flexShrink={1}>
            <Text wrap="truncate-end">
              <Text dimColor>{`${'  '.repeat(depth)}${isLast ? '└' : '├'} `}</Text>
              <Text color={markColorOf(row)} dimColor={!running}>
                {statusMark(row.status)}
              </Text>
              <Text color={color} dimColor={!running}>{` ${row.purpose || row.label}`}</Text>
            </Text>
          </Box>
          {tag !== undefined && (
            <Box flexShrink={0}>
              <Text color={color} dimColor>{`[${tag}]`}</Text>
            </Box>
          )}
          <Box flexGrow={1} />
          <Box flexShrink={0}>
            <Text dimColor={!running}>{formatDuration(elapsedOf(row))}</Text>
          </Box>
        </Box>
      )
    }

    const card = (row: PaneRow) => {
      const running = isRunning(row)
      const color = activityColor(row)
      const tag = activityTag(row)
      const descendants = descendantsOf(tree, row.id)
      const subInput = descendants.reduce((sum, { row: child }) => sum + (child.inputTokens ?? 0), 0)
      const subOutput = descendants.reduce((sum, { row: child }) => sum + (child.outputTokens ?? 0), 0)
      const role = roleOf(row)
      const subtitle = role ?? (GENERIC_TYPES.has(row.label) ? undefined : row.label)
      return (
        <Box key={row.id} flexDirection="column" borderStyle="round" borderColor={color} borderDimColor={!live.has(row.id)} paddingX={INNER_X} marginBottom={ROW_GAP}>
          <Box flexDirection="row" gap={1}>
            <Text color={markColorOf(row)} dimColor={!running}>
              {statusMark(row.status)}
            </Text>
            <Box flexShrink={1}>
              <Text color={color} bold={running} dimColor={!running} wrap="truncate-end">
                {row.purpose || row.label}
              </Text>
            </Box>
            {tag !== undefined && (
              <Box flexShrink={0}>
                <Text color={color} dimColor={!running}>{`[${tag}]`}</Text>
              </Box>
            )}
            <Box flexGrow={1} />
            <Box flexShrink={0}>
              <Text dimColor={!running}>{formatDuration(elapsedOf(row))}</Text>
            </Box>
          </Box>
          {row.kind === 'agent' && subtitle !== undefined && (
            <Text dimColor italic wrap="truncate-end">
              {subtitle}
            </Text>
          )}
          {row.kind === 'agent' && (
            <Text dimColor wrap="truncate-end">
              {`in ${formatCount(row.inputTokens ?? 0)} · out ${formatCount(row.outputTokens ?? 0)}`}
              {subInput + subOutput > 0 ? ` · sub in ${formatCount(subInput)} · out ${formatCount(subOutput)}` : ''}
            </Text>
          )}
          {descendants.map(childLine)}
          {row.kind === 'agent' && running && row.action !== undefined && (
            <Box flexDirection="column" width={stripColumns}>
              <Text color={ACTION_BACKGROUND}>{'▄'.repeat(stripColumns)}</Text>
              <Box backgroundColor={ACTION_BACKGROUND} paddingX={INNER_X}>
                <Text wrap="truncate-end">
                  <Text color={color}>▸ </Text>
                  {row.action}
                </Text>
              </Box>
              <Text color={ACTION_BACKGROUND}>{'▀'.repeat(stripColumns)}</Text>
            </Box>
          )}
        </Box>
      )
    }

    // godmode's own sections, each left out when it has nothing in it.
    const open = await read($, tickets)
    const waiting = open.filter(ticket => ticket.waits !== undefined)
    const running = await read($, tryRun)
    const currentMode = await read($, mode)
    const ticketLine = (ticket: PaneTicket) => (
      <Box key={`ticket-${ticket.id}`} flexDirection="row" gap={1}>
        <Box flexShrink={1}>
          <Text wrap="truncate-end">
            <Text bold>{ticket.id}</Text>
            <Text>{` ${ticket.title}`}</Text>
          </Text>
        </Box>
        <Box flexGrow={1} />
        <Box flexShrink={0}>
          <Text dimColor>{ticket.status}</Text>
        </Box>
      </Box>
    )
    const waitsLine = (ticket: PaneTicket) => (
      <Box key={`waits-${ticket.id}`} flexDirection="row" gap={1}>
        <Text color={WAITS_COLOR}>◆</Text>
        <Box flexShrink={1}>
          <Text wrap="truncate-end">{`${ticket.id}: ${ticket.waits ?? ''}`}</Text>
        </Box>
      </Box>
    )

    const folded = await read($, collapsed)
    const sections = (
      [
        { kind: 'agent', title: 'Agents', rows: shown.filter(row => row.kind === 'agent') },
        { kind: 'shell', title: 'Shells', rows: shown.filter(row => row.kind === 'shell') },
      ] as const
    ).filter(section => section.rows.length > 0)
    const toggle = (kind: PaneRowKind) => () => void update($, collapsed, state => ({ ...state, [kind]: !state[kind] }))

    const windows = await read($, limits)
    const limitBar = (limit: PaneLimit) => {
      const percent = Math.max(0, Math.min(100, limit.percentUsed))
      const filled = Math.round((percent / 100) * lineColumns)
      const resets = formatUntil(limit.resetsAt, at)
      return (
        <Box key={limit.kind} flexDirection="column">
          <Box flexDirection="row" gap={1}>
            <Box flexShrink={1}>
              <Text dimColor wrap="truncate-end">
                {LIMIT_NAMES[limit.kind] ?? limit.kind.replace(/_/g, ' ')}
              </Text>
            </Box>
            <Box flexGrow={1} />
            <Text color={limitColor(percent)}>{`${Math.round(limit.percentUsed)}%`}</Text>
            {resets !== '' && <Text dimColor>{`· resets in ${resets}`}</Text>}
          </Box>
          <Text>
            <Text color={limitColor(percent)}>{'█'.repeat(filled)}</Text>
            <Text color={LIMIT_EMPTY_COLOR}>{'█'.repeat(lineColumns - filled)}</Text>
          </Text>
        </Box>
      )
    }

    return (
      <Box flexDirection="column" width={width} minHeight={e.props.scroll.bodyRows} paddingX={OUTER_X} paddingY={OUTER_Y}>
        <Text color={HEADER_COLOR}>{'━'.repeat(lineColumns)}</Text>
        <Box flexDirection="row" marginBottom={OUTER_Y}>
          <Text color={HEADER_COLOR} bold>
            GODMODE
          </Text>
          <Text dimColor>{` · ${currentMode}`}</Text>
        </Box>
        {waiting.length > 0 && (
          <Box flexDirection="column" marginBottom={OUTER_Y}>
            <Text bold color={WAITS_COLOR}>{`Waits on you (${waiting.length})`}</Text>
            {waiting.map(waitsLine)}
          </Box>
        )}
        {open.length > 0 && (
          <Box flexDirection="column" marginBottom={OUTER_Y}>
            <Text dimColor bold>{`Tickets (${open.length})`}</Text>
            {open.slice(0, TICKETS_SHOWN).map(ticketLine)}
            {open.length > TICKETS_SHOWN && <Text dimColor>{`and ${open.length - TICKETS_SHOWN} more`}</Text>}
          </Box>
        )}
        {running !== null && (
          <Box flexDirection="column" marginBottom={OUTER_Y}>
            <Text dimColor bold>
              Try
            </Text>
            <Text wrap="truncate-end">{`${running.ticket} · ${running.url}`}</Text>
          </Box>
        )}
        <Box flexDirection="row" gap={OUTER_X} marginBottom={OUTER_Y}>
          <Button key="tab-active" hotkey="a" variant={shownTab === 'active' ? 'primary' : 'secondary'} onPress={showTab('active')}>
            Active ({active.length})
          </Button>
          <Button key="tab-finished" hotkey="f" variant={shownTab === 'finished' ? 'primary' : 'secondary'} onPress={showTab('finished')}>
            Finished ({finished.length})
          </Button>
          {shownTab === 'finished' && finished.length > 0 && (
            <Button key="clear" plain dimColor onPress={() => void update($, rows, list => dropFinishedTrees(list, isRunning))}>
              clear
            </Button>
          )}
        </Box>
        {shown.length === 0 && <Text dimColor>{shownTab === 'active' ? 'Nothing running.' : 'Nothing finished yet.'}</Text>}
        {sections.map(section => (
          <Box key={section.title} flexDirection="column" marginBottom={OUTER_Y}>
            <Button key={`section-${section.kind}`} plain onPress={toggle(section.kind)}>
              <Text dimColor bold>
                {folded[section.kind] ? '▸' : '▾'} {section.title} ({section.rows.length})
              </Text>
            </Button>
            {!folded[section.kind] && section.rows.map(card)}
          </Box>
        ))}
        {windows.length > 0 && <Box flexGrow={1} />}
        {windows.length > 0 && (
          <Box flexDirection="column">
            <Text dimColor>{'─'.repeat(lineColumns)}</Text>
            {windows.map(limitBar)}
          </Box>
        )}
      </Box>
    )
  })
}
