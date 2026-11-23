import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { withoutGodmodeLines } from '../hooks/reset'
import type { NoteDraft } from '../hooks/storage'
import { FIRST_COMMIT, HOME, makeWorld, mountWorld, REPO, setUpProject } from './world'
import type { World } from './world'

/*
 * `/godmode reset` (0.8.2): every trace godmode left in the project is listed, then wiped only on
 * "Wipe"; the project's own files, the team's conventions and worktrees holding work stay.
 */

const OUTSIDE = `${HOME}/.claude/godmode/projects/${FIRST_COMMIT}`

type Person = { asked: string[]; logs: string[]; store: Map<string, unknown> }

/** Mounts the world and the person, who answers the reset question with `answer`; `store` seeds godmode's store. */
const mount = (on: On, world: World, answer: string, store: Record<string, unknown> = {}): Person => {
  const person: Person = { asked: [], logs: [], store: new Map(Object.entries(store)) }
  mountWorld(on, world)
  on('store.get', (_$, e) => ({ value: person.store.get(e.key) }))
  on('store.set', (_$, e) => {
    person.store.set(e.key, e.value)
    return { value: undefined } as never
  })
  on('store.keys', () => ({ value: [...person.store.keys()] }))
  on('store.delete', (_$, e) => {
    person.store.delete(e.key)
    return { value: undefined } as never
  })
  on('agent.list', () => ({ value: [] }))
  on('ui.toast', () => ({ value: undefined }) as never)
  on('ui.panes', () => ({ value: [] }) as never)
  on('ui.log', (_$, e) => {
    person.logs.push(e.text)
    return { value: undefined } as never
  })
  on('tool.call', (_$, e) => {
    const input = e as unknown as Record<string, unknown>
    if (e.tool !== 'AskUserQuestion') return { result: 'ok' } as never
    const question = (input.questions as { question: string; header: string }[])[0]
    person.asked.push(question?.header ?? '')
    return { result: { questions: input.questions, answers: { [question?.question ?? '']: answer } } } as never
  })
  return person
}

const godmode = ($: Engine, args = '') => $.command.run({ command: 'godmode', args } as Parameters<typeof $.command.run>[0])

/** A project set up in `storage`, with a team's own AGENTS.md and two files setup wrote. */
const setUp = async (world: World, storage: NoteDraft['storage']) => {
  const dir = storage === 'committed' ? `${REPO}/docs/conventions` : storage === 'gitignored' ? `${REPO}/.godmode/conventions` : `${OUTSIDE}/conventions`
  world.files.set(`${REPO}/AGENTS.md`, '# The team\'s own agent rules\n')
  world.files.set(`${dir}/git-workflow.md`, '# Git workflow\n')
  world.files.set(`${dir}/project-rules.md`, '# Project rules\n')
  const shown = (path: string) => (path.startsWith(`${REPO}/`) ? path.slice(REPO.length + 1) : path)
  await setUpProject(world, {
    storage,
    conventions: ['AGENTS.md', shown(`${dir}/git-workflow.md`), shown(`${dir}/project-rules.md`)],
    written: [shown(`${dir}/git-workflow.md`), shown(`${dir}/project-rules.md`)],
  })
  return dir
}

/** godmode's records for this project, another project's, and a key that is no project's. */
const STORE = {
  [`verdicts:${FIRST_COMMIT}`]: { '12': { verdict: 'clean' } },
  [`fixRounds:${FIRST_COMMIT}`]: { 'T-1': { count: 1 } },
  [`devDispatches:${FIRST_COMMIT}`]: {},
  [`auditNotice:${FIRST_COMMIT}`]: '0.8.1',
  'verdicts:another-project': { '3': { verdict: 'clean' } },
  paneColumns: 40,
}

test('committed storage: the list comes first, "Wipe" removes godmode\'s files and records, the team\'s stay, and the deletions are left to commit', async ($, on) => {
  const world = makeWorld()
  const dir = await setUp(world, 'committed')
  world.tracked = ['.godmode/shared.json', 'docs/conventions/git-workflow.md', 'docs/conventions/project-rules.md', 'AGENTS.md', '.gitignore']
  world.files.set(`${REPO}/src/app.ts`, 'export const app = 1\n')
  const person = mount(on, world, 'Wipe', STORE)
  await godmode($)

  const reset = await godmode($, 'reset')

  expect(person.asked).toEqual(['Reset'])
  expect(person.logs).toContain('godmode would wipe from this project:')
  expect(person.logs).toContain('- .godmode/ (godmode\'s folder: its note, tickets, records and side files)')
  expect(person.logs).toContain('- docs/conventions/git-workflow.md (written by godmode\'s setup)')
  expect(person.logs).toContain('Kept, the project\'s own: AGENTS.md')
  expect([...world.files.keys()].filter(path => path.startsWith(`${REPO}/.godmode/`))).toEqual([])
  expect(world.files.has(`${dir}/git-workflow.md`)).toBe(false)
  expect(world.files.has(`${dir}/project-rules.md`)).toBe(false)
  // The project's own files and the team's conventions are never touched.
  expect(world.files.get(`${REPO}/AGENTS.md`)).toBe('# The team\'s own agent rules\n')
  expect(world.files.get(`${REPO}/src/app.ts`)).toBe('export const app = 1\n')
  expect(world.files.get(`${REPO}/.gitignore`) ?? '').not.toContain('godmode')
  expect([...person.store.keys()].sort()).toEqual(['paneColumns', 'verdicts:another-project'])
  expect(reset.text).toContain('These deletions are in the working tree, not committed: .godmode/shared.json, docs/conventions/git-workflow.md, docs/conventions/project-rules.md')
  expect(reset.text).toContain('godmode is gone from this project. `/godmode` starts a fresh setup.')
  expect(world.gitRuns.some(run => run.startsWith('git commit'))).toBe(false)
  // godmode is off.
  expect((await godmode($, 'off')).text).toBe('godmode is already off.')
})

