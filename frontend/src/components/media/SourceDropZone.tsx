import { useEffect, useEffectEvent, useId, useRef, useState } from 'react'
import { AlertTriangle, Check, ImagePlus, Upload, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { useUploads } from '@/hooks/useUploads'
import type { BrandPurpose } from '@/lib/brand'
import { modKey } from '@/lib/keyboard'
import { acceptFor, brandAccept, BRAND_RULES, filesFromClipboard, UPLOAD_RULES } from '@/lib/upload'
import type { MediaItem } from '@/lib/types'
import { cn } from '@/lib/utils'
import { MediaPicker } from './MediaPicker'

interface Props {
  label: string
  onAdd: (items: MediaItem[], warnings: string[]) => void
  // brand assets go to the brand endpoint (logo/font/product/reference); plain images to the Library
  purpose?: BrandPurpose
  multiple?: boolean
  // how many the Library dialog may hand back; 0 hides "Pick from Library"
  pickMax?: number
  taken?: string[]
  pickTitle?: string
  pickDescription?: string
  // listen for Ctrl+V anywhere on the page, not only while the zone has focus
  globalPaste?: boolean
  // a small square-ish tile for slots in a grid: an icon, `compactLine`, and the buttons stacked beneath
  compact?: boolean
  compactLine?: string
  className?: string
}

const editable = (el: EventTarget | null) =>
  el instanceof HTMLElement && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName))

/** Drop, paste (Ctrl+V), browse or pick from the Library. Each file gets a row with progress or a plain-words error. */
export function SourceDropZone({
  label,
  onAdd,
  purpose,
  multiple = false,
  pickMax = 1,
  taken,
  pickTitle,
  pickDescription,
  globalPaste,
  compact,
  compactLine,
  className,
}: Props) {
  const uid = useId()
  const input = useRef<HTMLInputElement>(null)
  const zone = useRef<HTMLDivElement>(null)
  const [over, setOver] = useState(false)
  const [picking, setPicking] = useState(false)
  const { rows, add, cancel, dismiss } = useUploads(['image'], (item, warnings) => onAdd([item], warnings), purpose)
  const hint = purpose ? BRAND_RULES[purpose].label : UPLOAD_RULES.image.label
  const font = purpose === 'font'

  const take = (files: File[]) => {
    if (!files.length) return false
    add(multiple ? files : files.slice(0, 1))
    return true
  }

  const onWindowPaste = useEffectEvent((e: ClipboardEvent) => {
    if (e.defaultPrevented || editable(e.target) || zone.current?.contains(e.target as Node)) return
    if (take(filesFromClipboard(e.clipboardData))) e.preventDefault()
  })
  useEffect(() => {
    if (!globalPaste) return
    const onPaste = (e: ClipboardEvent) => onWindowPaste(e)
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [globalPaste])

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <div
        ref={zone}
        role="group"
        aria-label={label}
        aria-describedby={`${uid}-hint`}
        tabIndex={0}
        onKeyDown={(e) => {
          if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) {
            e.preventDefault()
            input.current?.click()
          }
        }}
        onPaste={(e) => {
          if (take(filesFromClipboard(e.clipboardData))) e.preventDefault()
        }}
        onDragOver={(e) => {
          e.preventDefault()
          setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setOver(false)
          take(Array.from(e.dataTransfer.files))
        }}
        className={cn(
          'flex flex-wrap items-center gap-2 rounded-[8px] border border-dashed border-studio-border-strong bg-studio-raised/70 p-2.5 transition-colors duration-150',
          compact && 'min-h-36 min-w-0 flex-col justify-center text-center',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-studio-accent',
          over && 'border-studio-accent bg-studio-accent-soft',
        )}
      >
        <Upload aria-hidden className={cn('shrink-0 text-studio-accent', compact ? 'size-5' : 'size-4')} />
        {/* basis: at phone width the buttons wrap under the words instead of crushing them */}
        <div className={cn('min-w-0', compact ? 'w-full' : 'flex-1 basis-48')}>
          <p className="text-body font-medium">
            {compact ? (compactLine ?? label) : font ? 'Drop a font file here' : `Drop${multiple ? ' images' : ' an image'} here, or paste with ${modKey}+V`}
          </p>
          {/* compact keeps the drop / paste words for screen readers; the tile is too small to show them */}
          <p id={`${uid}-hint`} className={cn('text-small text-studio-muted', compact && 'sr-only')}>
            {compact ? `Drop or paste an image (${modKey}+V). ${hint}` : hint}
          </p>
        </div>
        <div className={cn(compact ? 'flex flex-wrap justify-center gap-1.5' : 'contents')}>
          <Button type="button" variant="secondary" size="sm" onClick={() => input.current?.click()}>
            <Upload aria-hidden />
            Upload
          </Button>
          {!font && pickMax > 0 && (
            <Button type="button" variant="secondary" size="sm" onClick={() => setPicking(true)} aria-label={compact ? `Pick ${(compactLine ?? label).toLowerCase()} from Library` : undefined}>
              <ImagePlus aria-hidden />
              {compact ? 'Pick' : 'Pick from Library'}
            </Button>
          )}
        </div>
        <input
          ref={input}
          type="file"
          hidden
          multiple={multiple}
          accept={purpose ? brandAccept(purpose) : acceptFor(['image'])}
          data-testid="source-input"
          aria-label={`Upload for ${label}`}
          onChange={(e) => {
            if (e.target.files?.length) take(Array.from(e.target.files))
            e.target.value = ''
          }}
        />
      </div>

      {rows.length > 0 && (
        <ul className="flex flex-col gap-1.5" aria-label={`${label} uploads`}>
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
                {r.state === 'done' &&
                  (r.warnings?.length ? (
                    <p className="text-small text-studio-warning">{r.warnings.join(' ')}</p>
                  ) : (
                    <p className="text-small text-studio-success">Uploaded</p>
                  ))}
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

      {!font && pickMax > 0 && (
        <MediaPicker
          open={picking}
          onOpenChange={setPicking}
          kind="image"
          max={pickMax + (taken?.length ?? 0)}
          taken={taken}
          title={pickTitle ?? `Pick for ${label.toLowerCase()}`}
          description={pickDescription}
          onConfirm={(items) => onAdd(items, [])}
        />
      )}
    </div>
  )
}
