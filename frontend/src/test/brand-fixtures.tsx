import { vi } from 'vitest'
import { DEFAULT_SETTINGS, type BrandKit } from '@/lib/brand'
import { T } from './media-fixtures'

export const kit = (id: string, extra: Partial<BrandKit> = {}): BrandKit => ({
  id,
  workspace_id: 'w1',
  name: `Kit ${id}`,
  is_default: false,
  palette: [],
  style_text: '',
  voice_text: '',
  tagline: '',
  logos: {},
  products: [],
  font_files: [],
  reference_media_ids: [],
  settings: DEFAULT_SETTINGS,
  assets: {},
  created_at: T,
  updated_at: T,
  ...extra,
})

export const file = (name: string, type: string, bytes = 100) => {
  const f = new File(['x'], name, { type })
  Object.defineProperty(f, 'size', { value: bytes })
  return f
}

export interface SentUpload {
  url: string
  body: FormData
}

/** A stand-in XMLHttpRequest that answers every upload with `respond(url)`. */
export function fakeXhr(respond: (url: string) => { status: number; body: unknown }) {
  const sent: SentUpload[] = []
  class FakeXhr {
    status = 0
    responseText = ''
    url = ''
    upload: { onprogress?: (e: { lengthComputable: boolean; loaded: number; total: number }) => void } = {}
    onload?: () => void
    onerror?: () => void
    onabort?: () => void
    withCredentials = false
    open(_m: string, url: string) {
      this.url = url
    }
    setRequestHeader() {}
    abort() {}
    send(body: FormData) {
      sent.push({ url: this.url, body })
      this.upload.onprogress?.({ lengthComputable: true, loaded: 5, total: 10 })
      setTimeout(() => {
        const r = respond(this.url)
        this.status = r.status
        this.responseText = JSON.stringify(r.body)
        this.onload?.()
      }, 5)
    }
  }
  vi.stubGlobal('XMLHttpRequest', FakeXhr)
  return sent
}
