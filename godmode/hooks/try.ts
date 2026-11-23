import { atom, read, update } from 'claude-code'
import type { EngineInterface, HookStream, ProcessSpawnChunk, ProcessSpawnResult, Timer } from 'claude-code'

import type { TryRun } from '../types'
import { loopContextOf, worktreePathOf } from './loop'
import type { LoopCache, LoopContext } from './loop'
import { commandKey } from './scan'
import { backendFor, normaliseId, TICKET_STATUSES, trackerOf } from './tickets'
import type { TicketHeader } from './tickets'
import { logLines } from './ui-text'
import { endProcesses, groupAndDescendants, listenersOn, processTable, runningInside } from './try-procs'
import type { ProcessRow } from './try-procs'

/*
 * `/godmode try <ticket>` (D49): starts the ticket's worktree with the project's start
 * command on a free port and gives the person the link. One app runs at a time; it stops
 * on `/godmode try stop`, on the next try, and when the session ends. Every helper that
 * takes `$` is a function declaration: the engine follows `$` past an import only into those.
 */

// Made here: `validate` follows a state source only to an atom made in the file that reads it.
const tryRun = atom({ plugin: 'godmode', key: 'tryRun' } as const, null as TryRun | null)

/**
 * The ports godmode hands out, past the usual dev-server defaults (3000, 5173, 8000,
 * 8080), so a try never takes the port the person's own server in the main checkout uses.
 */
export const TRY_PORTS = { first: 4100, count: 100 } as const

/** How long `/godmode try` waits for the app to answer before it says it is still starting. */
export const READY_WAIT_MS = 8_000

/** How often the app is checked while it starts. */
export const POLL_MS = 500

/** How long godmode keeps watching, after the command answered, for an app that is still starting. */
export const LATE_WATCH_MS = 120_000

/** The output kept for a failure's message: its last lines. */
const TAIL_LINES = 12
const KEPT_CHARACTERS = 8_000

/**
 * Runs the start command in a process group of its own, says the group's id and its own
 * pid on stderr, and passes a stop on to the whole group. Stopping the command alone does
 * not end what it started (`npm run dev` runs the server as a child of its own, `cd web &&
 * npm run dev` adds a shell), so godmode ends the group, and only it.
 */
export const IN_ITS_OWN_GROUP = [
  'set -m',
  '/bin/sh -c "$1" &',
  'p=$!',
  'set +m',
  'echo "godmode-try-pgid=$p wrapper=$$" >&2',
  "trap 'kill -TERM -- -$p 2>/dev/null; exit 143' TERM INT HUP",
  'wait $p',
].join('\n')

/** The line the wrapper prints first. */
const GROUP_LINE = /^godmode-try-pgid=(\d+) wrapper=(\d+)\r?\n?/m

/**
 * A try's processes, kept in the person's own store so a later session can stop a try a
 * crash or a reload left running: its process group, the wrapper that owns it, its port
 * and worktree, and when it started.
 */
export type TryRecord = { ticket: string; port: number; worktree: string; pgid: number; wrapperPid: number; startedAt: number }

/** The store key of the tries this person's godmode started; personal, like every `$.store` value. */
export const TRY_RECORDS_KEY = 'tryRuns'

/** What only this load of the module holds: the running child, which a reload kills. */
export type TryHandles = { live?: LiveTry }

