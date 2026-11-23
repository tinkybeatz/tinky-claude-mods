import type { EngineInterface } from 'claude-code'

/*
 * Text for godmode's dialog and transcript lines. `$.ui.log` appends one line, and a dialog
 * question is one line: a new line inside either draws as a stray character. So a text of
 * several lines is logged one line per call, and a question is folded onto one line.
 */

/** A question on one line: new lines and runs of spaces folded to one space. */
export const questionText = (text: string) => text.replace(/\s+/g, ' ').trim()

/** Logs a text of several lines, one `$.ui.log` line each; blank lines are left out. */
export function logLines($: EngineInterface, text: string) {
  for (const line of text.split('\n')) if (line.trim() !== '') $.ui.log(line.trimEnd())
}
