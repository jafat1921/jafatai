import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { Link, useParams } from 'react-router'
import { ArrowLeft, ClipboardPaste, Download, FileInput, Layers, Pause, Play, Plus, Scissors, Settings2, Clapperboard, Wand2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { ErrorState } from '@/components/studio/states'
import { AerabButton } from '@/components/text/AerabButton'
import { useImportProject, useMixScript, usePatchScript, useRenderLines, useScript, useSplitScript, useStemsScript } from '@/hooks/useDialogue'
import { useVoiceChoices } from '@/hooks/useGallery'
import { useVoiceEngines } from '@/hooks/useVoices'
import { isArabicScriptLang, joinLines, splitLines } from '@/lib/aerab'
import { clock } from '@/lib/audio'
import {
  LOUDNESS_LABEL,
  blankLine,
  changedLines,
  mergeServer,
  mixBlockedReason,
  moveLine,
  progressOf,
  runtimeEstimate,
  toPatch,
  type CastMember,
  type LoudnessPreset,
  type Script,
  type ScriptLine,
  type ScriptSettings,
} from '@/lib/dialogue'
import { AUTO_ENGINE, languageName } from '@/lib/voice'
import { cn } from '@/lib/utils'
import { announce } from '@/stores/ui'
import { togglePlay, useTrack } from '../sharedAudio'
import { SELECT } from '../voice/AddVoiceDialog'
import { CastPanel } from './CastPanel'
import { ImportProjectDialog } from './ImportProjectDialog'
import { LineList, type LineActions } from './LineList'
import { PasteSplitDialog } from './PasteSplitDialog'

const SAVE_AFTER_MS = 600
const UNDO_MS = 8000

export function DialogueEditorPage() {
  const { id = '' } = useParams()
  const q = useScript(id)
  if (q.isPending)
    return (
      <div className="flex flex-col gap-2 p-6">
        <Skeleton className="h-10" />
        <Skeleton className="h-64" />
      </div>
    )
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} className="m-6" />
  return <Editor key={q.data.id} script={q.data} />
}

const busy = (s: string | undefined) => s === 'queued' || s === 'running'
const message = (e: unknown) => (e instanceof Error ? e.message : null)

