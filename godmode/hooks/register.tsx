import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { GodmodeMode } from '../types'

const USAGE = 'Use `/godmode`, `/godmode setup`, `/godmode off`, `/godmode report` or `/godmode try <ticket>`.'

const isOn = atom({ plugin: 'godmode', key: 'isOn' } as const, false)
const mode = atom({ plugin: 'godmode', key: 'mode' } as const, 'coding' as GodmodeMode)

/**
 * Whether the project has a setup note (D20). Step 2 replaces this stub with the real
 * lookup in the chosen storage; until then every project counts as set up, so `/godmode`
 * always switches on in coding mode.
 */
const hasSetupNote = async (_$: EngineInterface) => true

/** The mode `/godmode` switches on in: setup with no note, coding with one (D27). */
const switchOnMode = async ($: EngineInterface): Promise<GodmodeMode> =>
  (await hasSetupNote($)) ? 'coding' : 'setup'

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
      await switchOn($, await switchOnMode($))
      return {}
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
