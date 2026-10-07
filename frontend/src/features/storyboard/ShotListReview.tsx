import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { CheckCheck, Combine, Lock, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/alert-dialog'
import { ErrorState } from '@/components/studio/states'
import { ProjectBrandKitButton } from '@/components/brand/ProjectBrandKit'
import { ModelSelect } from '@/components/models/ModelSelect'
import { qk } from '@/hooks/keys'
import { useCharacters } from '@/hooks/useCharacters'
import { useProject } from '@/hooks/useProjects'
import { useCreateShot, useDeleteShot, useReorderShots, useUpdateShot } from '@/hooks/useShots'
import { useStudioImageModel } from '@/hooks/useStudioImageModel'
import { closingOf } from '@/lib/brand'
import { formatDuration } from '@/lib/duration'
import { shotLabel } from '@/lib/shots'
import type { Scene, Shot } from '@/lib/types'
import { plural } from '@/lib/utils'
import { announce } from '@/stores/ui'
import { ShotListRow } from './ShotListRow'
import { SplitShotDialog } from './ShotDialogs'
import { isContiguous, mergedDuration, moveId } from './shotList'
import { useShotListActions } from './useShotList'

interface Props {
  scene: Scene
  sceneIndex: number
  shots: Shot[]
  firstShotId: string | undefined
}

/**
 * The shot-list gate (LTX-style): rewrite, reorder, merge and split the planned shots before any frame
 * is drawn. Aspect, image model and brand kit sit in one header because every frame will use them.
 */
export function ShotListReview({ scene, sceneIndex, shots, firstShotId }: Props) {
  const projectId = scene.project_id
  const qc = useQueryClient()
  const project = useProject(projectId)
  const { data: cast = [] } = useCharacters(projectId)
  const imageModel = useStudioImageModel(projectId)
  const update = useUpdateShot(projectId)
  const reorder = useReorderShots(projectId)
  const add = useCreateShot(projectId)
  const remove = useDeleteShot(projectId)
  const act = useShotListActions(projectId)
  const [picked, setSelected] = useState<string[]>([])
  const [dragId, setDragId] = useState<string | null>(null)
  const [splitting, setSplitting] = useState<Shot | null>(null)
  const [deleting, setDeleting] = useState<Shot | null>(null)
  const [merging, setMerging] = useState(false)

  const label = (s: Shot) => shotLabel(sceneIndex, shots.indexOf(s))
  const ids = shots.map((s) => s.id)
  // merged or deleted shots drop out of the selection on their own
  const selected = picked.filter((id) => ids.includes(id))
  const chosen = shots.filter((s) => selected.includes(s.id))
  const canMerge = isContiguous(selected, shots)
  const total = shots.reduce((t, s) => t + s.duration_s, 0)
  const frames = shots.reduce((n, s) => n + (closingOf(s) === 'logo_reveal' ? 0 : s.seam_in === 'continue' && s.id !== firstShotId ? 1 : 2), 0)

  const move = (id: string, to: number) => {
    const next = moveId(ids, id, to)
    if (next === ids) return
    // optimistic, so keyboard moves don't wait for the round trip
    qc.setQueryData<Shot[]>(qk.shots(projectId), (old) =>
      old?.map((s) => (s.scene_id === scene.id ? { ...s, order: next.indexOf(s.id) + 1 } : s)),
    )
    reorder.mutate({ sceneId: scene.id, ids: next })
    announce(`Shot moved to position ${to + 1} of ${ids.length}.`)
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-move-handle="${id}"]`)?.focus())
  }

  const doMerge = () =>
    act.merge.mutate(selected, {
      onSuccess: () => {
        announce(`${plural(selected.length, 'shot')} merged into one.`)
        setSelected([])
      },
    })

  const error = update.error ?? reorder.error ?? add.error ?? remove.error ?? act.merge.error ?? act.approve.error

  return (
    <section aria-labelledby={`review-${scene.id}`} className="flex flex-col gap-3 rounded-[6px] border border-studio-accent bg-studio-panel p-3 shadow-card">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id={`review-${scene.id}`} className="font-display text-panel font-semibold">
            Review the shot list · Scene {sceneIndex + 1}
          </h2>
          <p className="text-small text-studio-muted">
            {plural(shots.length, 'shot')} · {formatDuration(total)} · no frames drawn yet. Rewrite, reorder, merge or split,
            then approve.
          </p>
        </div>
        <Button
          variant="primary"
          disabled={!shots.length}
          loading={act.approve.isPending}
          onClick={() =>
            act.approve.mutate(
              { sceneId: scene.id, params: imageModel.params },
              { onSuccess: (r) => announce(`Shot list approved. ${plural(r.jobs.length, 'frame')} queued.`) },
            )
          }
        >
          <CheckCheck aria-hidden />
          Approve shot list &amp; generate {plural(frames, 'frame')}
        </Button>
      </header>

      <div role="group" aria-label="Locked for every frame of this list" className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-[6px] bg-studio-raised px-3 py-2">
        <span className="inline-flex items-center gap-1.5 text-small">
          <Lock aria-hidden className="size-3.5 text-studio-gold" />
          <span className="section-label">Aspect</span>
          <span className="font-mono">{project.data?.aspect_ratio ?? '—'}</span>
        </span>
        <span className="inline-flex items-center gap-1.5 text-small">
          <Lock aria-hidden className="size-3.5 text-studio-gold" />
          <label htmlFor={`model-${scene.id}`} className="section-label">
            Image model
          </label>
          <ModelSelect id={`model-${scene.id}`} models={imageModel.models} value={imageModel.model?.id} onChange={imageModel.setModel} className="h-7 w-48 text-small" />
        </span>
        <span className="inline-flex items-center gap-1.5 text-small">
          <Lock aria-hidden className="size-3.5 text-studio-gold" />
          <ProjectBrandKitButton projectId={projectId} />
        </span>
      </div>

      <div role="toolbar" aria-label="Shot list actions" className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="secondary" disabled={!canMerge} onClick={() => setMerging(true)} title={canMerge ? undefined : 'Select two or more neighbouring shots'}>
          <Combine aria-hidden />
          Merge selected{selected.length ? ` (${selected.length})` : ''}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          loading={add.isPending}
          onClick={() => add.mutate({ sceneId: scene.id, after_shot_id: ids[ids.length - 1] }, { onSuccess: () => announce('Shot added at the end.') })}
        >
          <Plus aria-hidden />
          Add shot
        </Button>
        {selected.length > 0 && (
          <Button size="sm" variant="ghost" onClick={() => setSelected([])}>
            Clear selection
          </Button>
        )}
        <p id="shotlist-move-help" className="ml-auto text-small text-studio-muted">
          Drag the grip, or focus it and press ↑ / ↓, to reorder.
        </p>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[960px] border-collapse text-left">
          <caption className="sr-only">Planned shots of scene {sceneIndex + 1}</caption>
          <thead>
            <tr className="section-label">
              <th scope="col" className="px-2 py-1">
                <span className="sr-only">Select</span>
              </th>
              <th scope="col" className="px-2 py-1">#</th>
              <th scope="col" className="px-2 py-1">Type</th>
              <th scope="col" className="px-2 py-1">Length</th>
              <th scope="col" className="px-2 py-1">Description</th>
              <th scope="col" className="px-2 py-1">Camera</th>
              <th scope="col" className="px-2 py-1">Characters</th>
              <th scope="col" className="px-2 py-1">Brand</th>
              <th scope="col" className="px-2 py-1">Seam in</th>
              <th scope="col" className="px-2 py-1">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {shots.map((s, i) => (
              <ShotListRow
                key={s.id}
                shot={s}
                label={label(s)}
                index={i}
                count={shots.length}
                firstOfFilm={s.id === firstShotId}
                cast={cast}
                selected={selected.includes(s.id)}
                dragging={dragId === s.id}
                onSelect={(on) => setSelected((cur) => (on ? [...cur, s.id] : cur.filter((x) => x !== s.id)))}
                onPatch={(patch) => update.mutate({ id: s.id, patch })}
                onMove={(to) => move(s.id, to)}
                onSplit={() => setSplitting(s)}
                onDelete={() => setDeleting(s)}
                onDragStart={() => setDragId(s.id)}
                onDragEnd={() => setDragId(null)}
                onDropOn={() => {
                  if (dragId && dragId !== s.id) move(dragId, i)
                  setDragId(null)
                }}
              />
            ))}
          </tbody>
        </table>
      </div>
      {error ? <ErrorState compact title="That didn't work" error={error} /> : null}

      <SplitShotDialog
        shot={splitting}
        label={splitting ? label(splitting) : ''}
        pending={act.split.isPending}
        error={act.split.error}
        onOpenChange={(o) => !o && setSplitting(null)}
        onSubmit={(body) =>
          splitting &&
          act.split.mutate(
            { id: splitting.id, ...body },
            {
              onSuccess: () => {
                announce(`Shot ${label(splitting)} split in two.`)
                setSplitting(null)
              },
            },
          )
        }
      />
      <ConfirmDialog
        open={merging}
        onOpenChange={setMerging}
        title={`Merge ${plural(chosen.length, 'shot')}?`}
        description={`${chosen.map(label).join(', ')} become one ${formatDuration(mergedDuration(chosen))} shot: descriptions joined, cast and brand placements combined.`}
        confirmLabel="Merge shots"
        onConfirm={doMerge}
      />
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        tone="danger"
        title={`Delete shot ${deleting ? label(deleting) : ''}?`}
        description="It leaves the shot list. Nothing has been drawn for it yet."
        confirmLabel="Delete shot"
        onConfirm={() => deleting && remove.mutate(deleting.id, { onSuccess: () => announce('Shot deleted.') })}
      />
    </section>
  )
}
