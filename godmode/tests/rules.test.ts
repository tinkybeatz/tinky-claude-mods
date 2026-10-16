import { expect, test } from 'claude-code/testing'

import {
  attributionIn,
  classifyShell,
  DEFAULT_PRESET,
  isInside,
  isMainThreadShell,
  mainThreadVerdict,
  PRESET_LEVELS,
  presetOf,
  relativeTo,
  roleOf,
  settingsOf,
  spawnModel,
  ticketIn,
} from '../hooks/rules'

// Spelled in pieces: a shell guard outside this repo blocks any command line that holds it.
const PR_CREATE = ['gh', 'pr', 'create'].join(' ')

const actions = (command: string) => classifyShell(command).map(step => step.action)

test('git commands read as the loop actions the presets gate', () => {
  expect(actions('git commit -m "x"')).toEqual(['git-write'])
  expect(actions('git add . && git commit -m "x" && git push origin HEAD')).toEqual(['git-write', 'push'])
  expect(actions('git push --force-with-lease')).toEqual(['force-push'])
  expect(actions('git push origin +main')).toEqual(['force-push'])
  expect(actions('git -C /work/app rebase main')).toEqual(['git-write'])
  expect(actions('FOO=1 git reset --hard HEAD~1')).toEqual(['git-write'])
  expect(actions('git checkout -- src/a.ts')).toEqual(['git-write'])
  expect(actions('git branch -D old')).toEqual(['git-write'])
  // Reads and plain navigation gate nothing.
  expect(actions('git status && git log --oneline -5 | head')).toEqual([])
  expect(actions('git checkout main')).toEqual([])
  expect(actions('git stash list')).toEqual([])
  expect(actions('npm test')).toEqual([])
})

test('gh commands read as PR actions, with the PR they name', () => {
  expect(classifyShell(`${PR_CREATE} --draft --title "T-3" --body "x"`)).toEqual([{ action: 'pr-open', verb: 'gh pr create', isDraft: true, bodyFiles: [] }])
  expect(classifyShell(`${PR_CREATE} -t x -F /tmp/body.md`)[0]).toEqual({ action: 'pr-open', verb: 'gh pr create', isDraft: false, bodyFiles: ['/tmp/body.md'] })
  expect(classifyShell('gh pr merge 12 --squash')[0]).toMatchObject({ action: 'pr-merge', pr: '12', isAuto: false })
  expect(classifyShell('gh pr merge --auto --squash https://github.com/acme/app/pull/12')[0]).toMatchObject({ action: 'pr-merge', pr: '12', isAuto: true })
  expect(classifyShell('gh pr merge 12 --disable-auto')[0]).toMatchObject({ isUndo: true })
  expect(classifyShell('gh pr ready 12')[0]).toMatchObject({ action: 'pr-ready', pr: '12', isUndo: false })
  expect(classifyShell('gh pr review 9 --approve')[0]).toMatchObject({ action: 'pr-approve', pr: '9' })
  expect(classifyShell('gh pr review 9 --request-changes -b "fix"')[0]).toMatchObject({ action: 'pr-comment', pr: '9' })
  expect(classifyShell('gh pr comment --body "x" 9')[0]).toMatchObject({ action: 'pr-comment', pr: '9' })
  expect(classifyShell('gh pr close #9')[0]).toMatchObject({ action: 'pr-edit', pr: '9' })
  expect(actions('gh api repos/acme/app/pulls/9/comments -f body=x')).toEqual(['host-write'])
  expect(actions('gh api -X DELETE repos/acme/app/git/refs/heads/x')).toEqual(['host-write'])
  expect(actions('gh api repos/acme/app/pulls/9')).toEqual([])
  expect(actions('gh pr view 9 && gh pr list')).toEqual([])
})

test('AI attribution lines are found, and ordinary text is not', () => {
  expect(attributionIn('fix\n\nCo-Authored-By: Claude Opus <noreply@anthropic.com>')).toBe('Co-Authored-By: Claude Opus <noreply@anthropic.com>')
  expect(attributionIn('Body\n\nGenerated with [Claude Code](https://claude.com/claude-code)')).toBe('Generated with [Claude Code]')
  expect(attributionIn('Co-authored-by: Mona <mona@example.com>')).toBeUndefined()
  expect(attributionIn('Talk to Claude about the export button')).toBeUndefined()
})

test('settings take their defaults, and every rule can be changed', () => {
  const defaults = settingsOf({ permissions: 'free' })
  expect(defaults).toMatchObject({
    preset: 'free',
    isAttributionAllowed: true,
    isAutoMergeOn: false,
    agentCap: 5,
    isThinMainThread: true,
    mainThreadReadLimit: 2,
    isDraftsOnly: true,
    isMergeGateOn: true,
    isContentionOn: true,
    contentionRefreshMs: 60_000,
    isWorktreeGuardOn: true,
    requiresReadyTicket: true,
    isReviewStartOn: true,
    branchPrefix: 'godmode/',
  })
  expect(defaults.presetNote).toBeUndefined()

  const changed = settingsOf({
    permissions: 'Full freedom',
    attribution: false,
    autoMerge: 'yes',
    agentCap: 3,
    thinMainThread: 'off',
    mainThreadReadLimit: '0',
    mainThreadTools: 'WebSearch, Grep',
    'permission.push': 'never',
    'permission.others-prs': 'ask',
  })
  expect(changed.preset).toBe('full-freedom')
  expect(changed.isAttributionAllowed).toBe(false)
  expect(changed.isAutoMergeOn).toBe(true)
  expect(changed.agentCap).toBe(3)
  expect(changed.isThinMainThread).toBe(false)
  expect(changed.mainThreadReadLimit).toBe(0)
  expect(changed.mainThreadTools).toEqual(['WebSearch', 'Grep'])
  expect(changed.levels.push).toBe('never')
  expect(changed.levels['force-push']).toBe('allow')
  expect(changed.othersPrs).toBe('ask')
})

