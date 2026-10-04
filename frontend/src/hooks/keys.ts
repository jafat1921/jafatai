import type { GenerationKind, TargetType } from '@/lib/types'

export const qk = {
  me: ['me'] as const,
  system: ['system-status'] as const,
  projects: ['projects'] as const,
  project: (id: string) => ['projects', id] as const,
  scenes: (projectId: string) => ['scenes', projectId] as const,
  characters: (projectId: string) => ['characters', projectId] as const,
  generationsFor: (t: TargetType, id: string, kind: GenerationKind) => ['generations', t, id, kind] as const,
  generations: (t: TargetType, id: string, kind: GenerationKind, includeRejected: boolean) =>
    ['generations', t, id, kind, includeRejected] as const,
  jobs: ['jobs'] as const,
  suggestions: (projectId: string) => ['suggestions', projectId] as const,
}