function Editor({ script }: { script: Script }) {
  const save = usePatchScript(script.id)
  const split = useSplitScript(script.id)
  const imp = useImportProject(script.id)
  const render = useRenderLines(script.id)
  const mix = useMixScript(script.id)
  const stems = useStemsScript(script.id)
  const voices = useVoiceChoices()
  const { engines } = useVoiceEngines()

  const [local, setLocal] = useState({ cast: script.cast, lines: script.lines })
  const [ver, setVer] = useState(0)
  const [savedVer, setSavedVer] = useState(0)
  const dirty = ver !== savedVer
  const [seen, setSeen] = useState(script)
  if (seen !== script) {
    setSeen(script)
    setLocal((l) => ({
      cast: dirty ? l.cast.map((c) => ({ ...c, color: c.color ?? script.cast.find((x) => x.id === c.id)?.color ?? null })) : script.cast,
      lines: mergeServer(l.lines, script.lines, dirty),
    }))
  }

  const latest = useRef(local)
  useEffect(() => {
    latest.current = local
  })
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const saveNow = useCallback(
    async (v: number) => {
      if (timer.current) clearTimeout(timer.current)
      timer.current = null
      const { cast, lines } = latest.current
      await save.mutateAsync({ cast, lines: lines.map(toPatch) })
      setSavedVer((s) => Math.max(s, v))
    },
    [save],
  )
  useEffect(() => {
    if (ver === savedVer) return
    timer.current = setTimeout(() => saveNow(ver).catch(() => {}), SAVE_AFTER_MS)
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [ver, savedVer, saveNow])
  const flush = () => (dirty ? saveNow(ver) : Promise.resolve())

  const edit = (fn: (l: { cast: CastMember[]; lines: ScriptLine[] }) => { cast: CastMember[]; lines: ScriptLine[] }) => {
    setLocal(fn)
    setVer((v) => v + 1)
  }

  const [undo, setUndo] = useState<{ line: ScriptLine; index: number } | null>(null)
  useEffect(() => {
    if (!undo) return
    const t = setTimeout(() => setUndo(null), UNDO_MS)
    return () => clearTimeout(t)
  }, [undo])
  const [focusText, setFocusText] = useState<string | null>(null)
  const clearFocus = useCallback(() => setFocusText(null), [])

  // what the user typed over the server's latest bookkeeping, so an edit reads as changed at once
  const lines = mergeServer(local.lines, script.lines, true)
  const renderIds = (ids: string[]) => {
    if (!ids.length) return
    flush()
      .then(() => render.mutateAsync(ids))
      .then((r) => announce(r.failed ? `${r.queued} queued, ${r.failed} couldn't start.` : `Rendering ${r.queued} line${r.queued === 1 ? '' : 's'}.`))
      .catch(() => {})
  }
  const actions: LineActions = {
    change: (id, patch) => edit((l) => ({ ...l, lines: l.lines.map((x) => (x.id === id ? { ...x, ...patch } : x)) })),
    insertAfter: (index, text = '') => {
      const line = { ...blankLine(lines[index]?.speaker_id), text }
      edit((l) => {
        const next = l.lines.slice()
        next.splice(index + 1, 0, line)
        return { ...l, lines: next }
      })
      return line.id
    },
    remove: (index) => {
      const line = lines[index]
      if (!line) return
      edit((l) => ({ ...l, lines: l.lines.filter((x) => x.id !== line.id) }))
      setUndo({ line, index })
      announce(`Line ${index + 1} removed. Undo is in the bar below the toolbar.`)
    },
    move: (from, to) => {
      if (to < 0 || to >= lines.length) return
      edit((l) => ({ ...l, lines: moveLine(l.lines, from, to) }))
      announce(`Moved to line ${to + 1}.`)
    },
    render: (id) => renderIds([id]),
  }
  const restore = () => {
    if (!undo) return
    edit((l) => {
      const next = l.lines.slice()
      next.splice(Math.min(undo.index, next.length), 0, undo.line)
      return { ...l, lines: next }
    })
    setUndo(null)
    announce('Line restored.')
  }
  const addLine = () => setFocusText(actions.insertAfter(lines.length - 1))
  // every line in one marking pass; the result goes back line by line
  const setAllTexts = (marked: string) => {
    const next = splitLines(lines.map((l) => l.text), marked)
    if (!next) return
    const byId = new Map(lines.map((l, i) => [l.id, next[i]]))
    edit((l) => ({ ...l, lines: l.lines.map((x) => (byId.has(x.id) && byId.get(x.id) !== x.text ? { ...x, text: byId.get(x.id)! } : x)) }))
  }

  const changed = changedLines(lines)
  const blocked = mixBlockedReason(lines, dirty)
  const mixing = busy(script.mix_job?.status) || mix.isPending
  const stemming = busy(script.stems_job?.status) || stems.isPending
  const { ready, total, rendering } = progressOf(lines)
  const counts: Record<string, number> = {}
  for (const l of lines) counts[l.speaker_id] = (counts[l.speaker_id] ?? 0) + 1

  const [pasting, setPasting] = useState(false)
  const [importing, setImporting] = useState(false)
  const runMix = () => flush().then(() => mix.mutateAsync()).catch(() => {})
  const runStems = () => flush().then(() => stems.mutateAsync()).catch(() => {})
  const reasonId = useId()
  const problem = message(render.error) ?? message(mix.error) ?? message(stems.error) ?? message(save.error)
  const stemsUrl = script.stems_job?.status === 'done' ? (script.stems_job.result as { url?: string } | null)?.url : null

  return (
    <main data-f6-region tabIndex={-1} aria-labelledby="script-title" className="flex h-full min-h-0 flex-col focus-visible:outline-none">
      <header className="flex flex-wrap items-center gap-2 border-b border-studio-border bg-studio-panel px-3 py-2">
        <Button asChild size="icon-sm" variant="ghost">
          <Link to="/audio/dialogue" aria-label="All scripts">
            <ArrowLeft aria-hidden />
          </Link>
        </Button>
        <h1 id="script-title" className="sr-only">
          {script.title}
        </h1>
        <TitleField title={script.title} onSave={(title) => save.mutate({ title })} />
        <span className="text-[11px] text-studio-muted">{languageName(script.language, engines)}</span>
        <div role="toolbar" aria-label="Script" className="ml-auto flex flex-wrap items-center gap-1.5">
          <Button type="button" size="sm" onClick={() => setPasting(true)}>
            <ClipboardPaste aria-hidden />
            Paste & split
          </Button>
          <Button type="button" size="sm" onClick={() => setImporting(true)}>
            <FileInput aria-hidden />
            Import from project
          </Button>
          <AerabButton text={joinLines(lines.map((l) => l.text))} onText={setAllTexts} language={script.language} label="Add aerab to all lines" showNote={false} />
          <SettingsPopover script={script} engines={engines} onSave={(patch) => save.mutate(patch)} />
          <Button type="button" size="sm" variant="primary" disabled={changed.length === 0} loading={render.isPending} onClick={() => renderIds(changed.map((l) => l.id))}>
            <Wand2 aria-hidden />
            Render {changed.length} changed
          </Button>
          <Button type="button" size="sm" aria-disabled={!!blocked || mixing || undefined} aria-describedby={blocked ? reasonId : undefined} loading={mixing} onClick={() => !blocked && !mixing && runMix()}>
            <Layers aria-hidden />
            Mix
          </Button>
          <Button type="button" size="sm" variant="ghost" aria-disabled={!!blocked || stemming || undefined} loading={stemming} onClick={() => !blocked && !stemming && runStems()}>
            Stems
          </Button>
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-studio-border bg-studio-raised px-3 py-1.5 text-[12px] text-studio-muted">
        <span>
          Runtime ≈ <span className="font-mono text-studio-text">{clock(runtimeEstimate(lines, script.settings))}</span>
        </span>
        <span className="flex items-center gap-2">
          <progress aria-label="Lines ready" value={ready} max={Math.max(1, total)} className="h-1.5 w-28 accent-studio-accent" />
          {ready} of {total} ready{rendering ? ` · ${rendering} rendering` : ''}
        </span>
        {blocked && (
          <span id={reasonId} className="text-studio-warning">
            Mix: {blocked}
          </span>
        )}
        <span aria-live="polite">{dirty ? 'Saving…' : save.isError ? '' : 'Saved'}</span>
      </div>

      {(undo || problem) && (
        <div className="flex flex-wrap items-center gap-3 border-b border-studio-border px-3 py-1.5 text-small">
          {problem && (
            <p role="alert" className="text-studio-danger">
              {problem}
            </p>
          )}
          {undo && (
            <p className="flex items-center gap-2">
              Line {undo.index + 1} removed.
              <Button type="button" size="sm" variant="outline" onClick={restore}>
                Undo
              </Button>
            </p>
          )}
        </div>
      )}

      <MixBar script={script} stemsUrl={stemsUrl ?? null} />

      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <CastPanel cast={local.cast} lineCounts={counts} voices={voices} engines={engines} language={script.language} onChange={(cast) => edit((l) => ({ ...l, cast }))} />
        <section aria-label="Lines" className="flex min-h-0 min-w-0 flex-1 flex-col">
          {lines.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
              <p className="font-display text-title">An empty script</p>
              <p className="max-w-md text-small text-studio-muted">Paste a script (NAME: lines and screenplay cues are cast for you), import one from a film project, or start typing.</p>
              <div className="flex flex-wrap justify-center gap-2">
                <Button type="button" variant="primary" onClick={() => setPasting(true)}>
                  <ClipboardPaste aria-hidden />
                  Paste & split
                </Button>
                <Button type="button" onClick={() => setImporting(true)}>
                  <FileInput aria-hidden />
                  Import from project
                </Button>
                <Button type="button" variant="ghost" onClick={addLine}>
                  <Plus aria-hidden />
                  Add a line
                </Button>
              </div>
            </div>
          ) : (
            <>
              <LineList lines={lines} cast={local.cast} voices={voices} engines={engines} language={script.language} title={script.title} actions={actions} focusText={focusText} onFocused={clearFocus} />
              <div className="flex flex-wrap items-center gap-3 border-t border-studio-border px-3 py-1.5">
                <Button type="button" size="sm" variant="ghost" onClick={addLine}>
                  <Plus aria-hidden />
                  Add line
                </Button>
                <p className="text-[11px] text-studio-faint">
                  On a line: ↑ ↓ move · Alt+↑ ↓ reorder · Enter new line · Ctrl+Enter render · Delete remove · F2 edit
                </p>
              </div>
            </>
          )}
        </section>
      </div>

      <PasteSplitDialog
        open={pasting}
        onOpenChange={setPasting}
        cast={local.cast}
        pending={split.isPending}
        error={message(split.error)}
        onSplit={(body) =>
          flush()
            .then(() => split.mutateAsync(body))
            .then((s) => {
              setPasting(false)
              announce(`${s.lines.length - lines.length} lines added.`)
            })
            .catch(() => {})
        }
      />
      <ImportProjectDialog
        open={importing}
        onOpenChange={setImporting}
        defaultProject={script.project_id}
        pending={imp.isPending}
        error={message(imp.error)}
        onImport={(body) =>
          flush()
            .then(() => imp.mutateAsync(body))
            .then((s) => {
              setImporting(false)
              announce(`${s.lines.length - lines.length} lines imported.`)
            })
            .catch(() => {})
        }
      />
    </main>
  )
}