type LiveTry = {
  run: TryRun
  stream: HookStream<ProcessSpawnChunk, ProcessSpawnResult>
  output: string
  /** The start command's process group, once the wrapper said it. */
  pgid?: number
  /** A link to the app the output printed, its host made `localhost`. */
  printedUrl?: string
  /** How the child ended, once it has; `failure` when it could not start at all. */
  ended?: { code: number | null; signal: string | null; failure?: string }
  /** Set once the person was told it runs (or still starts), so a later end is reported here. */
  isAnnounced: boolean
  isStopping: boolean
  watch?: Timer
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** A link to the app the output printed: a local address with a port; `0.0.0.0` and `[::1]` read as `localhost`. */
export const printedUrlIn = (output: string) => {
  const found = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):\d{2,5}[^\s'"`)\]]*/i.exec(output.replace(/\u001b\[[0-9;]*m/g, ''))?.[0]
  return found?.replace(/\/\/(?:127\.0\.0\.1|0\.0\.0\.0|\[::1?\])/i, '//localhost')
}

/** Whether the output says the app's port was taken. */
export const saysPortBusy = (output: string) => /EADDRINUSE|address already in use|port \d+ is (?:already )?in use|that port is already in use/i.test(output)

/** The output's last lines, for a message. */
export const lastLines = (output: string, count = TAIL_LINES) =>
  output
    .replace(/\u001b\[[0-9;]*m/g, '')
    .split(/\r?\n/)
    .map(line => line.trimEnd())
    .filter(line => line !== '')
    .slice(-count)
    .join('\n')

const quoted = (output: string) => {
  const tail = lastLines(output)
  return tail === '' ? 'It printed nothing.' : `Its last lines:\n${tail}`
}

/** The ports something listens on, from `lsof -F n`; undefined when `lsof` could not run. */
async function listeningPorts($: EngineInterface): Promise<Set<number> | undefined> {
  // lsof exits 1 when nothing listens, so only a run that could not start says nothing.
  const listed = await $.process.run(['lsof', '-nP', '-iTCP', '-sTCP:LISTEN', '-Fn'], { timeoutMs: 5_000 }).catch(() => undefined)
  if (listed === undefined) return undefined
  const ports = new Set<number>()
  for (const line of listed.stdout.split('\n')) {
    const port = /^n.*:(\d+)$/.exec(line.trim())?.[1]
    if (port !== undefined) ports.add(Number(port))
  }
  return ports
}

/** The first free port of godmode's range; undefined when all are taken. An `lsof` that cannot run reads as all free. */
async function freePort($: EngineInterface) {
  const taken = (await listeningPorts($)) ?? new Set<number>()
  for (let port = TRY_PORTS.first; port < TRY_PORTS.first + TRY_PORTS.count; port += 1) if (!taken.has(port)) return port
  return undefined
}

const isTryRecord = (value: unknown): value is TryRecord => {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.ticket === 'string' && typeof record.worktree === 'string' && ['port', 'pgid', 'wrapperPid', 'startedAt'].every(key => typeof record[key] === 'number')
}

async function readTryRecords($: EngineInterface): Promise<TryRecord[]> {
  const value: unknown = await $.store.get(TRY_RECORDS_KEY).catch(() => undefined)
  return Array.isArray(value) ? value.filter(isTryRecord) : []
}

async function keepTryRecords($: EngineInterface, change: (records: TryRecord[]) => TryRecord[]) {
  await $.store.set(TRY_RECORDS_KEY, change(await readTryRecords($))).catch(() => undefined)
}

/** The ports a try's app may hold: the one godmode gave it, and the one its output printed. */
const portsOf = (run: TryRun) => {
  const printed = Number(/:(\d+)/.exec(run.url.replace(/^https?:\/\//, ''))?.[1])
  return [...new Set([run.port, ...(Number.isInteger(printed) ? [printed] : [])])]
}

/**
 * Whether something of the try's listens on `port`: a process of its group or descending
 * from one, or one running inside its worktree. Undefined when `lsof` could not run.
 */
async function hasOwnListener($: EngineInterface, live: LiveTry, port: number) {
  const listeners = await listenersOn($, port)
  if (listeners === undefined) return undefined
  if (listeners.length === 0) return false
  const table = live.pgid === undefined ? undefined : await processTable($)
  const group = table === undefined || live.pgid === undefined ? new Set<number>() : groupAndDescendants(table, live.pgid)
  if (listeners.some(pid => group.has(pid))) return true
  return (await runningInside($, listeners, live.run.worktree)).length > 0
}

/**
 * Ends a try's processes and nothing else: its group and their descendants, and the
 * listeners on its ports that belong to it. A record a past load left (`isLeftover`) is
 * checked harder, since its group id could have been reused: each process must also run
 * inside the ticket's worktree. Resolves what still holds the try's ports, and is not its.
 */
async function endTryProcesses($: EngineInterface, run: TryRun, pgid: number | undefined, isLeftover: boolean) {
  const table: ProcessRow[] | undefined = await processTable($)
  const group = table === undefined || pgid === undefined ? new Set<number>() : groupAndDescendants(table, pgid)
  if (table === undefined && pgid !== undefined && !isLeftover) {
    // No process table: the group this load started is still the try's own.
    await $.process.run(['kill', '-TERM', '--', `-${pgid}`], { timeoutMs: 5_000 }).catch(() => undefined)
  }
  const ports = portsOf(run)
  const listeners = new Map<number, number[]>()
  for (const port of ports) listeners.set(port, (await listenersOn($, port)) ?? [])
  const candidates = [...new Set([...group, ...[...listeners.values()].flat()])]
  const inside = new Set(await runningInside($, candidates, run.worktree))
  const isOwn = (pid: number) => inside.has(pid) || (!isLeftover && group.has(pid))
  const ended = await endProcesses($, candidates.filter(isOwn))
  const foreign = [...listeners].flatMap(([port, pids]) => pids.filter(pid => !isOwn(pid)).map(pid => ({ port, pid })))
  return { ended, foreign }
}

const foreignLine = (foreign: readonly { port: number; pid: number }[]) =>
  foreign.length === 0
    ? undefined
    : `${foreign.map(({ port, pid }) => `Port ${port} is held by process ${pid}`).join('; ')}, which godmode did not start, so it left ${foreign.length === 1 ? 'it' : 'them'} running.`

/** Reads the child's output into `live` until it ends; an end nobody asked for is reported once the person was told it runs. */
function readOutput($: EngineInterface, handles: TryHandles, live: LiveTry) {
  void (async () => {
    try {
      for (;;) {
        const piece = await live.stream.next()
        if (piece.done === true) {
          live.ended = { code: piece.value.code, signal: piece.value.signal }
          break
        }
        live.output = (live.output + piece.value.text).slice(-KEPT_CHARACTERS)
        if (live.pgid === undefined) await takeGroupLine($, live)
        live.printedUrl ??= printedUrlIn(live.output)
      }
    } catch (error) {
      live.ended = { code: null, signal: null, failure: messageOf(error) }
    }
    if (live.isStopping || !live.isAnnounced) return
    live.watch?.cancel()
    if (handles.live === live) handles.live = undefined
    await update($, tryRun, current => (current?.ticket === live.run.ticket && current.port === live.run.port ? null : current))
    await endTryProcesses($, live.run, live.pgid, false)
    await forgetTryRecord($, live.pgid)
    logLines($, endedLine(live, false))
  })().catch(() => undefined)
}

/** Reads the wrapper's first line out of the output, and records the try's group in the store. */
async function takeGroupLine($: EngineInterface, live: LiveTry) {
  const found = GROUP_LINE.exec(live.output)
  if (found === null) return
  const pgid = Number(found[1])
  live.pgid = pgid
  live.output = live.output.replace(GROUP_LINE, '')
  const record: TryRecord = { ticket: live.run.ticket, port: live.run.port, worktree: live.run.worktree, pgid, wrapperPid: Number(found[2]), startedAt: await $.clock.now() }
  await keepTryRecords($, records => [...records.filter(entry => entry.pgid !== pgid), record])
}

async function forgetTryRecord($: EngineInterface, pgid: number | undefined) {
  if (pgid !== undefined) await keepTryRecords($, records => records.filter(entry => entry.pgid !== pgid))
}

/** How the child ended, in words. */
const howItEnded = (ended: LiveTry['ended']) => {
  if (ended?.failure !== undefined) return `could not run (${ended.failure})`
  if (ended?.signal !== null && ended?.signal !== undefined) return `was ended by ${ended.signal}`
  return `exited with code ${String(ended?.code ?? 'unknown')}`
}

/** Why the app ended, with its last lines: before it answered (`isStarting`), or later, on its own. */
const endedLine = (live: LiveTry, isStarting: boolean) => {
  const { run } = live
  if (saysPortBusy(live.output)) return portBusyLine(run, live.output)
  const what = isStarting ? 'failed to start' : 'stopped on its own'
  return `${run.ticket}'s app ${what}: \`${run.command}\` in ${run.worktree} ${howItEnded(live.ended)}. ${quoted(live.output)}`
}

const portBusyLine = (run: TryRun, output: string) =>
  `${run.ticket}'s app could not start: its port is busy. godmode gave it port ${run.port} in the PORT variable; a start command that ignores PORT uses its own port, which something else holds. Make the start command read $PORT (\`/godmode setup\`), or stop what holds the port. ${quoted(output)}`

/**
 * The link the app answers on: the port godmode gave it, or else a link the output printed
 * (a start command that ignores PORT prints its own), once a process of the try's listens
 * there. Something else on that port is not the try's app. With no `lsof` to ask, the
 * printed link stands on its own.
 */
async function answeringUrl($: EngineInterface, live: LiveTry) {
  if ((await hasOwnListener($, live, live.run.port)) === true) return `http://localhost:${live.run.port}`
  const printed = live.printedUrl
  if (printed === undefined) return undefined
  const port = Number(/:(\d+)/.exec(printed.replace(/^https?:\/\//, ''))?.[1])
  if (!Number.isInteger(port)) return printed
  const isOwn = await hasOwnListener($, live, port)
  return isOwn === false ? undefined : printed
}

/** Records the link the app answers on. */
async function markAnswering($: EngineInterface, live: LiveTry, url: string) {
  live.run = { ...live.run, url }
  await update($, tryRun, () => live.run)
}

const runningLine = (run: TryRun) =>
  `${run.ticket} runs at ${run.url} (\`${run.command}\` in ${run.worktree}). Stop it with \`/godmode try stop\`; it also stops with the next try and when the session ends.`

/** After the command answered "still starting": says here when the app answers, or that it has not yet. */
function watchLate($: EngineInterface, live: LiveTry) {
  let waited = 0
  let isChecking = false
  live.watch = $.clock.every(1_000, () => {
    if (isChecking) return
    isChecking = true
    void (async () => {
      waited += 1_000
      if (live.ended !== undefined || live.isStopping) {
        live.watch?.cancel()
        return
      }
      const url = await answeringUrl($, live)
      if (url !== undefined) {
        live.watch?.cancel()
        await markAnswering($, live, url)
        logLines($, runningLine(live.run))
      } else if (waited >= LATE_WATCH_MS) {
        live.watch?.cancel()
        logLines(
          $,
          `${live.run.ticket}'s app still does not answer on port ${live.run.port} after ${Math.round((READY_WAIT_MS + LATE_WATCH_MS) / 1000)} seconds; it keeps running until \`/godmode try stop\`. ${quoted(live.output)}`,
        )
      }
    })()
      .catch(() => undefined)
      .finally(() => {
        isChecking = false
      })
  })
}

/**
 * Stops the app a try started: its process group and what descends from it, and the
 * listeners on its ports that are its own. Resolves the run it stopped (undefined when none
 * was running), and a line naming what holds its port and is not its own.
 */
export async function stopTry($: EngineInterface, handles: TryHandles): Promise<{ run?: TryRun; left?: string }> {
  const live = handles.live
  handles.live = undefined
  const run = live?.run ?? (await read($, tryRun)) ?? undefined
  if (live !== undefined) {
    live.isStopping = true
    live.watch?.cancel()
    // Ending the stream kills the child; a pull still in flight must not hold the stop up.
    void live.stream.return({ code: null, signal: 'SIGTERM' }).catch(() => undefined)
  }
  let left: string | undefined
  if (run !== undefined && live !== undefined) {
    left = foreignLine((await endTryProcesses($, run, live.pgid, false)).foreign)
    await forgetTryRecord($, live.pgid)
  }
  await update($, tryRun, () => null)
  return { run, left }
}

/**
 * After a reload or in a new session: a try the old copy of the module (or a session that
 * crashed) started may still run, with no stream left to end it. Each recorded try whose
 * wrapper is gone has its processes ended, the ones tied to it by group and worktree; one
 * whose wrapper still runs belongs to a live session and is left alone.
 */
export async function forgetStaleTry($: EngineInterface, handles: TryHandles) {
  if (handles.live === undefined && (await read($, tryRun)) !== null) await update($, tryRun, () => null)
  const records = await readTryRecords($)
  if (records.length === 0) return
  const table = await processTable($)
  // Without the process table nothing can be tied to a try: keep the records for later.
  if (table === undefined) return
  const done: number[] = []
  for (const record of records) {
    if (record.pgid === handles.live?.pgid) continue
    const leader = table.find(row => row.pid === record.pgid)
    if (leader !== undefined && leader.ppid === record.wrapperPid) continue
    const run: TryRun = { ticket: record.ticket, port: record.port, url: `http://localhost:${record.port}`, command: '', worktree: record.worktree }
    const { ended } = await endTryProcesses($, run, record.pgid, true)
    done.push(record.pgid)
    if (ended.length > 0) $.ui.log(`godmode stopped ${record.ticket}'s app, which an earlier \`/godmode try\` left running in ${record.worktree} (process ${ended.join(', ')}).`)
  }
  if (done.length > 0) await keepTryRecords($, kept => kept.filter(entry => !done.includes(entry.pgid)))
}

/** The ticket the person named, or the line that says why there is nothing to start. */
async function ticketToTry($: EngineInterface, context: LoopContext, named: string): Promise<{ ticket: TicketHeader } | { line: string }> {
  let tickets: TicketHeader[]
  let isMarkdown = false
  try {
    const backend = backendFor($, trackerOf(context.note.shared.answers), context.note.dir, context.answers)
    isMarkdown = backend.tracker === 'none'
    tickets = await backend.list({ statuses: TICKET_STATUSES })
  } catch (error) {
    return { line: `godmode could not read the tickets to find ${named}: ${messageOf(error)}` }
  }
  const id = (isMarkdown ? normaliseId(named) : undefined) ?? named.trim().toUpperCase()
  const ticket = tickets.find(header => header.id.toUpperCase() === id)
  if (ticket === undefined) return { line: `There is no ticket ${named}. Name one from the ticket list, e.g. \`/godmode try T-3\`.` }
  return { ticket }
}

/** `/godmode try <ticket>` (D49): the answer for the person. */
export async function startTry($: EngineInterface, cache: LoopCache, handles: TryHandles, named: string, signal?: AbortSignal) {
  const context = await loopContextOf($, cache)
  if (context === undefined) return 'godmode is not set up in this project yet, so it has no start command and no tickets. Run `/godmode` first.'
  const found = await ticketToTry($, context, named)
  if ('line' in found) return found.line
  const { ticket } = found
  const command = context.answers[commandKey('start')]
  if (typeof command !== 'string' || command.trim() === '') {
    return `This project has nothing to run: godmode's setup recorded no start command, so ${ticket.id} was not started. To add one, \`/godmode setup\`.`
  }
  const worktree = worktreePathOf(context.project, context.settings, ticket.id)
  if (!(await $.fs.exists(worktree))) {
    if (ticket.branch === undefined) return `${ticket.id} has no branch or worktree yet: no dev agent has built it, so there is nothing to try.`
    return `${ticket.id} has no worktree at ${worktree} (gone after a merge, or never made here). Its branch is \`${ticket.branch}\`: check it out to try it, or dispatch the ticket again.`
  }

  const replaced = await stopTry($, handles)
  const before = replaced.run === undefined ? '' : `Stopped ${replaced.run.ticket}'s app first. ${replaced.left === undefined ? '' : `${replaced.left} `}`
  const port = await freePort($)
  if (port === undefined) {
    return `${before}Every port from ${TRY_PORTS.first} to ${TRY_PORTS.first + TRY_PORTS.count - 1} is busy, so ${ticket.id} was not started. Stop a server you no longer need, then try again.`
  }
  const run: TryRun = { ticket: ticket.id, port, url: `http://localhost:${port}`, command: command.trim(), worktree }
  const live: LiveTry = {
    run,
    // A shell, so the command runs as the person would type it, `$PORT` included, in a group of its own.
    stream: $.process.spawn({ argv: ['/bin/sh', '-c', IN_ITS_OWN_GROUP, 'godmode-try', run.command], cwd: worktree, env: { PORT: String(port) } }),
    output: '',
    isAnnounced: false,
    isStopping: false,
  }
  handles.live = live
  await update($, tryRun, () => run)
  readOutput($, handles, live)

  for (let waited = 0; ; waited += POLL_MS) {
    if (live.ended !== undefined) {
      handles.live = undefined
      await update($, tryRun, () => null)
      await forgetTryRecord($, live.pgid)
      return `${before}${endedLine(live, true)}`
    }
    const url = await answeringUrl($, live)
    if (url !== undefined) {
      live.isAnnounced = true
      await markAnswering($, live, url)
      return `${before}${runningLine(live.run)}`
    }
    if (waited >= READY_WAIT_MS) break
    try {
      await $.clock.sleep(POLL_MS, { signal })
    } catch {
      await stopTry($, handles)
      return `${before}The try was interrupted, so ${ticket.id}'s app was stopped.`
    }
  }
  live.isAnnounced = true
  watchLate($, live)
  return `${before}${ticket.id} is starting at ${run.url} (\`${run.command}\` in ${worktree}) and does not answer yet; godmode says here when it does. Stop it with \`/godmode try stop\`.`
}

/** `/godmode try stop`: the answer for the person. */
export async function stopTryCommand($: EngineInterface, handles: TryHandles) {
  const { run, left } = await stopTry($, handles)
  if (run === undefined) return 'Nothing runs from `/godmode try`.'
  return `Stopped ${run.ticket}'s app (${run.url}).${left === undefined ? '' : ` ${left}`}`
}
