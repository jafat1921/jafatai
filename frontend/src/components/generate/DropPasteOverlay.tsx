import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'
import { ImagePlus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Progress } from '@/components/ui/progress'
import { useUploads } from '@/hooks/useUploads'
import { filesFromClipboard } from '@/lib/upload'
import type { MediaItem } from '@/lib/types'
import { announce } from '@/stores/ui'

export interface DropTarget {
  id: string
  label: string
  hint?: string
  use: (item: MediaItem) => void
}

const isImage = (f: File) => f.type.startsWith('image/')
const hasFiles = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')

/**
 * Drop or paste a picture anywhere on a create page and pick what it's for. Drop zones that handle
 * the file themselves call preventDefault, so this only sees what landed elsewhere.
 */
export function DropPasteOverlay({ targets }: { targets: DropTarget[] }) {
  const [dragging, setDragging] = useState(false)
  const [file, setFile] = useState<File | null>(null)
  const depth = useRef(0)
  const chosen = useRef<DropTarget | null>(null)
  // upload rows from an earlier drop stay in the hook; only this drop's row is shown
  const [tries, setTries] = useState(0)
  const { rows, add } = useUploads(['image'], (item) => {
    const t = chosen.current
    chosen.current = null
    setFile(null)
    if (t) {
      t.use(item)
      announce(`Using the picture as ${t.label.toLowerCase()}.`)
    }
  })
  const preview = useMemo(() => (file && typeof URL.createObjectURL === 'function' ? URL.createObjectURL(file) : null), [file])
  useEffect(() => () => void (preview && URL.revokeObjectURL(preview)), [preview])

  const take = (files: File[]) => {
    const img = files.find(isImage)
    if (!img || !targets.length) return false
    setFile(img)
    setTries(rows.length)
    return true
  }

  const onEnter = useEffectEvent((e: DragEvent) => {
    if (!hasFiles(e)) return
    depth.current++
    setDragging(true)
  })
  const onOver = useEffectEvent((e: DragEvent) => {
    if (hasFiles(e) && targets.length) e.preventDefault()
  })
  const onLeave = useEffectEvent(() => {
    depth.current = Math.max(0, depth.current - 1)
    if (!depth.current) setDragging(false)
  })
  const onDrop = useEffectEvent((e: DragEvent) => {
    depth.current = 0
    setDragging(false)
    if (e.defaultPrevented) return
    if (take(Array.from(e.dataTransfer?.files ?? []))) e.preventDefault()
  })
  const onPaste = useEffectEvent((e: ClipboardEvent) => {
    if (e.defaultPrevented) return
    if (take(filesFromClipboard(e.clipboardData))) e.preventDefault()
  })

  useEffect(() => {
    const enter = (e: DragEvent) => onEnter(e)
    const over = (e: DragEvent) => onOver(e)
    const leave = () => onLeave()
    const drop = (e: DragEvent) => onDrop(e)
    const paste = (e: ClipboardEvent) => onPaste(e)
    window.addEventListener('dragenter', enter)
    window.addEventListener('dragover', over)
    window.addEventListener('dragleave', leave)
    window.addEventListener('drop', drop)
    window.addEventListener('paste', paste)
    return () => {
      window.removeEventListener('dragenter', enter)
      window.removeEventListener('dragover', over)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('drop', drop)
      window.removeEventListener('paste', paste)
    }
  }, [])

  const row = rows.length > tries ? rows.at(-1) : undefined
  const busy = row?.state === 'uploading'

  return (
    <>
      {dragging && targets.length > 0 && (
        <div aria-hidden className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center bg-[rgb(42_28_15/0.35)] p-6">
          <div className="flex flex-col items-center gap-2 rounded-[12px] border-2 border-dashed border-studio-gold bg-studio-raised/95 px-8 py-6 text-center shadow-modal">
            <ImagePlus className="size-7 text-studio-accent" />
            <p className="font-display text-title font-semibold">Drop the picture anywhere</p>
            <p className="text-small text-studio-muted">Then choose: {targets.map((t) => t.label).join(' · ')}</p>
          </div>
        </div>
      )}
      <Dialog
        open={!!file}
        onOpenChange={(o) => {
          if (!o && !busy) {
            setFile(null)
            chosen.current = null
          }
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Use this picture as…</DialogTitle>
            <DialogDescription>{file?.name ?? 'Pasted image'}</DialogDescription>
          </DialogHeader>
          {preview && (
            <div className="darkroom mb-3 flex max-h-56 justify-center overflow-hidden rounded-[6px]">
              <img src={preview} alt="The picture you dropped" className="max-h-56 object-contain" />
            </div>
          )}
          <div role="group" aria-label="Use as" className="flex flex-col gap-2">
            {targets.map((t) => (
              <Button
                key={t.id}
                type="button"
                variant="secondary"
                className="h-auto justify-start py-2 text-left"
                disabled={busy}
                onClick={() => {
                  if (!file) return
                  chosen.current = t
                  add([file])
                }}
              >
                <span className="flex flex-col items-start">
                  <span className="font-medium">{t.label}</span>
                  {t.hint && <span className="whitespace-normal text-small text-studio-muted">{t.hint}</span>}
                </span>
              </Button>
            ))}
          </div>
          {row?.state === 'uploading' && <Progress value={row.progress} label={`Uploading ${row.name}`} className="mt-3" />}
          {row?.state === 'error' && (
            <p role="alert" className="mt-3 text-small text-studio-danger">
              {row.error}
            </p>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
