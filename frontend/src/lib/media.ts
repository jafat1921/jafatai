import type { Generation, MediaItem } from './types'

export const isVideo = (g: Pick<Generation, 'media_type' | 'media_url' | 'kind'>) =>
  g.kind === 'take' || g.kind === 'render' || !!g.media_type?.startsWith('video') || /\.(mp4|webm|mov)(\?|$)/i.test(g.media_url ?? '')

/**
 * The upscale dialogs and download link want a Generation; a library item carries its current
 * version's id and media, which is all they read.
 */
export function mediaGeneration(item: MediaItem, version?: Generation): Generation {
  if (version) return version
  return {
    id: item.generation_id,
    target_type: 'media',
    target_id: item.id,
    kind: item.origin === 'upload' ? 'upload' : item.kind,
    version: item.versions_count || 1,
    status: item.status ?? 'ready',
    prompt: item.prompt ?? '',
    params: {
      title: item.title,
      ...(item.width && item.height ? { width: item.width, height: item.height } : {}),
      ...(item.duration_s ? { duration_s: item.duration_s } : {}),
    },
    seed: item.seed ?? null,
    media_url: item.media_url,
    media_type: item.kind === 'video' ? 'video/mp4' : 'image/png',
    created_at: item.created_at,
  }
}

export const downloadUrl = (generationId: string) => `/api/generations/${generationId}/download`

export const mediaAlt = (item: Pick<MediaItem, 'title' | 'prompt' | 'kind'>) => item.title || item.prompt || (item.kind === 'video' ? 'Video' : 'Image')
