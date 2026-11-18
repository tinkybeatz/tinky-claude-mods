import { expect, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On, ProcessSpawnResult } from 'claude-code'

import type { TryRun } from '../types'
import { markdownBackend } from '../hooks/tickets'
import { IN_ITS_OWN_GROUP, POLL_MS, READY_WAIT_MS, TRY_PORTS, TRY_RECORDS_KEY } from '../hooks/try'
import type { TryRecord } from '../hooks/try'
import { makeWorld, mountWorld, REPO, setUpProject, worldEngine } from './world'
import type { World } from './world'

const WORKTREES = `${REPO}-worktrees`

/**
 * How a pretend start command behaves: what it prints, whether its server listens on its
 * PORT (or on `printedPort`), and how it ends.
 */
type Script = { output?: string[]; isListening?: boolean; printedPort?: number; exit?: ProcessSpawnResult }

/** A child the plugin spawned: its command, folder and PORT, its process group, and whether its stream was ended. */
type Child = { argv: readonly string[]; cwd?: string; port: number; pgid: number; isEnded: boolean }

/** A process on the pretend host. */
type Proc = { ppid: number; pgid: number; cwd: string; listens?: number }

type Options = {
  startCommand?: string
  /** Tickets to file, each with its branch and whether its worktree is on disk. */
  tickets?: { title: string; branch?: string; hasWorktree?: boolean }[]
  /** Ports a process of someone else's listens on before the try. */
  busy?: number[]
  isSetUp?: boolean
  /** What the person's store holds when the session starts. */
  stored?: Record<string, unknown>
}

/** A foreign process's pid: listening on `port`, in its own group, outside every worktree. */
const foreignPid = (port: number) => 90000 + port

/**
 * A set-up project with markdown tickets, and a pretend host: a process table that `ps`,
 * `lsof` and `kill` read and change, and a pretend `$.process.spawn` that runs `script` for
 * each child. A child is a wrapper, the group leader it starts, and a server in that group;
 * ending the child's stream ends the wrapper and the leader but leaves the server running,
 * as a SIGKILLed wrapper would.
 */
