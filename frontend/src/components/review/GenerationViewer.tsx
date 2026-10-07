import { useState } from 'react'
import { ImageIcon, Loader2 } from 'lucide-react'
import { ConfirmDialog } from '@/components/ui/alert-dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { ErrorState } from '@/components/studio/states'
import { StatusPill } from '@/components/studio/status-pill'
import { useGenerationActions, useGenerations, type GenerationTarget } from '@/hooks/useGenerations'
import { useJob, useJobAction } from '@/hooks/useJobs'
import { useReviewShortcuts } from '@/hooks/useReviewShortcuts'
import { generationStatus, isPendingGeneration, kindLabel } from '@/lib/status'
import { comparePartner, isImageKind } from '@/lib/imageUpscale'
import { isVideo } from '@/lib/media'
import type { Generation, RegenerateMode } from '@/lib/types'
import { ImageUpscaleDialog } from '@/features/upscale/ImageUpscaleDialog'
import { announce } from '@/stores/ui'
import { ReviewBar } from './ReviewBar'
import { RegenerateDialog } from './RegenerateDialog'
import { VersionsPanel } from './VersionsPanel'
import { GenerationMedia } from './media'
import { CompareToggle, ImageStage } from './ImageStage'
import type { CompareMode } from './ZoomView'
import { cn } from '@/lib/utils'

interface Props {
  target: GenerationTarget
  subject: string // used for alt text, e.g. "Portrait of Mara"
  emptyHint?: string
  shortcuts?: boolean
  // frames and takes follow the project aspect; portraits stay square
  aspectClass?: string
  // lets a parent (the Render take row) drive which version is shown
  viewId?: string
  onViewIdChange?: (id: string | undefined) => void
}

