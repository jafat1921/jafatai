import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { Columns2, Grid3x3, ImageUp, Info, LayoutGrid, PanelLeft, Square, ArrowDownUp, FastForward } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/alert-dialog'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState, ErrorState } from '@/components/studio/states'
import { useAlbumMutations, useAlbums, useClientMutations, useClients, useFacets, useMarks, usePhotoImport, usePhotoList, photosOf } from '@/hooks/useCatalogue'
import { useBreakpoint } from '@/hooks/useBreakpoint'
import { api } from '@/lib/api'
import {
  LABELS, SORTS, apiQuery, keyAction, parseSource, readFilter, sourceKey, step, writeFilter, type Album, type Client, type FilterState, type SortKey, type Source, type View,
} from '@/lib/catalogue'
import { isTypingTarget } from '@/lib/keyboard'
import { cn } from '@/lib/utils'
import { announce } from '@/stores/ui'
import { AlbumDialog, ClientDialog, type AlbumDraft, type ClientDraft } from './dialogs'
import { FilterBar } from './FilterBar'
import { ImportDialog } from './ImportDialog'
import { InfoPanel } from './InfoPanel'
import { PhotoGrid } from './PhotoGrid'
import { SourcesPanel, type NewKind } from './SourcesPanel'
import { CompareView, LoupeView, SurveyView } from './views'

type Marks = { rating?: number; flag?: 'pick' | 'reject' | 'none'; label?: string }

const VIEWS: { id: View; label: string; key: string; icon: typeof Grid3x3 }[] = [
  { id: 'grid', label: 'Grid', key: 'G', icon: LayoutGrid },
  { id: 'loupe', label: 'Loupe', key: 'E', icon: Square },
  { id: 'compare', label: 'Compare', key: 'C', icon: Columns2 },
  { id: 'survey', label: 'Survey', key: 'N', icon: Grid3x3 },
]

function stored<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key)
    return v == null ? fallback : (JSON.parse(v) as T)
  } catch {
    return fallback
  }
}
function store(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v))
  } catch {
    /* private mode */
  }
}

