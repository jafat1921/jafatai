import { useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { checkFile, uploadMedia } from '@/lib/upload'
import type { MediaItem, MediaKind } from '@/lib/types'
import { announce } from '@/stores/ui'
import { upsertMedia } from './useMedia'

export interface UploadRow {
  key: string
  name: string
  progress: number
  state: 'uploading' | 'done' | 'error'
  error?: string
  item?: MediaItem
}

let seq = 0

/** Uploads files one request each, tracking progress per file. Rejected files never leave the browser. */
export function useUploads(allowed: MediaKind[], onUploaded?: (item: MediaItem) => void) {
  const qc = useQueryClient()
  const [rows, setRows] = useState<UploadRow[]>([])
  const aborts = useRef(new Map<string, () => void>())
  const patch = (key: string, p: Partial<UploadRow>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...p } : r)))

  const add = (files: FileList | File[]) => {
    for (const file of Array.from(files)) {
      const key = `u${++seq}`
      const problem = checkFile(file, allowed)
      if (problem) {
        setRows((rs) => [...rs, { key, name: file.name, progress: 0, state: 'error', error: problem }])
        continue
      }
      setRows((rs) => [...rs, { key, name: file.name, progress: 0, state: 'uploading' }])
      const h = uploadMedia(file, (f) => patch(key, { progress: f }))
      aborts.current.set(key, h.abort)
      h.promise
        .then((item) => {
          upsertMedia(qc, item)
          patch(key, { state: 'done', progress: 1, item })
          announce(`Uploaded ${file.name}.`)
          onUploaded?.(item)
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