test('gitignored storage: the folder and godmode\'s exclude lines go; nothing is left to commit', async ($, on) => {
  const world = makeWorld()
  await setUp(world, 'gitignored')
  world.files.set(`${REPO}/.git/info/exclude`, `# git ls-files --others --exclude-from=.git/info/exclude\n*.log\n\n${world.files.get(`${REPO}/.git/info/exclude`) ?? ''}`)
  mount(on, world, 'Wipe')

  const reset = await godmode($, 'reset')

  expect([...world.files.keys()].filter(path => path.startsWith(`${REPO}/.godmode`))).toEqual([])
  expect(world.files.get(`${REPO}/.git/info/exclude`)).toBe('# git ls-files --others --exclude-from=.git/info/exclude\n*.log\n')
  expect(reset.text).not.toContain('not committed')
  expect(world.files.get(`${REPO}/AGENTS.md`)).toBeDefined()
})

test('outside storage: the folder under ~/.claude goes, side files included, and the repo is untouched', async ($, on) => {
  const world = makeWorld()
  await setUp(world, 'outside')
  world.files.set(`${OUTSIDE}/tracker/jira/APP-3.json`, '{}\n')
  const before = [...world.files].filter(([path]) => path.startsWith(`${REPO}/`))
  const person = mount(on, world, 'Wipe', { 'jiraCreator:acme.atlassian.net:APP-3': 'acc-1', 'jiraCreator:acme.atlassian.net:OPS-9': 'acc-2' })

  await godmode($, 'reset')

  expect([...world.files.keys()].filter(path => path.startsWith(OUTSIDE))).toEqual([])
  expect([...world.files].filter(([path]) => path.startsWith(`${REPO}/`))).toEqual(before)
  // No Jira project in this note: no creator record is its, so both stay.
  expect(person.store.size).toBe(2)
})

test('worktrees: a clean, pushed one goes with its local branch; one holding work is listed as kept and left alone', async ($, on) => {
  const world = makeWorld()
  await setUp(world, 'committed')
  world.worktrees = [
    { path: '/work/app-worktrees/T-1', branch: 'godmode/t-1-export', isPushed: true },
    { path: '/work/app-worktrees/T-2', branch: 'godmode/t-2-filters', isDirty: true },
    { path: '/work/app-worktrees/T-3', branch: 'godmode/t-3-totals' },
    // Someone's own worktree, beside godmode's: never godmode's.
    { path: '/work/elsewhere', branch: 'my-spike', isPushed: true },
  ]
  world.branches.push('godmode/t-1-export', 'godmode/t-2-filters', 'godmode/t-3-totals', 'my-spike')
  const person = mount(on, world, 'Wipe')

  await godmode($, 'reset')

  expect(person.logs).toContain('- worktree /work/app-worktrees/T-1 and its local branch godmode/t-1-export (clean and pushed)')
  expect(person.logs).toContain('Kept, it holds work: /work/app-worktrees/T-2 (uncommitted changes)')
  expect(person.logs).toContain('Kept, it holds work: /work/app-worktrees/T-3 (commits not pushed)')
  expect(world.worktrees.map(tree => tree.path)).toEqual(['/work/app-worktrees/T-2', '/work/app-worktrees/T-3', '/work/elsewhere'])
  expect(world.branches).toEqual(['main', 'godmode/t-2-filters', 'godmode/t-3-totals', 'my-spike'])
})

test('Cancel deletes nothing, and godmode stays as it was', async ($, on) => {
  const world = makeWorld()
  await setUp(world, 'committed')
  world.worktrees = [{ path: '/work/app-worktrees/T-1', branch: 'godmode/t-1-export', isPushed: true }]
  const person = mount(on, world, 'Cancel', STORE)
  await godmode($)
  const files = new Map(world.files)

  const reset = await godmode($, 'reset')

  expect(reset.text).toBe('Nothing was wiped: godmode is as it was.')
  expect(world.files).toEqual(files)
  expect(person.store.size).toBe(Object.keys(STORE).length)
  expect(world.worktrees).toHaveLength(1)
  expect((await godmode($, 'off')).text).toContain('godmode is off')
})

test('a project godmode never set up has nothing to wipe, and nothing is asked', async ($, on) => {
  const world = makeWorld()
  world.files.set(`${REPO}/README.md`, '# App\n')
  const person = mount(on, world, 'Wipe', { paneColumns: 40 })

  const reset = await godmode($, 'reset')

  expect(reset.text).toContain('godmode has nothing to wipe in this project')
  expect(person.asked).toEqual([])
  expect(world.files.get(`${REPO}/README.md`)).toBe('# App\n')
})

test('a partial setup (the note never written) still wipes what it left', async ($, on) => {
  const world = makeWorld()
  world.files.set(`${REPO}/.godmode/tickets/T-1-export.md`, '# T-1\n')
  mount(on, world, 'Wipe')

  const reset = await godmode($, 'reset')

  expect(world.files.has(`${REPO}/.godmode/tickets/T-1-export.md`)).toBe(false)
  expect(reset.text).toContain('godmode is gone from this project')
})

test('godmode\'s ignore block comes out whole; the person\'s own lines stay', () => {
  expect(withoutGodmodeLines('node_modules/\n\n# godmode: personal setup, never committed\n.godmode/personal.json\n')).toBe('node_modules/\n')
  expect(withoutGodmodeLines('# godmode: setup kept on this machine only\n.godmode/\n')).toBe('')
  expect(withoutGodmodeLines('dist/\n.godmode-notes/\n')).toBeUndefined()
})
