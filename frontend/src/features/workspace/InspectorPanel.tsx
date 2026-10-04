import { FileText, Info, MousePointerClick } from 'lucide-react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { SourceBadge } from '@/components/studio/source-badge'
import { EmptyState } from '@/components/studio/states'
import { StatusPill } from '@/components/studio/status-pill'
import { CastInspector } from '@/features/cast/CastInspector'
import { StoryboardInspector } from '@/features/storyboard/StoryboardInspector'
import { RenderInspector } from '@/features/render/RenderInspector'
import { useProject } from '@/hooks/useProjects'
import { projectStatus, staleStatus } from '@/lib/status'
import type { StageId } from '@/lib/stages'
import { formatRuntime, humanize, timeAgo } from '@/lib/utils'
import { useProjectId, useSelectedScene } from './selection'

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <dt className="text-small text-studio-muted">{label}</dt>
      <dd className="text-right text-body">{children}</dd>
    </div>
  )
}

function ProjectDetails() {
  const { data: p } = useProject(useProjectId())
  if (!p) return null
  return (
    <dl className="divide-y divide-studio-border">
      <Row label="Status">
        <StatusPill status={projectStatus(p.status)} />
      </Row>
      <Row label="Authoring">{humanize(p.authoring_mode)}</Row>
      <Row label="Target runtime">{formatRuntime(p.target_runtime_s)}</Row>
      <Row label="Aspect ratio">
        <span className="font-mono">{p.aspect_ratio}</span>
      </Row>
      <Row label="Quality">{humanize(p.quality)}</Row>
      <Row label="Takes per shot">{p.takes_per_shot}</Row>
      <Row label="Overnight">{p.overnight ? 'On' : 'Off'}</Row>
      {p.logline && (
        <div className="py-2">
          <dt className="section-label mb-1">Logline</dt>
          <dd className="text-body text-studio-muted">{p.logline}</dd>
        </div>
      )}
    </dl>
  )
}

function SceneDetails() {
  const { scene, index } = useSelectedScene()
  if (!scene) {
    return (
      <EmptyState icon={<MousePointerClick />} title="No scene selected">
        Pick a scene from the Scenes column.
      </EmptyState>
    )
  }
  return (
    <dl className="divide-y divide-studio-border">
      <Row label="Scene">{index + 1}</Row>
      <Row label="Written by">
        <SourceBadge source={scene.source} locked={scene.locked} />
      </Row>
      <Row label="Version">
        <span className="font-mono">v{scene.version}</span>
      </Row>
      {scene.stale && (
        <Row label="Downstream">
          <StatusPill status={staleStatus} />
        </Row>
      )}
      <Row label="Updated">{timeAgo(scene.updated_at)}</Row>
      <div className="py-2">
        <dt className="section-label mb-1">Summary</dt>
        <dd className="text-body text-studio-muted">
          {scene.summary || 'A summary is written automatically once AI drafting arrives.'}
        </dd>
      </div>
    </dl>
  )
}

function ScriptInspector() {
  return (
    <Tabs defaultValue="scene" className="flex flex-col gap-3">
      <TabsList aria-label="Inspector sections">
        <TabsTrigger value="scene">
          <FileText aria-hidden />
          Scene
        </TabsTrigger>
        <TabsTrigger value="project">
          <Info aria-hidden />
          Project
        </TabsTrigger>
      </TabsList>
      <TabsContent value="scene">
        <SceneDetails />
      </TabsContent>
      <TabsContent value="project">
        <ProjectDetails />
      </TabsContent>
    </Tabs>
  )
}

export function InspectorPanel({ stage }: { stage: StageId }) {
  return (
    <ScrollArea className="h-full">
      <div className="p-3">
        {stage === 'script' && <ScriptInspector />}
        {stage === 'cast' && <CastInspector />}
        {stage === 'storyboard' && <StoryboardInspector />}
        {stage === 'render' && <RenderInspector />}
        {(stage === 'reel' || stage === 'output') && (
          <>
            <h3 className="section-label mb-2">Project</h3>
            <ProjectDetails />
          </>
        )}
      </div>
    </ScrollArea>
  )
}
