import { useEffect } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { ChevronLeft, ChevronRight, LayoutGrid } from 'lucide-react'
import { api } from '@/lib/api'
import { apiQuery, parseSource, readFilter } from '@/lib/catalogue'
import { isTypingTarget } from '@/lib/keyboard'

/**
 * Opened from Photos: the way back to the same grid, and previous / next through the same source,
 * filter and sort (Lightroom's filmstrip in Develop). Ctrl+← / Ctrl+→ step; plain arrows stay with sliders.
 */
export function LibraryNav({ itemId }: { itemId: string | null }) {
  const [search] = useSearchParams()
  const navigate = useNavigate()
  const raw = search.get('from') === 'photos' ? (search.get('list') ?? '') : null
  const list = new URLSearchParams(raw ?? '')
  const q = { ...apiQuery(parseSource(list.get('src')), readFilter(list)), sort: list.get('sort') || 'taken', order: list.get('order') || 'desc' }
  const n = useQuery({
    queryKey: ['photos', 'neighbours', itemId, raw],
    queryFn: () => api.photos.neighbours(itemId!, q),
    enabled: raw != null && !!itemId,
  })
  const go = (id: string | null | undefined) => id && navigate(`/image/studio/${id}?${search.toString()}`)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (raw == null || isTypingTarget(e.target)) return
      if (e.key.toLowerCase() === 'g' && !e.ctrlKey && !e.metaKey && !e.altKey && !document.querySelector('[role="dialog"]')) {
        e.preventDefault()
        navigate(`/photos?${raw}`)
        return
      }
      if (!(e.ctrlKey || e.metaKey)) return
      if (e.key === 'ArrowLeft' && n.data?.prev) {
        e.preventDefault()
        go(n.data.prev)
      } else if (e.key === 'ArrowRight' && n.data?.next) {
        e.preventDefault()
        go(n.data.next)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  if (raw == null) return null
  return (
    <nav aria-label="Library" className="flex items-center gap-2 border-b border-studio-border bg-studio-panel px-3 py-1 text-small">
      <Link to={`/photos?${raw}`} className="flex items-center gap-1 rounded-[6px] px-1.5 py-0.5 hover:bg-studio-panel-hover">
        <LayoutGrid aria-hidden className="size-4" /> Library (G)
      </Link>
      <span className="ml-auto text-studio-muted" aria-live="polite">
        {n.data?.position ? `${n.data.position} of ${n.data.total}` : n.data ? `${n.data.total} in this set` : ''}
      </span>
      <button type="button" onClick={() => go(n.data?.prev)} disabled={!n.data?.prev} aria-label="Previous photo (Ctrl+←)" className="rounded-[6px] p-1 hover:bg-studio-panel-hover disabled:opacity-40">
        <ChevronLeft className="size-4" />
      </button>
      <button type="button" onClick={() => go(n.data?.next)} disabled={!n.data?.next} aria-label="Next photo (Ctrl+→)" className="rounded-[6px] p-1 hover:bg-studio-panel-hover disabled:opacity-40">
        <ChevronRight className="size-4" />
      </button>
    </nav>
  )
}
