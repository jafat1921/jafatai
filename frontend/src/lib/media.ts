import type { Generation } from './types'

export const isVideo = (g: Pick<Generation, 'media_type' | 'media_url' | 'kind'>) =>
  g.kind === 'take' || g.kind === 'render' || !!g.media_type?.startsWith('video') || /\.(mp4|webm|mov)(\?|$)/i.test(g.media_url ?? '')
