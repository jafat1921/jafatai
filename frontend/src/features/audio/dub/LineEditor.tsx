import { forwardRef, useEffect, useId, useImperativeHandle, useRef, useState } from 'react'
import { Scissors } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { Textarea } from '@/components/ui/textarea'
import { FIT_LABEL, stamp, type DubSegment, type DubSpeaker, type FitMode, type SegmentEdit } from '@/lib/dub'
import type { Voice } from '@/lib/types'
import { modKey } from '@/lib/keyboard'
import { SELECT } from '../voice/AddVoiceDialog'

export interface LineEditorHandle {
  focus: () => void
}

interface Props {
  seg: DubSegment
  index: number
  lang: string
  langName: string
  showTarget: boolean
  speakers: DubSpeaker[]
  voices: Voice[]
  time: number
  disabled: boolean
  saving: boolean
  onSave: (edit: SegmentEdit, next: boolean) => void
  onSplit: (at: number) => void
}

interface Draft {
  source: string
  text: string
  speaker: string
  fit: FitMode
  voice: string
}

const draftOf = (seg: DubSegment, lang: string): Draft => ({
  source: seg.source_text,
  text: seg.target?.[lang]?.text ?? '',
  speaker: seg.speaker_id ?? '',
  fit: seg.target?.[lang]?.fit ?? 'smart',
  voice: seg.target?.[lang]?.voice_id ?? '',
})

/** The focused line, editable. Ctrl+Enter saves and moves on; Escape goes back to the list. */
export const LineEditor = forwardRef<LineEditorHandle, Props>(function LineEditor(
  { seg, index, lang, langName, showTarget, speakers, voices, time, disabled, saving, onSave, onSplit },
  ref,
) {
  const uid = useId()
  const [draft, setDraft] = useState<Draft>(() => draftOf(seg, lang))
  const target = useRef<HTMLTextAreaElement>(null)
  const source = useRef<HTMLTextAreaElement>(null)
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }))
  const t = seg.target?.[lang]

  useEffect(() => setDraft(draftOf(seg, lang)), [seg, lang])
  useImperativeHandle(ref, () => ({ focus: () => (showTarget ? target.current : source.current)?.focus() }))

  const edit = (): SegmentEdit | null => {
    const e: SegmentEdit = { id: seg.id }
    if (draft.source.trim() !== seg.source_text) e.source_text = draft.source.trim()
    if (draft.speaker && draft.speaker !== seg.speaker_id) e.speaker_id = draft.speaker
    const tg: NonNullable<SegmentEdit['target']>[string] = {}
    if (showTarget && draft.text.trim() !== (t?.text ?? '')) tg.text = draft.text.trim()
    if (showTarget && draft.fit !== (t?.fit ?? 'smart')) tg.fit = draft.fit
    if (showTarget && draft.voice !== (t?.voice_id ?? '')) tg.voice_id = draft.voice || null
    if (Object.keys(tg).length) e.target = { [lang]: tg }
    return Object.keys(e).length > 1 ? e : null
  }
  const save = (next: boolean) => {
    const e = edit()
    if (e) onSave(e, next)
    else if (next) onSave({ id: seg.id }, true)
  }
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      save(true)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      document.querySelector<HTMLElement>('[data-dub-lines]')?.focus()
    }
  }
  const inside = time > seg.start + 0.2 && time < seg.end - 0.2
  const changed = !!edit()

  return (
    <section aria-labelledby={`${uid}-h`} onKeyDown={onKey} className="flex flex-col gap-2 rounded-[6px] border border-studio-border-strong bg-studio-panel p-3 shadow-card">
      <div className="flex flex-wrap items-center gap-2">
        <h3 id={`${uid}-h`} className="text-body font-medium">
          Line {index + 1} <span className="font-mono text-small text-studio-muted">{stamp(seg.start)}–{stamp(seg.end)}</span>
        </h3>
        <label className="ml-auto flex items-center gap-1.5 text-small">
          <span className="text-studio-muted">Speaker</span>
          <select value={draft.speaker} onChange={(e) => set('speaker', e.target.value)} disabled={disabled} className={`${SELECT} h-7 w-36`}>
            {!seg.speaker_id && <option value="">Unassigned</option>}
            {speakers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className={`grid gap-2 ${showTarget ? 'md:grid-cols-2' : ''}`}>
        <label className="flex flex-col gap-1 text-small">
          <span className="section-label">Heard (transcript)</span>
          <Textarea ref={source} dir="auto" rows={3} value={draft.source} disabled={disabled} onChange={(e) => set('source', e.target.value)} />
        </label>
        {showTarget && (
          <label className="flex flex-col gap-1 text-small">
            <span className="section-label">{langName}</span>
            <Textarea ref={target} dir="auto" lang={lang} rows={3} value={draft.text} disabled={disabled} onChange={(e) => set('text', e.target.value)} />
            {t?.text_before && <span className="text-[11px] text-studio-muted">Shortened to fit; it was: {t.text_before}</span>}
          </label>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-small">
        {showTarget && (
          <>
            <label className="flex items-center gap-1.5">
              <span className="text-studio-muted">Fit</span>
              <select value={draft.fit} onChange={(e) => set('fit', e.target.value as FitMode)} disabled={disabled} className={`${SELECT} h-7 w-32`}>
                {(Object.keys(FIT_LABEL) as FitMode[]).map((f) => (
                  <option key={f} value={f}>
                    {FIT_LABEL[f]}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-1.5">
              <span className="text-studio-muted">Voice</span>
              <select value={draft.voice} onChange={(e) => set('voice', e.target.value)} disabled={disabled} className={`${SELECT} h-7 w-40`}>
                <option value="">Speaker's voice</option>
                {voices.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
        <Button type="button" size="sm" variant="ghost" disabled={disabled || !inside} onClick={() => onSplit(time)} title="Move the playhead inside the line first">
          <Scissors aria-hidden />
          Split at {stamp(time)}
        </Button>
        {t?.error && <span className="text-studio-danger">{t.error}</span>}
        <span className="ml-auto hidden text-[11px] text-studio-muted md:inline">
          <Kbd>{modKey}</Kbd>+<Kbd>Enter</Kbd> save &amp; next · <Kbd>Esc</Kbd> back to the list
        </span>
        <Button type="button" size="sm" variant="primary" disabled={disabled || !changed} loading={saving} onClick={() => save(false)}>
          Save line
        </Button>
      </div>
    </section>
  )
})
