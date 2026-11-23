import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, TurnStepChunk, TurnStepResult } from 'claude-code'

import type { GodmodeMode, SetupScope } from '../types'
import { NO_GIT_LINE } from './host'
import { indicatorOf, registerIndicator } from './indicator'
import { answerIssueLines } from './answers'
import {
  afterToolCall,
  ALLOW_ONCE_TOOL,
  context7Refusal,
  decideToolCall,
  noteDevEnds,
  planSpawn,
  QA_VERDICT_TOOL,
  recordAgent,
  recordDevDispatch,
  REVIEW_VERDICT_TOOL,
  serveAllowOnce,
  serveQaVerdict,
  serveReviewVerdict,
  takePendingReviews,
  ticketMoveCheck,
} from './loop'
import type { LoopCache } from './loop'
import { changedConventions, godmodeVersionOf, projectOf, readNote } from './storage'
import type { NoteLookup, Project } from './storage'
import { qaCheckBlock } from './qa-check'
import { fableOutcome, isPmModel, PM_FALLBACK_MODEL, PM_MODEL, pmReminder, pmRoleOf, qaModeLine } from './role'
import { godmodeReport, resumeOf, updateLineOf } from './report'
import { beginChangeSetup, beginSetup, leaveChangeSetup, offerGitInit, serveSetupTool, SETUP_TOOLS, setupEditRefusal, takeSetupReport } from './setup'
import type { SetupToolName } from './setup'
import { serveTicketRules, TICKET_RULES_TOOL } from './ticket-rules'
import { runTicketTool, TICKET_TOOLS, TicketError, ticketBackendOf } from './tickets'
import type { TicketToolName } from './tickets'
import { forgetStaleTry, startTry, stopTry, stopTryCommand } from './try'
import type { TryHandles } from './try'

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
const indicator = atom({ plugin: 'godmode', key: 'indicator' } as const, 'mode' as 'mode' | 'hint' | 'band')
const pmModel = atom({ plugin: 'godmode', key: 'pmModel' } as const, 'untried' as 'untried' | 'fable' | 'opus')

/** How `/godmode` switches on: the mode, and what the setup or the PM picks up first. */
type SwitchOnPlan = {
  mode: GodmodeMode
  /** `personal` when the shared half of a committed note is there and this person's is not (D61). */
  setupScope: SetupScope
  /** Conventions files edited since the note was written (D20); Step 3 re-checks them. */
  recheck: string[]
  /** The one line the reply carries, if any (D46, D60). */
  line?: string
  /** The on-indicator's style from the note's personal answers (D68). */
  indicatorStyle?: unknown
  /** The project's QA mode for the PM, in coding mode (Step 13.0). */
  qaLine?: string
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
  // A saved answer the rules repaired or cannot use is told at each switch-on, with what fixes it.
  const flagged = answerIssueLines(found.repairs ?? [], found.issues ?? [])
  const line = [updateLineOf(shared.godmodeVersion, current), ...flagged].filter(part => part !== undefined).join('\n') || undefined
  if (found.personal === undefined) return { mode: 'setup', setupScope: 'personal', recheck, line }
  return { mode: 'coding', setupScope: 'full', recheck, line, indicatorStyle: found.personal.answers.indicator, qaLine: qaModeLine(shared.answers) }
}

/**
 * Declares the four ticket tools (D24), `review_verdict` (D53), `qa_verdict` (D35) and the setup tools (Step 3) at each switch-on. No
 * call takes a tool back, so after `/godmode off` they stay listed and answer "godmode is
 * off". Resolves the line to show when they could not be declared.
 */
