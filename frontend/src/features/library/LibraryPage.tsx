import { useDeferredValue, useId, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { ChevronRight, Download, Film, Heart, Images, Loader2, Search, Wand2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Chip } from '@/components/studio/chip'
import { EmptyState } from '@/components/studio/states'
import { MediaDetailSheet } from '@/components/media/MediaDetail'
import { MediaGrid } from '@/components/media/MediaGrid'
import { UploadZone } from '@/components/media/UploadZone'
import { TopBarActions } from '@/components/shell/TopBarActions'
import { useJobs } from '@/hooks/useJobs'
import { folderPath, useBatchAction, useFolderMutations, useFolders } from '@/hooks/useLibraryOrg'
import { flatItems, libraryFilter, LIBRARY_ORIGINS as ORIGINS, useMediaList, type OriginFilter } from '@/hooks/useMedia'
import { api } from '@/lib/api'
import { mediaAlt, mediaRef } from '@/lib/media'
import { clickSelect, EMPTY_SELECTION, marqueeSelect, type Selection } from '@/lib/selection'
import type { BatchResult, MediaItem, MediaKind } from '@/lib/types'
import { plural } from '@/lib/utils'
import { useGenerateInto } from '@/stores/generateInto'
import { trackJobs } from '@/stores/toasts'
import { announce } from '@/stores/ui'
import { BatchBar, type BatchRun } from './BatchBar'
import { flatTree } from '@/lib/folders'
import { FolderTree } from './FolderTree'
import { MoveDialog } from './MoveDialog'
import { SavedFilters, type LibraryQuery } from './SavedFilters'

const typing = (el: EventTarget | null) => el instanceof HTMLElement && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName))

function resultText(res: BatchResult, verb: string) {
  const done = res.done.length
  const head = done ? `${verb} ${plural(done, 'item')}.` : `Nothing ${verb.toLowerCase()}.`
  if (!res.skipped.length) return head
  const reasons = [...new Set(res.skipped.map((s) => s.reason))].slice(0, 2).join('; ')
  return `${head} ${plural(res.skipped.length, 'skipped', 'skipped')}: ${reasons}.`
}

const VERB: Record<BatchResult['action'], string> = { delete: 'Deleted', download: 'Zipping', upscale: 'Queued upscales for', move: 'Moved', tag: 'Tagged' }

