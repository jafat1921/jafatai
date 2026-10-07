import { Link } from 'react-router'
import { Film, Play } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import { StatusPill } from '@/components/studio/status-pill'
import { useQuickRecent } from '@/hooks/useQuick'
import { formatDuration } from '@/lib/duration'
import { quickStatus } from '@/lib/quick'
import type { QuickRecent as Item } from '@/lib/types'
import { cn } from '@/lib/utils'

/** Under the prompt bar. Quiet when there's nothing yet, or when the server doesn't know the route. */
export function RecentQuick({ className }: { className?: string }) {
  const recent = useQuickRecent()
  if (recent.isError || (recent.isSuccess && !recent.data.length)) return null
  return (
    <section aria-labelledby="recent-quick-title" className={cn('flex flex-col gap-2', className)}>
      <h2 id="recent-quick-title" className="section-label">
        Recent quick videos
      </h2>
      {recent.isPending ? (
        <div className="flex gap-3" aria-hidden>
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="aspect-video w-48 shrink-0" />
          ))}
        </div>
      ) : (
        <ul className="-mx-1 flex snap-x gap-3 overflow-x-auto px-1 pb-2">
          {recent.data.map((item) => (
            <li key={item.project.id} className="w-48 shrink-0 snap-start">
              <RecentCard item={item} />
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function RecentCard({ item }: { item: Item }) {
  const { project, job, final_render: render } = item
  const status = quickStatus(job)
  const done = job.status === 'done' && !!render?.media_url
  const thumb = project.thumbnail_url
  return (
    <Link
      to={`/quick/${project.id}`}
      aria-label={`${project.title}: ${status.label}${done ? '. Play' : ''}`}
      className="group flex flex-col overflow-hidden rounded-[6px] border border-studio-border-strong bg-studio-panel shadow-card hover:bg-studio-panel-hover"
    >
      {/* one tile shape for every aspect so the strip lines up; covers crop the edges */}
      <div className="darkroom relative aspect-video w-full overflow-hidden border-x-0 border-t-0">
        {thumb ? (
          <img src={thumb} alt="" className="absolute inset-0 size-full object-cover" loading="lazy" />
        ) : done ? (
          <video src={render!.media_url!} preload="metadata" muted playsInline tabIndex={-1} aria-hidden className="absolute inset-0 size-full object-cover" />
        ) : (
          <span className="flex size-full items-center justify-center text-studio-on-dark-muted">
            <Film aria-hidden className="size-5" />
          </span>
        )}
        {done && (
          <span aria-hidden className="absolute inset-0 flex items-center justify-center">
            <span className="flex size-9 items-center justify-center rounded-full border border-studio-gold/70 bg-studio-darkroom/80 text-studio-on-dark transition-transform group-hover:scale-105">
              <Play className="ml-0.5 size-4" />
            </span>
          </span>
        )}
      </div>
      <div className="flex flex-col gap-1 p-2">
        <span className="line-clamp-1 text-body font-medium">{project.title}</span>
        <span className="flex items-center justify-between gap-1">
          <StatusPill status={status} />
          <span className="font-mono text-[12px] text-studio-muted">{formatDuration(project.target_runtime_s)}</span>
        </span>
      </div>
    </Link>
  )
}
