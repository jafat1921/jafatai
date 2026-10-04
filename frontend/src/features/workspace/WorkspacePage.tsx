import { Navigate, useParams } from 'react-router'
import { FolderOpen, ListTree, SlidersHorizontal } from 'lucide-react'
import { TabsContent } from '@/components/ui/tabs'
import { ErrorState } from '@/components/studio/states'
import { NotFound } from '@/features/stages/NotFound'
import { useProject } from '@/hooks/useProjects'
import { ApiError } from '@/lib/api'
import { isStage, STAGES, type StageId } from '@/lib/stages'
import { useBreakpoint } from '@/hooks/useBreakpoint'
import { ResizablePanel } from './ResizablePanel'
import { LibraryWithScenes } from './LibraryWithScenes'
import { InspectorSheet } from './InspectorSheet'
import { ReviewWorkspace } from './ReviewWorkspace'
import { LibraryPanel } from './LibraryPanel'
import { InspectorPanel } from './InspectorPanel'
import { AddSceneButton, ScenesPanel } from './ScenesPanel'
import { ScriptCanvas } from '@/features/script/ScriptCanvas'
import { CastCanvas } from '@/features/cast/CastCanvas'
import { PlaceholderCanvas } from '@/features/stages/PlaceholderCanvas'

function StageCanvas({ stage }: { stage: StageId }) {
  switch (stage) {
    case 'script':
      return <ScriptCanvas />
    case 'cast':
      return <CastCanvas />
    default:
      return <PlaceholderCanvas stage={stage} />
  }
}

export function WorkspacePage() {
  const { projectId, stage } = useParams()
  const project = useProject(projectId)
  const bp = useBreakpoint()

  if (!isStage(stage)) return <Navigate to={`/projects/${projectId}/script`} replace />
  if (project.error instanceof ApiError && project.error.status === 404) return <NotFound />
  if (project.isError && !project.data) {
    return (
      <div className="mx-auto max-w-lg p-8">
        <ErrorState title="Couldn't open this project" error={project.error} onRetry={() => project.refetch()} />
      </div>
    )
  }

  if (bp === 'mobile') return <ReviewWorkspace stage={stage} />

  return (
    <div className="flex h-full min-w-0">
      <ResizablePanel id="library" icon={FolderOpen}>
        {bp === 'wide' ? <LibraryPanel /> : <LibraryWithScenes />}
      </ResizablePanel>
      {bp !== 'compact' && (
        <ResizablePanel id="inspector" icon={SlidersHorizontal}>
          <InspectorPanel stage={stage} />
        </ResizablePanel>
      )}
      {bp === 'wide' && (
        <ResizablePanel id="scenes" as="nav" icon={ListTree} actions={<AddSceneButton />}>
          <ScenesPanel />
        </ResizablePanel>
      )}
      <main
        data-f6-region
        tabIndex={-1}
        aria-label={`${STAGES.find((s) => s.id === stage)?.label} canvas`}
        className="min-w-0 flex-1 overflow-hidden focus-visible:outline-none"
      >
        {STAGES.map((s) => (
          <TabsContent key={s.id} value={s.id} className="h-full focus-visible:outline-none" tabIndex={-1}>
            <StageCanvas stage={s.id} />
          </TabsContent>
        ))}
      </main>
      {bp === 'compact' && <InspectorSheet stage={stage} />}
    </div>
  )
}
