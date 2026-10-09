import { ChevronDown, ClipboardCopy, ClipboardPaste, Download, Keyboard, Layers, PanelLeft, PanelRight, Redo2, RefreshCw, Save, SlidersHorizontal, Undo2, Wand2 } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { SHORTCUTS } from './usePhotoShortcuts'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Kbd } from '@/components/ui/kbd'
import type { ExportFormat, PhotoSchema } from '@/lib/photo/types'

const EXPORTS: { id: ExportFormat; label: string; hint: string }[] = [
  { id: 'jpeg', label: 'JPEG', hint: 'Small, shares anywhere' },
  { id: 'png16', label: 'PNG 16-bit', hint: 'Lossless, room to grade further' },
  { id: 'tiff16', label: 'TIFF 16-bit', hint: 'For print and other editors' },
]

interface Props {
  title: string
  version: number | null
  dirty: boolean
  canUndo: boolean
  canRedo: boolean
  autoPending: boolean
  savePending: boolean
  exportPending: ExportFormat | null
  formats: PhotoSchema['formats'] | undefined
  downloadHref: string | null
  onUndo: () => void
  onRedo: () => void
  onHistory: () => void
  onCopy: () => void
  onPaste: (() => void) | null
  onSync: (() => void) | null
  syncCount: number
  left: boolean
  right: boolean
  onLeft: () => void
  onRight: () => void
  onAuto: () => void
  onSave: () => void
  onExport: (f: ExportFormat) => void
  onPanel?: () => void
}

/** Photo Studio's title bar: name and version on the left, the darkroom actions on the right. */
export function PhotoHeader(p: Props) {
  // labels drop to icons on narrow screens; every button keeps its accessible name
  const label = (text: string) => <span className="max-lg:sr-only">{text}</span>
  const offered = EXPORTS.filter((e) => !p.formats || p.formats.some((f) => f.id === e.id))
  return (
    <header className="flex flex-wrap items-center gap-2 border-b border-studio-border bg-studio-panel px-3 py-2">
      <h1 className="mr-auto min-w-0 truncate font-display text-title font-semibold">
        {`Photo Studio · ${p.title}`}
        {p.version != null && <span className="ml-1 font-mono text-small text-studio-muted">v{p.version}</span>}
      </h1>
      <div className="flex items-center gap-0.5" role="group" aria-label="Undo and redo">
        <Button size="icon-sm" variant="ghost" aria-label="Undo (Ctrl+Z)" title="Undo (Ctrl+Z)" disabled={!p.canUndo} onClick={p.onUndo}>
          <Undo2 aria-hidden />
        </Button>
        <Button size="icon-sm" variant="ghost" aria-label="Redo (Ctrl+Shift+Z)" title="Redo (Ctrl+Shift+Z)" disabled={!p.canRedo} onClick={p.onRedo}>
          <Redo2 aria-hidden />
        </Button>
      </div>
      <div className="flex items-center gap-0.5" role="group" aria-label="Settings">
        <Button size="sm" variant="ghost" onClick={p.onCopy} aria-label="Copy settings (Ctrl+Alt+C)" title="Copy settings (Ctrl+Alt+C)">
          <ClipboardCopy aria-hidden />
          {label('Copy')}
        </Button>
        <Button size="sm" variant="ghost" onClick={p.onPaste ?? undefined} disabled={!p.onPaste} aria-label="Paste settings (Ctrl+Alt+V)" title="Paste settings (Ctrl+Alt+V)">
          <ClipboardPaste aria-hidden />
          {label('Paste')}
        </Button>
        {p.onSync && (
          <Button size="sm" variant="secondary" onClick={p.onSync} aria-label={`Sync settings to ${p.syncCount} photos (Ctrl+Alt+S)`} title="Sync settings to the photos picked in the filmstrip (Ctrl+Alt+S)">
            <RefreshCw aria-hidden />
            {label(`Sync ${p.syncCount}`)}
          </Button>
        )}
      </div>
      <Button size="sm" variant="ghost" onClick={p.onHistory} aria-label="Manage versions">
        <Layers aria-hidden />
        {label('Versions')}
      </Button>
      <Button size="sm" variant="ghost" onClick={p.onAuto} loading={p.autoPending} aria-label="Auto">
        <Wand2 aria-hidden />
        {label('Auto')}
      </Button>
      <Button size="sm" variant="primary" onClick={p.onSave} loading={p.savePending} disabled={!p.dirty} aria-label="Save as new version">
        <Save aria-hidden />
        {label('Save as new version')}
        <Kbd className="max-lg:hidden">Ctrl+S</Kbd>
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="secondary" aria-label="Export" loading={!!p.exportPending}>
            <Download aria-hidden />
            {label('Export')}
            <ChevronDown aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          <DropdownMenuLabel>Save a copy as a new version</DropdownMenuLabel>
          {offered.map((e) => (
            <DropdownMenuItem key={e.id} onSelect={() => p.onExport(e.id)}>
              <span className="flex flex-col">
                <span>{e.label}</span>
                <span className="text-[12px] text-studio-muted">{e.hint}</span>
              </span>
            </DropdownMenuItem>
          ))}
          {p.downloadHref && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem asChild>
                <a href={p.downloadHref} download>
                  <Download aria-hidden />
                  Download this version as it is
                </a>
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <div className="flex items-center gap-0.5 max-md:hidden" role="group" aria-label="Panels">
        <Button size="icon-sm" variant="ghost" aria-pressed={p.left} aria-label="Left panel (Tab hides both)" title="Left panel: Navigator, Presets, Snapshots, History" onClick={p.onLeft}>
          <PanelLeft aria-hidden />
        </Button>
        <Button size="icon-sm" variant="ghost" aria-pressed={p.right} aria-label="Right panel" title="Right panel: histogram and edit panels" onClick={p.onRight}>
          <PanelRight aria-hidden />
        </Button>
        <Popover>
          <PopoverTrigger asChild>
            <Button size="icon-sm" variant="ghost" aria-label="Keyboard shortcuts" title="Keyboard shortcuts">
              <Keyboard aria-hidden />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-80">
            <h2 className="mb-2 font-display text-body font-semibold">Develop shortcuts</h2>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-small">
              {SHORTCUTS.map(([k, v]) => (
                <div key={k} className="contents">
                  <dt><Kbd>{k}</Kbd></dt>
                  <dd className="text-studio-muted">{v}</dd>
                </div>
              ))}
            </dl>
          </PopoverContent>
        </Popover>
      </div>
      {p.onPanel && (
        <Button size="sm" variant="secondary" onClick={p.onPanel} aria-label="Adjustments">
          <SlidersHorizontal aria-hidden />
          {label('Adjust')}
        </Button>
      )}
    </header>
  )
}