const startWorld = async (on: On, options: Options = {}) => {
  const world: World = makeWorld()
  const procs = new Map<number, Proc>()
  for (const port of options.busy ?? []) procs.set(foreignPid(port), { ppid: 1, pgid: foreignPid(port), cwd: '/home/dev/other', listens: port })
  const children: Child[] = []
  const killed: number[] = []
  const logs: string[] = []
  const runs: (TryRun | null)[] = []
  const store = new Map<string, unknown>(Object.entries(options.stored ?? {}))
  const state = { script: { isListening: true } as Script }
  if (options.isSetUp !== false) {
    const answers = { tracker: 'none', ...(options.startCommand === undefined ? {} : { startCommand: options.startCommand }) }
    const dir = await setUpProject(world, { sharedAnswers: answers })
    const tickets = markdownBackend(worldEngine(world), dir)
    for (const ticket of options.tickets ?? []) {
      const header = await tickets.create({ title: ticket.title, ask: ticket.title, visibleChange: true })
      if (ticket.branch !== undefined) await tickets.move(header.id, { branch: ticket.branch })
      if (ticket.hasWorktree === true) world.files.set(`${WORKTREES}/${header.id}/.git`, 'gitdir: x\n')
    }
  }
  const listeningOn = (port: number) => [...procs].filter(([, proc]) => proc.listens === port).map(([pid]) => pid)
  const end = (pid: number) => {
    if (procs.delete(pid)) killed.push(pid)
  }
  world.answer = run => {
    const [program, ...args] = run.argv
    if (program === 'ps') return { exitCode: 0, stdout: [...procs].map(([pid, proc]) => `${pid} ${proc.ppid} ${proc.pgid}`).join('\n') }
    if (program === 'kill') {
      for (const arg of args) {
        if (/^-\d+$/.test(arg)) for (const [pid, proc] of procs) proc.pgid === Number(arg.slice(1)) && end(pid)
        else if (/^\d+$/.test(arg)) end(Number(arg))
      }
      return { exitCode: 0, stdout: '' }
    }
    if (program !== 'lsof') return undefined
    const pidList = args[args.indexOf('-p') + 1]
    if (args.includes('cwd') && pidList !== undefined) {
      const lines = pidList.split(',').flatMap(pid => {
        const proc = procs.get(Number(pid))
        return proc === undefined ? [] : [`p${pid}`, 'fcwd', `n${proc.cwd}`]
      })
      return { exitCode: lines.length === 0 ? 1 : 0, stdout: lines.join('\n') }
    }
    const one = args.find(arg => arg.startsWith('-iTCP:'))
    if (one !== undefined) {
      const pids = listeningOn(Number(one.slice('-iTCP:'.length)))
      return pids.length === 0 ? { exitCode: 1, stdout: '' } : { exitCode: 0, stdout: `${pids.join('\n')}\n` }
    }
    const listening = [...procs].filter(([, proc]) => proc.listens !== undefined)
    if (listening.length === 0) return { exitCode: 1, stdout: '' }
    return { exitCode: 0, stdout: listening.map(([pid, proc]) => `p${pid}\nn*:${String(proc.listens)}`).join('\n') }
  }
  on('state.set', (_$, e, next) => {
    if (e.key === 'tryRun') runs.push(e.value as TryRun | null)
    return next(e)
  })
  on('store.get', (_$, e) => ({ value: store.get(e.key) }))
  on('store.set', (_$, e) => {
    store.set(e.key, e.value)
    return { value: undefined } as never
  })
  on('ui.log', (_$, e) => {
    logs.push(e.text)
    return { value: undefined } as never
  })
  on('process.spawn', async function* (_$, e, next) {
    const port = Number(e.env?.PORT)
    const index = children.length
    const wrapper = 60000 + index
    const pgid = 70000 + index
    const child: Child = { argv: e.argv, cwd: e.cwd, port, pgid, isEnded: false }
    children.push(child)
    const script = state.script
    const cwd = e.cwd ?? REPO
    procs.set(wrapper, { ppid: 1, pgid: 1, cwd })
    procs.set(pgid, { ppid: wrapper, pgid, cwd })
    try {
      yield { stream: 'stderr' as const, text: `godmode-try-pgid=${pgid} wrapper=${wrapper}\n` }
      for (const text of script.output ?? []) yield { stream: 'stdout' as const, text }
      if (script.exit !== undefined) {
        procs.delete(pgid)
        return { value: script.exit } as never
      }
      if (script.isListening === true || script.printedPort !== undefined) procs.set(80000 + index, { ppid: pgid, pgid, cwd, listens: script.printedPort ?? port })
      // A server runs until the plugin ends its stream.
      await new Promise<void>(resolve => next.signal.addEventListener('abort', () => resolve()))
      return { value: { code: null, signal: 'SIGTERM' } } as never
    } finally {
      child.isEnded = true
      procs.delete(wrapper)
      procs.delete(pgid)
      const server = procs.get(80000 + index)
      if (server !== undefined) server.ppid = 1
    }
  })
  const clock = mountWorld(on, world)
  return { world, clock, procs, children, killed, logs, runs, state, store }
}

const godmode = ($: Engine, args: string) => $.command.run({ command: 'godmode', args } as Parameters<typeof $.command.run>[0])

/** Runs `/godmode <args>` while moving the clock on, so the plugin's waits for the app resolve. */
const command = async ($: Engine, clock: MockClock, args: string, steps = READY_WAIT_MS / POLL_MS + 4) => {
  let isDone = false
  const answer = godmode($, args).finally(() => {
    isDone = true
  })
  for (let step = 0; step < steps && !isDone; step += 1) await clock.advance(POLL_MS)
  return answer
}

const BUILT = { title: 'Export menu', branch: 'godmode/t-1-export-menu', hasWorktree: true }

