import { useParams } from 'react-router'
import { useScenes } from '@/hooks/useScenes'
import { useCharacters } from '@/hooks/useCharacters'
import { useWorkspace } from '@/stores/workspace'

export function useProjectId() {
  const { projectId } = useParams()
  return projectId ?? ''
}

// Falls back to the first scene so the editor is never blank when scenes exist.
export function useSelectedScene() {
  const projectId = useProjectId()
  const scenes = useScenes(projectId)
  const selectedId = useWorkspace((s) => s.selectedScene[projectId])
  const select = useWorkspace((s) => s.selectScene)
  const list = scenes.data ?? []
  const scene = list.find((s) => s.id === selectedId) ?? list[0]
  return {
    scenes,
    scene,
    index: scene ? list.indexOf(scene) : -1,
    select: (id: string | undefined) => select(projectId, id),
  }
}

export function useSelectedCharacter() {
  const projectId = useProjectId()
  const characters = useCharacters(projectId)
  const selectedId = useWorkspace((s) => s.selectedCharacter[projectId])
  const select = useWorkspace((s) => s.selectCharacter)
  const character = characters.data?.find((c) => c.id === selectedId)
  return { characters, character, select: (id: string | undefined) => select(projectId, id) }
}
