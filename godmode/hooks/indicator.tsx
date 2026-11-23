import { atom, read } from 'claude-code'
import type { On } from 'claude-code'

/**
 * How the screen shows that godmode is on (D68), one style at a time, picked at setup as
 * a personal answer:
 * - `mode`: a red `godmode` label among the footer's mode labels, right of the prompt.
 * - `hint`: a `godmode` tag at the end of the hint line under the prompt.
 * - `band`: a dark red strip saying GODMODE directly above the prompt.
 * - `pane`: godmode's side pane (`pane.tsx`); the band stands in while it cannot be shown.
 */
export type Indicator = 'mode' | 'hint' | 'band' | 'pane'

export const INDICATORS: readonly Indicator[] = ['mode', 'hint', 'band', 'pane']

export const DEFAULT_INDICATOR: Indicator = 'pane'

/** Red enough to catch the eye on a dark or a light theme. */
const LABEL_COLOR = '#e5484d'
const BAND_COLOR = '#5c1018'
const BAND_TEXT = '#ffd7d9'

export const LABEL = 'godmode'

/** Reads any answer as a style, falling back to the default for a missing or unknown one. */
export const indicatorOf = (value: unknown): Indicator =>
  INDICATORS.includes(value as Indicator) ? (value as Indicator) : DEFAULT_INDICATOR

/**
 * Same keys as the atoms in `register.tsx`: the state is one, but `validate` follows a
 * state source only to an atom made in the same file.
 */
const isOn = atom({ plugin: 'godmode', key: 'isOn' } as const, false)
const indicator = atom({ plugin: 'godmode', key: 'indicator' } as const, DEFAULT_INDICATOR as Indicator)
// The side pane's own flag (`pane.tsx`): it could not be placed.
const paneFallback = atom({ plugin: 'godmode', key: 'paneFallback' } as const, false)

export function registerIndicator(on: On) {
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    if ((await read($, isOn)) !== true || indicatorOf(await read($, indicator)) !== 'mode') return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const others = e.props.modes.filter(mode => mode !== LABEL)
    return (
      <Box>
        {others.length > 0 ? <Text dimColor>{`${others.join(' & ')} & `}</Text> : null}
        <Text color={LABEL_COLOR} bold>
          {LABEL}
        </Text>
      </Box>
    )
  })

  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    if ((await read($, isOn)) !== true || indicatorOf(await read($, indicator)) !== 'hint') return next(e)
    const tail = e.props.tail === undefined ? `· ${LABEL}` : `${e.props.tail} · ${LABEL}`
    return next({ ...e, props: { ...e.props, tail } })
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    if ((await read($, isOn)) !== true) return next(e)
    const style = indicatorOf(await read($, indicator))
    // The band stands in for a side pane the terminal cannot place, so the person always sees that godmode is on.
    const isPaneAway = style === 'pane' && (await read($, paneFallback))
    if (style !== 'band' && !isPaneAway) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box backgroundColor={BAND_COLOR} width={e.props.bodyColumns} justifyContent="center">
        <Text color={BAND_TEXT} bold>
          GODMODE
        </Text>
      </Box>
    )
  })
}
