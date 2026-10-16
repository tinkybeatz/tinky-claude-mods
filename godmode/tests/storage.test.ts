import { expect, test } from 'claude-code/testing'

import {
  changedConventions,
  effectiveModel,
  ensureGitignore,
  fingerprint,
  isOlderVersion,
  projectOf,
  readNote,
  withGitignoreLines,
} from '../hooks/storage'
import { draft, FIRST_COMMIT, HOME, makeWorld, REPO, setUpProject, worldEngine } from './world'

const where = {
  committed: `${REPO}/.godmode`,
  gitignored: `${REPO}/.godmode`,
  outside: `${HOME}/.claude/godmode/projects/${FIRST_COMMIT}`,
} as const

for (const storage of ['committed', 'gitignored', 'outside'] as const) {
  test(`${storage} storage reads back its own note`, async () => {
    const world = makeWorld()
    const dir = await setUpProject(world, { storage })

    const found = await readNote(worldEngine(world))

    expect(dir).toBe(where[storage])
    expect(found.status).toBe('found')
    if (found.status !== 'found') return
    expect(found.dir).toBe(where[storage])
    expect(found.shared.storage).toBe(storage)
    expect(found.shared.godmodeVersion).toBe('0.2.0')
    expect(found.shared.writtenAt).toBe('2026-10-16T09:30:00.000Z')
    expect(found.shared.answers).toEqual(draft().sharedAnswers)
    expect(found.shared.minimumModels).toEqual({ reviewer: 'opus' })
    expect(found.shared.conventions).toEqual([{ path: 'AGENTS.md', fingerprint: await fingerprint('# Agent rules\n') }])
    expect(found.personal?.answers).toEqual(draft().personalAnswers)
    expect(found.personal?.models).toEqual({ dev: 'sonnet' })
  })
}

test('outside storage leaves the project folder untouched', async () => {
  const world = makeWorld()
  await setUpProject(world, { storage: 'outside' })

  const inRepo = [...world.files.keys()].filter(path => path.startsWith(`${REPO}/`))

  expect(inRepo).toEqual([`${REPO}/AGENTS.md`])
})

test('the project is named by its first commit, from the main working tree', async () => {
  const world = makeWorld({ sessionRoot: '/work/app-worktrees/T-4', git: { root: REPO, firstCommit: FIRST_COMMIT } })

  const project = await projectOf(worldEngine(world))

  expect(project).toEqual({ id: FIRST_COMMIT, root: REPO, hasGit: true })
})

test('a folder with no git, or a repo with no commit yet, is named by its path', async () => {
  const noGit = await projectOf(worldEngine(makeWorld({ git: undefined, sessionRoot: '/work/My Notes' })))
  const noCommit = await projectOf(worldEngine(makeWorld({ git: { root: REPO } })))

  expect(noGit).toEqual({ id: 'path-work-My-Notes', root: '/work/My Notes', hasGit: false })
  expect(noCommit).toEqual({ id: 'path-work-app', root: REPO, hasGit: true })
})

test('a fingerprint catches an edit, and ignores line endings', async () => {
  const world = makeWorld()
  await setUpProject(world)
  const $ = worldEngine(world)
  const found = await readNote($)
  if (found.status !== 'found') throw new Error('no note')

  world.files.set(`${REPO}/AGENTS.md`, '# Agent rules\r\n')
  expect(await changedConventions($, found.project, found.shared.conventions)).toEqual([])

  world.files.set(`${REPO}/AGENTS.md`, '# Agent rules\n\nNever push to main.\n')
  expect(await changedConventions($, found.project, found.shared.conventions)).toEqual(['AGENTS.md'])
})

test('gitignored storage excludes `.godmode/` through .git/info/exclude once, leaving .gitignore untouched', async () => {
  const world = makeWorld()
  world.files.set(`${REPO}/.gitignore`, 'node_modules/\ndist')
  world.files.set(`${REPO}/.git/info/exclude`, '# git ls-files --others --exclude-from=.git/info/exclude\n')

  await setUpProject(world, { storage: 'gitignored' })
  await setUpProject(world, { storage: 'gitignored' })

  expect(world.files.get(`${REPO}/.gitignore`)).toBe('node_modules/\ndist')
  expect(world.files.get(`${REPO}/.git/info/exclude`)).toBe(
    '# git ls-files --others --exclude-from=.git/info/exclude\n\n# godmode: setup kept on this machine only\n.godmode/\n',
  )
})

test('committed storage ignores the personal note alone; outside storage leaves .gitignore alone', async () => {
  const committed = makeWorld()
  await setUpProject(committed, { storage: 'committed' })
  const outside = makeWorld()
  await setUpProject(outside, { storage: 'outside' })

  expect(committed.files.get(`${REPO}/.gitignore`)).toBe('# godmode: personal setup, never committed\n.godmode/personal.json\n')
  expect(outside.files.has(`${REPO}/.gitignore`)).toBe(false)
})

test('a line already in .gitignore, anchored or not, is not added again', async () => {
  const world = makeWorld()
  world.files.set(`${REPO}/.gitignore`, '/.godmode/\n')
  const $ = worldEngine(world)

  const wrote = await ensureGitignore($, await projectOf($), ['.godmode/'])

  expect(wrote).toBe(false)
  expect(withGitignoreLines('', ['.godmode/'])).toBe('# godmode: personal setup, never committed\n.godmode/\n')
})

test('effectiveModel takes the default, raised to the shared minimum', () => {
  expect(effectiveModel('dev')).toBe('sonnet')
  expect(effectiveModel('reviewer')).toBe('opus')
  expect(effectiveModel('dev', { shared: { minimumModels: { dev: 'opus' } } })).toBe('opus')
  expect(effectiveModel('qa', { shared: { minimumModels: { qa: 'haiku' } } })).toBe('sonnet')
})

test('effectiveModel lets a personal pick raise the minimum, never lower it', () => {
  const shared = { minimumModels: { reviewer: 'opus', dev: 'sonnet' } } as const

  expect(effectiveModel('dev', { shared, personal: { models: { dev: 'opus' } } })).toBe('opus')
  expect(effectiveModel('dev', { shared, personal: { models: { dev: 'haiku' } } })).toBe('sonnet')
  expect(effectiveModel('reviewer', { shared, personal: { models: { reviewer: 'sonnet' } } })).toBe('opus')
  expect(effectiveModel('researcher', { personal: { models: { researcher: 'haiku' } } })).toBe('haiku')
})

test('versions compare by number, not by text', () => {
  expect(isOlderVersion('0.1.0', '0.2.0')).toBe(true)
  expect(isOlderVersion('0.9.0', '0.10.0')).toBe(true)
  expect(isOlderVersion('0.10.0', '0.9.0')).toBe(false)
  expect(isOlderVersion('1.0.0', '1.0.0')).toBe(false)
  expect(isOlderVersion('1.2', '1.2.1')).toBe(true)
})
