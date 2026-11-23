import { expect, test } from 'claude-code/testing'

import { codeReviewOf, protectionCount } from '../hooks/code-review'
import { makeWorld, REPO, worldEngine } from './world'
import type { World } from './world'

/*
 * Required human code review (D77): only each reviewer's latest review counts, never the
 * author's nor the person's own; GitHub's reviewDecision is followed where it gives one.
 */

const HEAD = 'a1b2c3d4e5'
const OLD = '0f9e8d7c6b'

type Review = { login: string; state: string; commit: string }

/** A world whose `gh pr view 12` answers these reviews, by `author`, with GitHub's `decision`. */
const prWith = (reviews: Review[], decision: string | null = null, author = 'dev-bot'): World => {
  const world = makeWorld({ gh: { login: 'me', prs: [] } })
  world.answer = run =>
    run.argv.slice(0, 3).join(' ') === 'gh pr view'
      ? {
          exitCode: 0,
          stdout: JSON.stringify({
            headRefOid: HEAD,
            reviewDecision: decision,
            author: { login: author },
            reviews: reviews.map(review => ({ author: { login: review.login }, state: review.state, commit: { oid: review.commit } })),
          }),
        }
      : undefined
  return world
}

const reviewOf = (world: World, rule = { count: 1, reviewers: '' }) => codeReviewOf(worldEngine(world), REPO, '12', rule, 'me')

test('anyone may approve, but never the PR\'s author nor the person running godmode', async () => {
  const selfOnly = prWith([
    { login: 'dev-bot', state: 'APPROVED', commit: HEAD },
    { login: 'me', state: 'APPROVED', commit: HEAD },
  ])
  expect(await reviewOf(selfOnly)).toEqual({ kind: 'waiting', have: 0, need: 1 })

  const colleague = prWith([{ login: 'bob', state: 'APPROVED', commit: HEAD }])
  expect(await reviewOf(colleague)).toEqual({ kind: 'approved', have: 1, need: 1 })
  expect(await reviewOf(colleague, { count: 2, reviewers: '' })).toEqual({ kind: 'waiting', have: 1, need: 2 })
})

test('with named reviewers, only their approvals count', async () => {
  const bobOnly = prWith([{ login: 'bob', state: 'APPROVED', commit: HEAD }])
  expect(await reviewOf(bobOnly, { count: 1, reviewers: 'carol' })).toEqual({ kind: 'waiting', have: 0, need: 1 })

  const carol = prWith([{ login: 'carol', state: 'APPROVED', commit: HEAD }])
  expect(await reviewOf(carol, { count: 1, reviewers: '@carol, dan' })).toEqual({ kind: 'approved', have: 1, need: 1 })
})

test('a stale approval counts only when GitHub kept it, and a dismissed one never does', async () => {
  expect(await reviewOf(prWith([{ login: 'bob', state: 'APPROVED', commit: OLD }]))).toEqual({ kind: 'waiting', have: 0, need: 1 })
  expect(await reviewOf(prWith([{ login: 'bob', state: 'APPROVED', commit: OLD }], 'APPROVED'))).toEqual({ kind: 'approved', have: 1, need: 1 })
  const dismissed = prWith([
    { login: 'bob', state: 'APPROVED', commit: HEAD },
    { login: 'bob', state: 'DISMISSED', commit: HEAD },
  ])
  expect(await reviewOf(dismissed)).toEqual({ kind: 'waiting', have: 0, need: 1 })
})

test('GitHub\'s REVIEW_REQUIRED holds even when godmode counts enough, and changes requested holds the merge', async () => {
  expect(await reviewOf(prWith([{ login: 'bob', state: 'APPROVED', commit: HEAD }], 'REVIEW_REQUIRED'))).toEqual({ kind: 'waiting', have: 1, need: 1 })
  const changes = prWith([
    { login: 'bob', state: 'APPROVED', commit: HEAD },
    { login: 'carol', state: 'CHANGES_REQUESTED', commit: HEAD },
  ])
  expect(await reviewOf(changes)).toEqual({ kind: 'changes', by: ['carol'] })
})

test('branch protection\'s approval count is read when gh can, and is undefined when the read fails', async () => {
  const world = makeWorld({ gh: { login: 'me', prs: [] } })
  world.answer = run => {
    const line = run.argv.join(' ')
    if (line.startsWith('gh repo view')) return { exitCode: 0, stdout: 'acme/app\n' }
    if (line.startsWith('gh api repos/acme/app/branches/main/protection')) return { exitCode: 0, stdout: '2\n' }
    return undefined
  }
  expect(await protectionCount(worldEngine(world), REPO, 'main')).toBe(2)

  world.answer = run => {
    const line = run.argv.join(' ')
    if (line.startsWith('gh repo view')) return { exitCode: 0, stdout: 'acme/app\n' }
    if (line.startsWith('gh api')) return { exitCode: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' }
    return undefined
  }
  expect(await protectionCount(worldEngine(world), REPO, 'main')).toBeUndefined()
})
