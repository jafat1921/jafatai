import { useProject } from '@/hooks/useProjects'
import { useProjectId } from '@/features/workspace/selection'

// literal class names so Tailwind's scanner picks them up
const CLASSES: Record<string, string> = {
  '16:9': 'aspect-video',
  '9:16': 'aspect-[9/16]',
  '1:1': 'aspect-square',
  '2.39:1': 'aspect-[239/100]',
}

export const aspectClassFor = (ratio: string | undefined) => CLASSES[ratio ?? ''] ?? 'aspect-video'

export function useProjectAspectClass() {
  const { data } = useProject(useProjectId())
  return aspectClassFor(data?.aspect_ratio)
}
