import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Dispatch, DispatchTab } from '../types'
import { THINKING, describeAction } from './actions'
import { ACTIVITY_LABELS, FAILED_MARK_COLOR, activityColor } from './kinds'

const PANE = 'dispatches'
const TITLE = 'Dispatched'
const MAX_ROWS = 50
const OUTER_X = 2
const OUTER_Y = 1
const INNER_X = 1
const ROW_GAP = 0
const ACTION_BACKGROUND = '#3a3a3a'
const WIDTH_SHARE = 2 / 3
const MIN_COLUMNS = 24
const COLUMNS_KEY = 'columns'
const ENDED = new Set(['completed', 'failed', 'killed', 'done'])

const dispatches = atom({ plugin: 'dispatch-panel', key: 'dispatches' } as const, [])
const now = atom({ plugin: 'dispatch-panel', key: 'now' } as const, 0)
const tab = atom({ plugin: 'dispatch-panel', key: 'tab' } as const, 'active' as DispatchTab)
const isSized = atom({ plugin: 'dispatch-panel', key: 'isSized' } as const, false)

/** The docked pane's width as last drawn; the render hook records it, since no `$` call reports it. */
let measuredColumns: number | undefined

const isRunning = (row: Dispatch) => !ENDED.has(row.status)

/** A task-notification row's id and status, in the order the engine writes them. */
const TASK_NOTIFICATION = /<task-id>([^<]+)<\/task-id>[\s\S]*?<status>([^<]+)<\/status>/g
/** The panel's status for each status a task notification reports. */
const NOTIFIED_STATUS: Readonly<Record<string, string>> = { completed: 'done', failed: 'failed', killed: 'killed' }

const firstLine = (text: string) => text.split('\n')[0]?.trim() ?? ''

const upsert = ($: EngineInterface, id: string, patch: (row: Dispatch | undefined) => Dispatch | undefined) =>
  update($, dispatches, list => {
    const rows = list ?? []
    const found = rows.find(row => row.id === id)
    const next = patch(found)
    if (next === undefined) return rows
    if (found === undefined) return [...rows, next].slice(-MAX_ROWS)
    return rows.map(row => (row.id === id ? next : row))
  })

const formatCount = (count: number) => {
  if (count < 1000) return `${count}`
  if (count < 1_000_000) return `${(count / 1000).toFixed(1)}k`
  return `${(count / 1_000_000).toFixed(2)}M`
}

const storedColumns = async ($: EngineInterface) => {
  const stored = await $.store.get(COLUMNS_KEY)
  return typeof stored === 'number' ? stored : undefined
}

const openPane = async ($: EngineInterface) => {
  const columns = await storedColumns($)
  return $.ui.open({ id: PANE, title: TITLE, ...(columns === undefined ? {} : { columns }) })
}

/**
 * Narrows the dock once per session to the remembered width, or to two thirds of the
 * width it was first drawn at, and remembers that width for later sessions.
 * The dock treats it as a request: a width the person dragged the dock to wins.
 */
