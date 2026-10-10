import { useId, useRef, useState } from 'react'
import { AlertTriangle, Check, Upload, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { useUploads } from '@/hooks/useUploads'
import { acceptFor, UPLOAD_RULES } from '@/lib/upload'
import type { MediaItem, MediaKind } from '@/lib/types'
import { cn } from '@/lib/utils'

interface Props {
  kinds: MediaKind[]
  onUploaded?: (item: MediaItem) => void
  multiple?: boolean
  compact?: boolean
  className?: string
}

/** Drop zone plus a button, with a row per file showing progress or a plain-words error. */
export function UploadZone({ kinds, onUploaded, multiple = true, compact, className }: Props) {
  const id = useId()
  const input = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)
  const { rows, add, cancel, dismiss } = useUploads(kinds, onUploaded)
  const hint = kinds.map((k) => UPLOAD_RULES[k].label).join(' · ')

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <div
        onDragOver={(e) => {
          e.preventDefault()
          setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setOver(false)
          if (e.dataTransfer.files.length) add(e.dataTransfer.files)
        }}
        className={cn(
          'flex items-center gap-3 rounded-[8px] border border-dashed border-studio-border-strong bg-studio-raised/70 transition-colors duration-150',
          compact ? 'p-2.5' : 'flex-col justify-center p-6 text-center',
          over && 'border-studio-accent bg-studio-accent-soft',
        )}
      >
        <Upload aria-hidden className={cn('shrink-0 text-studio-accent', compact ? 'size-4' : 'size-6')} />
        <div className={cn('min-w-0', compact && 'flex-1')}>
          <p className="text-body font-medium">Drop {kinds.length === 1 ? (kinds[0] === 'audio' ? 'audio files' : `${kinds[0]}s`) : 'files'} here</p>
          <p id={`${id}-hint`} className="text-small text-studio-muted">
            {hint}
          </p>
        </div>
        <Button type="button" variant="secondary" size={compact ? 'sm' : 'md'} onClick={() => input.current?.click()} aria-describedby={`${id}-hint`}>
          <Upload aria-hidden />
          Upload
        </Button>
        <input
          ref={input}
          type="file"
          hidden
          multiple={multiple}
          accept={acceptFor(kinds)}
          data-testid="upload-input"
          aria-label={`Upload ${kinds.join(' or ')}`}
          onChange={(e) => {
            if (e.target.files?.length) add(e.target.files)
            e.target.value = ''
          }}
        />
      </div>

      {rows.length > 0 && (
        <ul className="flex flex-col gap-1.5" aria-label="Uploads">
          {rows.map((r) => (
            <li key={r.key} className="flex items-center gap-2 rounded-[6px] border border-studio-border bg-studio-raised px-2.5 py-1.5">
              {r.state === 'error' ? (
                <AlertTriangle aria-hidden className="size-4 shrink-0 text-studio-danger" />
              ) : r.state === 'done' ? (
                <Check aria-hidden className="size-4 shrink-0 text-studio-success" />
              ) : (
                <Upload aria-hidden className="size-4 shrink-0 text-studio-muted" />
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-small font-medium">{r.name}</p>
                {r.state === 'uploading' && <Progress value={r.progress} label={`Uploading ${r.name}`} />}
                {r.state === 'error' && (
                  <p role="alert" className="text-small text-studio-danger">
                    {r.error}
                  </p>
                )}
                {r.state === 'done' && <p className="text-small text-studio-success">Uploaded</p>}
              </div>
              {r.state === 'uploading' ? (
                <Button size="sm" variant="ghost" onClick={() => cancel(r.key)}>
                  Cancel
                </Button>
              ) : (
                <Button size="icon-sm" variant="ghost" aria-label={`Dismiss ${r.name}`} onClick={() => dismiss(r.key)}>
                  <X aria-hidden />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
