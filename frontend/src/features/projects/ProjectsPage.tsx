import { useMemo, useState } from 'react'
import { ArrowDownUp, Clapperboard, Plus, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { EmptyState, ErrorState } from '@/components/studio/states'
import { useProjects } from '@/hooks/useProjects'
import type { Project } from '@/lib/types'
import { ProjectCard, ProjectCardSkeleton } from './ProjectCard'
import { NewProjectDialog } from './NewProjectDialog'

const SORTS = {
  updated: { label: 'Recently updated', fn: (a: Project, b: Project) => b.updated_at.localeCompare(a.updated_at) },
  created: { label: 'Newest first', fn: (a: Project, b: Project) => b.created_at.localeCompare(a.created_at) },
  title: { label: 'Title A–Z', fn: (a: Project, b: Project) => a.title.localeCompare(b.title) },
} as const
type SortKey = keyof typeof SORTS

export function ProjectsPage() {
  const projects = useProjects()
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<SortKey>('updated')
  const [creating, setCreating] = useState(false)

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = (projects.data ?? []).filter(
      (p) => !q || p.title.toLowerCase().includes(q) || p.logline?.toLowerCase().includes(q),
    )
    return list.sort(SORTS[sort].fn)
  }, [projects.data, query, sort])

  const hasAny = (projects.data?.length ?? 0) > 0

  return (
    <main data-f6-region tabIndex={-1} className="h-full overflow-y-auto focus-visible:outline-none" aria-labelledby="projects-title">
      <div className="mx-auto max-w-7xl px-4 py-6 md:px-8">
        <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 id="projects-title" className="text-title font-display font-semibold">
              Projects
            </h1>
            <p className="text-body text-studio-muted">
              {projects.data ? `${projects.data.length} ${projects.data.length === 1 ? 'film' : 'films'}` : 'Your films'}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-studio-muted" />
              <Input
                type="search"
                placeholder="Search projects"
                aria-label="Search projects"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="w-56 pl-8"
              />
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="secondary" aria-label={`Sort: ${SORTS[sort].label}`}>
                  <ArrowDownUp aria-hidden />
                  {SORTS[sort].label}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel>Sort by</DropdownMenuLabel>
                <DropdownMenuRadioGroup value={sort} onValueChange={(v) => setSort(v as SortKey)}>
                  {Object.entries(SORTS).map(([k, s]) => (
                    <DropdownMenuRadioItem key={k} value={k}>
                      {s.label}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button variant="primary" onClick={() => setCreating(true)}>
              <Plus aria-hidden />
              New project
            </Button>
          </div>
        </div>

        {projects.isError && (
          <ErrorState title="Couldn't load your projects" error={projects.error} onRetry={() => projects.refetch()} />
        )}

        {projects.isPending && (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-4" role="status" aria-label="Loading projects">
            {Array.from({ length: 6 }, (_, i) => (
              <ProjectCardSkeleton key={i} />
            ))}
          </div>
        )}

        {projects.isSuccess && !hasAny && (
          <EmptyState
            className="mt-10"
            icon={<Clapperboard />}
            title="No projects yet"
            action={
              <Button variant="primary" onClick={() => setCreating(true)}>
                <Plus aria-hidden />
                Start your first film
              </Button>
            }
          >
            Start from a one-line idea and let the AI Director draft it, or write scene by scene yourself.
          </EmptyState>
        )}

        {projects.isSuccess && hasAny && visible.length === 0 && (
          <EmptyState icon={<Search />} title={`No projects match “${query}”`}>
            Try a different word, or clear the search.
          </EmptyState>
        )}

        {visible.length > 0 && (
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-4">
            {visible.map((p) => (
              <li key={p.id} className="flex">
                <div className="flex w-full [&>a]:w-full">
                  <ProjectCard project={p} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
      <NewProjectDialog open={creating} onOpenChange={setCreating} />
    </main>
  )
}
