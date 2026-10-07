import { useId, useLayoutEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { X } from 'lucide-react'
import { Textarea } from '@/components/ui/textarea'
import { api } from '@/lib/api'
import {
  insertMention,
  keyOf,
  knownOption,
  MENTION_GROUPS,
  mentionRefCount,
  queryAt,
  rememberOptions,
  serialize,
  toDisplay,
  tokensOf,
  uniqueMentions,
  unlink,
  type MentionOption,
} from '@/lib/mentions'
import { cn } from '@/lib/utils'

type Native = Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange' | 'defaultValue'>

export interface MentionOptions {
  projectId?: string
  // how many reference pictures the request can take in all; 0 = names only
  refBudget?: number
  // already taken by the request itself (edit sources)
  refsUsed?: number
  // shown when refBudget is 0, e.g. why the model can't take pictures
  namesOnlyNote?: string
}

interface Props extends Native, MentionOptions {
  value: string
  onValueChange: (v: string) => void
  textareaRef?: React.RefObject<HTMLTextAreaElement | null>
}

function useMentionSearch(q: string | null, projectId?: string) {
  return useQuery({
    queryKey: ['mentions', q, projectId ?? null],
    queryFn: async () => {
      const rows = await api.mentions.search({ q: q ?? '', project_id: projectId })
      const list = Array.isArray(rows) ? rows : []
      rememberOptions(list)
      return list
    },
    enabled: q !== null,
    staleTime: 30_000,
    retry: false,
  })
}

/**
 * The prompt textarea with @-mentions. It stays a real textarea (screen readers, IME, dir=auto for Urdu);
 * the field shows `@Mara`, the value carries the server token.
 */
export function MentionTextarea({ value, onValueChange, textareaRef, projectId, refBudget, refsUsed = 0, namesOnlyNote, onKeyDown, onSelect, className, ...rest }: Props) {
  const uid = useId()
  const own = useRef<HTMLTextAreaElement>(null)
  const field = textareaRef ?? own
  const [at, setAt] = useState<{ start: number; query: string; caret: number } | null>(null)
  const [active, setActive] = useState(0)
  const [dismissedAt, setDismissedAt] = useState<number | null>(null)
  const caretNext = useRef<number | null>(null)
  const display = toDisplay(value)
  const open = !!at && at.start !== dismissedAt
  const search = useMentionSearch(open ? at.query : null, projectId)
  const options = search.data ?? []
  const grouped = MENTION_GROUPS.map((g) => ({ ...g, items: options.filter((o) => o.type === g.type) })).filter((g) => g.items.length)
  const flat = grouped.flatMap((g) => g.items)
  const activeOpt = open ? flat[Math.min(active, flat.length - 1)] : undefined
  const optId = (o: MentionOption) => `${uid}-o-${keyOf(o)}`

  useLayoutEffect(() => {
    if (caretNext.current === null || !field.current) return
    field.current.setSelectionRange(caretNext.current, caretNext.current)
    caretNext.current = null
  }, [value, field])

  const track = (el: HTMLTextAreaElement) => {
    const caret = el.selectionStart ?? el.value.length
    let q = el.selectionStart === el.selectionEnd ? queryAt(el.value, caret) : null
    // just past a finished mention ("@Harbour |") isn't a new search
    if (q && tokensOf(value).some((t) => q!.query.length >= t.label.length && el.value.startsWith(t.label, q!.start + 1))) q = null
    // a new query starts at the top of the list
    if (q?.query !== at?.query) setActive(0)
    setAt(q ? { ...q, caret } : null)
    if (!q) setDismissedAt(null)
  }

  const pick = (o: MentionOption) => {
    if (!at) return
    const next = insertMention(value, at.start, at.caret, o)
    caretNext.current = next.caret
    onValueChange(next.value)
    setAt(null)
    field.current?.focus()
  }

  const mentions = uniqueMentions(value)
  const refs = mentionRefCount(value)
  const over = refBudget !== undefined && refBudget > 0 && refs + refsUsed > refBudget

  return (
    <div className="relative flex flex-col gap-1.5">
      <Textarea
        {...rest}
        ref={field}
        value={display}
        dir="auto"
        aria-autocomplete="list"
        aria-controls={open ? `${uid}-list` : undefined}
        aria-activedescendant={activeOpt ? optId(activeOpt) : undefined}
        onChange={(e) => {
          onValueChange(serialize(e.target.value, tokensOf(value)))
          track(e.target)
        }}
        onSelect={(e) => {
          track(e.currentTarget)
          onSelect?.(e)
        }}
        onBlur={(e) => {
          // let a click on a suggestion land first
          setTimeout(() => setAt(null), 120)
          rest.onBlur?.(e)
        }}
        onKeyDown={(e) => {
          if (open && !e.nativeEvent.isComposing) {
            if (e.key === 'Escape') {
              e.preventDefault()
              e.stopPropagation()
              setDismissedAt(at.start)
              return
            }
            if (flat.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
              e.preventDefault()
              setActive((i) => (i + (e.key === 'ArrowDown' ? 1 : -1) + flat.length) % flat.length)
              return
            }
            if (activeOpt && (e.key === 'Enter' || e.key === 'Tab') && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
              e.preventDefault()
              pick(activeOpt)
              return
            }
          }
          onKeyDown?.(e)
        }}
        className={className}
      />

      {open && (
        <div
          id={`${uid}-list`}
          role="listbox"
          aria-label="Mention suggestions"
          className="absolute inset-x-0 top-full z-30 mt-1 max-h-72 overflow-y-auto rounded-[6px] border border-studio-border-strong bg-studio-raised p-1 shadow-pop"
        >
          {search.isPending ? (
            <p className="px-2 py-1.5 text-small text-studio-muted">Looking for “{at.query || '…'}”…</p>
          ) : search.isError ? (
            <p className="px-2 py-1.5 text-small text-studio-muted">Couldn't load suggestions. Keep typing, or press Esc.</p>
          ) : !flat.length ? (
            <p className="px-2 py-1.5 text-small text-studio-muted">
              {at.query ? `Nothing called “${at.query}”.` : 'Nothing to mention yet.'} Add cast and locations in a project, or products and logos in a Brand Kit.
            </p>
          ) : (
            grouped.map((g) => (
              <div key={g.type} role="group" aria-label={g.label}>
                <div aria-hidden className="section-label px-2 pb-0.5 pt-1.5">
                  {g.label}
                </div>
                {g.items.map((o) => {
                  const on = activeOpt === o
                  return (
                    <div
                      key={keyOf(o)}
                      id={optId(o)}
                      role="option"
                      aria-selected={on}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => pick(o)}
                      onMouseEnter={() => setActive(flat.indexOf(o))}
                      className={cn('flex cursor-pointer items-center gap-2 rounded-[4px] px-2 py-1', on ? 'bg-studio-accent-soft' : 'hover:bg-studio-panel-hover')}
                    >
                      <span className="darkroom size-8 shrink-0 overflow-hidden rounded-[4px]">
                        {o.thumb_url ? <img src={o.thumb_url} alt="" className="size-full object-cover" /> : null}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-body" dir="auto">
                          {o.label}
                        </span>
                        {(o.hint || !o.ref_generation_id) && (
                          <span className="block truncate text-small text-studio-muted">
                            {[o.hint, o.ref_generation_id ? null : 'no picture yet'].filter(Boolean).join(' · ')}
                          </span>
                        )}
                      </span>
                    </div>
                  )
                })}
              </div>
            ))
          )}
        </div>
      )}

      {mentions.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <ul aria-label="Mentions" className="flex flex-wrap gap-1.5">
            {mentions.map((m) => {
              const o = knownOption(m)
              return (
                <li key={keyOf(m)} className="inline-flex h-7 items-center gap-1 rounded-full border border-studio-border-strong bg-studio-raised pl-0.5 pr-1 text-small">
                  <span className="darkroom size-6 overflow-hidden rounded-full">{o?.thumb_url ? <img src={o.thumb_url} alt="" className="size-full object-cover" /> : null}</span>
                  <span dir="auto" className="max-w-40 truncate">
                    {m.label}
                  </span>
                  <button
                    type="button"
                    onClick={() => onValueChange(unlink(value, m))}
                    aria-label={`Remove the mention of ${m.label}`}
                    className="flex size-5 items-center justify-center rounded-full text-studio-muted hover:bg-studio-panel-hover hover:text-studio-text"
                  >
                    <X aria-hidden className="size-3" />
                  </button>
                </li>
              )
            })}
          </ul>
          <p className={cn('text-small', over ? 'text-studio-danger' : 'text-studio-muted')} aria-live="polite">
            {refBudget === undefined
              ? `${mentions.length} mentioned`
              : refBudget === 0
                ? (namesOnlyNote ?? 'Names only: this model takes no reference pictures, so a short description goes in instead.')
                : over
                  ? `Uses ${refs + refsUsed} of ${refBudget} references. Remove a mention to run.`
                  : `Uses ${refs + refsUsed} of ${refBudget} references`}
          </p>
        </div>
      )}
    </div>
  )
}
