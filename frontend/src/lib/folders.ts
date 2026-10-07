import type { Folder } from './types'

export function childrenOf(folders: Folder[], parent: string | null) {
  return folders.filter((f) => (f.parent_id ?? null) === parent).sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name))
}

/** Depth-first, for the keyboard Move dialog and the phone's folder picker. */
export function flatTree(folders: Folder[], parent: string | null = null, depth = 0): { folder: Folder; depth: number }[] {
  return childrenOf(folders, parent).flatMap((f) => [{ folder: f, depth }, ...flatTree(folders, f.id, depth + 1)])
}

export function isAncestor(folders: Folder[], ancestor: string, id: string) {
  let cur = folders.find((f) => f.id === id)
  const seen = new Set<string>()
  while (cur?.parent_id && !seen.has(cur.id)) {
    seen.add(cur.id)
    if (cur.parent_id === ancestor) return true
    cur = folders.find((f) => f.id === cur!.parent_id)
  }
  return false
}
