import type { EngineInterface } from 'claude-code'

/*
 * The PM's role for the main thread (D63, D64). `agents/pm.md` is written like the other
 * role prompts, but the PM is the main thread, never a dispatched agent: the module hides
 * its agent type and hands its body to the main thread through the channels that run on
 * every kind of account, `command.run`'s context when `/godmode` switches on and
 * `prompt.submit`'s context after a setup and as a one-line reminder on each prompt.
 * `prompt.compose`, which an organisation's security plugin can pass over, is not used.
 */

/** The PM's agent type, hidden from the model's list of agents. */
export const PM_AGENT = 'godmode:pm'

/** A role file's body: the text after its front matter. */
export const bodyOf = (text: string) => text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim()

/**
 * A role file's body with `${CLAUDE_PLUGIN_ROOT}` made the plugin's folder. The engine
 * expands it in an agent's prompt and a skill's body, but not in a file a hook reads.
 */
export const expandRoot = (text: string, root: string) => text.split('${CLAUDE_PLUGIN_ROOT}').join(root.replace(/[\\/]+$/, ''))

/** The one line each prompt carries while godmode is on in coding mode, so the role survives compaction. */
export const pmReminder = (root: string) =>
  `godmode is on: you are its PM. Keep this thread for talking, tickets and dispatch; agents do the work. If your role is no longer in view, read ${root.replace(/[\\/]+$/, '')}/agents/pm.md.`

/** The PM's role, ready for the main thread; undefined when the file cannot be read. */
export async function pmRoleOf($: EngineInterface) {
  const text = await $.fs.read(`${$.plugin.root}/agents/pm.md`).catch(() => undefined)
  if (text === undefined || bodyOf(text) === '') return undefined
  return expandRoot(bodyOf(text), $.plugin.root)
}