const fitWidth = async ($: EngineInterface) => {
  if (measuredColumns === undefined || (await read($, isSized)) === true) return
  const panes = await $.ui.panes()
  if (!panes.some(pane => pane.id === PANE && pane.isPlaced)) return
  const columns = (await storedColumns($)) ?? Math.max(MIN_COLUMNS, Math.round(measuredColumns * WIDTH_SHARE))
  await $.store.set(COLUMNS_KEY, columns)
  await update($, isSized, () => true)
  await $.ui.open({ id: PANE, title: TITLE, columns })
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

const statusMark = (status: string) => {
  if (status === 'failed') return '✗'
  if (status === 'killed') return '■'
  if (ENDED.has(status)) return '✓'
  return '●'
}

/** Reconciles tracked agents with the engine's own list, and finds any the spawn hook missed. */
const syncAgents = async ($: EngineInterface, at: number) => {
  const agents = await $.agent.list()
  for (const agent of agents) {
    await upsert($, agent.id, row => {
      if (row === undefined) {
        if (ENDED.has(agent.status)) return undefined
        return {
          id: agent.id,
          kind: 'agent',
          label: agent.type,
          purpose: agent.description,
          status: agent.status,
          startedAt: at,
        }
      }
      if (row.status === agent.status) return undefined
      const hasEnded = ENDED.has(agent.status)
      return {
        ...row,
        status: agent.status,
        endedAt: hasEnded ? (row.endedAt ?? at) : undefined,
      }
    })
  }
  // An agent the engine no longer lists is over, whatever its row last said:
  // without this, a row whose final status was never seen stays active forever.
  const listed = new Set(agents.map(agent => agent.id))
  await update($, dispatches, list =>
    (list ?? []).map(row =>
      row.kind === 'agent' && isRunning(row) && !listed.has(row.id) ? { ...row, status: 'done', endedAt: at } : row,
    ),
  )
}

/**
 * Classifies one agent's activity per tick, outside any hook's dispatch, so a slow
 * model call never holds up a spawn. A failed call settles on 'something else'.
 */
const classifyNext = async ($: EngineInterface) => {
  const list = (await read($, dispatches)) ?? []
  const row = list.find(one => one.kind === 'agent' && one.isClassified !== true)
  if (row === undefined) return
  await upsert($, row.id, found => (found === undefined ? undefined : { ...found, isClassified: true }))
  const text = [`agent type: ${row.label}`, `task: ${row.purpose}`, row.brief ? `prompt: ${row.brief}` : '']
    .filter(Boolean)
    .join('\n')
  let activity: string | undefined
  try {
    activity = await $.model.classify(text, ACTIVITY_LABELS)
  } catch {
    activity = undefined
  }
  await upsert($, row.id, found =>
    found === undefined ? undefined : { ...found, activity: activity ?? 'something else' },
  )
}

const tick = async ($: EngineInterface) => {
  const at = await $.clock.now()
  await syncAgents($, at)
  await classifyNext($)
  await fitWidth($)
  const list = (await read($, dispatches)) ?? []
  if (list.some(isRunning)) await update($, now, () => at)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'dispatches',
      description:
        'Show dispatched agents and shells in a side panel (`active`, `finished`, `clear` to drop finished rows, `clear all` to drop every row, `width <columns>` to resize)',
      argumentHint: '[active|finished|clear|clear all|width <columns>]',
    })
    const startedAt = await $.clock.now()
    await update($, now, () => startedAt)
    $.clock.every(1000, () => void tick($))
    void openPane($)

    return next(e)
  })

  on('command.run', { command: 'dispatches' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'active' || arg === 'finished') {
      await update($, tab, () => arg)
      await openPane($)
      return { text: `Dispatch panel opened on ${arg}.` }
    }
    const width = /^width\s+(\d+)$/.exec(arg)
    if (width?.[1] !== undefined) {
      const columns = Math.max(MIN_COLUMNS, Number(width[1]))
      await $.store.set(COLUMNS_KEY, columns)
      await update($, isSized, () => true)
      await $.ui.open({ id: PANE, title: TITLE, columns })
      return { text: `Dispatch panel width set to ${columns} columns.` }
    }
    if (arg === 'clear all') {
      await update($, dispatches, () => [])
      return { text: 'Cleared every dispatch, active ones included.' }
    }
    if (arg === 'clear') {
      await update($, dispatches, list => (list ?? []).filter(isRunning))
      return { text: 'Cleared finished dispatches.' }
    }
    await openPane($)
    return { text: 'Dispatch panel opened.' }
  })

  on('agent.spawn', async ($, e, next) => {
    const startedAt = await $.clock.now()
    const spawned = await next(e)
    if (spawned.agentId !== undefined) {
      const agentId = spawned.agentId
      await upsert($, agentId, row => ({
        id: agentId,
        kind: 'agent',
        label: e.subagentType || 'agent',
        purpose: e.description || firstLine(e.prompt),
        brief: e.prompt.slice(0, 600),
        activity: row?.activity,
        isClassified: row?.isClassified,
        action: row?.action ?? 'starting',
        status: row?.status ?? 'running',
        startedAt: row?.startedAt ?? startedAt,
        endedAt: row?.endedAt,
        inputTokens: row?.inputTokens,
        outputTokens: row?.outputTokens,
      }))
    }
    return spawned
  })

  on('turn.step', async function* ($, e, next) {
    const step = yield* next(e)
    const agentId = e.agentId
    const usage = step.usage
    if (agentId !== undefined && usage !== null) {
      const inputTokens = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
      await upsert($, agentId, row =>
        row === undefined
          ? undefined
          : { ...row, inputTokens, outputTokens: (row.outputTokens ?? 0) + usage.output_tokens },
      )
    }
    return step
  })

  /** Each tool call an agent makes is its current action, until the call ends and it thinks again. */
  on('tool.call', async ($, e, next) => {
    const agentId = e.agentId
    if (agentId === undefined) return next(e)
    const action = describeAction(String(e.tool), e as unknown as Record<string, unknown>)
    const setAction = (label: string) =>
      upsert($, agentId, row => (row === undefined || !isRunning(row) ? undefined : { ...row, action: label }))
    await setAction(action)
    const ran = await next(e)
    await setAction(THINKING)
    return ran
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (e.tool !== 'Bash') return next(e)
    const startedAt = await $.clock.now()
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError) return ran
    const taskId = ran.result.backgroundTaskId
    if (taskId !== undefined) {
      const purpose = e.description || firstLine(e.command)
      await upsert($, taskId, row =>
        row ?? { id: taskId, kind: 'shell', label: 'bash', purpose, status: 'running', startedAt },
      )
    }
    return ran
  })

  on('tool.call', { tool: 'TaskStop' }, async ($, e, next) => {
    if (e.tool !== 'TaskStop') return next(e)
    const ran = await next(e)
    const taskId = e.task_id ?? e.shell_id
    if (taskId !== undefined && ran.deny === undefined && !ran.isError) {
      const at = await $.clock.now()
      await upsert($, taskId, row =>
        row === undefined || !isRunning(row) ? undefined : { ...row, status: 'killed', endedAt: at },
      )
    }
    return ran
  })

  /**
   * Every finished background task writes a notification row into its owner's
   * conversation, a subagent's included, carrying the task's id and final status.
   * It is the one signal that reaches the panel for a shell a subagent started.
   */
  on('session.append', async ($, e, next) => {
    const appended = await next(e)
    const raw = JSON.stringify(e.message.content)
    if (!raw.includes('<task-notification>')) return appended
    const at = await $.clock.now()
    for (const match of raw.matchAll(TASK_NOTIFICATION)) {
      const [, id, status] = match
      if (id === undefined || status === undefined) continue
      const ended = NOTIFIED_STATUS[status] ?? 'done'
      await upsert($, id, row =>
        row === undefined || (!isRunning(row) && row.status !== 'done')
          ? undefined
          : { ...row, status: ended, endedAt: row.endedAt ?? at },
      )
    }
    return appended
  })

  /** At each stop the engine lists the background work still in flight: any shell missing from it has finished. */
  on('classic.Stop', async ($, e, next) => {
    const inFlight = e.background_tasks ?? []
    const at = await $.clock.now()
    const liveShells = new Set(inFlight.filter(task => task.type === 'shell').map(task => task.id))
    await update($, dispatches, list =>
      (list ?? []).map(row =>
        row.kind === 'shell' && isRunning(row) && !liveShells.has(row.id)
          ? { ...row, status: 'done', endedAt: at }
          : row,
      ),
    )
    for (const task of inFlight) {
      if (task.type !== 'shell') continue
      await upsert($, task.id, row =>
        row ?? {
          id: task.id,
          kind: 'shell',
          label: 'bash',
          purpose: task.description || firstLine(task.command ?? ''),
          status: 'running',
          startedAt: at,
        },
      )
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const list = (await read($, dispatches)) ?? []
    const at = (await read($, now)) ?? 0
    const shownTab = (await read($, tab)) ?? 'active'
    const width = Math.max(10, e.props.bodyColumns)
    // The card's inside: the panel's width less its side padding, the card's border and its padding.
    const stripColumns = Math.max(4, width - 2 * OUTER_X - 2 - 2 * INNER_X)
    if (e.props.placement === 'dock') measuredColumns = e.props.bodyColumns
    const active = list.filter(isRunning)
    const finished = list.filter(row => !isRunning(row)).reverse()
    const shown = shownTab === 'active' ? active : finished
    const showTab = (next: DispatchTab) => () => void update($, tab, () => next)

    // Terminal spacing is in cells, not pixels: a cell is about 10px wide and 20px tall,
    // so OUTER (about 20px) is 2 columns or 1 row, and INNER (about 10px) is 1 column.
    // Half a row does not exist, so the gap between rows (about 10px asked) is 0 rows.
    return (
      <Box flexDirection="column" width={width} paddingX={OUTER_X} paddingY={OUTER_Y}>
        <Box flexDirection="row" gap={OUTER_X} marginBottom={OUTER_Y}>
          <Button
            key="tab-active"
            hotkey="a"
            variant={shownTab === 'active' ? 'primary' : 'secondary'}
            onPress={showTab('active')}
          >
            Active ({active.length})
          </Button>
          <Button
            key="tab-finished"
            hotkey="f"
            variant={shownTab === 'finished' ? 'primary' : 'secondary'}
            onPress={showTab('finished')}
          >
            Finished ({finished.length})
          </Button>
          {shownTab === 'finished' && finished.length > 0 && (
            <Button key="clear" plain dimColor onPress={() => void update($, dispatches, rows => (rows ?? []).filter(isRunning))}>
              clear
            </Button>
          )}
        </Box>
        {shown.length === 0 && (
          <Text dimColor>{shownTab === 'active' ? 'Nothing running.' : 'Nothing finished yet.'}</Text>
        )}
        {shown.map(row => {
          const running = isRunning(row)
          const elapsed = (row.endedAt ?? Math.max(at, row.startedAt)) - row.startedAt
          const color = activityColor(row)
          const markColor = row.status === 'failed' ? FAILED_MARK_COLOR : color
          return (
            <Box
              key={row.id}
              flexDirection="column"
              borderStyle="round"
              borderColor={color}
              borderDimColor={!running}
              paddingX={INNER_X}
              marginBottom={ROW_GAP}
            >
              <Box flexDirection="row" justifyContent="space-between">
                <Text wrap="truncate-end" dimColor={!running}>
                  <Text color={markColor}>{statusMark(row.status)}</Text>{' '}
                  <Text color={color} bold={running}>
                    {row.label}
                  </Text>
                </Text>
                <Text dimColor={!running}>{formatDuration(elapsed)}</Text>
              </Box>
              <Text dimColor italic wrap="truncate-end">
                {row.purpose}
              </Text>
              {row.kind === 'agent' && (
                <Text dimColor wrap="truncate-end">
                  in {formatCount(row.inputTokens ?? 0)} · out {formatCount(row.outputTokens ?? 0)}
                </Text>
              )}
              {row.kind === 'agent' && running && row.action !== undefined && (
                // A row cannot be split, so the strip's top and bottom edges are half blocks:
                // they read as half a row of space above and below a slightly taller strip.
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
        })}
      </Box>
    )
  })
}
