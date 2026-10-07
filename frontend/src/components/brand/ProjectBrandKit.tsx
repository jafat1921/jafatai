import { useId } from 'react'
import { Link } from 'react-router'
import { Stamp } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { fieldClass } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ErrorState } from '@/components/studio/states'
import { useBrandKits, useSetProjectKit } from '@/hooks/useBrandKits'
import { useProject } from '@/hooks/useProjects'
import { projectKitId } from '@/lib/brand'
import { cn } from '@/lib/utils'
import { announce } from '@/stores/ui'

/** The project's brand kit; saved the moment it changes (PUT /projects/{id}/brand-kit). */
export function ProjectBrandKitField({ projectId }: { projectId: string }) {
  const uid = useId()
  const { kits } = useBrandKits()
  const project = useProject(projectId)
  const current = projectKitId(project.data?.settings)
  const save = useSetProjectKit(projectId)

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={`${uid}-kit`} className="section-label">
        Brand kit
      </label>
      <select
        id={`${uid}-kit`}
        value={current ?? ''}
        disabled={save.isPending}
        aria-describedby={`${uid}-hint`}
        onChange={(e) => {
          const id = e.target.value || null
          save.mutate(id, { onSuccess: () => announce(id ? `Brand kit set for this project.` : 'This project no longer uses a brand kit.') })
        }}
        className={cn(fieldClass, 'h-8')}
      >
        <option value="">No brand kit</option>
        {kits.map((k) => (
          <option key={k.id} value={k.id}>
            {k.name}
          </option>
        ))}
      </select>
      <p id={`${uid}-hint`} className="text-small text-studio-muted">
        The AI plans where the logo and products appear in each shot, and ends on a brand moment.{' '}
        <Link to="/brand-kits" className="text-studio-accent-hover underline underline-offset-2">
          Manage kits
        </Link>
      </p>
      {save.isError && <ErrorState compact title="Couldn't change the kit" error={save.error} />}
    </div>
  )
}

export function ProjectBrandKitButton({ projectId }: { projectId: string }) {
  const { kits } = useBrandKits()
  const project = useProject(projectId)
  const current = kits.find((k) => k.id === projectKitId(project.data?.settings))
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button type="button" variant="secondary" size="sm" aria-label={`Brand kit: ${current?.name ?? 'none'}. Change`}>
          <Stamp aria-hidden />
          Brand: {current?.name ?? 'none'}
        </Button>
      </PopoverTrigger>
      <PopoverContent aria-label="Project brand kit" className="w-80">
        <ProjectBrandKitField projectId={projectId} />
      </PopoverContent>
    </Popover>
  )
}
