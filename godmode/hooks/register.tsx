import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { GodmodeMode, SetupScope } from '../types'
import { changedConventions, godmodeVersionOf, isOlderVersion, readNote } from './storage'
import type { NoteLookup } from './storage'

const USAGE = 'Use `/godmode`, `/godmode setup`, `/godmode off`, `/godmode report` or `/godmode try <ticket>`.'

const isOn = atom({ plugin: 'godmode', key: 'isOn' } as const, false)
const mode = atom({ plugin: 'godmode', key: 'mode' } as const, 'coding' as GodmodeMode)
const setupScope = atom({ plugin: 'godmode', key: 'setupScope' } as const, 'full' as SetupScope)
const recheck = atom({ plugin: 'godmode', key: 'recheck' } as const, [] as string[])

/** How `/godmode` switches on: the mode, and what the setup or the PM picks up first. */
type SwitchOnPlan = {
  mode: GodmodeMode
  /** `personal` when the shared half of a committed note is there and this person's is not (D61). */
  setupScope: SetupScope
  /** Conventions files edited since the note was written (D20); Step 3 re-checks them. */
  recheck: string[]
  /** The one line the reply carries, if any (D46, D60). */
  line?: string
}

/**
 * Reads the project's setup note (D20): none means setup, a note means coding. A note
 * from an older godmode adds the update line, and changes nothing until asked (D60).
 */
const switchOnPlan = async ($: EngineInterface): Promise<SwitchOnPlan> => {
  let found: NoteLookup
  try {
    found = await readNote($)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { mode: 'setup', setupScope: 'full', recheck: [], line: `godmode could not look for its setup note (${reason}), so setup runs.` }
  }
  if (found.status === 'none') return { mode: 'setup', setupScope: 'full', recheck: [] }
  if (found.status === 'unreadable') {
    return { mode: 'setup', setupScope: 'full', recheck: [], line: `godmode could not read its setup note at ${found.path}: ${found.reason}. Setup runs again.` }
  }
  const { shared } = found
  const recheck = await changedConventions($, found.project, shared.conventions).catch(() => [])
  const current = await godmodeVersionOf($).catch(() => shared.godmodeVersion)
  const line = isOlderVersion(shared.godmodeVersion, current)
    ? `A godmode update is available for this project's conventions (set up with ${found.shared.godmodeVersion}, now ${current}): \`/godmode setup\` to apply it.`
    : undefined
  if (found.personal === undefined) return { mode: 'setup', setupScope: 'personal', recheck, line }
  return { mode: 'coding', setupScope: 'full', recheck, line }
}

const switchOn = async ($: EngineInterface, to: GodmodeMode) => {
  await update($, mode, () => to)
  await update($, isOn, () => true)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'godmode',
      description:
        'Switch godmode on: a PM main thread that files tickets and dispatches dev and review agents (`setup` to change the setup, `off`, `report`, `try <ticket>`)',
      argumentHint: '[setup|off|report|try <ticket>]',
    })
    return next(e)
  })

  on('command.run', { command: 'godmode' }, async ($, e) => {
    const [action = '', ...rest] = e.args.trim().split(/\s+/)
    const ticket = rest.join(' ')

    // Switching on is quiet (D46), and typed while on it changes nothing (D45).
    if (action === '') {
      if ((await read($, isOn)) === true) return {}
      const plan = await switchOnPlan($)
      await update($, setupScope, () => plan.setupScope)
      await update($, recheck, () => plan.recheck)
      await switchOn($, plan.mode)
      return plan.line === undefined ? {} : { text: plan.line }
    }
    if (action === 'setup') {
      await switchOn($, 'change-setup')
      return { text: 'godmode is in change-setup mode: say what you want to change.' }
    }
    if (action === 'off') {
      if ((await read($, isOn)) !== true) return { text: 'godmode is already off.' }
      await update($, isOn, () => false)
      return { text: 'godmode is off: plain Claude Code for the rest of the session.' }
    }
    if (action === 'report') return { text: '`/godmode report` is not built yet.' }
    if (action === 'try') {
      if (ticket === '') return { text: 'Name a ticket: `/godmode try <ticket>`.' }
      return { text: `\`/godmode try\` is not built yet, so ${ticket} was not started.` }
    }
    return { text: `Unknown \`/godmode ${action}\`. ${USAGE}` }
  })
}
