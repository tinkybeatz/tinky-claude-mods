import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { DispatchedAgent, GodmodeMode, SetupRun, SetupScope } from '../types'
import { closeGodmodePane } from './pane'
import { readNote } from './storage'

/*
 * Switching godmode off, from wherever it happens (0.8.3): `/godmode off`, the person closing
 * the side pane, a setup that did not finish, or a note that is gone. godmode never stays on
 * where its tools cannot work: off, it injects no role, no instructions and no per-prompt
 * check, and its pane and indicator are gone. Every helper that takes `$` is a function
 * declaration.
 */

// The same state as the other files' atoms.
const isOn = atom({ plugin: 'godmode', key: 'isOn' } as const, false)
const mode = atom({ plugin: 'godmode', key: 'mode' } as const, 'coding' as GodmodeMode)
const setupScope = atom({ plugin: 'godmode', key: 'setupScope' } as const, 'full' as SetupScope)
const setupRun = atom({ plugin: 'godmode', key: 'setupRun' } as const, { consented: [], written: [] } as SetupRun)
const setupReport = atom({ plugin: 'godmode', key: 'setupReport' } as const, '')
const recheck = atom({ plugin: 'godmode', key: 'recheck' } as const, [] as string[])
const paneFallback = atom({ plugin: 'godmode', key: 'paneFallback' } as const, false)
const agents = atom({ plugin: 'godmode', key: 'agents' } as const, {} as Record<string, DispatchedAgent>)

/** The line a setup that did not finish leaves. */
export const SETUP_UNFINISHED = 'Setup didn\'t finish, so godmode is off. `/godmode` starts it again.'

/** The line the person's own close of the side pane leaves. */
export const PANE_CLOSED = 'godmode is off (side pane closed). `/godmode` turns it back on.'

/**
 * Whether a pane's close is the person's own close of godmode's side pane (their close mark or
 * key: origin `person`), which means "godmode off". godmode's own `$.ui.close` at `/godmode off`
 * is origin `plugin`, and an unload's is `unload`: neither turns anything off again.
 */
export const isPersonPaneClose = (e: { id: string; origin: { kind: string } }) => e.id === 'godmode' && e.origin.kind === 'person'

/** The line a note that went away leaves. */
export const NOTE_GONE = 'godmode\'s setup note is gone, so godmode is off. `/godmode` sets it up again.'

/**
 * Switches godmode fully off: a setup or change in progress ends with nothing saved, the side
 * pane closes and the band with it, and the prompt hook injects nothing from now on. `line`,
 * when given, is logged once. Off already, nothing changes. Resolves whether godmode was on.
 */
export async function turnOff($: EngineInterface, line?: string) {
  if ((await read($, isOn)) !== true) return false
  await update($, isOn, () => false)
  await update($, mode, () => 'coding')
  await update($, setupScope, () => 'full')
  await update($, setupRun, () => ({ consented: [], written: [] }))
  await update($, setupReport, () => '')
  await update($, recheck, () => [])
  await update($, paneFallback, () => false)
  await closeGodmodePane($).catch(() => undefined)
  if (line !== undefined) $.ui.log(line)
  return true
}

/** Whether the project's setup is finished: a note with this person's half. */
async function isSetUp($: EngineInterface) {
  const found = await readNote($).catch(() => undefined)
  return found?.status === 'found' && found.personal !== undefined
}

/** Ends a setup that stopped before `setup_finish` saved: godmode turns off, saying so. Resolves whether it did. */
export async function endUnfinishedSetup($: EngineInterface) {
  if ((await read($, isOn)) !== true || (await read($, mode)) !== 'setup' || (await isSetUp($))) return false
  return turnOff($, SETUP_UNFINISHED)
}

const NOTIFICATION = /<task-notification>([\s\S]*?)<\/task-notification>/g

/**
 * Reads the task notifications in a delivery: the setup agent ending (done, failed or stopped)
 * while godmode is still in setup mode means setup did not finish, since `setup_finish` moves
 * godmode to coding mode when it saves.
 */
export async function noteSetupEnds($: EngineInterface, text: string) {
  if (!text.includes('<task-notification>')) return
  const known = await read($, agents)
  for (const [, body = ''] of text.matchAll(NOTIFICATION)) {
    const id = /<task-id>([^<]+)<\/task-id>/.exec(body)?.[1]?.trim()
    if (id !== undefined && known[id]?.role === 'setup' && (await endUnfinishedSetup($))) return
  }
}

/**
 * godmode on where its tools cannot work turns off (0.8.3): coding or change-setup mode with no
 * note to read, as after the note was deleted by hand. Setup mode has no note yet by design.
 * Resolves whether it turned off.
 */
export async function offWithoutNote($: EngineInterface) {
  if ((await read($, isOn)) !== true || (await read($, mode)) === 'setup') return false
  const found = await readNote($).catch(() => undefined)
  if (found?.status === 'found') return false
  return turnOff($, NOTE_GONE)
}
