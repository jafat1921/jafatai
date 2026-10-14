import { useId, useRef, useState } from 'react'
import { Ban, Check, ChevronDown, Palette, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Chip } from '@/components/studio/chip'
import { useImageOptions } from '@/hooks/useMedia'
import { filterStyles, findStyle, initials } from '@/lib/styles'
import type { ImageStyle } from '@/lib/types'
import { cn } from '@/lib/utils'
import { useModelLabels } from './useModelLabel'

const NONE = '__none__'

function Thumb({ style, className }: { style: ImageStyle | undefined; className?: string }) {
  const [broken, setBroken] = useState(false)
  if (style?.preview_url && !broken) {
    return <img src={style.preview_url} alt="" loading="lazy" decoding="async" onError={() => setBroken(true)} className={cn('size-full object-cover', className)} />
  }
  // no example rendered yet (or it failed): a quiet card in the studio's own colours, never a broken image
  return (
    <span aria-hidden data-testid="style-fallback" className={cn('flex size-full items-center justify-center bg-studio-raised font-display text-studio-muted', className)}>
      {style ? initials(style.label) : <Ban className="size-5" />}
    </span>
  )
}

interface GalleryProps {
  value: string | null
  onChange: (id: string | null) => void
  // the model the form will send; with onUseModel the hint offers a one-click switch
  modelId?: string
  onUseModel?: (id: string) => void
  // e.g. "Your words only" vs "Keeps your photo" on Image to Image
  noneHint?: string
  // a template slot has to be filled: no "None" card there
  allowNone?: boolean
}

/**
 * The style picker: group tabs, search and a radio grid of 3:4 example cards. Arrow keys move and
 * pick (the radio pattern), Home/End jump, and the grid is one tab stop.
 */
