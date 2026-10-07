import { useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { BrandPurpose } from '@/lib/brand'
import { checkBrandFile, checkFile, uploadBrandAsset, uploadMedia } from '@/lib/upload'
import type { MediaItem, MediaKind } from '@/lib/types'
import { announce } from '@/stores/ui'
import { upsertMedia } from './useMedia'

export interface UploadRow {
  key: string
  name: string
  progress: number
  state: 'uploading' | 'done' | 'error'
  error?: string
  warnings?: string[]
  item?: MediaItem
}

let seq = 0

/**
 * Uploads files one request each, tracking progress per file. Rejected files never leave the browser.
 * With a brand `purpose` the file goes to the brand-kit endpoint, which also returns warnings.
 */
export function useUploads(allowed: MediaKind[], onUploaded?: (item: MediaItem, warnings: string[]) => void, purpose?: BrandPurpose) {
  const qc = useQueryClient()
  const [rows, setRows] = useState<UploadRow[]>([])
  const aborts = useRef(new Map<string, () => void>())
  const patch = (key: string, p: Partial<UploadRow>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...p } : r)))

  const add = (files: FileList | File[]) => {
    for (const file of Array.from(files)) {
      const key = `u${++seq}`
      const problem = purpose ? checkBrandFile(file, purpose) : checkFile(file, allowed)
      if (problem) {
        setRows((rs) => [...rs, { key, name: file.name, progress: 0, state: 'error', error: problem }])
        announce(problem)
        continue
      }
      setRows((rs) => [...rs, { key, name: file.name, progress: 0, state: 'uploading' }])
      const onProgress = (f: number) => patch(key, { progress: f })
      const h = purpose
        ? uploadBrandAsset(file, purpose, onProgress)
        : (() => {
            const m = uploadMedia(file, onProgress)
            return { abort: m.abort, promise: m.promise.then((item) => ({ item, warnings: [] as string[] })) }
          })()
      aborts.current.set(key, h.abort)
      h.promise
        .then(({ item, warnings }) => {
          if (item.kind === 'image' || item.kind === 'video') upsertMedia(qc, item)
          patch(key, { state: 'done', progress: 1, item, warnings })
          announce(`Uploaded ${file.name}.${warnings?.length ? ` ${warnings.join(' ')}` : ''}`)
          onUploaded?.(item, warnings ?? [])
        })
        .catch((e: Error) => {
          patch(key, { state: 'error', error: e.message })
          announce(`Upload failed: ${e.message}`)
        })
        .finally(() => aborts.current.delete(key))
    }
  }

  const cancel = (key: string) => aborts.current.get(key)?.()
  const dismiss = (key: string) => setRows((rs) => rs.filter((r) => r.key !== key))
  const clearDone = () => setRows((rs) => rs.filter((r) => r.state !== 'done'))

  return { rows, add, cancel, dismiss, clearDone }
}
