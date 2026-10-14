import type { Dispatch } from '../types'

/**
 * Groups rows by who started them. An agent or shell that a dispatched agent started
 * has that agent as `parentId`; the panel draws one card per top-level row and lists
 * the rest inside it. A row whose parent is not tracked (cleared, or never seen) is
 * top-level itself.
 */
export type Tree = {
  /** Each row's top-level ancestor's id. */
  rootIdOf: (row: Dispatch) => string
  /** The rows a row started, in the order they were tracked. */
  childrenOf: (id: string) => Dispatch[]
}

export const buildTree = (rows: readonly Dispatch[]): Tree => {
  const byId = new Map(rows.map(row => [row.id, row]))
  const children = new Map<string, Dispatch[]>()
  for (const row of rows) {
    if (row.parentId === undefined || !byId.has(row.parentId)) continue
    children.set(row.parentId, [...(children.get(row.parentId) ?? []), row])
  }
  const rootIdOf = (row: Dispatch) => {
    let current = row
    const seen = new Set<string>()
    while (current.parentId !== undefined && !seen.has(current.id)) {
      seen.add(current.id)
      const parent = byId.get(current.parentId)
      if (parent === undefined) break
      current = parent
    }
    return current.id
  }
  return { rootIdOf, childrenOf: id => children.get(id) ?? [] }
}

/** The ids of the top-level rows whose tree still has a row running. */
export const liveRootIds = (rows: readonly Dispatch[], isRunning: (row: Dispatch) => boolean) => {
  const tree = buildTree(rows)
  return new Set(rows.filter(isRunning).map(tree.rootIdOf))
}

/** Drops the rows of every tree with nothing left running; a finished child of a live tree stays. */
export const dropFinishedTrees = (rows: readonly Dispatch[], isRunning: (row: Dispatch) => boolean) => {
  const tree = buildTree(rows)
  const live = liveRootIds(rows, isRunning)
  return rows.filter(row => live.has(tree.rootIdOf(row)))
}

export type Descendant = { row: Dispatch; depth: number; isLast: boolean }

/** A row's descendants, depth first, each with its depth below the row and whether it is its parent's last child. */
export const descendantsOf = (tree: Tree, id: string, depth = 0): Descendant[] => {
  const children = tree.childrenOf(id)
  return children.flatMap((row, index) => [
    { row, depth, isLast: index === children.length - 1 },
    ...descendantsOf(tree, row.id, depth + 1),
  ])
}
