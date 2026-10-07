import { useId, useState } from 'react'
import { Settings2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ErrorState } from '@/components/studio/states'
import { useModels, useUpdateProjectSettings } from '@/hooks/useModels'
import { useStudioImageModel } from '@/hooks/useStudioImageModel'
import { announce } from '@/stores/ui'
import { ModelSelect } from './ModelSelect'

function ProjectDefaultPopover({ projectId, current }: { projectId: string; current: string | undefined }) {
  const uid = useId()
  const { models } = useModels('image')
  const [value, setValue] = useState(current)
  const save = useUpdateProjectSettings(projectId)
  return (
    <Popover onOpenChange={(open) => open && setValue(current)}>
      <PopoverTrigger asChild>
        <Button type="button" size="sm" variant="ghost" className="h-6 px-1.5">
          <Settings2 aria-hidden className="size-3.5" />
          Project default
        </Button>
      </PopoverTrigger>
      <PopoverContent aria-label="Project settings" className="flex flex-col gap-2">
        <label htmlFor={`${uid}-def`} className="section-label">
          Default image model
        </label>
        <ModelSelect id={`${uid}-def`} models={models} value={value} onChange={setValue} describedBy={`${uid}-hint`} />
        <p id={`${uid}-hint`} className="text-small text-studio-muted">
          Used for portraits, establishing shots and storyboard frames in this project, including Quick batches.
        </p>
        {save.isError && <ErrorState compact title="Couldn't save" error={save.error} />}
        <div className="flex justify-end gap-2">
          <PopoverClose asChild>
            <Button type="button" size="sm" variant="ghost">
              Cancel
            </Button>
          </PopoverClose>
          <Button
            type="button"
            size="sm"
            variant="primary"
            loading={save.isPending}
            disabled={!value || value === current}
            onClick={() => save.mutate({ image_model: value }, { onSuccess: () => announce('Project default image model saved.') })}
          >
            Save default
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

// TODO: the server also takes settings.edit_model and image_speed; add them here once people ask for them
/** Select plus a small popover to change the project's lasting default. */
export function StudioImageModelField({ projectId, withRefsNote }: { projectId: string; withRefsNote?: boolean }) {
  const uid = useId()
  const { models, model, projectDefault, setModel } = useStudioImageModel(projectId)
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={`${uid}-m`} className="section-label">
          Image model
        </label>
        <ProjectDefaultPopover projectId={projectId} current={projectDefault?.id} />
      </div>
      <ModelSelect id={`${uid}-m`} models={models} value={model?.id} onChange={setModel} describedBy={`${uid}-n`} />
      <p id={`${uid}-n`} className="text-small text-studio-muted">
        {model?.description}
        {withRefsNote && ' Frames with reference images use the edit model instead.'}
      </p>
    </div>
  )
}