test('/godmode try starts the ticket\'s worktree on a free port and gives the link', async ($, on) => {
  const w = await startWorld(on, { startCommand: 'npm run dev', tickets: [BUILT], busy: [TRY_PORTS.first] })

  const answer = await command($, w.clock, 'try t-1')

  const port = TRY_PORTS.first + 1
  expect(answer.text).toContain(`T-1 runs at http://localhost:${port}`)
  expect(answer.text).toContain('/godmode try stop')
  expect(w.children).toHaveLength(1)
  expect(w.children[0]?.argv).toEqual(['/bin/sh', '-c', IN_ITS_OWN_GROUP, 'godmode-try', 'npm run dev'])
  expect(w.children[0]?.cwd).toBe(`${WORKTREES}/T-1`)
  expect(w.children[0]?.port).toBe(port)
  expect(w.runs.at(-1)).toEqual({ ticket: 'T-1', port, url: `http://localhost:${port}`, command: 'npm run dev', worktree: `${WORKTREES}/T-1` })
})

test('/godmode try gives the link the app printed when it ignores PORT', async ($, on) => {
  const w = await startWorld(on, { startCommand: 'vite', tickets: [BUILT] })
  w.state.script = { output: ['  VITE ready\n  ➜  Local:   http://127.0.0.1:5173/\n'], printedPort: 5173 }

  const answer = await command($, w.clock, 'try T-1')

  expect(answer.text).toContain('T-1 runs at http://localhost:5173/')
})

test('a link the app printed is not taken while only someone else\'s server listens there, and that server is never killed', async ($, on) => {
  const w = await startWorld(on, { startCommand: 'vite', tickets: [BUILT], busy: [5173] })
  w.state.script = { output: ['  ➜  Local:   http://localhost:5173/\n'], isListening: false }

  const answer = await command($, w.clock, 'try T-1')
  await command($, w.clock, 'try stop')

  expect(answer.text).toContain('does not answer yet')
  expect(answer.text).not.toContain('runs at http://localhost:5173')
  expect(w.killed).not.toContain(foreignPid(5173))
  expect(w.procs.has(foreignPid(5173))).toBe(true)
})

test('try stop leaves a process that took the try\'s port alone, and says so', async ($, on) => {
  const w = await startWorld(on, { startCommand: 'npm run dev', tickets: [BUILT] })
  w.state.script = { isListening: false }
  await command($, w.clock, 'try T-1')
  // Something of the person's own took the port the try was given.
  w.procs.set(foreignPid(TRY_PORTS.first), { ppid: 1, pgid: foreignPid(TRY_PORTS.first), cwd: '/home/dev/other', listens: TRY_PORTS.first })
  await w.clock.advance(1_000)
  await w.clock.advance(1_000)

  const answer = await command($, w.clock, 'try stop')

  expect(w.logs.some(line => line.includes('runs at'))).toBe(false)
  expect(answer.text).toContain(`Port ${TRY_PORTS.first} is held by process ${foreignPid(TRY_PORTS.first)}, which godmode did not start`)
  expect(w.killed).not.toContain(foreignPid(TRY_PORTS.first))
  expect(w.procs.has(foreignPid(TRY_PORTS.first))).toBe(true)
})

test('/godmode try stop ends the server its start command left running, and only that', async ($, on) => {
  const w = await startWorld(on, { startCommand: 'cd web && npm run dev', tickets: [BUILT], busy: [3000] })
  await command($, w.clock, 'try T-1')
  const server = 80000

  const answer = await command($, w.clock, 'try stop')

  expect(answer.text).toBe(`Stopped T-1's app (http://localhost:${TRY_PORTS.first}).`)
  expect(w.children[0]?.isEnded).toBe(true)
  expect(w.killed).toContain(server)
  expect(w.procs.has(server)).toBe(false)
  expect(w.procs.has(foreignPid(3000))).toBe(true)
  expect(w.store.get(TRY_RECORDS_KEY)).toEqual([])
  expect(w.runs.at(-1)).toBeNull()
  expect((await command($, w.clock, 'try stop')).text).toBe('Nothing runs from `/godmode try`.')
})

