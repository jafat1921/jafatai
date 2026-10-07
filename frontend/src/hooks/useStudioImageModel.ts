import { pickModel } from '@/lib/models'
import { useModelChoice } from '@/stores/modelChoice'
import { useModels } from './useModels'
import { useProject } from './useProjects'

/** The image model for no-reference studio generations: this session's pick, else the project default. */
export function useStudioImageModel(projectId: string) {
  const { models } = useModels('image')
  const project = useProject(projectId || undefined)
  const projectDefault = pickModel(models, project.data?.settings?.image_model)
  const picked = useModelChoice((s) => s.imageModel[projectId])
  const setPicked = useModelChoice((s) => s.setImageModel)
  const model = pickModel(models, picked ?? projectDefault?.id)
  return {
    models,
    model,
    projectDefault,
    setModel: (id: string) => setPicked(projectId, id),
    // what goes into generation params
    params: model ? { model: model.id } : undefined,
  }
}
