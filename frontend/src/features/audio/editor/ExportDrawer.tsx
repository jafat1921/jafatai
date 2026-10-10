import { useId, useState } from 'react'
import { Download } from 'lucide-react'
import { buttonVariants } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { api } from '@/lib/api'
import { EXPORT_FORMATS, LOUDNESS, loudnessLabel } from '@/lib/audio-edit'
import type { AudioExportFormat, LoudnessTarget } from '@/lib/types'
import { cn } from '@/lib/utils'

const slug = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 60) || 'audio'

interface Props {
  open: boolean
  onOpenChange: (o: boolean) => void
  itemId: string
  version: string | null
  title: string
  // unsaved edits aren't in the export; say so rather than surprise anyone
  dirty: boolean
}

export function ExportDrawer({ open, onOpenChange, itemId, version, title, dirty }: Props) {
  const id = useId()
  const [format, setFormat] = useState<AudioExportFormat>('wav24')
  const [loudness, setLoudness] = useState<LoudnessTarget | ''>('')
  const [name, setName] = useState(() => slug(title))
  const ext = EXPORT_FORMATS.find((f) => f.value === format)?.ext ?? 'wav'
  const href = api.audio.exportUrl(itemId, { format, loudness: loudness || null, version: version ?? undefined })

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-[380px] gap-4 overflow-y-auto p-4 pt-12">
        <SheetTitle className="font-display text-title font-semibold">Export</SheetTitle>
        <SheetDescription className="text-small text-studio-muted">
          {dirty ? 'Exports the saved version. Save your edits as a version first to include them.' : 'Downloads the open version in the format you pick.'}
        </SheetDescription>
        <fieldset className="flex flex-col gap-1">
          <legend className="section-label mb-1">Format</legend>
          {EXPORT_FORMATS.map((f) => (
            <label key={f.value} className="flex cursor-pointer items-center gap-2 rounded-[4px] px-1 py-1 text-small hover:bg-studio-panel-hover">
              <input type="radio" name={`${id}-format`} value={f.value} checked={format === f.value} onChange={() => setFormat(f.value)} />
              {f.label}
            </label>
          ))}
        </fieldset>
        <label className="flex flex-col gap-1 text-small">
          <span className="section-label">Loudness</span>
          <select value={loudness} onChange={(e) => setLoudness(e.target.value as LoudnessTarget | '')} className="h-8 rounded-[6px] border border-studio-border-strong bg-studio-raised px-2">
            <option value="">As it is</option>
            {LOUDNESS.map((l) => (
              <option key={l.value} value={l.value}>
                {loudnessLabel(l.value)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-small">
          <span className="section-label">File name</span>
          <span className="flex items-center gap-1">
            <Input value={name} onChange={(e) => setName(e.target.value)} aria-label="File name" />
            <span className="font-mono text-studio-faint">.{ext}</span>
          </span>
        </label>
        <a href={href} download={`${slug(name)}.${ext}`} className={cn(buttonVariants({ variant: 'primary', size: 'lg' }), 'mt-2')} onClick={() => onOpenChange(false)}>
          <Download aria-hidden />
          Download {EXPORT_FORMATS.find((f) => f.value === format)?.label}
        </a>
      </SheetContent>
    </Sheet>
  )
}