test('a second try stops the first before it starts', async ($, on) => {
  const w = await startWorld(on, { startCommand: 'npm run dev', tickets: [BUILT, { title: 'Import menu', branch: 'godmode/t-2-import-menu', hasWorktree: true }] })
  await command($, w.clock, 'try T-1')

  const answer = await command($, w.clock, 'try T-2')

  expect(answer.text).toContain('Stopped T-1\'s app first.')
  expect(answer.text).toContain('T-2 runs at')
  expect(w.children).toHaveLength(2)
  expect(w.children[0]?.isEnded).toBe(true)
  expect(w.children[1]?.isEnded).toBe(false)
  expect(w.children[1]?.cwd).toBe(`${WORKTREES}/T-2`)
  expect(w.runs.at(-1)?.ticket).toBe('T-2')
})

test('the app stops when the session ends', async ($, on) => {
  const w = await startWorld(on, { startCommand: 'npm run dev', tickets: [BUILT] })
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  await command($, w.clock, 'try T-1')

  await $.session.end({ reason: 'prompt_input_exit', sessionId: 's1' } as Parameters<typeof $.session.end>[0])

  expect(w.children[0]?.isEnded).toBe(true)
  expect(w.runs.at(-1)).toBeNull()
})

test('a start command that fails says so with its last lines, and keeps nothing running', async ($, on) => {
  const w = await startWorld(on, { startCommand: 'npm run dev', tickets: [BUILT] })
  w.state.script = { output: ['> app@1.0.0 dev\n', 'sh: next: command not found\n'], exit: { code: 127, signal: null } }

  const answer = await command($, w.clock, 'try T-1')

  expect(answer.text).toContain('T-1\'s app failed to start')
  expect(answer.text).toContain('exited with code 127')
  expect(answer.text).toContain('sh: next: command not found')
  expect(w.runs.at(-1)).toBeNull()
  expect((await command($, w.clock, 'try stop')).text).toBe('Nothing runs from `/godmode try`.')
})

test('an app whose port is taken says the port is busy', async ($, on) => {
  const w = await startWorld(on, { startCommand: 'python manage.py runserver', tickets: [BUILT] })
  w.state.script = { output: ['Error: That port is already in use.\n'], exit: { code: 1, signal: null } }

  const answer = await command($, w.clock, 'try T-1')

  expect(answer.text).toContain('its port is busy')
  expect(answer.text).toContain('$PORT')
  expect(answer.text).toContain('That port is already in use.')
})

test('no free port in godmode\'s range starts nothing', async ($, on) => {
  const busy = Array.from({ length: TRY_PORTS.count }, (_, index) => TRY_PORTS.first + index)
  const w = await startWorld(on, { startCommand: 'npm run dev', tickets: [BUILT], busy })

  const answer = await command($, w.clock, 'try T-1')

  expect(answer.text).toContain('is busy, so T-1 was not started')
  expect(w.children).toHaveLength(0)
})

test('an app slow to answer is reported when it does', async ($, on) => {
  const w = await startWorld(on, { startCommand: 'npm run dev', tickets: [BUILT] })
  w.state.script = { isListening: false }

  const answer = await command($, w.clock, 'try T-1')
  expect(answer.text).toContain('T-1 is starting at')
  expect(answer.text).toContain('does not answer yet')

  w.procs.set(80000, { ppid: w.children[0]?.pgid ?? 0, pgid: w.children[0]?.pgid ?? 0, cwd: `${WORKTREES}/T-1`, listens: TRY_PORTS.first })
  await w.clock.advance(1_000)
  await w.clock.advance(1_000)

  expect(w.logs.some(line => line.includes(`T-1 runs at http://localhost:${TRY_PORTS.first}`))).toBe(true)
})