function TitleField({ title, onSave }: { title: string; onSave: (t: string) => void }) {
  const [value, setValue] = useState(title)
  const [was, setWas] = useState(title)
  if (was !== title) {
    setWas(title)
    setValue(title)
  }
  const commit = () => {
    const t = value.trim()
    if (t && t !== title) onSave(t)
    else setValue(title)
  }
  return (
    <Input
      aria-label="Script title"
      value={value}
      maxLength={200}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
      className="h-8 w-56 border-transparent bg-transparent font-display text-[18px] font-semibold hover:border-studio-border"
    />
  )
}

function MixBar({ script, stemsUrl }: { script: Script; stemsUrl: string | null }) {
  const mix = script.mix
  const track = useTrack(`mix-${script.id}`)
  if (!mix?.url && !stemsUrl) return null
  return (
    <section aria-label="Mix" className="flex flex-wrap items-center gap-2 border-b border-studio-border bg-studio-panel px-3 py-1.5 text-small">
      {mix?.url && (
        <>
          <Button
            type="button"
            size="sm"
            variant="outline"
            aria-label={track.playing ? 'Pause the mix' : 'Play the mix'}
            onClick={() => togglePlay(`mix-${script.id}`, mix.url!, { title: `${script.title} · mix`, mediaId: mix.media_id })}
          >
            {track.playing ? <Pause aria-hidden /> : <Play aria-hidden />}
            Mix
          </Button>
          {mix.duration_s ? <span className="font-mono text-[12px] text-studio-muted">{clock(mix.duration_s)}</span> : null}
          {mix.stale && <span className="rounded-[4px] border border-studio-warning px-1.5 text-[11px] leading-5 text-studio-warning">Out of date</span>}
          <Button asChild size="sm" variant="ghost">
            <Link to={`/audio/edit/${mix.media_id}`}>
              <Scissors aria-hidden />
              Open in Editor
            </Link>
          </Button>
          <Button asChild size="sm" variant="ghost">
            <Link to={`/audio/score?audio=${mix.media_id}`}>
              <Clapperboard aria-hidden />
              Use in Score a Clip
            </Link>
          </Button>
        </>
      )}
      {stemsUrl && (
        <Button asChild size="sm" variant="ghost">
          <a href={stemsUrl} download>
            <Download aria-hidden />
            Stems (zip)
          </a>
        </Button>
      )}
    </section>
  )
}

