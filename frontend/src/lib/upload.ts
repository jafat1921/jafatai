import { API_BASE, ApiError } from './api'
import type { MediaItem, MediaKind } from './types'

const MB = 1024 * 1024

// contract-v5: the server checks the bytes too; this just saves a pointless 2 GB upload
export const UPLOAD_RULES: Record<MediaKind, { types: string[]; exts: string[]; maxBytes: number; label: string }> = {
  image: { types: ['image/png', 'image/jpeg', 'image/webp'], exts: ['png', 'jpg', 'jpeg', 'webp'], maxBytes: 40 * MB, label: 'PNG, JPG or WebP up to 40 MB' },
  video: { types: ['video/mp4', 'video/quicktime', 'video/webm'], exts: ['mp4', 'mov', 'webm'], maxBytes: 2048 * MB, label: 'MP4, MOV or WebM up to 2 GB' },
}

export const acceptFor = (kinds: MediaKind[]) => kinds.flatMap((k) => [...UPLOAD_RULES[k].types, ...UPLOAD_RULES[k].exts.map((e) => `.${e}`)]).join(',')

export function kindOfFile(file: File): MediaKind | null {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
  for (const kind of ['image', 'video'] as const) {
    const r = UPLOAD_RULES[kind]
    if (r.types.includes(file.type) || r.exts.includes(ext)) return kind
  }
  return null
}

const sizeText = (bytes: number) => (bytes >= 1024 * MB ? `${(bytes / 1024 / MB).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / MB))} MB`)

/** Plain-language reason a file can't go up, or null when it looks fine. */
export function checkFile(file: File, allowed: MediaKind[]): string | null {
  const kind = kindOfFile(file)
  if (!kind || !allowed.includes(kind)) {
    return `“${file.name}” isn't a file type we can use. Try ${allowed.map((k) => UPLOAD_RULES[k].label).join(', or ')}.`
  }
  const rule = UPLOAD_RULES[kind]
  if (file.size > rule.maxBytes) return `“${file.name}” is ${sizeText(file.size)}, bigger than the ${sizeText(rule.maxBytes)} limit for ${kind}s.`
  return null
}

export function uploadErrorText(status: number, detail: string | undefined, fileName: string): string {
  if (status === 413) return `“${fileName}” is too big for the server. Images can be up to 40 MB, videos up to 2 GB.`
  if (status === 415) return `“${fileName}” isn't a supported image or video, even if its name says so. Try PNG, JPG, WebP, MP4, MOV or WebM.`
  if (status === 0) return "Can't reach the studio server. Check your connection and try again."
  if (status === 401) return 'Your session has ended. Sign in again, then retry the upload.'
  if (status >= 500) return 'The server hit a problem while saving the file. Try again in a moment.'
  return detail || `The upload didn't go through (${status}).`
}

export interface UploadHandle {
  promise: Promise<MediaItem>
  abort: () => void
}

/** XHR rather than fetch: fetch still can't report upload progress. */
export function uploadMedia(file: File, onProgress: (fraction: number) => void, title?: string): UploadHandle {
  const xhr = new XMLHttpRequest()
  const promise = new Promise<MediaItem>((resolve, reject) => {
    const form = new FormData()
    form.append('file', file)
    if (title) form.append('title', title)
    xhr.open('POST', `${API_BASE}/media/upload`)
    xhr.withCredentials = true
    xhr.setRequestHeader('Accept', 'application/json')
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total)
    xhr.onerror = () => reject(new ApiError(0, uploadErrorText(0, undefined, file.name)))
    xhr.onabort = () => reject(new ApiError(0, 'Upload cancelled.'))
    xhr.onload = () => {
      let body: unknown
      try {
        body = xhr.responseText ? JSON.parse(xhr.responseText) : null
      } catch {
        body = null
      }
      if (xhr.status >= 200 && xhr.status < 300) return resolve(body as MediaItem)
      const detail = (body as { detail?: unknown } | null)?.detail
      reject(new ApiError(xhr.status, uploadErrorText(xhr.status, typeof detail === 'string' ? detail : undefined, file.name), body))
    }
    xhr.send(form)
  })
  return { promise, abort: () => xhr.abort() }
}
