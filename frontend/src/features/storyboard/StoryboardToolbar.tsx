import { useState } from 'react'
import { CheckCheck, ListChecks, Loader2, Plus, Sparkles, Wand2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Tooltip } from '@/components/ui/tooltip'
import { ErrorState } from '@/components/studio/states'
import { ProjectBrandKitButton } from '@/components/brand/ProjectBrandKit'
import { useAiJob } from '@/hooks/useAi'
import { useCreateShot } from '@/hooks/useShots'
import { api } from '@/lib/api'
import type { Scene, Shot } from '@/lib/types'
import { announce } from '@/stores/ui'
import { useSceneBatch } from './useSceneBatch'
import { useShotListActions } from './useShotList'

// Per-scene actions for the shot breakdown view.
export function StoryboardToolbar({
  scene,
  shots,
  prevOf,
}: {
  scene: Scene
  shots: Shot[]
  prevOf: (s: Shot) => Shot | undefined
}) {
  // TODO: show shot suggestions inline once the API lists them (suggest-shots on a scene with hand-made shots)
  const suggest = useAiJob(({ id, review }: { id: string; review: boolean }) => api.ai.suggestShots(id, undefined, review))
  // studio default: look over the AI's shot list before any frame is drawn
  const [reviewFirst, setReviewFirst] = useState(true)
  const reviewing = scene.shots_review === 'pending'
  const gate = useShotListActions(scene.project_id)
  const add = useCreateShot(scene.project_id)
  const batch = useSceneBatch(shots, prevOf)
  const suggestLabel = suggest.working
    ? suggest.job?.status === 'running'
      ? suggest.job.message || 'Breaking the scene down…'
      : 'Waiting for a worker…'
    : 'Suggest shots'

  return (
    <div className="flex flex-col gap-2">
      <div role="toolbar" aria-label="Scene shot actions" className="flex flex-wrap items-center gap-2">
        <Tooltip
          content={
            scene.script_text?.trim()
              ? 'AI breaks this scene into shots. It writes directly only when you have no hand-made shots here; otherwise it suggests.'
              : 'Write the scene first'
          }
        >
          <Button
            variant="secondary"
            size="sm"
            aria-disabled={!scene.script_text?.trim() || undefined}
            onClick={() => scene.script_text?.trim() && !suggest.working && suggest.run({ id: scene.id, review: reviewFirst })}
            className="max-w-72"
          >
            {suggest.working ? <Loader2 aria-hidden className="animate-spin" /> : <Sparkles aria-hidden />}
            <span className="truncate">{suggestLabel}</span>
          </Button>
        </Tooltip>
        <label className="flex items-center gap-1.5 text-small text-studio-muted">
          <Switch checked={reviewFirst} onCheckedChange={setReviewFirst} aria-label="Review shot list first" />
          Review first
        </label>
        <Button
          variant="secondary"
          size="sm"
          loading={add.isPending}
          onClick={() =>
            add.mutate(
              { sceneId: scene.id, after_shot_id: shots[shots.length - 1]?.id },
              { onSuccess: () => announce(`Shot ${shots.length + 1} added.`) },
            )
          }
        >
          <Plus aria-hidden />
          Add shot
        </Button>
        {!reviewing && shots.length > 1 && (
          <Button
            variant="ghost"
            size="sm"
            loading={gate.setReview.isPending}
            onClick={() => gate.setReview.mutate({ sceneId: scene.id, status: 'pending' }, { onSuccess: () => announce('Shot list opened for review.') })}
          >
            <ListChecks aria-hidden />
            Edit as shot list
          </Button>
        )}
        {!reviewing && (
          <>
            <Button
              variant="secondary"
              size="sm"
              disabled={batch.generateCount === 0}
              loading={batch.running === 'generate'}
              onClick={batch.generateAll}
              title={batch.generateCount ? undefined : 'Every frame has been generated'}
            >
              <Wand2 aria-hidden />
              Generate all frames{batch.generateCount ? ` (${batch.generateCount})` : ''}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={batch.approveCount === 0}
              loading={batch.running === 'approve'}
              onClick={batch.approveAll}
            >
              <CheckCheck aria-hidden />
              Approve all ready{batch.approveCount ? ` (${batch.approveCount})` : ''}
            </Button>
          </>
        )}
        <span className="ml-auto">
          <ProjectBrandKitButton projectId={scene.project_id} />
        </span>
      </div>
      {suggest.error || add.error || batch.error || gate.setReview.error ? (
        <ErrorState compact title="That didn't work" error={suggest.error ?? add.error ?? batch.error ?? gate.setReview.error} />
      ) : null}
    </div>
  )
}
