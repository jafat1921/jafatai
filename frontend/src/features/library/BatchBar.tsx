import { useId, useState } from 'react'
import { Download, FolderInput, ImageUpscale, Tag, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/alert-dialog'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Kbd } from '@/components/ui/kbd'
import { Chip, ChipGroup } from '@/components/studio/chip'
import { IMAGE_TARGETS } from '@/lib/imageUpscale'
import { TARGETS } from '@/lib/upscale'
import type { ImageUpscaleEngineId, ImageUpscaleTarget, MediaItem, UpscaleEngineId, UpscaleTarget } from '@/lib/types'
import { plural } from '@/lib/utils'

export type BatchRun =
  | { action: 'delete' | 'download' }
  | { action: 'upscale'; options: Record<string, unknown> }
  | { action: 'tag'; options: { add: string[]; remove: string[] } }

interface Props {
  selected: MediaItem[]
  total: number
  busy: boolean
  onSelectAll: () => void
  onClear: () => void
  onMove: () => void
  onRun: (run: BatchRun) => void
}

const IMAGE_ENGINES: { value: ImageUpscaleEngineId; label: string }[] = [
  { value: 'redraw', label: 'Redraw' },
  { value: 'quick', label: 'Quick' },
  { value: 'best', label: 'Faithful' },
]
const VIDEO_ENGINES: { value: UpscaleEngineId; label: string }[] = [
  { value: 'best', label: 'Best' },
  { value: 'fast', label: 'Fast' },
  { value: 'quick', label: 'Quick preview' },
]

/** Sticky bar while something is selected: Download zip · Upscale · Move · Tag · Delete. */
export function BatchBar({ selected, total, busy, onSelectAll, onClear, onMove, onRun }: Props) {
  const [dialog, setDialog] = useState<'delete' | 'upscale' | 'tag' | null>(null)
  const n = selected.length
  const fromProjects = selected.filter((m) => m.origin === 'project').length
  const own = n - fromProjects
  const close = () => setDialog(null)

  return (
    <div
      role="toolbar"
      aria-label="Selection actions"
      className="sticky bottom-3 z-30 mx-auto flex w-full max-w-4xl flex-wrap items-center gap-1.5 rounded-[8px] border border-studio-border-strong bg-studio-panel p-2 shadow-modal motion-safe:animate-fade-in"
    >
      <span className="px-2 text-body font-medium" aria-live="polite">
        {plural(n, 'selected', 'selected')}
      </span>
      {n < total && (
        <Button size="sm" variant="ghost" onClick={onSelectAll}>
          Select all {total}
        </Button>
      )}
      <Button size="sm" variant="ghost" onClick={onClear} aria-label="Clear selection (Esc)">
        <X aria-hidden />
        Clear
      </Button>
      <span className="mx-1 h-6 w-px bg-studio-border" aria-hidden />
      <Button size="sm" variant="secondary" disabled={busy} onClick={() => onRun({ action: 'download' })}>
        <Download aria-hidden />
        Download zip
      </Button>
      <Button size="sm" variant="secondary" disabled={busy} onClick={() => setDialog('upscale')}>
        <ImageUpscale aria-hidden />
        Upscale
      </Button>
      <Button size="sm" variant="secondary" disabled={busy} onClick={onMove} aria-keyshortcuts="M">
        <FolderInput aria-hidden />
        Move <Kbd>M</Kbd>
      </Button>
      <Button size="sm" variant="secondary" disabled={busy || !own} onClick={() => setDialog('tag')}>
        <Tag aria-hidden />
        Tag
      </Button>
      <Button size="sm" variant="danger" disabled={busy || !own} onClick={() => setDialog('delete')}>
        <Trash2 aria-hidden />
        Delete
      </Button>

      <ConfirmDialog
        open={dialog === 'delete'}
        onOpenChange={(o) => !o && close()}
        title={`Delete ${plural(own, 'item')}?`}
        description={
          <>
            They go from your library with all their versions. This can't be undone.
            {fromProjects > 0 && ` ${plural(fromProjects, 'project result')} will be left alone; change ${fromProjects === 1 ? 'it' : 'them'} inside the project.`}
          </>
        }
        confirmLabel={`Delete ${plural(own, 'item')}`}
        tone="danger"
        onConfirm={() => {
          close()
          onRun({ action: 'delete' })
        }}
      />
      <UpscaleBatchDialog
        open={dialog === 'upscale'}
        items={selected}
        onOpenChange={(o) => !o && close()}
        onConfirm={(options) => {
          close()
          onRun({ action: 'upscale', options })
        }}
      />
      <TagDialog
        open={dialog === 'tag'}
        items={selected}
        onOpenChange={(o) => !o && close()}
        onConfirm={(options) => {
          close()
          onRun({ action: 'tag', options })
        }}
      />
    </div>
  )
}

function UpscaleBatchDialog({ open, items, onOpenChange, onConfirm }: { open: boolean; items: MediaItem[]; onOpenChange: (o: boolean) => void; onConfirm: (o: Record<string, unknown>) => void }) {
  const [imgEngine, setImgEngine] = useState<ImageUpscaleEngineId>('redraw')
  const [imgTarget, setImgTarget] = useState<ImageUpscaleTarget>('2x')
  const [vidEngine, setVidEngine] = useState<UpscaleEngineId>('best')
  const [vidTarget, setVidTarget] = useState<UpscaleTarget>('1080p')
  const images = items.filter((m) => m.kind === 'image').length
  const videos = items.length - images
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            onConfirm({
              ...(images ? { image: { engine: imgEngine, target: imgTarget } } : {}),
              ...(videos ? { video: { engine: vidEngine, target: vidTarget } } : {}),
            })
          }}
        >
          <DialogHeader className="mb-0">
            <DialogTitle>Upscale {plural(items.length, 'item')}</DialogTitle>
            <DialogDescription>
              One job per item, each a new version beside the original. Anything already at that size is skipped and listed afterwards.
            </DialogDescription>
          </DialogHeader>
          {images > 0 && (
            <fieldset className="flex flex-col gap-2">
              <legend className="section-label mb-1">{plural(images, 'image')}</legend>
              <ChipGroup label="Image engine" options={IMAGE_ENGINES} value={imgEngine} onChange={(v) => v && setImgEngine(v)} allowEmpty={false} />
              <ChipGroup label="Image size" options={IMAGE_TARGETS.map((t) => ({ value: t.id, label: t.label }))} value={imgTarget} onChange={(v) => v && setImgTarget(v)} allowEmpty={false} />
            </fieldset>
          )}
          {videos > 0 && (
            <fieldset className="flex flex-col gap-2">
              <legend className="section-label mb-1">{plural(videos, 'video')}</legend>
              <ChipGroup label="Video engine" options={VIDEO_ENGINES} value={vidEngine} onChange={(v) => v && setVidEngine(v)} allowEmpty={false} />
              <ChipGroup label="Video size" options={TARGETS.map((t) => ({ value: t.id, label: t.label }))} value={vidTarget} onChange={(v) => v && setVidTarget(v)} allowEmpty={false} />
            </fieldset>
          )}
          <p className="text-small text-studio-muted">They queue on the GPU one after another; follow them in the jobs tray.</p>
          <DialogFooter className="mt-0">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary">
              Upscale {plural(items.length, 'item')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

const splitTags = (text: string) =>
  text
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean)