/** Photos · Library: sources, the filter bar, grid / loupe / compare / survey, metadata, Lightroom keys. */
export function PhotosPage() {
  const navigate = useNavigate()
  const bp = useBreakpoint()
  const [params, setParams] = useSearchParams()
  const source = parseSource(params.get('src'))
  const filter = readFilter(params)
  const inAlbum = source.kind === 'album' ? source.id : null
  const sort = (params.get('sort') as SortKey) || 'taken'
  const order = params.get('order') === 'asc' ? 'asc' : 'desc'
  const view = (params.get('view') as View) || 'grid'
  // TanStack hashes query keys by value, so a fresh object each render is fine
  const q = apiQuery(source, filter)

  const list = usePhotoList(q, sort === 'manual' && !inAlbum ? 'taken' : sort, order)
  const items = photosOf(list.data)
  const total = list.data?.pages[0]?.total ?? 0
  const facets = useFacets(q)
  const albums = useAlbums()
  const clients = useClients()
  const marks = useMarks()
  const am = useAlbumMutations()
  const cm = useClientMutations()
  const importer = usePhotoImport()

  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [anchor, setAnchor] = useState<string | null>(null)
  const [focus, setFocus] = useState(0)
  const [cols, setCols] = useState(4)
  const [cell, setCell] = useState(() => stored('mixai.photos.cell', 180))
  const [target, setTarget] = useState<string | null>(() => stored('mixai.photos.target', null))
  const [autoAdvance, setAutoAdvance] = useState(() => stored('mixai.photos.advance', false))
  const [info, setInfo] = useState(true)
  const [sourcesOpen, setSourcesOpen] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [albumDraft, setAlbumDraft] = useState<AlbumDraft | null>(null)
  const [clientDraft, setClientDraft] = useState<ClientDraft | null>(null)
  const [doomed, setDoomed] = useState<{ kind: 'album'; album: Album } | { kind: 'client'; client: Client } | { kind: 'photos'; ids: string[] } | null>(null)
  const [failure, setFailure] = useState<unknown>(null)
  const [candidate, setCandidate] = useState(1)

  // a new source or filter starts a fresh selection
  const key = params.toString()
  const lastKey = useRef(key)
  useEffect(() => {
    const was = new URLSearchParams(lastKey.current)
    lastKey.current = key
    was.delete('view')
    const now = new URLSearchParams(key)
    now.delete('view')
    if (was.toString() !== now.toString()) {
      setSelected(new Set())
      setFocus(0)
    }
  }, [key])

  const focused = items[focus]
  const selList = items.filter((m) => selected.has(m.id))
  const desktop = bp === 'wide' || bp === 'medium'
  const albumById = useMemo(() => new Map((albums.data ?? []).map((a) => [a.id, a])), [albums.data])
  const here = source.kind === 'album' ? albumById.get(source.id) : null
  const sourceName =
    source.kind === 'album' ? here?.name ?? 'Album'
      : source.kind === 'client' ? clients.data?.find((c) => c.id === source.id)?.name ?? 'Client'
        : { all: 'All photos', picks: 'Picks', rejected: 'Rejected', unsorted: 'Not yet culled', recent: 'Recently added', favourites: 'Favourites' }[source.kind]

  const setQuery = (patch: Record<string, string | null>) => {
    const p = new URLSearchParams(params)
    for (const [k, v] of Object.entries(patch)) {
      if (v == null || v === '') p.delete(k)
      else p.set(k, v)
    }
    setParams(p, { replace: true })
  }
  const setSource = (s: Source) => {
    const p = writeFilter(new URLSearchParams(), filter)
    if (s.kind !== 'all') p.set('src', sourceKey(s))
    if (params.get('sort')) p.set('sort', params.get('sort')!)
    setParams(p)
    setSourcesOpen(false)
  }
  const setFilter = (f: FilterState) => setParams(writeFilter(params, f), { replace: true })
  const setView = (v: View) => setQuery({ view: v === 'grid' ? null : v })

  // ---------------------------------------------------------------- marks
  const targets = () => (focused && selected.has(focused.id) && selected.size > 1 ? [...selected] : focused ? [focused.id] : [])
  const mark = (m: Marks, ids = targets()) => {
    if (!ids.length) return
    marks.mutate({ ids, marks: m }, { onError: setFailure })
    const what = m.rating != null ? (m.rating ? `${m.rating} stars` : 'no stars') : m.flag ? (m.flag === 'none' ? 'unflagged' : m.flag === 'pick' ? 'pick' : 'rejected') : `${m.label === 'none' ? 'no' : m.label} label`
    announce(`${ids.length === 1 ? '' : `${ids.length} photos: `}${what}`)
  }
  const advance = (e?: KeyboardEvent) => {
    if ((autoAdvance || e?.getModifierState?.('CapsLock')) && focus < items.length - 1) moveTo(focus + 1, false)
  }

  const moveTo = (i: number, extend: boolean) => {
    const m = items[i]
    if (!m) return
    setFocus(i)
    if (extend && anchor) {
      const a = items.findIndex((x) => x.id === anchor)
      const [lo, hi] = [Math.min(a, i), Math.max(a, i)]
      setSelected(new Set(items.slice(lo, hi + 1).map((x) => x.id)))
    } else {
      setSelected(new Set([m.id]))
      setAnchor(m.id)
    }
  }

  const onClickTile = (i: number, e: MouseEvent) => {
    const m = items[i]
    setFocus(i)
    if (e.shiftKey && anchor) {
      moveTo(i, true)
    } else if (e.ctrlKey || e.metaKey) {
      setSelected((s) => {
        const n = new Set(s)
        if (n.has(m.id)) n.delete(m.id)
        else n.add(m.id)
        return n
      })
      setAnchor(m.id)
    } else {
      setSelected(new Set([m.id]))
      setAnchor(m.id)
    }
  }

  const toTarget = (ids: string[]) => {
    const a = target ? albumById.get(target) : null
    if (!a) {
      announce('Set a target album first: ⋯ on an album, then "Set as target album".')
      return
    }
    const allIn = ids.every((id) => items.find((m) => m.id === id)?.album_ids?.includes(a.id))
    am.items.mutate({ id: a.id, ids, action: allIn ? 'remove' : 'add' }, { onError: setFailure })
    announce(`${allIn ? 'Removed from' : 'Added to'} ${a.name}`)
  }

  const developHref = (id: string) => `/image/studio/${id}?${new URLSearchParams({ from: 'photos', list: params.toString() }).toString()}`

  // ---------------------------------------------------------------- keys
  const dialogOpen = importOpen || !!albumDraft || !!clientDraft || !!doomed
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (dialogOpen || isTypingTarget(e.target) || document.querySelector('[role="menu"]')) return
      const a = keyAction(e)
      if (!a) return
      if (a.type === 'move') {
        const dy = view === 'grid' ? a.dy : 0
        const dx = view === 'grid' ? a.dx : a.dx || a.dy
        if (view === 'compare' && (a.dy === -1)) {
          // ↑ promotes the candidate to select
          const sel = selList.length >= 2 ? selList : items
          const c = sel[candidate]
          if (c) {
            setFocus(items.indexOf(c))
            setCandidate(1)
          }
        } else if (view === 'compare') {
          const pool = selList.length >= 2 ? selList : items
          setCandidate((c) => Math.min(pool.length - 1, Math.max(1, c + dx)))
        } else if (view === 'survey') {
          const pool = selList
          const at = pool.findIndex((m) => m.id === focused?.id)
          const next = pool[Math.min(pool.length - 1, Math.max(0, at + dx))]
          if (next) setFocus(items.indexOf(next))
        } else {
          moveTo(step(focus, items.length, cols, dx, dy), a.extend)
        }
      } else if (a.type === 'rate') {
        mark({ rating: a.value })
        advance(e)
      } else if (a.type === 'flag') {
        mark({ flag: a.value })
        advance(e)
      } else if (a.type === 'label') {
        const ids = targets()
        const same = ids.length && ids.every((id) => items.find((m) => m.id === id)?.label === a.value)
        mark({ label: same ? 'none' : a.value }, ids)
        advance(e)
      } else if (a.type === 'view') {
        setView(a.value)
      } else if (a.type === 'develop') {
        if (focused) navigate(developHref(focused.id))
      } else if (a.type === 'target') {
        toTarget(targets())
      } else if (a.type === 'remove') {
        const ids = targets()
        if (!ids.length) return
        if (here && (here.kind === 'album' || here.kind === 'shoot')) {
          am.items.mutate({ id: here.id, ids, action: 'remove' }, { onError: setFailure })
          announce(`Removed ${ids.length} from ${here.name}. The photos stay in the catalogue.`)
        } else setDoomed({ kind: 'photos', ids })
      } else if (a.type === 'selectAll') {
        setSelected(new Set(items.map((m) => m.id)))
      } else if (a.type === 'clear') {
        if (view !== 'grid') setView('grid')
        else setSelected(new Set(focused ? [focused.id] : []))
      } else if (a.type === 'info') {
        setInfo((v) => !v)
      } else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // ---------------------------------------------------------------- album / client actions
  const newThing = (kind: NewKind, parentId: string | null = null, clientId: string | null = null) => {
    if (kind === 'client') return setClientDraft({ name: '', email: '', phone: '', notes: '' })
    setAlbumDraft({
      kind, name: '', parent_id: parentId, client_id: clientId, shoot_date: kind === 'shoot' ? new Date().toISOString().slice(0, 10) : null, venue: '', notes: '',
      rules: kind === 'smart' ? { match: 'all', rules: [{ field: 'rating', op: '>=', value: 4 }] } : null,
    })
  }
  const saveAlbum = async (d: AlbumDraft) => {
    const body = { name: d.name, parent_id: d.parent_id, client_id: d.kind === 'shoot' ? d.client_id : undefined, shoot_date: d.shoot_date ?? undefined, venue: d.venue, notes: d.notes, rules: d.kind === 'smart' ? d.rules : undefined }
    if (d.id) return am.update.mutateAsync({ id: d.id, ...body } as Partial<Album> & { id: string })
    const a = await am.create.mutateAsync({ ...body, kind: d.kind } as Partial<Album> & { name: string; kind: Album['kind'] })
    // a fresh album with photos selected: put them in, which is almost always why it was made
    if ((d.kind === 'album' || d.kind === 'shoot') && selected.size > 0) await am.items.mutateAsync({ id: a.id, ids: [...selected] })
    setSource({ kind: 'album', id: a.id })
  }
  const editAlbum = (a: Album) =>
    setAlbumDraft({ id: a.id, kind: a.kind, name: a.name, parent_id: a.parent_id, client_id: a.client_id, shoot_date: a.shoot_date, venue: a.venue, notes: a.notes, rules: a.rules })
  const saveClient = async (d: ClientDraft) => (d.id ? cm.update.mutateAsync({ id: d.id, ...d }) : cm.create.mutateAsync(d))

  const confirmDelete = async () => {
    if (!doomed) return
    try {
      if (doomed.kind === 'album') {
        await am.remove.mutateAsync(doomed.album.id)
        if (inAlbum === doomed.album.id) setSource({ kind: 'all' })
        if (target === doomed.album.id) {
          setTarget(null)
          store('mixai.photos.target', null)
        }
      } else if (doomed.kind === 'client') {
        await cm.remove.mutateAsync(doomed.client.id)
        if (source.kind === 'client') setSource({ kind: 'all' })
      } else {
        for (const id of doomed.ids) await api.media.remove(id)
        setSelected(new Set())
        list.refetch()
        albums.refetch()
      }
    } catch (e) {
      setFailure(e)
    }
    setDoomed(null)
  }

  // ---------------------------------------------------------------- layout
  const sources = (
    <SourcesPanel
      source={source}
      onSource={setSource}
      albums={albums.data ?? []}
      clients={clients.data ?? []}
      totals={{ all: source.kind === 'all' && !filter.q ? total : undefined }}
      target={target}
      onTarget={(id) => {
        setTarget(id)
        store('mixai.photos.target', id)
        announce(id ? `${albumById.get(id)?.name} is the target album. Press B to add or remove photos.` : 'No target album.')
      }}
      onNew={newThing}
      onEdit={editAlbum}
      onEditClient={(c) => setClientDraft({ id: c.id, name: c.name, email: c.email, phone: c.phone, notes: c.notes })}
      onDelete={(album) => setDoomed({ kind: 'album', album })}
      onDeleteClient={(client) => setDoomed({ kind: 'client', client })}
      onDropIds={(albumId, ids) => {
        am.items.mutate({ id: albumId, ids }, { onError: setFailure })
        announce(`Added ${ids.length} photo${ids.length === 1 ? '' : 's'} to ${albumById.get(albumId)?.name ?? 'the album'}`)
      }}
    />
  )
  const details = (
    <InfoPanel
      item={focused}
      selectedCount={selected.size}
      albums={albums.data ?? []}
      onMarks={(m) => mark(m)}
      onRemoveFromAlbum={(albumId, id) => am.items.mutate({ id: albumId, ids: [id], action: 'remove' }, { onError: setFailure })}
      developHref={focused ? developHref(focused.id) : null}
    />
  )
  const pool = selList.length >= 2 ? selList : items
  const compareSelect = focused && pool.includes(focused) ? focused : pool[0]
  const others = pool.filter((m) => m !== compareSelect)

  let content: React.ReactNode
  if (list.isPending) content = <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-2">{Array.from({ length: 12 }, (_, i) => <Skeleton key={i} className="aspect-square" />)}</div>
  else if (list.isError) content = <ErrorState error={list.error} onRetry={() => list.refetch()} />
  else if (!items.length) {
    content = (
      <EmptyState
        title={source.kind === 'all' && !filter.q ? 'No photos yet' : 'Nothing matches'}
        action={<Button variant="primary" onClick={() => setImportOpen(true)}><ImageUp aria-hidden /> Import photos</Button>}
      >
        {source.kind === 'all' && !filter.q ? 'Import a shoot to start culling, rating and building albums.' : 'Try another source, or clear the filters.'}
      </EmptyState>
    )
  } else if (view === 'loupe') content = <LoupeView item={focused} info={info} index={focus} total={items.length} onPrev={() => moveTo(focus - 1, false)} onNext={() => moveTo(focus + 1, false)} />
  else if (view === 'compare') content = <CompareView select={compareSelect} candidate={others[Math.min(candidate - 1, others.length - 1)]} info={info} />
  else if (view === 'survey') content = <SurveyView items={selList} focusId={focused?.id ?? null} onFocus={(id) => setFocus(items.findIndex((m) => m.id === id))} />
  else {
    content = (
      <PhotoGrid
        items={items}
        focus={focus}
        selected={selected}
        cell={cell}
        onClickTile={onClickTile}
        onOpen={(i) => {
          moveTo(i, false)
          setView('loupe')
        }}
        onColumns={setCols}
        hasMore={!!list.hasNextPage}
        onMore={() => !list.isFetchingNextPage && list.fetchNextPage()}
      />
    )
  }

  return (
    <main data-f6-region tabIndex={-1} aria-label="Photos" className="flex h-full min-h-0 flex-col focus-visible:outline-none">
      <header className="flex flex-wrap items-center gap-2 border-b border-studio-border px-3 py-2">
        {!desktop && (
          <Button size="sm" variant="outline" onClick={() => setSourcesOpen(true)}><PanelLeft aria-hidden /> Sources</Button>
        )}
        <h1 className="font-display text-title font-semibold">{sourceName}</h1>
        {here?.kind === 'shoot' && <span className="text-small text-studio-muted">{[here.client_name, here.shoot_date, here.venue].filter(Boolean).join(' · ')}</span>}
        <span className="text-small text-studio-muted" aria-live="polite">{total} photo{total === 1 ? '' : 's'}{selected.size > 1 ? ` · ${selected.size} selected` : ''}</span>
        <div className="ml-auto flex items-center gap-1.5">
          <div role="group" aria-label="View" className="flex rounded-[6px] border border-studio-border-strong">
            {VIEWS.map((v) => (
              <button
                key={v.id}
                type="button"
                aria-pressed={view === v.id}
                title={`${v.label} (${v.key})`}
                onClick={() => setView(v.id)}
                className={cn('flex h-7 items-center gap-1 px-2 text-small first:rounded-l-[5px] last:rounded-r-[5px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-studio-accent', view === v.id ? 'bg-studio-accent text-studio-accent-fg' : 'hover:bg-studio-panel-hover')}
              >
                <v.icon aria-hidden className="size-4" />
                <span className="hidden lg:inline">{v.label}</span>
              </button>
            ))}
          </div>
          <Button size="sm" variant="primary" onClick={() => setImportOpen(true)}><ImageUp aria-hidden /> Import</Button>
          {!desktop && <Button size="sm" variant="outline" onClick={() => setDetailsOpen(true)} aria-label="Photo details"><Info aria-hidden /></Button>}
        </div>
      </header>

      <div className={cn('min-h-0 flex-1', desktop ? 'grid grid-cols-[240px_minmax(0,1fr)_300px]' : 'flex flex-col')}>
        {desktop && <aside className="min-h-0 overflow-y-auto border-r border-studio-border bg-studio-panel p-2">{sources}</aside>}

        <section aria-label="Library" className="flex min-h-0 flex-col">
          <div className="flex flex-col gap-2 border-b border-studio-border px-3 py-2">
            <FilterBar value={filter} onChange={setFilter} facets={facets.data} />
            <div className="flex flex-wrap items-center gap-3 text-small">
              <label className="flex items-center gap-1.5">
                <ArrowDownUp aria-hidden className="size-3.5 text-studio-muted" />
                <span className="sr-only">Sort by</span>
                <select value={sort} onChange={(e) => setQuery({ sort: e.target.value === 'taken' ? null : e.target.value })} className="h-7 rounded-[6px] border border-studio-border-strong bg-studio-raised px-1.5">
                  {SORTS.filter((s) => s.id !== 'manual' || inAlbum).map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
                </select>
              </label>
              <button type="button" onClick={() => setQuery({ order: order === 'desc' ? 'asc' : null })} className="rounded-[6px] px-1.5 py-0.5 hover:bg-studio-panel-hover" aria-label={`Order: ${order === 'desc' ? 'newest or highest first' : 'oldest or lowest first'}`}>
                {order === 'desc' ? '↓ Descending' : '↑ Ascending'}
              </button>
              <button
                type="button"
                aria-pressed={autoAdvance}
                title="After a mark, move to the next photo (Caps Lock does the same)"
                onClick={() => {
                  setAutoAdvance((v: boolean) => !v)
                  store('mixai.photos.advance', !autoAdvance)
                }}
                className={cn('flex items-center gap-1 rounded-[6px] px-1.5 py-0.5', autoAdvance ? 'bg-studio-accent-soft font-medium' : 'hover:bg-studio-panel-hover')}
              >
                <FastForward aria-hidden className="size-3.5" /> Auto-advance
              </button>
              {view === 'grid' && (
                <label className="ml-auto flex items-center gap-1.5">
                  <span className="text-studio-muted">Size</span>
                  <input type="range" min={110} max={360} step={10} value={cell} aria-label="Thumbnail size" onChange={(e) => { setCell(Number(e.target.value)); store('mixai.photos.cell', Number(e.target.value)) }} className="w-28 accent-[var(--accent)]" />
                </label>
              )}
              <span className="hidden text-[11px] text-studio-muted xl:inline">
                Keys: P pick · X reject · U unflag · 0–5 stars · {LABELS.filter((l) => l.key).map((l) => `${l.key} ${l.name.toLowerCase()}`).join(' · ')} · B target album · D develop
              </span>
            </div>
          </div>
          {failure != null && <div className="px-3 pt-2"><ErrorState compact title="That didn't work" error={failure} /></div>}
          <div className="min-h-0 flex-1 overflow-y-auto p-3">{content}</div>
          {view !== 'grid' && items.length > 0 && (
            <nav aria-label="Filmstrip" className="flex gap-1 overflow-x-auto border-t border-studio-border bg-studio-panel p-1.5">
              {items.map((m, i) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={(e) => onClickTile(i, e)}
                  aria-label={m.title || 'Photo'}
                  aria-current={i === focus ? 'true' : undefined}
                  className={cn('h-14 w-20 shrink-0 overflow-hidden rounded-[4px] bg-studio-darkroom', i === focus ? 'ring-2 ring-studio-gold' : selected.has(m.id) ? 'ring-2 ring-studio-accent' : 'opacity-80 hover:opacity-100', m.flag === 'reject' && 'opacity-40')}
                >
                  {m.thumb_url && <img src={m.thumb_url.replace('w=512', 'w=256')} alt="" loading="lazy" className="size-full object-cover" />}
                </button>
              ))}
            </nav>
          )}
        </section>

        {desktop && <aside aria-label="Photo details" className="min-h-0 overflow-y-auto border-l border-studio-border bg-studio-panel p-3">{details}</aside>}
      </div>

      {!desktop && (
        <>
          <Sheet open={sourcesOpen} onOpenChange={setSourcesOpen}>
            <SheetContent className="w-[300px] overflow-y-auto p-3 pt-10"><SheetTitle className="sr-only">Sources</SheetTitle>{sources}</SheetContent>
          </Sheet>
          <Sheet open={detailsOpen} onOpenChange={setDetailsOpen}>
            <SheetContent className="w-[340px] overflow-y-auto p-3 pt-10"><SheetTitle className="sr-only">Photo details</SheetTitle>{details}</SheetContent>
          </Sheet>
        </>
      )}

      <ImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        albums={albums.data ?? []}
        defaultAlbum={here && (here.kind === 'album' || here.kind === 'shoot') ? here.id : null}
        rows={importer.rows}
        onImport={importer.add}
        onClearFinished={importer.clearFinished}
        onCancel={importer.cancelAll}
      />
      <AlbumDialog draft={albumDraft} albums={albums.data ?? []} clients={clients.data ?? []} onClose={() => setAlbumDraft(null)} onSave={saveAlbum} />
      <ClientDialog draft={clientDraft} onClose={() => setClientDraft(null)} onSave={saveClient} />
      <ConfirmDialog
        open={!!doomed}
        onOpenChange={(o) => !o && setDoomed(null)}
        tone="danger"
        title={doomed?.kind === 'photos' ? `Delete ${doomed.ids.length} photo${doomed.ids.length === 1 ? '' : 's'}?` : doomed?.kind === 'client' ? `Delete ${doomed.client.name}?` : `Delete “${doomed?.kind === 'album' ? doomed.album.name : ''}”?`}
        description={
          doomed?.kind === 'photos' ? 'They are removed from the catalogue and every album, with all their versions. This can’t be undone.'
            : doomed?.kind === 'client' ? 'Their shoots and photos stay; the shoots just no longer belong to a client.'
              : doomed?.kind === 'album' && doomed.album.kind === 'folder' ? 'Albums inside move up one level. No photos are deleted.'
                : 'Only the album goes. The photos stay in the catalogue and in any other albums.'
        }
        confirmLabel="Delete"
        onConfirm={confirmDelete}
      />
    </main>
  )
}
