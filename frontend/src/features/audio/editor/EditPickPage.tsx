import { useDeferredValue, useState } from 'react'
import { Link } from 'react-router'
import { Scissors, Search } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState, ErrorState } from '@/components/studio/states'
import { flatItems, useMediaList } from '@/hooks/useMedia'
import { clock } from '@/lib/audio'
import { minus } from '@/lib/audio-edit'
import { mediaAlt } from '@/lib/media'

/** /audio/edit with nothing open: pick a track from the Library. */
export function EditPickPage() {
  const [q, setQ] = useState('')
  const query = useDeferredValue(q.trim())
  const list = useMediaList({ kind: 'audio', include: 'project', ...(query ? { q: query } : {}) })
  const items = flatItems(list.data).filter((m) => m.media_url)

  return (
    <main data-f6-region tabIndex={-1} aria-labelledby="edit-pick-title" className="relative h-full overflow-y-auto focus-visible:outline-none">
      <div className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-6 md:px-8">
        <header className="flex flex-col gap-1">
          <h1 id="edit-pick-title" className="font-display text-title font-semibold">
            Editor
          </h1>
          <p className="text-small text-studio-muted">Pick a song, cue or effect to trim, fade, sweeten and level. Every save is a new version; the original stays.</p>
        </header>
        <div className="relative">
          <Search aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-studio-muted" />
          <Input type="search" aria-label="Search audio" placeholder="Search audio" value={q} onChange={(e) => setQ(e.target.value)} className="pl-8" />
        </div>
        {list.isPending ? (
          <div className="flex flex-col gap-2">
            {Array.from({ length: 5 }, (_, i) => (
              <Skeleton key={i} className="h-11" />
            ))}
          </div>
        ) : list.isError ? (
          <ErrorState error={list.error} onRetry={() => list.refetch()} />
        ) : items.length === 0 ? (
          <EmptyState icon={<Scissors />} title={query ? `Nothing matches “${query}”` : 'No audio yet'}>
            Make a song, score or sound effect first, or upload one in the Library.
          </EmptyState>
        ) : (
          <ul aria-label="Audio" className="divide-y divide-studio-border rounded-[6px] border border-studio-border bg-studio-panel">
            {items.map((m) => (
              <li key={m.id}>
                <Link to={`/audio/edit/${m.id}`} className="flex items-center gap-3 px-3 py-2.5 hover:bg-studio-panel-hover">
                  <Scissors aria-hidden className="size-4 shrink-0 text-studio-muted" />
                  <span className="min-w-0 flex-1 truncate text-body">{mediaAlt(m)}</span>
                  {m.analysis?.lufs_i != null && <span className="shrink-0 font-mono text-[11px] text-studio-faint">{minus(m.analysis.lufs_i, 1)} LUFS</span>}
                  {m.duration_s ? <span className="shrink-0 font-mono text-[11px] text-studio-muted">{clock(m.duration_s)}</span> : null}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  )
}
