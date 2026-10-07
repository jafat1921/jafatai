import { useState } from 'react'
import { Link } from 'react-router'
import { ArrowRight } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import { JobRow } from '@/components/shell/JobRow'
import { MediaDetailSheet } from '@/components/media/MediaDetail'
import { MediaTile } from '@/components/media/MediaTile'
import { ProjectCard } from '@/features/projects/ProjectCard'
import { RecentQuick } from '@/features/quick/RecentQuick'
import { useJobs } from '@/hooks/useJobs'
import { useProjects } from '@/hooks/useProjects'
import { useDashboard } from '@/hooks/useStudio'
import { isActiveJob } from '@/lib/status'
import type { MediaItem } from '@/lib/types'
import { HomeCreateBar } from './HomeCreateBar'

function Section({ title, to, linkText, children }: { title: string; to?: string; linkText?: string; children: React.ReactNode }) {
  const id = `home-${title.toLowerCase().replace(/\W+/g, '-')}`
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2 border-b border-studio-border pb-1">
        <h2 id={id} className="font-display text-panel font-semibold">
          {title}
        </h2>
        {to && (
          <Link to={to} className="flex items-center gap-1 text-small text-studio-accent-hover hover:underline">
            {linkText ?? 'See all'}
            <ArrowRight aria-hidden className="size-3.5" />
          </Link>
        )}
      </div>
      {children}
    </section>
  )
}

function Strip({ items, empty, onOpen, min }: { items: MediaItem[]; empty: string; onOpen: (id: string) => void; min: number }) {
  if (!items.length) return <p className="py-3 text-body text-studio-muted">{empty}</p>
  return (
    <ul className="grid gap-3" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${min}px, 1fr))` }}>
      {items.map((m) => (
        <li key={m.id}>
          <MediaTile item={m} onOpen={() => onOpen(m.id)} />
        </li>
      ))}
    </ul>
  )
}

export function HomePage() {
  const dash = useDashboard()
  // an older server has no /dashboard: fall back to the projects list so Home still works
  const projects = useProjects()
  const jobs = useJobs()
  const [detail, setDetail] = useState<string | null>(null)

  const recentProjects = dash.data?.recent_projects ?? (dash.isError ? (projects.data ?? []).slice().sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 6) : [])
  const running = (jobs.data ?? []).filter((j) => isActiveJob(j.status)).slice(0, 5)
  const loading = dash.isPending

  return (
    <main data-f6-region tabIndex={-1} className="h-full overflow-y-auto focus-visible:outline-none" aria-labelledby="home-title">
      <div className="mx-auto flex max-w-7xl flex-col gap-7 px-4 py-6 md:px-8">
        <h1 id="home-title" className="sr-only">
          Home
        </h1>
        <HomeCreateBar />
        <RecentQuick />

        {running.length > 0 && (
          <Section title="Running now" to="/queue" linkText="Open the queue">
            <ul className="grid gap-2 md:grid-cols-2" aria-live="polite">
              {running.map((j) => (
                <JobRow key={j.id} job={j} />
              ))}
            </ul>
          </Section>
        )}

        <Section title="Continue working" to="/video/projects" linkText="All projects">
          {loading && !dash.isError ? (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-3">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="aspect-video" />
              ))}
            </div>
          ) : recentProjects.length ? (
            <ul className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-3">
              {recentProjects.map((p) => (
                <li key={p.id} className="flex [&>a]:w-full">
                  <ProjectCard project={p} />
                </li>
              ))}
            </ul>
          ) : (
            <p className="py-3 text-body text-studio-muted">
              No projects yet. <Link className="text-studio-accent-hover underline underline-offset-2" to="/video/projects">Start a studio project</Link> or make a quick video above.
            </p>
          )}
        </Section>

        <div className="grid gap-7 xl:grid-cols-2">
          <Section title="Recent videos" to="/video/library">
            {loading ? <Skeleton className="h-32" /> : <Strip items={dash.data?.recent_videos ?? []} min={180} onOpen={setDetail} empty="Finished videos show up here." />}
          </Section>
          <Section title="Recent images" to="/image/library">
            {loading ? <Skeleton className="h-32" /> : <Strip items={dash.data?.recent_images ?? []} min={120} onOpen={setDetail} empty="Images you create or upload show up here." />}
          </Section>
        </div>
      </div>
      <MediaDetailSheet id={detail} onClose={() => setDetail(null)} />
    </main>
  )
}