export function StyleGallery({ value, onChange, modelId, onUseModel, noneHint = 'Your words only', allowNone = true }: GalleryProps) {
  const uid = useId()
  const options = useImageOptions()
  const labelOf = useModelLabels()
  const [group, setGroup] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const grid = useRef<HTMLDivElement>(null)
  const styles = options.data?.styles ?? []
  const groups = options.data?.style_groups ?? []
  const selected = findStyle(styles, value, options.data?.style_aliases)
  const shown = filterStyles(styles, groups, group, q)
  // "None" leads the grid unless a search is narrowing it
  const cards: (ImageStyle | null)[] = q.trim() || !allowNone ? shown : [null, ...shown]
  const selectedIndex = cards.findIndex((c) => (c ? c.id === selected?.id : !value))
  const tabStop = selectedIndex >= 0 ? selectedIndex : 0

  const columns = () => {
    const kids = Array.from(grid.current?.children ?? []) as HTMLElement[]
    if (!kids.length) return 1
    // jsdom lays nothing out; four is what the popover shows at desktop width
    if (kids.every((k) => k.offsetWidth === 0)) return 4
    const top = kids[0].offsetTop
    return Math.max(1, kids.filter((k) => k.offsetTop === top).length)
  }

  const move = (from: number, e: React.KeyboardEvent) => {
    const cols = columns()
    const last = cards.length - 1
    const to =
      e.key === 'ArrowRight' ? from + 1
        : e.key === 'ArrowLeft' ? from - 1
          : e.key === 'ArrowDown' ? from + cols
            : e.key === 'ArrowUp' ? from - cols
              : e.key === 'Home' ? 0
                : e.key === 'End' ? last
                  : null
    if (to === null) return
    e.preventDefault()
    const next = Math.min(last, Math.max(0, to))
    if (next === from) return
    onChange(cards[next]?.id ?? null)
    ;(grid.current?.children[next] as HTMLElement | undefined)?.focus()
  }

  if (options.isPending) return <p className="text-small text-studio-muted" role="status">Loading styles…</p>
  if (options.isError || !styles.length) {
    return (
      <div className="flex flex-col items-start gap-2">
        <p className="text-small text-studio-muted">Styles aren't available right now. Your prompt still works without one.</p>
        {options.isError && (
          <Button size="sm" variant="secondary" onClick={() => options.refetch()}>
            Try again
          </Button>
        )}
      </div>
    )
  }

  const best = selected && selected.best_model !== modelId ? selected.best_model : null
  return (
    <div className="flex min-h-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-40 flex-1">
          <Search aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-studio-muted" />
          <Input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search styles" aria-label="Search styles" className="h-8 pl-8" />
        </div>
      </div>
      <div role="group" aria-label="Style groups" className="flex flex-wrap gap-1">
        <Chip selected={group === null} onClick={() => setGroup(null)}>
          All
        </Chip>
        {groups.map((g) => (
          <Chip key={g.id} selected={group === g.id} onClick={() => setGroup(group === g.id ? null : g.id)}>
            {g.label}
          </Chip>
        ))}
      </div>
      <p className="sr-only" role="status">
        {shown.length} {shown.length === 1 ? 'style' : 'styles'}
      </p>
      {cards.length === 0 ? (
        <p className="text-small text-studio-muted">No style matches “{q.trim()}”.</p>
      ) : (
        <div ref={grid} role="radiogroup" aria-label="Style" aria-describedby={`${uid}-hint`} className="grid grid-cols-3 gap-2 sm:grid-cols-4">
          {cards.map((s, i) => {
            const on = i === selectedIndex
            return (
              <button
                key={s?.id ?? NONE}
                type="button"
                role="radio"
                aria-checked={on}
                aria-label={s ? `${s.label}, ${s.subtitle}` : `None, ${noneHint}`}
                tabIndex={i === tabStop ? 0 : -1}
                onClick={() => onChange(s?.id ?? null)}
                onKeyDown={(e) => move(i, e)}
                className={cn(
                  'group relative flex flex-col overflow-hidden rounded-[6px] border bg-studio-panel text-left transition-colors duration-150',
                  on ? 'border-studio-accent ring-2 ring-studio-accent' : 'border-studio-border-strong hover:border-studio-border-hover',
                )}
              >
                <span className="block aspect-[3/4] w-full overflow-hidden">
                  <Thumb style={s ?? undefined} className="text-lg transition-transform duration-200 group-hover:scale-[1.03] motion-reduce:transition-none" />
                </span>
                <span className="flex flex-col px-1.5 py-1">
                  <span className="truncate text-small font-medium text-studio-text">{s ? s.label : 'None'}</span>
                  <span className="truncate text-[12px] text-studio-muted">{s ? s.subtitle : noneHint}</span>
                </span>
                {on && (
                  <span aria-hidden className="absolute right-1 top-1 flex size-5 items-center justify-center rounded-full bg-studio-accent text-studio-accent-fg">
                    <Check className="size-3" />
                  </span>
                )}
              </button>
            )
          })}
        </div>
      )}
      <div id={`${uid}-hint`} className="flex flex-wrap items-center gap-2 text-small text-studio-muted">
        {selected ? (
          <>
            <span>
              {selected.label}: {selected.subtitle.toLowerCase()}. Best on {labelOf(selected.best_model) ?? selected.best_model}.
            </span>
            {best && onUseModel && (
              <Button size="sm" variant="ghost" onClick={() => onUseModel(best)}>
                Use {labelOf(best) ?? best}
              </Button>
            )}
          </>
        ) : (
          <span>Arrow keys move through the styles; the pick applies straight away.</span>
        )}
      </div>
    </div>
  )
}

/** The dock chip: the picked style's thumbnail and name, the gallery in a popover. */
export function StyleDockChip(props: GalleryProps) {
  const options = useImageOptions()
  const style = findStyle(options.data?.styles ?? [], props.value, options.data?.style_aliases)
  const label = style?.label ?? (props.value ? props.value : 'None')
  return (
    <Popover>
      <PopoverTrigger
        aria-label={`Style: ${label}`}
        className={cn(
          'inline-flex h-8 max-w-full items-center gap-1.5 rounded-full border px-3 text-small transition-colors duration-150 [&_svg]:size-3.5 [&_svg]:shrink-0',
          props.value ? 'border-studio-accent bg-studio-accent-soft text-studio-text' : 'border-studio-border-strong bg-studio-raised text-studio-text hover:bg-studio-panel-hover',
          style && 'pl-1',
        )}
      >
        {style ? (
          <span className="block size-6 shrink-0 overflow-hidden rounded-full border border-studio-border">
            <Thumb style={style} className="text-[9px]" />
          </span>
        ) : (
          <Palette aria-hidden />
        )}
        <span className="truncate">{props.value ? label : 'Style'}</span>
        <ChevronDown aria-hidden className="text-studio-muted" />
      </PopoverTrigger>
      <PopoverContent aria-label="Style" collisionPadding={12} className="flex max-h-[min(75vh,640px)] w-[min(640px,calc(100vw-24px))] flex-col gap-3 overflow-y-auto">
        <StyleGallery {...props} />
      </PopoverContent>
    </Popover>
  )
}
