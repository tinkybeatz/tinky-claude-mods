import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { GodmodeMode, SetupScope } from '../types'
import { NO_GIT_LINE } from './host'
import { afterToolCall, decideToolCall, planSpawn, recordAgent, REVIEW_VERDICT_TOOL, serveReviewVerdict, takePendingReviews } from './loop'
import type { LoopCache } from './loop'
import { changedConventions, godmodeVersionOf, isOlderVersion, projectOf, readNote } from './storage'
import type { NoteLookup, Project } from './storage'
import { runTicketTool, TICKET_TOOLS, TicketError, ticketBackendOf } from './tickets'
import type { TicketToolName } from './tickets'

const USAGE = 'Use `/godmode`, `/godmode setup`, `/godmode off`, `/godmode report` or `/godmode try <ticket>`.'

/*
 * State refs are written in each file that reads or updates them: `validate` follows a
 * state source only to an atom made in the same file. `loop.ts` holds its own.
 */
const isOn = atom({ plugin: 'godmode', key: 'isOn' } as const, false)
const mode = atom({ plugin: 'godmode', key: 'mode' } as const, 'coding' as GodmodeMode)
const setupScope = atom({ plugin: 'godmode', key: 'setupScope' } as const, 'full' as SetupScope)
const recheck = atom({ plugin: 'godmode', key: 'recheck' } as const, [] as string[])
const mainThreadReads = atom({ plugin: 'godmode', key: 'mainThreadReads' } as const, 0)

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
const switchOnPlan = async ($: EngineInterface, project: Project): Promise<SwitchOnPlan> => {
  let found: NoteLookup
  try {
    found = await readNote($, project)
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

/**
 * Declares the four ticket tools (D24) and `review_verdict` (D53) at each switch-on. No
 * call takes a tool back, so after `/godmode off` they stay listed and answer "godmode is
 * off". Resolves the line to show when they could not be declared.
 */
const registerTicketTools = async ($: EngineInterface) => {
  try {
    for (const tool of [...TICKET_TOOLS, REVIEW_VERDICT_TOOL]) await $.tool.register(tool)
    return undefined
  } catch (error) {
    return `godmode could not add its ticket tools (${error instanceof Error ? error.message : String(error)}).`
  }
}

const switchOn = async ($: EngineInterface, to: GodmodeMode) => {
  await update($, mainThreadReads, () => 0)
  await update($, mode, () => to)
  await update($, isOn, () => true)
  return registerTicketTools($)
}

/** The session's project, or undefined in a folder with no git, where godmode does not start (D54). */
const gitProject = async ($: EngineInterface) => {
  const project = await projectOf($).catch(() => undefined)
  return project?.hasGit === true ? project : undefined
}

/** Serves a ticket tool from the project's backend; a failure is the model's to read, as an error. */
const serveTicketTool = async ($: EngineInterface, e: { tool: string; agentId?: string } & Record<string, unknown>) => {
  if ((await read($, isOn)) !== true) return { deny: 'godmode is off, so its ticket tools do nothing. The person switches it on with `/godmode`.' }
  const { tool, tool_use_id: _id, agentId, consent: _consent, ...input } = e
  try {
    const backend = await ticketBackendOf($)
    return { result: await runTicketTool(backend, tool.replace(/^mcp__godmode__/, '') as TicketToolName, input, { agentId }) }
  } catch (error) {
    if (error instanceof TicketError) return { deny: error.message }
    return { deny: `godmode's ticket tool failed: ${error instanceof Error ? error.message : String(error)}` }
  }
}

const failedTicketTool = () => ({ deny: 'godmode\'s ticket tool failed before it could answer.' })

/**
 * Prompts the person sent themselves; each starts the main thread's read count over (D63).
 * A prompt with no origin is the person's own.
 */
const PERSON_ORIGINS: readonly (string | undefined)[] = ['composer', 'bridge', 'sdk', undefined]

export const register: Register = on => {
  // The note's settings and the open PRs, kept between calls for this load of the module.
  const cache: LoopCache = {}

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'godmode',
      description:
        'Switch godmode on: a PM main thread that files tickets and dispatches dev and review agents (`setup` to change the setup, `off`, `report`, `try <ticket>`)',
      argumentHint: '[setup|off|report|try <ticket>]',
    })
    // A reload runs `register` again while the state says on: declare the tools again.
    if ((await read($, isOn)) === true) await registerTicketTools($)
    return next(e)
  })

  // One hook per tool, each named literally so `validate` reads what the module serves.
  on('tool.call', { tool: 'mcp__godmode__ticket_create' }, ($, e) => serveTicketTool($, e)).catch(failedTicketTool)
  on('tool.call', { tool: 'mcp__godmode__ticket_move' }, ($, e) => serveTicketTool($, e)).catch(failedTicketTool)
  on('tool.call', { tool: 'mcp__godmode__ticket_list' }, ($, e) => serveTicketTool($, e)).catch(failedTicketTool)
  on('tool.call', { tool: 'mcp__godmode__ticket_comment' }, ($, e) => serveTicketTool($, e)).catch(failedTicketTool)
  on('tool.call', { tool: 'mcp__godmode__review_verdict' }, ($, e) => serveReviewVerdict($, cache, e)).catch(() => ({
    deny: 'godmode\'s review_verdict tool failed before it could record anything.',
  }))

  /*
   * The loop's gate (Step 7): every tool call while godmode is on. A failed check refuses
   * the call rather than letting it through, and says how to go on without godmode. Its
   * own `$.ui.ask` raises an AskUserQuestion call beneath this hook: that re-entry is
   * passed on, or the person could never be asked.
   */
  on('tool.call', async ($, e, next) => {
    const decision = await decideToolCall($, cache, e)
    if (decision.deny !== undefined) return { deny: decision.deny }
    return afterToolCall($, cache, decision, await next(e))
  }).catch(($, e, next) => {
    if (next.error.kind === 're-entry' || next.called) return next(e)
    return {
      deny: `godmode's tool-call check failed (${next.error.message ?? next.error.kind}), so it refused this call to be safe. Nothing ran. The person can go on without godmode with \`/godmode off\`.`,
    }
  })

  // Dispatch (Step 7): the agent cap, the role's model, a dev agent's ticket, worktree and brief.
  on('agent.spawn', async ($, e, next) => {
    const plan = await planSpawn($, cache, e)
    if (plan.deny !== undefined) return { deny: plan.deny }
    const started = await next(plan.input)
    if (started.agentId !== undefined && plan.record !== undefined) await recordAgent($, started.agentId, plan.record)
    return started
  }).catch(($, e, next) => {
    if (next.error.kind === 're-entry' || next.called) return next(e)
    return {
      deny: `godmode's dispatch check failed (${next.error.message ?? next.error.kind}), so the agent did not start. The person can go on without godmode with \`/godmode off\`.`,
    }
  })

  // The PM hears about each new draft PR on its next prompt, a person's or a task notification (D35, D64).
  on('prompt.submit', async ($, e, next) => {
    if ((await read($, isOn)) !== true) return next(e)
    if (PERSON_ORIGINS.includes((e.origin as typeof e.origin | undefined)?.kind)) await update($, mainThreadReads, () => 0)
    const told = await takePendingReviews($)
    return next(told === undefined ? e : { ...e, context: [...(e.context ?? []), told] })
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'godmode' }, async ($, e) => {
    const [action = '', ...rest] = e.args.trim().split(/\s+/)
    const ticket = rest.join(' ')
    // The setup note may have changed: the loop reads it again on its next call.
    cache.context = undefined

    // Switching on is quiet (D46), and typed while on it changes nothing (D45).
    if (action === '') {
      if ((await read($, isOn)) === true) return {}
      const project = await gitProject($)
      if (project === undefined) return { text: NO_GIT_LINE }
      const plan = await switchOnPlan($, project)
      await update($, setupScope, () => plan.setupScope)
      await update($, recheck, () => plan.recheck)
      const toolsLine = await switchOn($, plan.mode)
      const lines = [plan.line, toolsLine].filter(line => line !== undefined)
      return lines.length === 0 ? {} : { text: lines.join('\n') }
    }
    if (action === 'setup') {
      if ((await gitProject($)) === undefined) return { text: NO_GIT_LINE }
      const toolsLine = await switchOn($, 'change-setup')
      const line = 'godmode is in change-setup mode: say what you want to change.'
      return { text: toolsLine === undefined ? line : `${line}\n${toolsLine}` }
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
