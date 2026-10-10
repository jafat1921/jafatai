import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Kbd } from '@/components/ui/kbd'
import { modKey } from '@/lib/keyboard'
import { NUMBERED } from './pages'

type Row = [keys: string[], what: string]

const EDITOR: Row[] = [
  [['Space'], 'Play or pause'],
  [['I'], 'Set the region start at the playhead'],
  [['O'], 'Set the region end at the playhead'],
  [['Delete'], 'Cut the region'],
  [['M'], 'Add a marker at the playhead'],
  [['L'], 'Loop the region'],
  [['←', '→'], 'Nudge the playhead (Shift: ×10)'],
  [['Home', 'End'], 'Go to the start or end'],
  [['+', '−'], 'Zoom in or out'],
  [[modKey, 'Z'], 'Undo'],
  [[modKey, 'Shift', 'Z'], 'Redo'],
]

const VOICE: Row[] = [
  [[modKey, 'Enter'], 'Speak the script (Design: preview)'],
  [['Esc'], 'Close a picker or dialog'],
]

function Rows({ rows }: { rows: Row[] }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-small">
      {rows.map(([keys, what]) => (
        <div key={what} className="contents">
          <dt className="flex items-center gap-1">
            {keys.map((k) => (
              <Kbd key={k}>{k}</Kbd>
            ))}
          </dt>
          <dd className="text-studio-muted">{what}</dd>
        </div>
      ))}
    </dl>
  )
}

export function ShortcutSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const pages: Row[] = NUMBERED.map((p, i) => [[modKey, String(i + 1)], p.label])
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Audio shortcuts</DialogTitle>
          <DialogDescription>Ignored while you type in a field. The editor keys work when the waveform has focus.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-6 sm:grid-cols-2">
          <section aria-labelledby="sc-pages">
            <h3 id="sc-pages" className="section-label mb-2">
              Pages
            </h3>
            <Rows rows={[...pages, [['?'], 'This sheet']]} />
          </section>
          <section aria-labelledby="sc-voice" className="sm:col-start-1">
            <h3 id="sc-voice" className="section-label mb-2">
              Speak and Design
            </h3>
            <Rows rows={VOICE} />
          </section>
          <section aria-labelledby="sc-editor">
            <h3 id="sc-editor" className="section-label mb-2">
              Editor
            </h3>
            <Rows rows={EDITOR} />
          </section>
        </div>
      </DialogContent>
    </Dialog>
  )
}
