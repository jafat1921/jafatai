import { useState } from 'react'
import { useNavigate } from 'react-router'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ConfirmDialog } from '@/components/ui/alert-dialog'
import { MediaDetailSheet } from '@/components/media/MediaDetail'
import { RenameDialog } from '@/components/media/RenameDialog'
import { MoveDialog } from '@/features/library/MoveDialog'
import { RegenerateDialog } from '@/components/review/RegenerateDialog'
import { ImageUpscaleDialog } from '@/features/upscale/ImageUpscaleDialog'
import { UpscaleDialog } from '@/features/upscale/UpscaleDialog'
import { useBatchAction, useFolders } from '@/hooks/useLibraryOrg'
import { upsertMedia, useDeleteMedia, useMediaItem, useMediaRegenerate } from '@/hooks/useMedia'
import { api } from '@/lib/api'
import { mediaAlt, mediaGeneration, mediaRef } from '@/lib/media'
import { modelUsedId } from '@/lib/models'
import { upscaleInfo } from '@/lib/upscale'
import type { MediaDetail, MediaItem, RegenerateMode } from '@/lib/types'
import { useFavourites } from '@/stores/favourites'
import { trackJobs } from '@/stores/toasts'
import { announce } from '@/stores/ui'
import { Lightbox, type LightboxEntry } from './Lightbox'
import type { TileHandlers } from './TileActions'

export function entryFor(item: MediaItem, detail?: MediaDetail | null, fav = false): LightboxEntry {
  const gen = detail?.versions?.find((v) => v.id === item.generation_id) ?? detail?.versions?.[0]
  const p = { ...(item.params ?? {}), ...(gen?.params ?? {}) }
  const w = (p.width as number | undefined) ?? item.width
  const h = (p.height as number | undefined) ?? item.height
  // an upscaled version compares against the one it was made from
  const up = gen ? upscaleInfo(gen) : null
  const source = up?.sourceId ? detail?.versions?.find((v) => v.id === up.sourceId && v.media_url) : undefined
  return {
    key: item.id,
    kind: item.kind,
    src: item.media_url ?? gen?.media_url ?? null,
    poster: item.thumb_url,
    title: mediaAlt(item),
    prompt: gen?.prompt || item.prompt || null,
    modelId: modelUsedId(gen?.params, item.params, { model: item.model }),
    seed: gen?.seed ?? item.seed ?? null,
    size: w && h ? `${w}×${h}` : null,
    brandKitId: typeof p.brand_kit_id === 'string' ? p.brand_kit_id : null,
    createdAt: gen?.created_at ?? item.created_at,
    projectId: item.project_id,
    generationId: item.generation_id,
    favourite: fav,
    compare: source?.media_url ? { src: source.media_url, label: `Original · v${source.version}`, afterLabel: `Upscaled · v${gen?.version ?? ''}`.trim() } : null,
    originalId: item.original_generation_id ?? source?.id ?? null,
  }
}

const viewable = (m: MediaItem) => !!(m.media_url || m.thumb_url)

interface Options {
  items: MediaItem[]
  // page-specific: put the picture into this page's own reference slot
  onUseAsRef?: (item: MediaItem) => void
  refLabel?: string
  // page-specific: refill the dock from this result
  reuse?: (item: MediaItem) => void
}

/**
 * Everything a results grid opens: the lightbox, regenerate / upscale / delete dialogs and the
 * versions sheet. Returns the tile handlers plus the node that hosts those overlays.
 */
