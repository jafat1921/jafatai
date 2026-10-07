import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { ArrowUpRight, Check, PenLine, Wand2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { ErrorState } from '@/components/studio/states'
import { DownloadButton } from '@/features/reel/ReelRenders'
import { ComparePlayer } from '@/features/upscale/ComparePlayer'
import { SegmentStrip } from '@/features/upscale/SegmentStrip'
import { UpscaleDialog } from '@/features/upscale/UpscaleDialog'
import { useJob } from '@/hooks/useJobs'
import { useRenders } from '@/hooks/useReel'
import { aspectClassFor } from '@/lib/aspect'
import { quickResult } from '@/lib/quick'
import { isPendingGeneration } from '@/lib/status'
import type { Job, Project, Render } from '@/lib/types'
import { compareSources, readSegments, upscaleInfo } from '@/lib/upscale'
import { cn } from '@/lib/utils'

/** The finished film: the result screen most quick-create users will spend their time on. */
export function QuickDone({ project, job }: { project: Project; job: Job }) {
  const renders = useRenders(project.id)
  const [upscaling, setUpscaling] = useState(false)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const all = renders.data ?? []
  const finalId = quickResult(job).final_render_id
  const final: Render | undefined =
    all.find((r) => r.id === finalId) ?? all.find((r) => r.status === 'approved') ?? all.find((r) => r.status === 'ready')
  // the autopilot may hand us the upscaled copy; its source is the original
  const original = final && upscaleInfo(final) ? all.find((r) => r.id === upscaleInfo(final)!.sourceId) : final
  const child = original && all.find((r) => upscaleInfo(r)?.sourceId === original.id && r.status !== 'rejected')
  const childJob = useJob(child?.job_id)
  const aspect = aspectClassFor(project.aspect_ratio)

  useEffect(() => {
    headingRef.current?.focus()
  }, [])

  if (renders.isPending) return <Skeleton className={cn('w-full', aspect)} />
  if (renders.isError) return <ErrorState title="Couldn't load the video" error={renders.error} onRetry={() => renders.refetch()} />
  if (!final?.media_url) {
    return <ErrorState title="The video finished but its file is missing" error="Open it in the Studio and stitch the Reel again." />
  }

  const playing = child && !isPendingGeneration(child.status) && child.status !== 'failed' ? child : final
  const canUpscale = !upscaleInfo(final) && !child

  return (
    <section aria-labelledby="quick-done-title" className="flex flex-col gap-3">
      <h2 id="quick-done-title" ref={headingRef} tabIndex={-1} className="flex items-center gap-2 font-display text-title font-semibold focus-visible:outline-none">
        <Check aria-hidden className="size-5 text-studio-success" />
        Your video is ready
      </h2>
      <div className={cn('mx-auto w-full', project.aspect_ratio === '9:16' ? 'max-w-sm' : project.aspect_ratio === '1:1' ? 'max-w-xl' : 'max-w-4xl')}>
        <ComparePlayer key={playing.id} sources={compareSources(playing, all, undefined)} aspectClass={aspect} title={project.title} />
      </div>

      {child && isPendingGeneration(child.status) && (
        <div className="rounded-[6px] border border-studio-border bg-studio-raised p-2.5">
          <p className="text-body font-medium">Upscaling a sharper copy</p>
          <SegmentStrip segments={readSegments(child)} message={childJob?.message} />
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <DownloadButton render={playing} size="md" label={`Download ${project.title}`} />
        {canUpscale && (
          <Button variant="secondary" onClick={() => setUpscaling(true)}>
            <ArrowUpRight aria-hidden />
            Upscale
          </Button>
        )}
        <Button asChild variant="secondary">
          <Link to={`/projects/${project.id}/script`}>
            <PenLine aria-hidden />
            Open in Studio
          </Link>
        </Button>
        <Button asChild variant="primary" className="sm:ml-auto">
          <Link to="/video/quick">
            <Wand2 aria-hidden />
            Make another
          </Link>
        </Button>
      </div>
      <p className="text-small text-studio-muted">
        Open in Studio to change any scene, frame or take; every step the autopilot made is there to edit and re-render.
      </p>
      <UpscaleDialog
        render={upscaling ? final : null}
        projectId={project.id}
        aspectRatio={project.aspect_ratio}
        onOpenChange={(o) => !o && setUpscaling(false)}
      />
    </section>
  )
}
