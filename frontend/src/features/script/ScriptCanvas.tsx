import { Plus, ScrollText } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState, ErrorState } from '@/components/studio/states'
import { useLatestJob, useSceneRevision } from '@/hooks/useAi'
import { useProject } from '@/hooks/useProjects'
import { useProjectId, useSelectedScene } from '@/features/workspace/selection'
import { useAddScene } from '@/features/workspace/useAddScene'
import { DirectorBanner, DirectorEmptyState } from './DirectorPanel'
import { SceneEditor } from './SceneEditor'

export function ScriptCanvas() {
  const projectId = useProjectId()
  const project = useProject(projectId)
  const { scenes, scene, index } = useSelectedScene()
  const { add, pending } = useAddScene()
  const outlineJob = useLatestJob(projectId, 'ai_outline')
  const revision = useSceneRevision(scene?.id ?? '')

  if (scenes.isPending) {
    return (
      <div className="mx-auto flex max-w-3xl flex-col gap-4 p-5" role="status" aria-label="Loading script">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-9" />
        <Skeleton className="h-[50vh]" />
      </div>
    )
  }
  if (scenes.isError) {
    return (
      <div className="mx-auto max-w-lg p-8">
        <ErrorState title="Couldn't load the script" error={scenes.error} onRetry={() => scenes.refetch()} />
      </div>
    )
  }
  if (!scene) {
    if (project.data?.authoring_mode === 'ai_director' || outlineJob) {
      return <DirectorEmptyState projectId={projectId} job={outlineJob} />
    }
    return (
      <EmptyState
        className="h-full"
        icon={<ScrollText />}
        title="Your script starts here"
        action={
          <Button variant="primary" onClick={add} loading={pending}>
            <Plus aria-hidden />
            Add the first scene
          </Button>
        }
      >
        Write scene by scene. Each scene keeps its own history, and AI only fills the gaps you leave.
      </EmptyState>
    )
  }
  return (
    <div className="flex h-full flex-col">
      {outlineJob && <DirectorBanner key={outlineJob.id} job={outlineJob} />}
      <div className="min-h-0 flex-1">
        {/* keyed: switching scenes (or an AI rewrite landing) remounts the editor, which flushes any pending autosave */}
        <SceneEditor key={`${scene.id}:${revision}`} scene={scene} index={index} />
      </div>
    </div>
  )
}