export function useMediaHost({ items, onUseAsRef, refLabel = 'Use as reference', reuse }: Options) {
  const navigate = useNavigate()
  const [viewing, setViewing] = useState<string | null>(null)
  const [detail, setDetail] = useState<string | null>(null)
  const [regen, setRegen] = useState<{ item: MediaItem; mode: 'note' | 'edit' } | null>(null)
  const [upscaling, setUpscaling] = useState<MediaItem | null>(null)
  const [deleting, setDeleting] = useState<MediaItem | null>(null)
  const [moving, setMoving] = useState<MediaItem | null>(null)
  const [renaming, setRenaming] = useState<MediaItem | null>(null)
  const regenerate = useMediaRegenerate()
  const remove = useDeleteMedia()
  const move = useBatchAction()
  const { folders } = useFolders(moving?.kind, !!moving)
  const qc = useQueryClient()
  const rename = useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) => api.media.update(id, { title }),
    onSuccess: (item) => {
      upsertMedia(qc, item)
      setRenaming(null)
      announce(`Renamed to ${mediaAlt(item)}.`)
    },
  })
  const favs = useFavourites()
  const shown = items.filter(viewable)
  const index = viewing ? shown.findIndex((m) => m.id === viewing) : -1
  const current = index >= 0 ? shown[index] : undefined
  const currentDetail = useMediaItem(current?.id).data

  const runRegenerate = (item: MediaItem, mode: RegenerateMode, extra?: { note?: string; prompt?: string }) =>
    regenerate.mutate(
      { id: item.id, mode, ...extra },
      {
        onSuccess: (job) => {
          trackJobs([job], mediaAlt(item))
          setRegen(null)
          announce(`Regenerating ${mediaAlt(item)}. A new version is queued.`)
        },
      },
    )

  const handlers: TileHandlers = {
    open: (item) => setViewing(item.id),
    details: (item) => setDetail(item.id),
    regenerate: (item, mode) => (mode === 'same' ? runRegenerate(item, 'same') : setRegen({ item, mode })),
    upscale: setUpscaling,
    remove: setDeleting,
    edit: (item) => navigate(`/image/edit?sources=${item.id}`),
    img2img: (item) => navigate(`/image/img2img?source=${item.id}`),
    move: setMoving,
    rename: (item) => {
      rename.reset()
      setRenaming(item)
    },
    animate: (item) => navigate(`/video/img2vid?image=${item.id}`),
    onUseAsRef: (item) => {
      setViewing(null)
      if (onUseAsRef) onUseAsRef(item)
      else navigate(`/image/edit?sources=${item.id}`)
    },
    favourite: (item) => announce(favs.toggle(item.id) ? `${mediaAlt(item)} added to favourites.` : `${mediaAlt(item)} removed from favourites.`),
    reuse: (item) => {
      setViewing(null)
      if (reuse) return reuse(item)
      const q = new URLSearchParams()
      if (item.prompt) q.set('prompt', item.prompt)
      const model = modelUsedId(item.params, { model: item.model })
      if (model) q.set('model', model)
      navigate(`${item.kind === 'video' ? '/video/create' : '/image/generate'}?${q}`)
    },
    refLabel,
  }

  const byKey = (fn: (m: MediaItem) => void) => (e: LightboxEntry) => {
    const m = shown.find((x) => x.id === e.key)
    if (m) fn(m)
  }

  const failure = regenerate.error ?? remove.error ?? move.error

  const host = (
    <>
      <Lightbox
        entries={shown.map((m) => entryFor(m, m.id === current?.id ? currentDetail : null, favs.ids.includes(m.id)))}
        index={index >= 0 ? index : null}
        onIndex={(i) => setViewing(shown[i]?.id ?? null)}
        onClose={() => setViewing(null)}
        refLabel={refLabel}
        actions={{
          favourite: byKey(handlers.favourite),
          upscale: byKey((m) => {
            setViewing(null)
            setUpscaling(m)
          }),
          edit: byKey(handlers.edit),
          animate: byKey(handlers.animate),
          onUseAsRef: byKey(handlers.onUseAsRef),
          reuse: byKey(handlers.reuse),
          details: byKey((m) => {
            setViewing(null)
            setDetail(m.id)
          }),
        }}
      />
      <MediaDetailSheet id={detail} onClose={() => setDetail(null)} />
      <RegenerateDialog
        mode={regen?.mode ?? null}
        initialPrompt={regen?.item.prompt ?? ''}
        onOpenChange={(o) => !o && setRegen(null)}
        onSubmit={(v) => regen && runRegenerate(regen.item, regen.mode, v)}
        pending={regenerate.isPending}
      />
      <ImageUpscaleDialog source={upscaling?.kind === 'image' ? mediaGeneration(upscaling) : null} subject="Image" onOpenChange={(o) => !o && setUpscaling(null)} />
      <UpscaleDialog render={upscaling?.kind === 'video' ? mediaGeneration(upscaling) : null} onOpenChange={(o) => !o && setUpscaling(null)} />
      <MoveDialog
        open={!!moving}
        count={1}
        folders={folders}
        current={moving?.folder_id ?? null}
        rootLabel={moving?.kind === 'video' ? 'All videos' : 'All images'}
        onOpenChange={(o) => !o && setMoving(null)}
        onMove={(folderId) => {
          const item = moving
          setMoving(null)
          if (item) move.mutate({ action: 'move', refs: [mediaRef(item)], options: { folder_id: folderId } }, { onSuccess: () => announce(`Moved ${mediaAlt(item)}.`) })
        }}
      />
      <RenameDialog
        item={renaming}
        pending={rename.isPending}
        error={rename.error?.message}
        onOpenChange={(o) => !o && setRenaming(null)}
        onRename={(title) => renaming && rename.mutate({ id: renaming.id, title })}
      />
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Delete “${deleting ? mediaAlt(deleting) : ''}”?`}
        description="This removes the item and all of its versions from your library. It can't be undone."
        confirmLabel="Delete"
        tone="danger"
        onConfirm={() => {
          const item = deleting
          setDeleting(null)
          if (item) remove.mutate(item.id, { onSuccess: () => announce(`Deleted ${mediaAlt(item)}.`) })
        }}
      />
    </>
  )

  return { handlers, host, failure }
}
