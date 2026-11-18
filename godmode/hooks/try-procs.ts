import type { EngineInterface } from 'claude-code'

/*
 * Which processes a `/godmode try` started, read from the host's process table. A try's
 * start command runs in a process group of its own (`try.ts`), so its app is every process
 * in that group and every process descending from one. godmode stops only those, and takes
 * a listener for the try's app only when it is one of them or runs inside the ticket's
 * worktree: never a process it cannot tie to the try. Every helper that takes `$` is a
 * function declaration: the engine follows `$` past an import only into those.
 */

/** One row of the process table. */
export type ProcessRow = { pid: number; ppid: number; pgid: number }

const TIMEOUT_MS = 5_000

const pidsIn = (text: string) =>
  text
    .split(/\s+/)
    .filter(word => /^\d+$/.test(word))
    .map(Number)

/** The process table, from `ps`; undefined when it could not be read. */
export async function processTable($: EngineInterface): Promise<ProcessRow[] | undefined> {
  const listed = await $.process.run(['ps', '-A', '-o', 'pid=,ppid=,pgid='], { timeoutMs: TIMEOUT_MS }).catch(() => undefined)
  if (listed === undefined || listed.exitCode !== 0) return undefined
  const rows: ProcessRow[] = []
  for (const line of listed.stdout.split('\n')) {
    const [pid, ppid, pgid] = pidsIn(line)
    if (pid !== undefined && ppid !== undefined && pgid !== undefined) rows.push({ pid, ppid, pgid })
  }
  return rows
}

/** The processes of group `pgid` and every process descending from one of them. */
export const groupAndDescendants = (table: readonly ProcessRow[], pgid: number) => {
  const found = new Set(table.filter(row => row.pgid === pgid).map(row => row.pid))
  for (let grew = true; grew; ) {
    grew = false
    for (const row of table) {
      if (!found.has(row.pid) && found.has(row.ppid)) {
        found.add(row.pid)
        grew = true
      }
    }
  }
  return found
}

/** The processes listening on a TCP port; undefined when `lsof` could not run. */
export async function listenersOn($: EngineInterface, port: number): Promise<number[] | undefined> {
  // lsof exits 1 when nothing listens, so only a run that could not start says nothing.
  const listed = await $.process.run(['lsof', '-nP', '-t', `-iTCP:${port}`, '-sTCP:LISTEN'], { timeoutMs: TIMEOUT_MS }).catch(() => undefined)
  return listed === undefined ? undefined : pidsIn(listed.stdout)
}

/** Each process's working directory, from `lsof`; a process it could not read is absent. */
export async function workingDirectories($: EngineInterface, pids: readonly number[]): Promise<Map<number, string>> {
  const found = new Map<number, string>()
  if (pids.length === 0) return found
  const listed = await $.process.run(['lsof', '-a', '-d', 'cwd', '-Fpn', '-p', pids.join(',')], { timeoutMs: TIMEOUT_MS }).catch(() => undefined)
  let pid: number | undefined
  for (const line of (listed?.stdout ?? '').split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1))
    else if (line.startsWith('n') && pid !== undefined) found.set(pid, line.slice(1))
  }
  return found
}

const isInsideFolder = (path: string, folder: string) => {
  const root = folder.replace(/\/+$/, '')
  return path === root || path.startsWith(`${root}/`)
}

/** The pids among `pids` whose working directory is inside `folder`. */
export async function runningInside($: EngineInterface, pids: readonly number[], folder: string) {
  const directories = await workingDirectories($, pids)
  return pids.filter(pid => {
    const directory = directories.get(pid)
    return directory !== undefined && isInsideFolder(directory, folder)
  })
}

/** Ends processes by pid with SIGTERM; never a pid that is not a positive number. */
export async function endProcesses($: EngineInterface, pids: Iterable<number>) {
  const list = [...new Set(pids)].filter(pid => Number.isInteger(pid) && pid > 1)
  if (list.length > 0) await $.process.run(['kill', '-TERM', ...list.map(String)], { timeoutMs: TIMEOUT_MS }).catch(() => undefined)
  return list
}
