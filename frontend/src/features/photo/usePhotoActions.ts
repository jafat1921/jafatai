import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { photoKeys, useAutoSuggest, useRenderPhoto, useRevertPhoto } from '@/hooks/usePhoto'
import { api } from '@/lib/api'
import { compact, mergeParams } from '@/lib/photo/params'
import type { DevelopParams, ExportFormat, HistoryVersion } from '@/lib/photo/types'
import { announce } from '@/stores/ui'
import { trackJobs } from '@/stores/toasts'
import type { Develop } from './useDevelop'

const FORMAT_NAME: Record<ExportFormat, string> = { jpeg: 'JPEG', png: 'PNG', png16: '16-bit PNG', tiff16: '16-bit TIFF' }

/** Save, export, Auto and the version actions, wired to the jobs tray and announcements. */
export function usePhotoActions({ routeId, baseId, title, develop }: { routeId: string; baseId: string; title: string; develop: Develop }) {
  const qc = useQueryClient()
  const render = useRenderPhoto(routeId)
  const revert = useRevertPhoto(routeId)
  const auto = useAutoSuggest()
  const [exporting, setExporting] = useState<ExportFormat | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [notes, setNotes] = useState<string[]>([])
  const [failure, setFailure] = useState<unknown>(null)

  const queue = (format: ExportFormat, params: DevelopParams) =>
    render.mutateAsync({ id: baseId, params: compact(params), format }).then((job) => {
      trackJobs([job], `Photo Studio · ${title}`, `/image/studio/${routeId}`)
      return job
    })

  const save = () => {
    if (render.isPending) return
    setFailure(null)
    queue('jpeg', develop.params).then(
      () => announce(`Saving ${title} as a new version. It appears in the filmstrip when it's ready.`),
      setFailure,
    )
  }

  const exportAs = (format: ExportFormat) => {
    setExporting(format)
    setFailure(null)
    queue(format, develop.params)
      .then(() => announce(`Exporting ${title} as ${FORMAT_NAME[format]}. Download it from History when it's ready.`), setFailure)
      .finally(() => setExporting(null))
  }

  const runAuto = () =>
    auto.mutate(baseId, {
      onSuccess: (res) => {
        // merged over the current settings in one undoable step
        develop.replace(mergeParams(develop.params, res.params), null)
        setNotes(res.notes ?? [])
        announce(res.notes?.length ? `Auto: ${res.notes.join('. ')}.` : 'Auto adjusted the photo.')
      },
      onError: setFailure,
    })

  const act = async (tag: string, fn: () => Promise<unknown>) => {
    setBusy(tag)
    setFailure(null)
    try {
      await fn()
      qc.invalidateQueries({ queryKey: photoKeys.history(routeId) })
      qc.invalidateQueries({ queryKey: ['media'] })
    } catch (e) {
      setFailure(e)
    } finally {
      setBusy(null)
    }
  }

  return {
    save,
    exportAs,
    runAuto,
    saving: render.isPending && !exporting,
    exporting,
    autoPending: auto.isPending,
    notes,
    clearNotes: () => setNotes([]),
    failure,
    busy,
    revert: (v: HistoryVersion) =>
      act(`revert:${v.generation.id}`, () => revert.mutateAsync(v.generation.id).then(() => announce(`Version ${v.generation.version} is current again.`))),
    approve: (v: HistoryVersion) => act(`approve:${v.generation.id}`, () => api.generations.approve(v.generation.id).then(() => announce(`Approved version ${v.generation.version}.`))),
    restore: (v: HistoryVersion) => act(`restore:${v.generation.id}`, () => api.generations.restore(v.generation.id)),
  }
}
