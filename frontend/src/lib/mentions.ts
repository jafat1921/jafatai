// @-mentions (contract v8 P2). The prompt state holds the server format, `@[Mara](character:<id>)`;
// the textarea shows `@Mara` and keeps the link through the token list, so the field stays a plain textarea.

export type MentionType = 'character' | 'location' | 'product' | 'logo'

export interface MentionRef {
  label: string
  type: MentionType
  id: string
}

export interface MentionOption extends MentionRef {
  hint?: string | null
  thumb_url?: string | null
  ref_generation_id?: string | null
}

// Create Image turns mentioned pictures into a composition on the default edit model (Qwen edit: 3 inputs)
export const MENTION_REFS = 3

export const MENTION_GROUPS: { type: MentionType; label: string }[] = [
  { type: 'character', label: 'Cast' },
  { type: 'location', label: 'Locations' },
  { type: 'product', label: 'Products' },
  { type: 'logo', label: 'Logos' },
]

const TOKEN = /@\[([^\]\n]{1,120})\]\((character|location|product|logo):([A-Za-z0-9_-]{1,64})\)/g
// a letter or digit right after the name means it's a longer word, not the mention
const WORD = /[\p{L}\p{N}_]/u

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
export const tokenOf = (r: MentionRef) => `@[${r.label}](${r.type}:${r.id})`
export const keyOf = (r: Pick<MentionRef, 'type' | 'id'>) => `${r.type}:${r.id}`

/** Names can't carry the token's own brackets. */
export const cleanLabel = (s: string) => s.replace(/[[\]()\n]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120)

/** Every token, in order (repeats included). */
export function tokensOf(text: string): MentionRef[] {
  return [...(text ?? '').matchAll(TOKEN)].map((m) => ({ label: m[1], type: m[2] as MentionType, id: m[3] }))
}

/** One entry per mentioned thing, in order of first appearance. */
export function uniqueMentions(text: string): MentionRef[] {
  const seen = new Map<string, MentionRef>()
  for (const t of tokensOf(text)) if (!seen.has(keyOf(t))) seen.set(keyOf(t), t)
  return [...seen.values()]
}

/** What the textarea shows: `@Mara`. */
export const toDisplay = (text: string) => (text ?? '').replace(TOKEN, (_, label: string) => `@${label}`)

/** Plain names, for titles, session rows and the magic-prompt preview. */
export const plainPrompt = (text: string) => (text ?? '').replace(TOKEN, (_, label: string) => label)

function byLabel(refs: MentionRef[]) {
  const map = new Map<string, MentionRef>()
  for (const r of refs) if (!map.has(r.label)) map.set(r.label, r)
  return map
}

function labelPattern(labels: string[]) {
  // longest first, so "@Mara Khan" wins over "@Mara"
  return labels.sort((a, b) => b.length - a.length).map(escape).join('|')
}

/** Display text back to the server format: each `@Name` we know becomes its token again. */
export function serialize(display: string, refs: MentionRef[]): string {
  const map = byLabel(refs)
  if (!map.size) return display
  const re = new RegExp(`@(${labelPattern([...map.keys()])})`, 'gu')
  return display.replace(re, (whole, label: string, offset: number, all: string) => {
    const next = all.charAt(offset + whole.length)
    return next && WORD.test(next) ? whole : tokenOf(map.get(label)!)
  })
}

/**
 * After the magic prompt rewrites the text (with plain names), link the names again: `@Name` first,
 * otherwise the first whole-word use of the name. Mentions whose name is gone are dropped.
 */
export function relink(text: string, refs: MentionRef[]): string {
  let out = serialize(text, refs)
  for (const r of byLabel(refs).values()) {
    if (out.includes(tokenOf(r))) continue
    const re = new RegExp(`(^|[^\\p{L}\\p{N}_@\\[])(${escape(r.label)})(?![\\p{L}\\p{N}_])`, 'u')
    out = out.replace(re, (_, pre: string) => `${pre}${tokenOf(r)}`)
  }
  return out
}

/** Swap one mention for its plain name (its picture stops being a reference). */
export function unlink(text: string, r: Pick<MentionRef, 'type' | 'id'>): string {
  return (text ?? '').replace(TOKEN, (whole, label: string, type: string, id: string) => (type === r.type && id === r.id ? label : whole))
}

/** The "@query" being typed at the caret, or null. Names can have spaces, so the query can too. */
export function queryAt(display: string, caret: number): { start: number; query: string } | null {
  const before = display.slice(0, caret)
  const at = before.lastIndexOf('@')
  if (at < 0) return null
  const prev = at > 0 ? before.charAt(at - 1) : ''
  if (prev && !/\s|[(“"'«]/u.test(prev)) return null
  const query = before.slice(at + 1)
  if (query.length > 40 || /\n/.test(query) || /^\s/.test(query) || /\s{2}/.test(query)) return null
  return { start: at, query }
}

/** Two different things with the same name would collide in the display text; tell them apart. */
export function uniqueLabel(o: MentionOption, taken: MentionRef[]): string {
  const base = cleanLabel(o.label) || o.type
  const clash = taken.some((t) => t.label === base && keyOf(t) !== keyOf(o))
  if (!clash) return base
  return cleanLabel(`${base} ${o.hint || o.type}`)
}

/** Insert the picked option in place of the "@query" at [start, caret). Returns the new prompt and caret. */
export function insertMention(value: string, start: number, caret: number, o: MentionOption) {
  const display = toDisplay(value)
  const refs = tokensOf(value)
  const label = uniqueLabel(o, refs)
  const piece = `@${label} `
  const nextDisplay = display.slice(0, start) + piece + display.slice(caret).replace(/^ /, '')
  return {
    value: serialize(nextDisplay, [...refs, { label, type: o.type, id: o.id }]),
    caret: start + piece.length,
  }
}

// what we've seen from /mentions, so chips have thumbnails and the reference count knows who has a picture
const seen = new Map<string, MentionOption>()
export const rememberOptions = (opts: MentionOption[]) => opts.forEach((o) => seen.set(keyOf(o), o))
export const knownOption = (r: Pick<MentionRef, 'type' | 'id'>) => seen.get(keyOf(r))

/**
 * How many reference pictures the mentions add. A mention we haven't looked up (a reused prompt) is
 * counted, since the server would most likely find a picture for it.
 */
export function mentionRefCount(text: string): number {
  return uniqueMentions(text).filter((r) => {
    const o = knownOption(r)
    return !o || !!o.ref_generation_id
  }).length
}
