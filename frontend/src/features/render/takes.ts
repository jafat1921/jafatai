import type { Generation } from '@/lib/types'

export function takeVideo(id: string) {
  return document.querySelector<HTMLVideoElement>(`[data-take-id="${id}"] video`)
}

// Takes read as "Take 1, 2, 3" in the order they were made; the API lists newest first.
export const takesInOrder = (list: Generation[] | undefined) => [...(list ?? [])].sort((a, b) => a.version - b.version)