function TagDialog({ open, items, onOpenChange, onConfirm }: { open: boolean; items: MediaItem[]; onOpenChange: (o: boolean) => void; onConfirm: (o: { add: string[]; remove: string[] }) => void }) {
  const uid = useId()
  const [text, setText] = useState('')
  const [remove, setRemove] = useState<string[]>([])
  const existing = [...new Set(items.filter((m) => m.origin !== 'project').flatMap((m) => m.tags ?? []))].sort()
  const add = splitTags(text)
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          setText('')
          setRemove([])
        }
        onOpenChange(o)
      }}
    >
      <DialogContent className="max-w-md">
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            if (add.length || remove.length) onConfirm({ add, remove })
          }}
        >
          <DialogHeader className="mb-0">
            <DialogTitle>Tag {plural(items.length, 'item')}</DialogTitle>
            <DialogDescription>Project results keep their tags in the project and are skipped.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1">
            <label htmlFor={`${uid}-add`} className="text-small font-medium">
              Add tags
            </label>
            <Input id={`${uid}-add`} value={text} onChange={(e) => setText(e.target.value)} placeholder="b-roll, spring campaign" autoFocus />
            <span className="text-small text-studio-muted">Separate with commas.</span>
          </div>
          {existing.length > 0 && (
            <div role="group" aria-label="Remove tags" className="flex flex-wrap items-center gap-1">
              <span className="section-label mr-1">Remove</span>
              {existing.map((t) => (
                <Chip key={t} selected={remove.includes(t)} onClick={() => setRemove((r) => (r.includes(t) ? r.filter((x) => x !== t) : [...r, t]))}>
                  {t}
                </Chip>
              ))}
            </div>
          )}
          <DialogFooter className="mt-0">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={!add.length && !remove.length}>
              Save tags
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
