import { expect, test } from 'claude-code/testing'
import type { On, RenderElement } from 'claude-code'

import { DEFAULT_INDICATOR, indicatorOf } from '../hooks/indicator'
import type { Indicator } from '../hooks/indicator'

/** Answers godmode's state reads beneath the plugin, as if `/godmode` had switched it on. */
const godmodeState = (on: On, state: { isOn: boolean; indicator?: Indicator }) => {
  on('state.get', (_$, e, next) => {
    if (e.plugin !== 'godmode') return next(e)
    if (e.key === 'isOn') return { value: { value: state.isOn, version: 1 } }
    if (e.key === 'indicator') return { value: { value: state.indicator, version: state.indicator === undefined ? 0 : 1 } }
    return next(e)
  })
  on('ui.render', () => ENGINE_LINE)
}

/** What the engine would draw, standing beneath the plugin; a hook that passes ends here. */
const ENGINE_LINE: RenderElement = { type: 'Text', children: ['engine'] }

const SURFACES = ['terminal', 'desktop'] as const

test('the mode style adds a godmode label after the footer modes', async ($, on) => {
  godmodeState(on, { isOn: true, indicator: 'mode' })
  for (const surface of SURFACES) {
    const site = await $.ui.mount({ plugin: 'godmode', surface, component: 'SessionMode', props: { modes: ['focus'] } })
    expect(await site.find({ text: 'godmode' })).toBeDefined()
    expect(await site.find({ text: 'focus & ' })).toBeDefined()
  }
})

test('with no style answered, the side pane is the default, so no mode label is drawn', async ($, on) => {
  godmodeState(on, { isOn: true })
  const site = await $.ui.mount({ plugin: 'godmode', surface: 'terminal', component: 'SessionMode', props: { modes: [] } })
  expect(await site.find({ text: 'godmode' })).toBeUndefined()
  expect(DEFAULT_INDICATOR).toBe('pane')
})

test('the band style draws GODMODE above the prompt, and only that style does', async ($, on) => {
  godmodeState(on, { isOn: true, indicator: 'band' })
  const band = await $.ui.mount({
    plugin: 'godmode',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 9 }, view: {} },
  })
  expect(await band.find({ text: 'GODMODE' })).toBeDefined()

  const mode = await $.ui.mount({ plugin: 'godmode', surface: 'terminal', component: 'SessionMode', props: { modes: [] } })
  expect(await mode.find({ text: 'godmode' })).toBeUndefined()
})

test('the hint style adds a godmode tag to the hint line and keeps the engine line', async ($, on) => {
  const tails: (string | undefined)[] = []
  // Made before godmodeState's catch-all, so the plugin's pass reaches it first.
  on('ui.render', { component: 'PromptHint' }, (_$, e) => {
    tails.push(e.props.tail)
    return ENGINE_LINE
  })
  godmodeState(on, { isOn: true, indicator: 'hint' })
  await $.ui.mount({
    plugin: 'godmode',
    surface: 'terminal',
    component: 'PromptHint',
    props: { isDraft: false, isWorking: false, hint: '? for shortcuts' },
  })
  expect(tails.at(-1)).toBe('· godmode')
})

test('the band yields to a survey', async ($, on) => {
  godmodeState(on, { isOn: true, indicator: 'band' })
  const band = await $.ui.mount({
    plugin: 'godmode',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: true, isCollapsed: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 9 }, view: {} },
  })
  expect(await band.find({ text: 'GODMODE' })).toBeUndefined()
})

test('nothing shows while godmode is off', async ($, on) => {
  godmodeState(on, { isOn: false, indicator: 'band' })
  const band = await $.ui.mount({
    plugin: 'godmode',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 9 }, view: {} },
  })
  expect(await band.find({ text: 'GODMODE' })).toBeUndefined()
})

test('an unknown answer reads as the default style', () => {
  expect(indicatorOf('band')).toBe('band')
  expect(indicatorOf('neon')).toBe('pane')
  expect(indicatorOf(undefined)).toBe('pane')
})