const GAP = 'h-7 w-20 px-2'

function SettingsPopover({ script, engines, onSave }: { script: Script; engines: { id: string; label: string }[]; onSave: (p: { settings?: ScriptSettings; engine?: string }) => void }) {
  const uid = useId()
  const s = script.settings
  const set = (patch: Partial<ScriptSettings>) => onSave({ settings: { ...s, ...patch } })
  const seconds = (v: string) => Math.min(10, Math.max(0, Number(v) || 0))
  return (
    <Popover>
      <PopoverTrigger className="inline-flex h-7 items-center gap-1.5 rounded-[6px] border border-studio-border-strong bg-studio-raised px-2.5 text-small hover:bg-studio-panel-hover [&_svg]:size-4">
        <Settings2 aria-hidden />
        Settings
      </PopoverTrigger>
      <PopoverContent aria-label="Script settings" align="end" className="flex w-80 flex-col gap-3">
        <div className="grid grid-cols-[1fr_auto] items-center gap-2 text-small">
          <label htmlFor={`${uid}-gap`}>Gap between lines (s)</label>
          <Input id={`${uid}-gap`} type="number" min={0} max={10} step={0.05} defaultValue={s.gap_s} onBlur={(e) => set({ gap_s: seconds(e.target.value) })} className={GAP} />
          <label htmlFor={`${uid}-para`}>Gap after a paragraph (s)</label>
          <Input id={`${uid}-para`} type="number" min={0} max={10} step={0.05} defaultValue={s.paragraph_gap_s} onBlur={(e) => set({ paragraph_gap_s: seconds(e.target.value) })} className={GAP} />
        </div>
        <label className="flex flex-col gap-1 text-small">
          <span className="section-label">Loudness</span>
          <select value={s.loudness} onChange={(e) => set({ loudness: e.target.value as LoudnessPreset })} className={SELECT}>
            {(Object.keys(LOUDNESS_LABEL) as LoudnessPreset[]).map((k) => (
              <option key={k} value={k}>
                {LOUDNESS_LABEL[k]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-small">
          <span className="section-label">Engine</span>
          <select value={script.engine} onChange={(e) => onSave({ engine: e.target.value })} className={SELECT}>
            <option value={AUTO_ENGINE}>Auto (per voice)</option>
            {engines.map((e) => (
              <option key={e.id} value={e.id}>
                {e.label}
              </option>
            ))}
          </select>
        </label>
        <div className="flex items-start gap-2">
          <Switch id={`${uid}-aerab`} checked={s.aerab} onCheckedChange={(v) => set({ aerab: v })} className="mt-0.5" />
          <label htmlFor={`${uid}-aerab`} className={cn('text-small', !isArabicScriptLang(script.language) && 'text-studio-muted')}>
            Aerab for Urdu, Arabic and other Arabic-script lines
            <span className="block text-[11px] text-studio-muted">Adds the vowel marks (zer, zabar, pesh; tashkeel for Arabic) before speaking, so the vowels come out right.</span>
          </label>
        </div>
      </PopoverContent>
    </Popover>
  )
}