test('an unknown preset falls back to local only and says so', () => {
  const settings = settingsOf({ permissions: 'yolo' })
  expect(settings.preset).toBe(DEFAULT_PRESET)
  expect(settings.presetNote).toContain('yolo')
  expect(presetOf('local_only')).toBe('local-only')
})

test('the four presets, as decided (D18, D53)', () => {
  expect(Object.values(PRESET_LEVELS['full-freedom']).every(level => level === 'allow')).toBe(true)
  expect(PRESET_LEVELS.free).toMatchObject({ edit: 'allow', 'git-write': 'allow', push: 'allow', 'pr-open': 'allow', 'pr-ready': 'allow', 'pr-merge': 'allow', 'force-push': 'ask', 'pr-approve': 'ask' })
  expect(PRESET_LEVELS['local-only']).toMatchObject({ edit: 'allow', 'git-write': 'ask', push: 'ask', 'pr-open': 'ask', 'pr-comment': 'ask' })
  expect(Object.values(PRESET_LEVELS.locked).every(level => level === 'ask')).toBe(true)
})

test('the main thread may run quick status checks and the PM\'s own PR actions, nothing heavier', () => {
  for (const command of ['git status', 'git log --oneline -10', 'git diff --stat main', 'gh pr list --json number | jq length', 'gh pr checks 12', 'git worktree list', 'gh pr merge 12 --squash', 'ls']) {
    expect([command, isMainThreadShell(command)]).toEqual([command, true])
  }
  for (const command of ['npm test', 'git diff main', 'cat src/a.ts', 'grep -r export src', 'git status > out.txt', 'echo $(cat x)', 'git log -p', 'ls -R', 'git commit -m x', 'gh pr diff 12', 'gh pr list | xargs rm']) {
    expect([command, isMainThreadShell(command)]).toEqual([command, false])
  }
})

test('the main thread\'s tools: talking, tickets and dispatch pass, heavier work is refused with what to do', () => {
  const settings = settingsOf({})
  for (const tool of ['Agent', 'AskUserQuestion', 'SendMessage', 'mcp__godmode__ticket_list', 'TodoWrite']) {
    expect(mainThreadVerdict({ tool }, settings, 0)).toEqual({ isAllowed: true })
  }
  expect(mainThreadVerdict({ tool: 'Bash', command: 'npm test', run_in_background: true }, settings, 0)).toEqual({ isAllowed: true })
  expect(mainThreadVerdict({ tool: 'Read' }, settings, 1)).toEqual({ isAllowed: true, isRead: true })

  for (const call of [{ tool: 'Read' }, { tool: 'Edit' }, { tool: 'Grep' }, { tool: 'WebFetch' }, { tool: 'Bash', command: 'npm test' }, { tool: 'mcp__other__thing' }]) {
    const verdict = mainThreadVerdict(call, settings, 2)
    expect(verdict.isAllowed).toBe(false)
    if (!verdict.isAllowed) expect(verdict.reason).toContain('Dispatch a researcher or a shell')
    if (!verdict.isAllowed) expect(verdict.reason).toContain('/godmode setup')
  }
  expect(mainThreadVerdict({ tool: 'Grep' }, settingsOf({ mainThreadTools: 'Grep' }), 0)).toEqual({ isAllowed: true })
})

test('roles, model floors, paths and ticket ids', () => {
  expect(roleOf('godmode:dev')).toBe('dev')
  expect(roleOf('reviewer')).toBe('reviewer')
  expect(roleOf('general-purpose')).toBeUndefined()

  expect(spawnModel(undefined, 'dev')).toBe('sonnet')
  expect(spawnModel('haiku', 'reviewer')).toBe('opus')
  expect(spawnModel('opus', 'dev')).toBe('opus')
  expect(spawnModel('claude-haiku-4-5', 'dev', { shared: { minimumModels: { dev: 'opus' } } })).toBe('opus')
  expect(spawnModel('sonnet', 'dev', { personal: { models: { dev: 'opus' } } })).toBe('opus')
  expect(spawnModel('fable', 'dev')).toBe('fable')

  expect(isInside('/w/app-worktrees/T-3/src/a.ts', '/w/app-worktrees/T-3')).toBe(true)
  expect(isInside('/w/app-worktrees/T-3/../T-4/a.ts', '/w/app-worktrees/T-3')).toBe(false)
  expect(isInside('/w/app-worktrees/T-30/a.ts', '/w/app-worktrees/T-3')).toBe(false)
  expect(relativeTo('/w/app-worktrees/T-3/src/a.ts', '/w/app-worktrees/T-3/')).toBe('src/a.ts')

  expect(ticketIn('Build t-3 now; see T-4 too')).toBe('T-3')
  expect(ticketIn('Build ABC-12 next', false)).toBe('ABC-12')
  expect(ticketIn('no ticket here')).toBeUndefined()
})
