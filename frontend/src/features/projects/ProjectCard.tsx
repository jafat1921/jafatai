import { Link } from 'react-router'
import { Film, Wand2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { StatusPill } from '@/components/studio/status-pill'
import { projectStatus } from '@/lib/status'
import type { Project } from '@/lib/types'
import { formatRuntime, plural, timeAgo } from '@/lib/utils'

// `to` lets the grid send a quick video that's still being made to its progress screen
export function ProjectCard({ project, to }: { project: Project; to?: string }) {
  const { counts } = project
  return (
    <Link
      to={to ?? `/projects/${project.id}/script`}
      className="group flex flex-col overflow-hidden rounded-[6px] border border-studio-border-strong bg-studio-panel shadow-card transition-colors duration-150 hover:border-studio-border-hover hover:bg-studio-panel-hover"
    >
      <div className="darkroom relative aspect-video overflow-hidden border-x-0 border-t-0">
        {project.thumbnail_url ? (
          <img src={project.thumbnail_url} alt={`Still from ${project.title}`} className="absolute inset-0 size-full object-cover" loading="lazy" />
        ) : (
          <div className="flex size-full items-center justify-center text-studio-on-dark-muted">
            <Film aria-hidden className="size-7" />
          </div>
        )}
        <span className="absolute bottom-2 right-2 rounded-[4px] bg-studio-darkroom/85 px-1.5 font-mono text-[12px] text-studio-on-dark">
          {project.aspect_ratio} · {formatRuntime(project.target_runtime_s)}
        </span>
        {project.authoring_mode === 'quick' && (
          <Badge tone="accent" className="absolute left-2 top-2 border-studio-gold/70 bg-studio-darkroom/85 text-studio-on-dark">
            <Wand2 aria-hidden />
            Quick
          </Badge>
        )}
      </div>
      <div className="flex flex-1 flex-col gap-1.5 p-3">
        <div className="flex items-start justify-between gap-2">
          <h3 className="line-clamp-1 font-display text-panel font-semibold">{project.title}</h3>
          <StatusPill status={projectStatus(project.status)} className="shrink-0" />
        </div>
        {project.logline && <p className="line-clamp-2 text-small text-studio-muted">{project.logline}</p>}
        <p className="mt-auto pt-1 text-small text-studio-muted">
          {plural(counts?.scenes ?? 0, 'scene')} · {plural(counts?.shots ?? 0, 'shot')} ·{' '}
          {plural(counts?.characters ?? 0, 'character')}
        </p>
        <p className="text-small text-studio-muted">Updated {timeAgo(project.updated_at)}</p>
      </div>
    </Link>
  )
}

export function ProjectCardSkeleton() {
  return (
    <div className="overflow-hidden rounded-[6px] border border-studio-border bg-studio-panel" aria-hidden>
      <Skeleton className="aspect-video rounded-none" />
      <div className="flex flex-col gap-2 p-3">
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-1/2" />
      </div>
    </div>
  )
}