export function GenerationViewer({
  target,
  subject,
  emptyHint,
  shortcuts = true,
  aspectClass = 'aspect-square',
  viewId: controlledViewId,
  onViewIdChange,
}: Props) {
  const [showRejected, setShowRejected] = useState(false)
  const [versionsOpen, setVersionsOpen] = useState(false)
  const [localViewId, setLocalViewId] = useState<string>()
  const viewId = controlledViewId ?? localViewId
  const setViewId = (id: string | undefined) => {
    setLocalViewId(id)
    onViewIdChange?.(id)
  }
  const [dialogMode, setDialogMode] = useState<'note' | 'edit' | null>(null)
  const [confirmMode, setConfirmMode] = useState<RegenerateMode | null>(null)
  const [upscaling, setUpscaling] = useState<Generation | null>(null)
  const [compare, setCompare] = useState<CompareMode>('off')

  const query = useGenerations(target, showRejected)
  const actions = useGenerationActions()
  const cancelJob = useJobAction('cancel')

  const list = query.data ?? []
  const current: Generation | undefined =
    list.find((g) => g.id === viewId) ?? list.find((g) => g.status === 'approved') ?? list[0]
  const job = useJob(current?.job_id)

  const busy = actions.approve.isPending || actions.unapprove.isPending || actions.reject.isPending || actions.restore.isPending
  const lastError = [actions.regenerate, actions.approve, actions.unapprove, actions.reject, actions.restore, cancelJob].find(
    (m) => m.isError,
  )?.error

  const runRegenerate = (mode: RegenerateMode, extra?: { note?: string; prompt?: string }) => {
    if (!current) return
    actions.regenerate.mutate(
      { id: current.id, mode, ...extra },
      {
        onSuccess: (g) => {
          setViewId(g.id)
          setDialogMode(null)
          announce(`Regenerating. Version ${g.version} queued.`)
        },
      },
    )
  }

  const startRegenerate = (mode: RegenerateMode) => {
    if (mode === 'same') runRegenerate('same')
    else setDialogMode(mode)
  }

  // Regenerating something approved is a bigger deal — confirm first (PLAN 2d).
  const requestRegenerate = (mode: RegenerateMode) => {
    if (!current || isPendingGeneration(current.status)) return
    if (current.status === 'approved') setConfirmMode(mode)
    else startRegenerate(mode)
  }

  const approve = (g: Generation) =>
    actions.approve.mutate(g.id, { onSuccess: () => announce(`Version ${g.version} approved.`) })
  const reject = (g: Generation) =>
    actions.reject.mutate(g.id, {
      onSuccess: () => {
        setViewId(undefined)
        announce(`Version ${g.version} rejected. Turn on "Show rejected" in Versions to restore it.`)
      },
    })
  const restore = (g: Generation) =>
    actions.restore.mutate(g.id, { onSuccess: () => announce(`Version ${g.version} restored.`) })

  const ready = current?.status === 'ready'
  const pending = current ? isPendingGeneration(current.status) : false
  const still = !!current?.media_url && !pending && !isVideo(current)
  const canUpscale = isImageKind(target.kind) && still && (current?.status === 'ready' || current?.status === 'approved')
  const partner = still && current ? comparePartner(current, list) : undefined
  useReviewShortcuts(
    {
      approve: ready ? () => approve(current!) : undefined,
      regenerate: current && !pending ? () => requestRegenerate('same') : undefined,
      regenerateWithNote: current && !pending ? () => requestRegenerate('note') : undefined,
      editAndRegenerate: current && !pending ? () => requestRegenerate('edit') : undefined,
      reject: ready ? () => reject(current!) : undefined,
      toggleVersions: current ? () => setVersionsOpen((v) => !v) : undefined,
      upscale: canUpscale ? () => setUpscaling(current!) : undefined,
    },
    shortcuts && dialogMode === null && confirmMode === null && upscaling === null,
  )

  if (query.isPending) return <Skeleton className={cn(aspectClass, 'w-full')} />
  if (query.isError) return <ErrorState error={query.error} onRetry={() => query.refetch()} />

  if (!current) {
    return (
      <div
        className={cn(
          'darkroom flex w-full flex-col items-center justify-center gap-2 rounded-[6px] border-dashed text-center text-studio-on-dark-muted',
          aspectClass,
        )}
      >
        <ImageIcon aria-hidden className="size-6" />
        <p className="max-w-52 text-small">{emptyHint ?? `No ${kindLabel(target.kind).toLowerCase()} yet.`}</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <figure className={cn('darkroom relative w-full overflow-hidden rounded-[6px]', aspectClass)}>
        {still ? (
          <ImageStage current={current} partner={partner} subject={subject} mode={compare} />
        ) : current.media_url && !pending ? (
          <GenerationMedia
            key={current.id}
            gen={current}
            alt={`${subject}, version ${current.version}`}
            className="animate-fade-in"
          />
        ) : pending ? (
          <div className="shimmer-dark flex size-full items-center justify-center">
            <Loader2 aria-hidden className="size-6 animate-spin text-studio-on-dark-muted" />
          </div>
        ) : (
          <div className="flex size-full items-center justify-center text-studio-on-dark-muted">
            <ImageIcon aria-hidden className="size-6" />
          </div>
        )}
        {!pending && (
          <figcaption className="absolute left-2 top-2">
            <StatusPill status={generationStatus(current.status)} className="bg-studio-raised/90 backdrop-blur" />
          </figcaption>
        )}
      </figure>

      {partner && <CompareToggle mode={compare} onChange={setCompare} />}

      <ReviewBar
        status={current.status}
        version={current.version}
        versionCount={list.length}
        progress={job?.progress}
        error={job?.error}
        versionsOpen={versionsOpen}
        busy={busy}
        onApprove={() => approve(current)}
        onUnapprove={() =>
          actions.unapprove.mutate(current.id, { onSuccess: () => announce(`Version ${current.version} unapproved.`) })
        }
        onRegenerate={requestRegenerate}
        onReject={() => reject(current)}
        onRestore={() => restore(current)}
        onToggleVersions={() => setVersionsOpen((v) => !v)}
        onCancel={current.job_id ? () => cancelJob.mutate(current.job_id!) : undefined}
        onUpscale={canUpscale ? () => setUpscaling(current) : undefined}
      />

      {lastError && <ErrorState compact title="That didn't work" error={lastError} />}

      {versionsOpen && (
        <VersionsPanel
          versions={list}
          currentId={current.id}
          showRejected={showRejected}
          onShowRejectedChange={setShowRejected}
          onMakeCurrent={(g) => setViewId(g.id)}
          onApprove={approve}
          onRestore={restore}
          subject={subject}
        />
      )}

      <RegenerateDialog
        mode={dialogMode}
        initialPrompt={current.prompt}
        onOpenChange={(open) => !open && setDialogMode(null)}
        onSubmit={(v) => runRegenerate(dialogMode!, v)}
        pending={actions.regenerate.isPending}
      />

      <ImageUpscaleDialog
        source={upscaling}
        subject={kindLabel(target.kind)}
        onOpenChange={(open) => !open && setUpscaling(null)}
        onQueued={(job) => job.generation_id && setViewId(job.generation_id)}
      />

      <ConfirmDialog
        open={confirmMode !== null}
        onOpenChange={(open) => !open && setConfirmMode(null)}
        title="Regenerate an approved item?"
        description="This version is approved and used downstream. A new version will be created, but it won't be approved until you approve it. Anything built from this one may be marked stale."
        confirmLabel="Regenerate anyway"
        onConfirm={() => {
          const mode = confirmMode
          setConfirmMode(null)
          if (mode) startRegenerate(mode)
        }}
      />
    </div>
  )
}