test('a running try is recorded in the person\'s store with its process group', async ($, on) => {
  const w = await startWorld(on, { startCommand: 'npm run dev', tickets: [BUILT] })

  await command($, w.clock, 'try T-1')

  const records = w.store.get(TRY_RECORDS_KEY) as TryRecord[]
  expect(records).toHaveLength(1)
  expect(records[0]).toMatchObject({ ticket: 'T-1', port: TRY_PORTS.first, worktree: `${WORKTREES}/T-1`, pgid: 70000, wrapperPid: 60000 })
})

test('a new session stops a try an earlier one left running, and nothing else', async ($, on) => {
  const leftover: TryRecord = { ticket: 'T-1', port: TRY_PORTS.first, worktree: `${WORKTREES}/T-1`, pgid: 71000, wrapperPid: 61000, startedAt: 0 }
  // Another session's try: its wrapper still runs, so that session still owns it.
  const live: TryRecord = { ticket: 'T-2', port: TRY_PORTS.first + 1, worktree: `${WORKTREES}/T-2`, pgid: 72000, wrapperPid: 62000, startedAt: 0 }
  const w = await startWorld(on, { startCommand: 'npm run dev', tickets: [BUILT], stored: { [TRY_RECORDS_KEY]: [leftover, live] } })
  on('command.register', () => ({ value: {} }) as never)
  on('session.start', (_$, e) => e as never)
  // The leftover's server, re-parented once its wrapper died, and a worker the server started.
  w.procs.set(81000, { ppid: 1, pgid: 71000, cwd: `${WORKTREES}/T-1/web`, listens: TRY_PORTS.first })
  w.procs.set(81001, { ppid: 81000, pgid: 71000, cwd: `${WORKTREES}/T-1/web` })
  // A process outside the worktree in that group: the group id may have been reused.
  w.procs.set(81500, { ppid: 1, pgid: 71000, cwd: '/home/dev/other' })
  w.procs.set(62000, { ppid: 1, pgid: 1, cwd: `${WORKTREES}/T-2` })
  w.procs.set(72000, { ppid: 62000, pgid: 72000, cwd: `${WORKTREES}/T-2` })

  await $.session.start({ cwd: REPO } as Parameters<typeof $.session.start>[0])

  expect([...w.killed].sort()).toEqual([81000, 81001])
  expect(w.procs.has(81500)).toBe(true)
  expect(w.procs.has(72000)).toBe(true)
  expect(w.store.get(TRY_RECORDS_KEY)).toEqual([live])
  expect(w.logs.some(line => line.includes('T-1\'s app, which an earlier `/godmode try` left running'))).toBe(true)
})

test('each try that cannot start says why, and starts nothing', async ($, on) => {
  const w = await startWorld(on, {
    startCommand: 'npm run dev',
    tickets: [BUILT, { title: 'Not built' }, { title: 'Merged', branch: 'godmode/t-3-merged' }],
  })

  const unknown = await command($, w.clock, 'try T-9')
  const unbuilt = await command($, w.clock, 'try T-2')
  const merged = await command($, w.clock, 'try T-3')

  expect(unknown.text).toContain('There is no ticket T-9')
  expect(unbuilt.text).toContain('T-2 has no branch or worktree yet')
  expect(merged.text).toContain(`T-3 has no worktree at ${WORKTREES}/T-3`)
  expect(merged.text).toContain('godmode/t-3-merged')
  expect(w.children).toHaveLength(0)
})

test('a project with no start command has nothing to run', async ($, on) => {
  const w = await startWorld(on, { tickets: [BUILT] })

  const answer = await command($, w.clock, 'try T-1')

  expect(answer.text).toContain('nothing to run')
  expect(answer.text).toContain('T-1 was not started')
  expect(w.children).toHaveLength(0)
})

test('a project godmode has not set up has no try', async ($, on) => {
  const w = await startWorld(on, { isSetUp: false })

  const answer = await command($, w.clock, 'try T-1')

  expect(answer.text).toContain('not set up in this project yet')
  expect(w.children).toHaveLength(0)
})
