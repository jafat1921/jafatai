import { useEffect, useRef, type MouseEvent } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { Flag, PanelBottom, PanelLeft, PanelRight, X } from 'lucide-react'
import { photosOf, usePhotoList } from '@/hooks/useCatalogue'
import { LABELS, apiQuery, parseSource, readFilter, type SortKey } from '@/lib/catalogue'
import type { MediaItem } from '@/lib/types'
import { cn } from '@/lib/utils'

export type StripPlace = 'bottom' | 'left' | 'right'

// Lightroom's filmstrip filter, in one menu
const FILTERS: { id: string; label: string; q: Record<string, string | number | boolean> }[] = [
  { id: '', label: 'All', q: {} },
  { id: 'picks', label: 'Picks', q: { flag: 'pick' } },
  { id: 'unflagged', label: 'Unflagged', q: { flag: 'none' } },
  { id: 'nonreject', label: 'Not rejected', q: { flag: 'pick,none' } },
  ...[1, 2, 3, 4, 5].map((n) => ({ id: `s${n}`, label: `${'★'.repeat(n)} and up`, q: { rating_min: n } })),
  { id: 'edited', label: 'Edited', q: { edited: true } },
  { id: 'unedited', label: 'Not edited', q: { edited: false } },
  ...LABELS.map((l) => ({ id: `l-${l.id}`, label: `${l.name} label`, q: { label: l.id } })),
]

interface Props {
  currentId: string | null
  place: StripPlace
  onPlace: (p: StripPlace) => void
  size: number
  filter: string
  onFilter: (f: string) => void
  selected: Set<string>
  onSelected: (s: Set<string>) => void
}

/**
 * The pictures around this one (the Photos source it was opened from, or the whole catalogue):
 * click to switch, Ctrl/Shift-click to pick several for Sync. Sits under the photo or beside it.
 */
export function SourceStrip({ currentId, place, onPlace, size, filter, onFilter, selected, onSelected }: Props) {
  const [search] = useSearchParams()
  const navigate = useNavigate()
  const list = new URLSearchParams(search.get('from') === 'photos' ? (search.get('list') ?? '') : '')
  const extra = FILTERS.find((f) => f.id === filter)?.q ?? {}
  const q = { ...apiQuery(parseSource(list.get('src')), readFilter(list)), ...extra }
  const sort = (list.get('sort') as SortKey) || 'taken'
  const order = list.get('order') === 'asc' ? 'asc' : 'desc'
  const photos = usePhotoList(q, sort === 'manual' && !q.album_id ? 'taken' : sort, order)
  const items = photosOf(photos.data)
  const current = useRef<HTMLButtonElement | null>(null)
  const vertical = place !== 'bottom'

  useEffect(() => {
    current.current?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  }, [currentId, items.length])

  const open = (m: MediaItem) => {
    const s = new URLSearchParams(search)
    if (!s.get('from')) s.set('from', 'photos')
    navigate(`/image/studio/${m.id}?${s.toString()}`)
  }
  const click = (m: MediaItem, e: MouseEvent) => {
    if (e.ctrlKey || e.metaKey) {
      const n = new Set(selected)
      if (n.has(m.id)) n.delete(m.id)
      else n.add(m.id)
      if (currentId) n.add(currentId)
      onSelected(n)
    } else if (e.shiftKey && currentId) {
      const a = items.findIndex((x) => x.id === currentId)
      const b = items.findIndex((x) => x.id === m.id)
      onSelected(new Set(items.slice(Math.min(a, b), Math.max(a, b) + 1).map((x) => x.id)))
    } else {
      onSelected(new Set())
      open(m)
    }
  }

  const Icon = { bottom: PanelBottom, left: PanelLeft, right: PanelRight }[place]
  return (
    <nav aria-label="Filmstrip" className={cn('flex min-h-0 gap-1 bg-studio-panel', vertical ? 'h-full flex-col p-1' : 'flex-col px-1.5 pb-1.5 pt-1')}>
      <div className={cn('flex items-center gap-1.5 text-[11px] text-studio-muted', vertical && 'flex-wrap')}>
        <span className="truncate">{photos.data?.pages[0]?.total ?? 0} photos{selected.size > 1 ? ` · ${selected.size} selected for Sync` : ''}</span>
        <label className="ml-auto flex items-center gap-1">
          <span className="sr-only">Filmstrip filter</span>
          <select value={filter} onChange={(e) => onFilter(e.target.value)} className="h-6 rounded-[4px] border border-studio-border-strong bg-studio-raised px-1">
            {FILTERS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
          </select>
        </label>
        <button
          type="button"
          aria-label={`Filmstrip: ${place}. Move it`}
          title="Move the filmstrip (bottom, left, right)"
          onClick={() => onPlace(place === 'bottom' ? 'left' : place === 'left' ? 'right' : 'bottom')}
          className="rounded-[4px] p-0.5 hover:bg-studio-panel-hover hover:text-studio-text"
        >
          <Icon className="size-4" />
        </button>
      </div>
      <div className={cn('flex gap-1', vertical ? 'min-h-0 flex-1 flex-col overflow-y-auto' : 'overflow-x-auto')}>
        {items.map((m) => {
          const on = m.id === currentId
          const picked = selected.has(m.id)
          return (
            <button
              key={m.id}
              ref={on ? current : undefined}
              type="button"
              onClick={(e) => click(m, e)}
              aria-current={on ? 'true' : undefined}
              aria-pressed={picked}
              aria-label={`${m.title || 'Photo'}${on ? ' (open)' : ''}`}
              title={m.title}
              className={cn(
                'relative shrink-0 overflow-hidden rounded-[4px] bg-studio-darkroom focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-studio-accent',
                on ? 'ring-2 ring-studio-gold' : picked ? 'ring-2 ring-studio-accent' : 'opacity-85 hover:opacity-100',
                m.flag === 'reject' && 'opacity-40',
              )}
              style={vertical ? { width: '100%', height: Math.round(size * 0.7) } : { width: Math.round(size * 1.4), height: size }}
            >
              {m.thumb_url && <img src={m.thumb_url.replace('w=512', 'w=256')} alt="" loading="lazy" className="size-full object-cover" draggable={false} />}
              <span className="absolute bottom-0.5 left-0.5 flex items-center gap-0.5">
                {m.flag === 'pick' && <Flag aria-hidden className="size-3 fill-white text-white drop-shadow" />}
                {m.flag === 'reject' && <X aria-hidden className="size-3 text-white drop-shadow" />}
                {!!m.rating && <span className="text-[10px] leading-none text-white drop-shadow">{'★'.repeat(m.rating)}</span>}
                {m.label && <span className="size-2 rounded-full ring-1 ring-black/30" style={{ background: LABELS.find((l) => l.id === m.label)?.swatch }} />}
              </span>
            </button>
          )
        })}
        {photos.hasNextPage && (
          <button type="button" onClick={() => photos.fetchNextPage()} className="shrink-0 rounded-[4px] px-2 text-[11px] text-studio-muted hover:bg-studio-panel-hover">More…</button>
        )}
      </div>
    </nav>
  )
}
