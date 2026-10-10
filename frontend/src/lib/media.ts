import type { Generation, GenerationKind, MediaItem } from './types'

const AUDIO_GEN_KINDS = ['song', 'music', 'sfx'] as const

function audioGenKind(item: MediaItem): GenerationKind {
  const k = item.params?.kind
  return AUDIO_GEN_KINDS.find((x) => x === k) ?? 'music'
}

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
    kind: item.origin === 'upload' ? 'upload' : item.kind === 'audio' ? audioGenKind(item) : item.kind,
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
    media_type: item.kind === 'video' ? 'video/mp4' : item.kind === 'audio' ? 'audio/flac' : 'image/png',
    created_at: item.created_at,
  }
}

export const downloadUrl = (generationId: string) => `/api/generations/${generationId}/download`

const KIND_NOUN = { image: 'Image', video: 'Video', audio: 'Audio' } as const

export const mediaAlt = (item: Pick<MediaItem, 'title' | 'prompt' | 'kind'>) => item.title || item.prompt || KIND_NOUN[item.kind]

/** The server's name for a Library row: project results are "gen:<generation id>" (contract v8 P4). */
export const mediaRef = (item: Pick<MediaItem, 'id' | 'origin'>) => (item.origin === 'project' ? `gen:${item.id}` : item.id)

/** Where an object-contain picture of natural size nw×nh actually sits inside a w×h box. */
export function containedRect(w: number, h: number, nw: number, nh: number) {
  const s = Math.min(w / nw, h / nh)
  const dw = nw * s
  const dh = nh * s
  return { x: (w - dw) / 2, y: (h - dh) / 2, w: dw, h: dh }
}

const UPSCALE_LABELS: Record<string, string> = { '2x': '2×', '4x': '4×', '2k': '2K', '4k': '4K', '1080p': '1080p', '1440p': '1440p' }
export const upscaleLabel = (target: string | null | undefined) => (target ? (UPSCALE_LABELS[target] ?? target.toUpperCase()) : '')

/** "Original" / "Upscaled · 4K" / "Version 3": what a version is, for lists that show several. */
export function versionRole(g: Pick<Generation, 'params' | 'version' | 'parent_id'>, isOriginal: boolean) {
  const up = (g.params ?? {}).upscale as { target?: string } | undefined
  if (up && typeof up === 'object') return `Upscaled · ${upscaleLabel(up.target)}`
  return isOriginal ? 'Original' : `Version ${g.version}`
}

// renders live on Output, keyframes ("· Start frame") on the Storyboard, portraits and places on Cast
export const projectLink = (item: Pick<MediaItem, 'project_id' | 'kind' | 'title'>) =>
  `/projects/${item.project_id}/${item.kind === 'video' ? 'output' : /frame$/i.test(item.title) ? 'storyboard' : 'cast'}`
