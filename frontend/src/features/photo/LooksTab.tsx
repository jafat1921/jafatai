import { useState } from 'react'
import { Clapperboard, Download, Save, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/alert-dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState, ErrorState } from '@/components/studio/states'
import { useLookMutations, useLooks } from '@/hooks/usePhoto'
import { api } from '@/lib/api'
import { applyLook } from '@/lib/photo/looks'
import { compact, isIdentity } from '@/lib/photo/params'
import type { DevelopParams, Look } from '@/lib/photo/types'
import { announce } from '@/stores/ui'
import { ApplyVideoDialog } from './ApplyVideoDialog'
import { DevelopSlider } from './DevelopSlider'
import { ImportLooks } from './ImportLooks'
import { LookCard } from './LookCard'
import { NameDialog } from './NameDialog'
import { useLookThumbs } from './useLookThumbs'

export interface AppliedLook {
  look: Look
  intensity: number
  // the params the look went over, so the intensity slider can redo the merge
  before: DevelopParams
}

interface Props {
  photoId: string
  sourceUrl: string | null
  params: DevelopParams
  applied: AppliedLook | null
  onApplied: (a: AppliedLook | null) => void
  onParams: (next: DevelopParams, group: string | null) => void
}

const INTENSITY = { min: 0, max: 100, step: 1, default: 100, label: 'Look intensity' }

function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** Looks: one click applies (over the current settings), intensity, save / import / export, grade a video. */
export function LooksTab({ photoId, sourceUrl, params, applied, onApplied, onParams }: Props) {
  const looks = useLooks()
  const m = useLookMutations()
  const thumbs = useLookThumbs(looks.data, sourceUrl, applied?.before ?? params)
  const [saving, setSaving] = useState(false)
  const [renaming, setRenaming] = useState<Look | null>(null)
  const [deleting, setDeleting] = useState<Look | null>(null)
  const [video, setVideo] = useState<{ lookId: string | null } | null>(null)
  const [exporting, setExporting] = useState(false)

  const apply = (look: Look) => {
    const before = applied ? applied.before : params
    onParams(applyLook(before, look, 100), `look:${look.id}`)
    onApplied({ look, intensity: 100, before })
    announce(`Applied the ${look.name} look.`)
  }
  const setIntensity = (v: number) => {
    if (!applied) return
    onParams(applyLook(applied.before, applied.look, v), `look-intensity:${applied.look.id}`)
    onApplied({ ...applied, intensity: v })
  }
  const remove = () => {
    if (!applied) return
    onParams(applied.before, null)
    onApplied(null)
  }

  const exportCube = async () => {
    setExporting(true)
    try {
      saveBlob(await api.photo.cube(compact(params), 'My grade'), 'my-grade.cube')
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-1.5">
        <Button size="sm" variant="secondary" onClick={() => setSaving(true)} disabled={isIdentity(params)}>
          <Save aria-hidden />
          Save current as look
        </Button>
        <Button size="sm" variant="secondary" loading={exporting} onClick={exportCube} disabled={isIdentity(params)}>
          <Download aria-hidden />
          Current as .cube
        </Button>
        <Button size="sm" variant="primary" onClick={() => setVideo({ lookId: applied?.look.id ?? null })} disabled={!looks.data?.length}>
          <Clapperboard aria-hidden />
          Apply look to video…
        </Button>
      </div>

      {applied && (
        <div className="flex flex-col gap-2 rounded-[6px] border border-studio-accent/50 bg-studio-accent-soft p-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-small font-medium">Look: {applied.look.name}</span>
            <Button size="sm" variant="ghost" onClick={remove}>
              <X aria-hidden />
              Remove
            </Button>
          </div>
          <DevelopSlider name="look-intensity" label="Intensity" value={applied.intensity} range={INTENSITY} onChange={setIntensity} />
        </div>
      )}

      <ImportLooks pending={m.importFiles.isPending} onImport={(files) => m.importFiles.mutateAsync(files)} />

      {looks.isPending ? (
        <div className="grid grid-cols-3 gap-2">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="aspect-square" />
          ))}
        </div>
      ) : looks.isError ? (
        <ErrorState error={looks.error} onRetry={() => looks.refetch()} />
      ) : !looks.data.length ? (
        <EmptyState title="No looks yet">Save your settings as a look, or import a preset.</EmptyState>
      ) : (
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(92px,1fr))] gap-2" aria-label="Looks">
          {looks.data.map((l) => (
            <LookCard
              key={l.id}
              look={l}
              thumb={thumbs[l.id] ?? api.looks.thumbUrl(l.id, photoId)}
              applied={applied?.look.id === l.id}
              onApply={() => apply(l)}
              onVideo={() => setVideo({ lookId: l.id })}
              onRename={() => setRenaming(l)}
              onDelete={() => setDeleting(l)}
            />
          ))}
        </ul>
      )}

      <NameDialog
        open={saving}
        title="Save as a look"
        description="Your current settings, reusable on any photo or video."
        initial={applied ? `${applied.look.name} (mine)` : ''}
        confirm="Save look"
        pending={m.create.isPending}
        error={m.create.error?.message}
        onOpenChange={(o) => {
          setSaving(o)
          if (!o) m.create.reset()
        }}
        onSubmit={(name) =>
          m.create.mutate(
            { name, params: compact(params), generation_id: photoId },
            {
              onSuccess: (look) => {
                setSaving(false)
                announce(`Saved the look ${look.name}.`)
              },
            },
          )
        }
      />
      <NameDialog
        open={!!renaming}
        title="Rename look"
        initial={renaming?.name}
        confirm="Rename"
        pending={m.rename.isPending}
        error={m.rename.error?.message}
        onOpenChange={(o) => !o && setRenaming(null)}
        onSubmit={(name) => renaming && m.rename.mutate({ id: renaming.id, name }, { onSuccess: () => setRenaming(null) })}
      />
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Delete “${deleting?.name ?? ''}”?`}
        description="Versions you already made with it stay as they are."
        confirmLabel="Delete look"
        tone="danger"
        onConfirm={() => {
          const l = deleting
          setDeleting(null)
          if (l) m.remove.mutate(l.id, { onSuccess: () => announce(`Deleted the look ${l.name}.`) })
        }}
      />
      <ApplyVideoDialog open={!!video} onOpenChange={(o) => !o && setVideo(null)} looks={looks.data ?? []} lookId={video?.lookId ?? null} />
    </div>
  )
}
