// Cheap word-level diff — enough to see what a "with note" regeneration changed.
export function promptDiff(prev: string | undefined, next: string) {
  if (prev === undefined) return null
  const a = new Set(prev.toLowerCase().split(/\s+/).filter(Boolean))
  const b = new Set(next.toLowerCase().split(/\s+/).filter(Boolean))
  const added = [...b].filter((w) => !a.has(w))
  const removed = [...a].filter((w) => !b.has(w))
  return { added, removed }
}

export type DiffPart = { type: 'same' | 'add' | 'del'; text: string }

// Tokens keep their trailing whitespace so joining parts reproduces the text exactly.
const tokenize = (s: string) => s.match(/\S+\s*|\s+/g) ?? []

function lcsDiff(a: string[], b: string[]): DiffPart[] {
  const n = a.length
  const m = b.length
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = a[i].trim() === b[j].trim() ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  const out: DiffPart[] = []
  const push = (type: DiffPart['type'], text: string) => {
    const last = out[out.length - 1]
    if (last?.type === type) last.text += text
    else out.push({ type, text })
  }
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i].trim() === b[j].trim()) {
      push('same', b[j])
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) push('del', a[i++])
    else push('add', b[j++])
  }
  while (i < n) push('del', a[i++])
  while (j < m) push('add', b[j++])
  return out
}

/** Word-level diff for suggestion cards. Very long texts fall back to a line diff to bound the table size. */
export function wordDiff(before: string, after: string): DiffPart[] {
  const a = tokenize(before)
  const b = tokenize(after)
  if (a.length * b.length <= 2_000_000) return lcsDiff(a, b)
  const lines = (s: string) => s.split(/(?<=\n)/)
  return lcsDiff(lines(before), lines(after))
}
