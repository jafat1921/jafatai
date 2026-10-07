import type { GenerationKind, MediaQuery, TargetType } from '@/lib/types'

export const qk = {
  me: ['me'] as const,
  system: ['system-status'] as const,
  projects: ['projects'] as const,
  project: (id: string) => ['projects', id] as const,
  scenes: (projectId: string) => ['scenes', projectId] as const,
  characters: (projectId: string) => ['characters', projectId] as const,
  locations: (projectId: string) => ['locations', projectId] as const,
  // one project-wide list; scenes filter it client-side so SSE patches land in one place
  shots: (projectId: string) => ['shots', projectId] as const,
  generationsFor: (t: TargetType, id: string, kind: GenerationKind) => ['generations', t, id, kind] as const,
  generations: (t: TargetType, id: string, kind: GenerationKind, includeRejected: boolean) =>
    ['generations', t, id, kind, includeRejected] as const,
  jobs: ['jobs'] as const,
  shotEstimate: (shotId: string, durationS: number) => ['shot-estimate', shotId, durationS] as const,
  reel: (projectId: string) => ['reel', projectId] as const,
  reelEstimate: (projectId: string) => ['reel-estimate', projectId] as const,
  renders: (projectId: string) => ['renders', projectId] as const,
  suggestions: (projectId: string) => ['suggestions', projectId] as const,
  // single generations seen over SSE, so quick-create thumbnails can resolve preview_ids
  generation: (id: string) => ['generation', id] as const,
  upscaleOptions: ['upscale-options'] as const,
  quickRecent: ['quick-recent'] as const,
  quickJob: (projectId: string) => ['quick-job', projectId] as const,
  // contract-v5
  mediaLists: ['media', 'list'] as const,
  mediaList: (q: Omit<MediaQuery, 'cursor'>) => ['media', 'list', q] as const,
  mediaItem: (id: string) => ['media', 'item', id] as const,
  templates: (type: 'video' | 'image') => ['templates', type] as const,
  dashboard: ['dashboard'] as const,
  comfyCheck: ['comfy-check'] as const,
  llmCheck: (ping: boolean) => ['llm-check', ping] as const,
}