const registerTicketTools = async ($: EngineInterface) => {
  try {
    for (const tool of [...TICKET_TOOLS, REVIEW_VERDICT_TOOL, QA_VERDICT_TOOL, ALLOW_ONCE_TOOL, TICKET_RULES_TOOL, ...SETUP_TOOLS]) await $.tool.register(tool)
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

/**
 * Serves a ticket tool from the project's backend; a failure is the model's to read, as an
 * error. A move meets the loop's QA rules first (D69).
 */
const serveTicketTool = async ($: EngineInterface, cache: LoopCache, e: { tool: string; agentId?: string } & Record<string, unknown>) => {
  if ((await read($, isOn)) !== true) return { deny: 'godmode is off, so its ticket tools do nothing. The person switches it on with `/godmode`.' }
  const { tool, tool_use_id: _id, agentId, consent: _consent, ...input } = e
  try {
    const backend = await ticketBackendOf($)
    return { result: await runTicketTool(backend, tool.replace(/^mcp__godmode__/, '') as TicketToolName, input, { agentId, checkMove: ticketMoveCheck($, cache) }) }
  } catch (error) {
    if (error instanceof TicketError) return { deny: error.message }
    return { deny: `godmode's ticket tool failed: ${error instanceof Error ? error.message : String(error)}` }
  }
}

const failedTicketTool = () => ({ deny: 'godmode\'s ticket tool failed before it could answer.' })

/** Serves a setup tool (Step 3), its input without the call's own fields. */
const setupTool = ($: EngineInterface, name: SetupToolName, e: Record<string, unknown>) => {
  const { tool: _tool, tool_use_id: _id, agentId: _agentId, consent: _consent, ...input } = e
  return serveSetupTool($, name, input)
}

const failedSetupTool = () => ({ deny: 'godmode\'s setup tool failed before it could answer.' })

/**
 * Prompts the person sent themselves; each starts the main thread's read count over (D63).
 * A prompt with no origin is the person's own.
 */
const PERSON_ORIGINS: readonly (string | undefined)[] = ['composer', 'bridge', 'sdk', undefined]

export const register: Register = on => {
  // The note's settings and the open PRs, kept between calls for this load of the module.
  const cache: LoopCache = {}
  // The app `/godmode try` started; a reload of the module ends it.
  const tries: TryHandles = {}

  // The "godmode is on" indicator (D68), drawn by `indicator.tsx`.
  registerIndicator(on)

  // The PM is the main thread, never a dispatched agent: its type stays off the model's list.
  on('agent.offer', { agent: 'godmode:pm' }, () => ({ isOffered: false }))

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'godmode',
      description:
        'Switch godmode on: a PM main thread that files tickets and dispatches dev and review agents (`setup` to change the setup, `off`, `report`, `try <ticket>`)',
      argumentHint: '[setup|off|report|try <ticket>]',
    })
    // A reload runs `register` again while the state says on: declare the tools again.
    if ((await read($, isOn)) === true) await registerTicketTools($)
    // A try the old copy of the module started died with it; free its port.
    await forgetStaleTry($, tries).catch(() => undefined)
    return next(e)
  })

  // The app a try started stops with the session (D49).
  /*
   * The PM's main loop runs on Fable while godmode is on in coding or change-setup mode
   * (D74); agents keep the model their dispatch gave them, and once godmode is off the
   * person's own model applies again. The session's first Fable step is held until it
   * ends: an error saying Fable is unavailable here, thrown or as a response with no
   * message, sends the same request on Opus, and every later step goes to Opus straight
   * away. Once Fable answered, steps stream as they come. Other errors pass as they are.
   */
  on('turn.step', async function* ($, e, next) {
    const current = (await read($, isOn)) === true ? await read($, mode) : undefined
    const isPm = e.agentId === undefined && (current === 'coding' || current === 'change-setup') && !isPmModel(e.model)
    if (!isPm) return yield* next(e)
    const known = await read($, pmModel)
    if (known !== 'untried') return yield* next({ ...e, model: known === 'opus' ? PM_FALLBACK_MODEL : PM_MODEL })
    const held: TurnStepChunk[] = []
    let outcome: 'unavailable' | 'works' | 'unknown'
    let result: TurnStepResult | undefined
    try {
      const stream = next({ ...e, model: PM_MODEL })
      for await (const chunk of stream) held.push(chunk)
      result = await stream.result
      outcome = fableOutcome(result)
    } catch (error) {
      outcome = fableOutcome({ error: error instanceof Error ? error.message : String(error) })
      if (outcome !== 'unavailable') throw error
    }
    if (outcome === 'unavailable' || result === undefined) {
      await update($, pmModel, () => 'opus')
      $.ui.log('Fable is unavailable here, so the PM runs on Opus.')
      return yield* next({ ...e, model: PM_FALLBACK_MODEL })
    }
    if (outcome === 'works') await update($, pmModel, () => 'fable')
    for (const chunk of held) yield chunk
    return result
  })

  on('session.end', async ($, e, next) => {
    await stopTry($, tries).catch(() => undefined)
    return next(e)
  }).catch(($, e, next) => next(e))

  // One hook per tool, each named literally so `validate` reads what the module serves.
  on('tool.call', { tool: 'mcp__godmode__ticket_create' }, ($, e) => serveTicketTool($, cache, e)).catch(failedTicketTool)
  on('tool.call', { tool: 'mcp__godmode__ticket_move' }, ($, e) => serveTicketTool($, cache, e)).catch(failedTicketTool)
  on('tool.call', { tool: 'mcp__godmode__ticket_list' }, ($, e) => serveTicketTool($, cache, e)).catch(failedTicketTool)
  on('tool.call', { tool: 'mcp__godmode__ticket_comment' }, ($, e) => serveTicketTool($, cache, e)).catch(failedTicketTool)
  on('tool.call', { tool: 'mcp__godmode__setup_scan' }, ($, e) => setupTool($, 'setup_scan', e)).catch(failedSetupTool)
  on('tool.call', { tool: 'mcp__godmode__setup_questionnaire' }, ($, e) => setupTool($, 'setup_questionnaire', e)).catch(failedSetupTool)
  on('tool.call', { tool: 'mcp__godmode__setup_confirm' }, ($, e) => setupTool($, 'setup_confirm', e)).catch(failedSetupTool)
  on('tool.call', { tool: 'mcp__godmode__setup_write_preset' }, ($, e) => setupTool($, 'setup_write_preset', e)).catch(failedSetupTool)
  // The note is new: the loop reads it again on its next call.
  on('tool.call', { tool: 'mcp__godmode__setup_finish' }, async ($, e) => {
    const answer = await setupTool($, 'setup_finish', e)
    cache.context = undefined
    return answer
  }).catch(failedSetupTool)
  on('tool.call', { tool: 'mcp__godmode__review_verdict' }, ($, e) => serveReviewVerdict($, cache, e)).catch(() => ({
    deny: 'godmode\'s review_verdict tool failed before it could record anything.',
  }))
  on('tool.call', { tool: 'mcp__godmode__qa_verdict' }, ($, e) => serveQaVerdict($, cache, e)).catch(() => ({
    deny: 'godmode\'s qa_verdict tool failed before it could record anything.',
  }))
  on('tool.call', { tool: 'mcp__godmode__ticket_rules' }, ($, e) => serveTicketRules($, e)).catch(() => ({
    deny: 'godmode\'s ticket_rules tool failed before it could save anything.',
  }))
  on('tool.call', { tool: 'mcp__godmode__allow_once' }, ($, e) => serveAllowOnce($, e)).catch(() => ({
    deny: 'godmode\'s allow_once tool failed before it could record anything.',
  }))

  /*
   * The loop's gate (Step 7): every tool call while godmode is on, and godmode's own
   * context7 tools while it is off (D12). A failed check refuses
   * the call rather than letting it through, and says how to go on without godmode. Its
   * own `$.ui.ask` raises an AskUserQuestion call that skips this hook, so the person can
   * still be asked.
   */
  on('tool.call', async ($, e, next) => {
    const context7 = await context7Refusal($, cache, e.tool)
    if (context7 !== undefined) return { deny: context7 }
    const setupRefusal = await setupEditRefusal($, e as unknown as { tool: string } & Record<string, unknown>)
    if (setupRefusal !== undefined) return { deny: setupRefusal }
    const decision = await decideToolCall($, cache, e)
    if (decision.deny !== undefined) return { deny: decision.deny }
    return afterToolCall($, cache, decision, await next(e))
  }).catch(($, e, next) => {
    if (next.called) return next(e)
    return {
      deny: `godmode's tool-call check failed (${next.error.message ?? next.error.kind}), so it refused this call to be safe. Nothing ran. The person can go on without godmode with \`/godmode off\`.`,
    }
  })

  // Dispatch (Step 7): the agent cap, the role's model, a dev agent's ticket, worktree and brief.
  on('agent.spawn', async ($, e, next) => {
    const plan = await planSpawn($, cache, e)
    if (plan.deny !== undefined) return { deny: plan.deny }
    const started = await next(plan.input)
    if (started.agentId !== undefined && plan.record !== undefined) {
      await recordAgent($, started.agentId, plan.record)
      await recordDevDispatch($, cache, started.agentId, plan.record).catch(() => undefined)
    }
    return started
  }).catch(($, e, next) => {
    if (next.called) return next(e)
    return {
      deny: `godmode's dispatch check failed (${next.error.message ?? next.error.kind}), so the agent did not start. The person can go on without godmode with \`/godmode off\`.`,
    }
  })

  // A dev agent's end reaches the main thread as a task notification; its last report says whether it stopped to ask the person (D57).
  on('session.receive', async ($, e, next) => {
    if (e.agentId === undefined && (await read($, isOn)) === true) await noteDevEnds($, cache, e.text).catch(() => undefined)
    return next(e)
  }).catch(($, e, next) => next(e))

  // The PM hears about each new draft PR, and each ticket waiting on QA, on its next prompt, a person's or a task notification (D35, D64, D73).
  on('prompt.submit', async ($, e, next) => {
    if ((await read($, isOn)) !== true) return next(e)
    if (PERSON_ORIGINS.includes((e.origin as typeof e.origin | undefined)?.kind)) await update($, mainThreadReads, () => 0)
    const report = await takeSetupReport($)
    // A setup that just finished hands the main thread its PM role; after that, a one-line reminder (D64).
    const role = report === undefined ? undefined : await pmRoleOf($)
    const isCoding = (await read($, mode)) === 'coding'
    const reminder = isCoding && role === undefined ? pmReminder($.plugin.root) : undefined
    // The tickets waiting on QA, read from the ticket store on each prompt, never from memory (D73).
    const qa = isCoding ? await qaCheckBlock($, cache) : undefined
    const told = [report, role, reminder, qa, await takePendingReviews($)].filter(text => text !== undefined)
    return next(told.length === 0 ? e : { ...e, context: [...(e.context ?? []), ...told] })
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'godmode' }, async ($, e, next) => {
    const [action = '', ...rest] = e.args.trim().split(/\s+/)
    const ticket = rest.join(' ')
    // The setup note may have changed: the loop reads it again on its next call.
    cache.context = undefined

    // Switching on is quiet (D46), and typed while on it changes nothing (D45), except to end a change-setup unsaved.
    if (action === '') {
      if ((await read($, isOn)) === true) {
        if ((await read($, mode)) !== 'change-setup') return {}
        const left = await leaveChangeSetup($)
        const role = await pmRoleOf($)
        return role === undefined ? { text: left } : { text: left, context: [role] }
      }
      let project = await gitProject($)
      // No git (D54): offer `git init`, run only on a yes; otherwise godmode does not start.
      if (project === undefined) {
        const folder = await $.session.root()
        if (!(await offerGitInit($, folder))) return { text: NO_GIT_LINE }
        project = await gitProject($)
        if (project === undefined) return { text: NO_GIT_LINE }
      }
      const plan = await switchOnPlan($, project)
      await update($, setupScope, () => plan.setupScope)
      await update($, recheck, () => plan.recheck)
      await update($, indicator, () => indicatorOf(plan.indicatorStyle))
      const toolsLine = await switchOn($, plan.mode)
      // Setup mode (Step 3): the PM is told to dispatch the setup agent, so the main thread stays clean.
      const setup = plan.mode === 'setup' ? await beginSetup($, plan.setupScope) : undefined
      const lines = [plan.line, setup?.text, toolsLine].filter(line => line !== undefined)
      if (setup !== undefined) return { text: lines.join('\n'), context: setup.context }
      // Coding mode: the PM's role and the QA mode reach the main thread as hidden context, quietly (D46, D64).
      // The one thing it shows is a line per ticket resumed (D57); tickets in qa are not resumed, and no QA result shows.
      const resume = await resumeOf($, cache)
      const shown = [plan.line, ...(resume?.lines ?? []), toolsLine].filter(line => line !== undefined)
      const told = [await pmRoleOf($), plan.qaLine, resume?.context].filter(text => text !== undefined)
      const context = told.length === 0 ? {} : { context: told }
      return shown.length === 0 ? context : { text: shown.join('\n'), ...context }
    }
    if (action === 'setup') {
      const project = await gitProject($)
      if (project === undefined) return { text: NO_GIT_LINE }
      const found = await readNote($, project).catch(() => undefined)
      if (found?.status === 'found') await update($, indicator, () => indicatorOf(found.personal?.answers.indicator))
      const toolsLine = await switchOn($, 'change-setup')
      return beginChangeSetup($, found, toolsLine)
    }
    if (action === 'off') {
      if ((await read($, isOn)) !== true) return { text: 'godmode is already off.' }
      await update($, isOn, () => false)
      return { text: 'godmode is off: plain Claude Code for the rest of the session.' }
    }
    // Read-only, on or off (D44, D70).
    if (action === 'report') return { text: await godmodeReport($, cache) }
    if (action === 'try') {
      if (ticket === '') return { text: 'Name a ticket: `/godmode try <ticket>`, or `/godmode try stop`.' }
      if (ticket === 'stop') return { text: await stopTryCommand($, tries) }
      return { text: await startTry($, cache, tries, ticket, next.signal) }
    }
    return { text: `Unknown \`/godmode ${action}\`. ${USAGE}` }
  })
}
