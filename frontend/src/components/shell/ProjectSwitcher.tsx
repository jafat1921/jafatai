import { useNavigate, useParams } from 'react-router'
import { ChevronDown, LayoutGrid } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useProject, useProjects } from '@/hooks/useProjects'

export function ProjectSwitcher({ projectId }: { projectId: string }) {
  const navigate = useNavigate()
  const { stage } = useParams()
  const project = useProject(projectId)
  const projects = useProjects()

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex min-w-0 items-center gap-1.5 rounded-[6px] px-2 py-1 font-display text-panel font-semibold hover:bg-studio-panel-hover">
        <span className="max-w-56 truncate">{project.data?.title ?? 'Loading…'}</span>
        <ChevronDown aria-hidden className="size-4 shrink-0 text-studio-muted" />
        <span className="sr-only">Switch project</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel>Switch project</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={projectId}
          onValueChange={(id) => navigate(`/projects/${id}/${stage ?? 'script'}`)}
        >
          {projects.data?.slice(0, 12).map((p) => (
            <DropdownMenuRadioItem key={p.id} value={p.id}>
              <span className="truncate">{p.title}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        {projects.isPending && <p className="px-2 py-1.5 text-small text-studio-muted">Loading projects…</p>}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => navigate('/projects')}>
          <LayoutGrid aria-hidden />
          All projects
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
