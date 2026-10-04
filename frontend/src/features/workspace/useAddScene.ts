import { useCreateScene } from '@/hooks/useScenes'
import { announce } from '@/stores/ui'
import { useProjectId, useSelectedScene } from './selection'

export function useAddScene() {
  const projectId = useProjectId()
  const create = useCreateScene(projectId)
  const { scenes, select } = useSelectedScene()
  const add = () => {
    const last = scenes.data?.at(-1)
    create.mutate(last ? { after_scene_id: last.id } : {}, {
      onSuccess: (s) => {
        select(s.id)
        announce('Scene added.')
      },
    })
  }
  return { add, pending: create.isPending, error: create.error }
}