export function LibraryPage({ kind }: { kind: MediaKind }) {
  const uid = useId()
  const [params, setParams] = useSearchParams()
  const folderId = params.get('folder')
  // ?open=<id>: "Open in Library" from an upscale card lands on that item's versions
  const openId = params.get('open')
  const [q, setQ] = useState('')
  const [origin, setOrigin] = useState<OriginFilter>('all')
  const [tag, setTag] = useState<string | null>(null)
  const [fav, setFav] = useState(false)
  const query = useDeferredValue(q)
  const filter = libraryFilter(kind, origin, query, tag, { folderId, favourite: fav })
  const list = useMediaList(filter)
  const items = flatItems(list.data)
  const { folders } = useFolders(kind)
  const folderOps = useFolderMutations()
  const batch = useBatchAction()
  const jobs = useJobs().data
  const setInto = useGenerateInto((s) => s.set)

  // selection belongs to one view of the grid; changing folder or filters starts afresh
  const viewKey = JSON.stringify(filter)
  const [selState, setSelState] = useState<{ key: string; sel: Selection }>({ key: viewKey, sel: EMPTY_SELECTION })
  const sel = selState.key === viewKey ? selState.sel : EMPTY_SELECTION
  const setSel = (next: Selection) => setSelState({ key: viewKey, sel: next })
  const ids = new Set(sel.ids)
  const selected = items.filter((m) => ids.has(m.id))
  const order = items.map((m) => m.id)

  const [moving, setMoving] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [zipJobId, setZipJobId] = useState<string | null>(null)
  const zipJob = zipJobId ? jobs?.find((j) => j.id === zipJobId) : undefined

  // TODO: ask the server for the tag list; this only knows tags on pages already loaded
  const tags = [...new Set(items.flatMap((m) => m.tags ?? []))].sort().slice(0, 12)
  const noun = kind === 'image' ? 'images' : 'videos'
  const rootLabel = kind === 'image' ? 'All images' : 'All videos'
  const filtered = !!(query.trim() || tag || origin !== 'all' || fav)
  const path = folderPath(folders, folderId)
  const here = path.at(-1)

  const openFolder = (id: string | null) => {
    const next = new URLSearchParams(params)
    if (id) next.set('folder', id)
    else next.delete('folder')
    setParams(next)
  }

  const run = (action: BatchResult['action'], refs: string[], options?: Record<string, unknown>, after?: () => void) => {
    setNotice(null)
    batch.mutate(
      { action, refs, options },
      {
        onSuccess: (res) => {
          const text = resultText(res, VERB[res.action])
          setNotice(text)
          announce(text)
          if (res.jobs?.length) trackJobs(res.jobs, action === 'download' ? 'Zip download' : `Upscale ${plural(res.jobs.length, 'item')}`)
          if (action === 'download' && res.jobs?.[0]) setZipJobId(res.jobs[0].id)
          if (action === 'delete' || action === 'move') setSel(EMPTY_SELECTION)
          after?.()
        },
        onError: (e) => setNotice(e.message),
      },
    )
  }
  const refsOf = (list: MediaItem[]) => list.map(mediaRef)
  const onBatch = (r: BatchRun) => run(r.action, refsOf(selected), 'options' in r ? r.options : undefined)
  const moveTo = (target: string | null, refs = refsOf(selected)) => {
    setMoving(false)
    run('move', refs, { folder_id: target })
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (typing(e.target) || e.altKey || (e.target as HTMLElement).closest('[role="dialog"],[role="alertdialog"],[role="menu"]')) return
    const k = e.key.toLowerCase()
    if ((e.ctrlKey || e.metaKey) && k === 'a') {
      e.preventDefault()
      setSel({ ids: order, anchor: order[0] ?? null })
      announce(`Selected ${plural(order.length, 'item')}.`)
    } else if (e.key === 'Escape' && sel.ids.length) {
      e.preventDefault()
      setSel(EMPTY_SELECTION)
      announce('Selection cleared.')
    } else if (k === 'm' && !e.ctrlKey && !e.metaKey && sel.ids.length) {
      e.preventDefault()
      setMoving(true)
    }
  }

  const applySaved = (sq: LibraryQuery) => {
    setOrigin((ORIGINS.some((o) => o.value === sq.origin) ? sq.origin : 'all') as OriginFilter)
    setTag(sq.tag ?? null)
    setQ(sq.q ?? '')
    setFav(!!sq.favourite)
    openFolder(sq.folder_id ?? null)
  }

  const tree = (
    <FolderTree
      folders={folders}
      current={folderId}
      rootLabel={rootLabel}
      onOpen={openFolder}
      onDropRefs={(target, refs) => moveTo(target, refs)}
      onCreate={(name, parent) =>
        folderOps.create.mutate({ name, parent_id: parent, kind }, { onSuccess: (f) => announce(`Made the folder ${f.name}.`) })
      }
      onRename={(id, name) => folderOps.rename.mutate({ id, name })}
      onDelete={(f) =>
        folderOps.remove.mutate(f.id, {
          onSuccess: () => {
            announce(`Deleted the folder ${f.name}. Its contents moved up.`)
            if (folderId === f.id || path.some((p) => p.id === f.id)) openFolder(f.parent_id)
          },
        })
      }
    />
  )

  return (
    <main data-f6-region tabIndex={-1} onKeyDown={onKeyDown} className="h-full overflow-y-auto focus-visible:outline-none" aria-labelledby={`${uid}-title`}>
      <TopBarActions>
        <Button asChild size="sm" variant="primary">
          <Link to={kind === 'image' ? '/image/generate' : '/video/create'} onClick={() => here && setInto(kind, here.id)}>
            <Wand2 aria-hidden />
            {here ? `Create ${kind} in “${here.name}”` : kind === 'image' ? 'Create image' : 'Create video'}
          </Link>
        </Button>
      </TopBarActions>
      <div className="mx-auto flex max-w-[1440px] gap-6 px-4 py-6 md:px-8">
        <aside className="hidden w-56 shrink-0 md:block">
          <div className="sticky top-4">{tree}</div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col gap-4">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="min-w-0">
              <nav aria-label="Folder path" className="mb-0.5">
                <ol className="flex flex-wrap items-center gap-1 text-small text-studio-muted">
                  <li>
                    {folderId ? (
                      <button type="button" className="hover:text-studio-text hover:underline" onClick={() => openFolder(null)}>
                        {kind === 'image' ? 'Image library' : 'Video library'}
                      </button>
                    ) : (
                      <span>{kind === 'image' ? 'Image library' : 'Video library'}</span>
                    )}
                  </li>
                  {path.map((f, i) => (
                    <li key={f.id} className="flex items-center gap-1">
                      <ChevronRight aria-hidden className="size-3" />
                      {i === path.length - 1 ? (
                        <span aria-current="location" className="text-studio-text">
                          {f.name}
                        </span>
                      ) : (
                        <button type="button" className="hover:text-studio-text hover:underline" onClick={() => openFolder(f.id)}>
                          {f.name}
                        </button>
                      )}
                    </li>
                  ))}
                </ol>
              </nav>
              <h1 id={`${uid}-title`} className="font-display text-title font-semibold">
                {here?.name ?? (kind === 'image' ? 'Image library' : 'Video library')}
              </h1>
              <p className="text-body text-studio-muted">
                {here
                  ? 'Drag pictures onto a folder on the left, or select them and press M to move.'
                  : kind === 'image'
                    ? 'Everything you created, uploaded or approved in a project.'
                    : 'Finished films from every project, quick videos and uploads.'}
              </p>
            </div>
            <div className="relative">
              <Search aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-studio-muted" />
              <Input type="search" placeholder={`Search ${noun}`} aria-label={`Search ${noun}`} value={q} onChange={(e) => setQ(e.target.value)} className="w-64 pl-8" />
            </div>
          </div>

          {/* phones get the folders as a picker; the tree needs room */}
          {folders.length > 0 && (
            <label className="flex items-center gap-2 text-small md:hidden">
              <span className="section-label">Folder</span>
              <select
                value={folderId ?? ''}
                onChange={(e) => openFolder(e.target.value || null)}
                className="h-8 min-w-0 flex-1 rounded-[6px] border border-studio-border-strong bg-studio-raised px-2 text-body"
              >
                <option value="">{rootLabel}</option>
                {flatTree(folders).map(({ folder, depth }) => (
                  <option key={folder.id} value={folder.id}>
                    {`${'  '.repeat(depth)}${folder.name}`}
                  </option>
                ))}
              </select>
            </label>
          )}

          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <div role="group" aria-label="Where from" className="flex flex-wrap gap-1">
              {ORIGINS.map((o) => (
                <Chip key={o.value} selected={origin === o.value} onClick={() => setOrigin(o.value)}>
                  {o.label}
                </Chip>
              ))}
            </div>
            <Chip selected={fav} onClick={() => setFav((f) => !f)} icon={<Heart aria-hidden />}>
              Favourites
            </Chip>
            {tags.length > 0 && (
              <div role="group" aria-label="Tags" className="flex flex-wrap items-center gap-1">
                <span className="section-label mr-1">Tags</span>
                {tags.map((t) => (
                  <Chip key={t} selected={tag === t} onClick={() => setTag(tag === t ? null : t)}>
                    {t}
                  </Chip>
                ))}
              </div>
            )}
          </div>
          <SavedFilters
            current={{ kind, origin: origin === 'all' ? undefined : origin, q: query.trim() || undefined, tag, favourite: fav, folder_id: folderId }}
            canSave={filtered || !!folderId}
            onApply={applySaved}
          />

          <UploadZone compact kinds={[kind]} />

          {(notice || zipJob) && (
            <div role="status" className="flex flex-wrap items-center gap-2 rounded-[6px] border border-studio-border bg-studio-raised px-3 py-2 text-small">
              {notice && <span>{notice}</span>}
              {zipJob && (zipJob.status === 'queued' || zipJob.status === 'running') && (
                <span className="flex items-center gap-1 text-studio-muted">
                  <Loader2 aria-hidden className="size-3.5 motion-safe:animate-spin" />
                  Making the zip{zipJob.status === 'running' ? ` · ${Math.round(zipJob.progress * 100)}%` : ''}
                </span>
              )}
              {zipJob?.status === 'done' && (
                <a href={api.exportUrl(zipJob.id)} download className="inline-flex items-center gap-1 font-medium text-studio-accent-hover underline underline-offset-2">
                  <Download aria-hidden className="size-3.5" />
                  Download the zip
                </a>
              )}
              {zipJob?.status === 'failed' && <span className="text-studio-danger">The zip failed: {zipJob.error ?? 'unknown error'}</span>}
            </div>
          )}

          <MediaGrid
            label={kind === 'image' ? 'Images' : 'Videos'}
            items={items}
            loading={list.isPending}
            error={list.isError ? list.error : undefined}
            onRetry={() => list.refetch()}
            hasMore={list.hasNextPage}
            loadingMore={list.isFetchingNextPage}
            onLoadMore={() => list.fetchNextPage()}
            selection={{
              ids,
              onSelect: (item, mods) => {
                const next = clickSelect(sel, order, item.id, mods)
                setSel(next)
                announce(`${mediaAlt(item)} ${next.ids.includes(item.id) ? 'selected' : 'not selected'}. ${plural(next.ids.length, 'selected', 'selected')}.`)
              },
              onMarquee: (hits, additive) => setSel(marqueeSelect(sel, hits, additive)),
              // dragging a picked tile carries the whole selection
              dragRefs: (item) => (ids.has(item.id) ? refsOf(selected) : [mediaRef(item)]),
            }}
            empty={
              filtered ? (
                <EmptyState icon={<Search />} title={`No ${noun} match`}>
                  Try another word or filter.
                </EmptyState>
              ) : folderId ? (
                <EmptyState icon={kind === 'image' ? <Images /> : <Film />} title="This folder is empty">
                  Drag {noun} onto it from {rootLabel.toLowerCase()}, or pick it under “Generate into” on the prompt dock.
                </EmptyState>
              ) : (
                <EmptyState icon={kind === 'image' ? <Images /> : <Film />} title={`No ${noun} yet`}>
                  {kind === 'image' ? 'Create an image or upload one, and it lands here.' : 'Finish a quick video or a project render, or upload a clip.'}
                </EmptyState>
              )
            }
          />

          {selected.length > 0 && (
            <BatchBar
              selected={selected}
              total={items.length}
              busy={batch.isPending}
              onSelectAll={() => setSel({ ids: order, anchor: order[0] ?? null })}
              onClear={() => setSel(EMPTY_SELECTION)}
              onMove={() => setMoving(true)}
              onRun={onBatch}
            />
          )}
        </div>
      </div>
      <MediaDetailSheet
        id={openId}
        onClose={() => {
          const next = new URLSearchParams(params)
          next.delete('open')
          setParams(next, { replace: true })
        }}
      />
      <MoveDialog open={moving} count={selected.length} folders={folders} current={folderId} rootLabel={rootLabel} onOpenChange={setMoving} onMove={(t) => moveTo(t)} />
    </main>
  )
}
