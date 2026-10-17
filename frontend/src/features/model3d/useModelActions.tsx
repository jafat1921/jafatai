import { useId, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { RenameDialog } from '@/components/media/RenameDialog'
import { ConfirmDialog } from '@/components/ui/alert-dialog'
import { upsertMedia, removeMedia, useDeleteMedia } from '@/hooks/useMedia'
import { useMake3D } from '@/hooks/useModel3D'
import { api } from '@/lib/api'
import { mediaAlt } from '@/lib/media'
import { fileStem, remakePayload, saveBlob, turntablesOf } from '@/lib/model3d'
import type { Engine3D, MediaItem } from '@/lib/types'
import { useFavourites } from '@/stores/favourites'
import { trackJobs } from '@/stores/toasts'
import { announce } from '@/stores/ui'
import type { ExportFormat } from './exporters'

export interface ModelHandlers {
  open?: (m: MediaItem) => void
  turntable?: (m: MediaItem) => void
  thumbnail?: (m: MediaItem) => void
  // Ad Studio product shots; only given when the package has both studios
  shots?: (m: MediaItem) => void
  remake: (m: MediaItem, engine?: Engine3D) => void
  exportAs: (m: MediaItem, format: ExportFormat) => void
  favourite: (m: MediaItem) => void
  isFavourite: (m: MediaItem) => boolean
  rename: (m: MediaItem) => void
  remove: (m: MediaItem) => void
  busy: string | null
}

/**
 * The Library actions for 3D models, the same ones useMediaHost gives pictures (rename, delete with a confirm,
 * favourite), plus making it again and the browser-side downloads. Returns the handlers and the dialogs.
 */
export function useModelActions({ open, turntable, thumbnail, shots, afterDelete }: Pick<ModelHandlers, 'open' | 'turntable' | 'thumbnail' | 'shots'> & { afterDelete?: () => void }) {
  const uid = useId()
  const qc = useQueryClient()
  const favs = useFavourites()
  const make = useMake3D()
  const remove = useDeleteMedia()
  const [renaming, setRenaming] = useState<MediaItem | null>(null)
  const [deleting, setDeleting] = useState<MediaItem | null>(null)
  const [withVideos, setWithVideos] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const rename = useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) => api.media.update(id, { title }),
    onSuccess: (item) => {
      upsertMedia(qc, item)
      setRenaming(null)
      announce(`Renamed to ${mediaAlt(item)}.`)
    },
  })

  const handlers: ModelHandlers = {
    open,
    turntable,
    thumbnail,
    shots,
    remake: (m, engine) => {
      const body = remakePayload(m, engine)
      if (!body) return announce('This model can’t be made again from here. Start it again from the dock.')
      make.mutate(body, {
        onSuccess: (res) => {
          trackJobs([res.job], mediaAlt(res.item))
          announce(engine ? `Making ${mediaAlt(m)} again with ${engine === 'trellis2' ? 'TRELLIS.2' : 'Pixal3D'}.` : `Making ${mediaAlt(m)} again.`)
        },
        onError: (e) => announce(`Couldn’t start it again: ${e.message}`),
      })
    },
    exportAs: async (m, format) => {
      if (!m.media_url || busy) return
      setBusy(`${m.id}:${format}`)
      try {
        const { exportFromUrl } = await import('./exporters')
        saveBlob(await exportFromUrl(m.media_url, format), `${fileStem(m.title || '3D model')}.${format}`)
        announce(`${format.toUpperCase()} file ready.`)
      } catch {
        announce(`Couldn't make the ${format.toUpperCase()} file.`)
      } finally {
        setBusy(null)
      }
    },
    favourite: (m) => announce(favs.toggle(m.id) ? `${mediaAlt(m)} added to favourites.` : `${mediaAlt(m)} removed from favourites.`),
    isFavourite: (m) => favs.ids.includes(m.id),
    rename: (m) => {
      rename.reset()
      setRenaming(m)
    },
    remove: (m) => {
      setWithVideos(false)
      setDeleting(m)
    },
    busy,
  }

  const videos = deleting ? turntablesOf(deleting) : []

  const host = (
    <>
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
        description="This removes the 3D model and all of its versions from your library. It can't be undone."
        confirmLabel="Delete"
        tone="danger"
        onConfirm={() => {
          const item = deleting
          const also = withVideos ? videos : []
          setDeleting(null)
          if (!item) return
          remove.mutate(item.id, {
            onSuccess: async () => {
              // the turntables are videos of their own; one already deleted from the Library is fine
              await Promise.all(also.map((id) => api.media.remove(id).then(() => removeMedia(qc, id), () => {})))
              announce(also.length ? `Deleted ${mediaAlt(item)} and its turntable${also.length > 1 ? 's' : ''}.` : `Deleted ${mediaAlt(item)}.`)
              afterDelete?.()
            },
            onError: (e) => announce(`Couldn’t delete ${mediaAlt(item)}: ${e.message}`),
          })
        }}
      >
        {videos.length > 0 && (
          <label htmlFor={`${uid}-tt`} className="mt-3 flex cursor-pointer items-start gap-2 text-body">
            <input id={`${uid}-tt`} type="checkbox" className="mt-1 size-4 accent-[var(--accent)]" checked={withVideos} onChange={(e) => setWithVideos(e.target.checked)} />
            <span>
              Also delete its {videos.length === 1 ? 'turntable video' : `${videos.length} turntable videos`}
              <span className="block text-small text-studio-muted">Left unticked, they stay in the video library.</span>
            </span>
          </label>
        )}
      </ConfirmDialog>
    </>
  )

  return { handlers, host, error: remove.error ?? make.error }
}
