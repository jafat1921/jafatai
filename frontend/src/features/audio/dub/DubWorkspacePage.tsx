import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { Link, useParams } from 'react-router'
import { AlertTriangle, ArrowLeft, Download, Eye, Loader2, Merge, RefreshCw, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { Progress } from '@/components/ui/progress'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ErrorState } from '@/components/studio/states'
import { useContinueDub, useDub, useMergeSegments, usePatchDub, useRegenDub, useSplitSegment } from '@/hooks/useDub'
import { useVoiceEngines, useVoices } from '@/hooks/useVoices'
import { changedIds, checkpoint, dubBusy, failure, FIT_LABEL, segmentAt, STAGE_LABEL, type Dub, type FitMode, type SegmentEdit } from '@/lib/dub'
import { isTypingTarget } from '@/lib/keyboard'
import { allLanguages, languageName } from '@/lib/voice'
import { announce } from '@/stores/ui'
import { SELECT } from '../voice/AddVoiceDialog'
import { CastingBoard } from './CastingBoard'
import { DubExportDrawer } from './DubExportDrawer'
import { DubPlayer, type Listen, type PlayerHandle } from './DubPlayer'
import { GlossaryEditor } from './GlossaryEditor'
import { LineEditor, type LineEditorHandle } from './LineEditor'
import { SegmentTable } from './SegmentTable'
import { StageStepper } from './StageStepper'
import { Timeline } from './Timeline'

// earthy inks that sit on parchment; a speaker keeps its colour across the table and the timeline
const SPEAKER_INKS = ['#8A5A2B', '#2F5D62', '#7A3E48', '#4E6B3A', '#5B4A7A', '#9A7B2F', '#3E5A7A', '#7A5A3E']
const JUMP_S = 5

export function DubWorkspacePage() {
  const { id } = useParams()
  const q = useDub(id)
  if (q.isPending) {
    return (
      <div className="flex flex-col gap-3 p-6">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-64" />
      </div>
    )
  }
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} className="m-6" />
  return <DubWorkspace key={q.data.id} dub={q.data} />
}

function Banner({ dub, onContinue, pending, error }: { dub: Dub; onContinue: () => void; pending: boolean; error: Error | null }) {
  const note = checkpoint(dub)
  const fail = failure(dub)
  const busy = dubBusy(dub)
  if (busy) {
    return (
      <div role="status" className="flex flex-col gap-1.5 rounded-[6px] border border-studio-border bg-studio-panel px-3 py-2">
        <p className="flex items-center gap-2 text-small">
          <Loader2 aria-hidden className="size-3.5 animate-spin text-studio-accent" />
          <span className="font-medium">{STAGE_LABEL[dub.stage]}</span>
          <span className="truncate text-studio-muted">{dub.job?.message}</span>
        </p>
        <Progress value={dub.job?.status === 'running' ? (dub.job.progress ?? 0) : null} label={`${STAGE_LABEL[dub.stage]} progress`} />
      </div>
    )
  }
  if (!note && !fail) return null
  return (
    <div
      role={fail ? 'alert' : 'status'}
      className={`flex flex-wrap items-center gap-2 rounded-[6px] border px-3 py-2 text-small ${fail ? 'border-studio-danger bg-studio-danger/5' : 'border-studio-warning bg-studio-warning/10'}`}
    >
      {fail ? <AlertTriangle aria-hidden className="size-4 text-studio-danger" /> : <Eye aria-hidden className="size-4 text-studio-warning" />}
      <p className="min-w-0 flex-1">{fail ? `${STAGE_LABEL[fail.stage]} failed: ${fail.error}` : note}</p>
      {error && <span className="text-studio-danger">{error.message}</span>}
      <Button type="button" size="sm" variant="primary" loading={pending} onClick={onContinue}>
        {fail ? 'Try again' : 'Continue'}
      </Button>
    </div>
  )
}

function DubWorkspace({ dub }: { dub: Dub }) {
  const { engines } = useVoiceEngines()
  const voices = useVoices().data ?? []
  const name = (code: string) => languageName(code, engines)
  const [lang, setLang] = useState(dub.targets[0] ?? 'ur')
  const [listen, setListen] = useState<Listen>('original')
  const [time, setTime] = useState(0)
  const [focused, setFocused] = useState(0)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [exporting, setExporting] = useState(false)
  const player = useRef<PlayerHandle>(null)
  const editor = useRef<LineEditorHandle>(null)
  const patch = usePatchDub(dub.id)
  const cont = useContinueDub(dub.id)
  const regen = useRegenDub(dub.id)
  const split = useSplitSegment(dub.id)
  const merge = useMergeSegments(dub.id)

  const segs = dub.segments
  const busy = dubBusy(dub)
  const translated = ['review', 'done'].includes(dub.stages.translate?.status ?? '')
  const showTarget = translated || segs.some((s) => s.target?.[lang]?.text)
  const changed = changedIds(segs, lang)
  const playing = segmentAt(segs, time)
  const current = segs[Math.min(focused, segs.length - 1)]
  const order = new Map(dub.speakers.map((s, i) => [s.id, i]))
  const colorOf = (sid: string | null) => SPEAKER_INKS[(order.get(sid ?? '') ?? 0) % SPEAKER_INKS.length]
  const langs = allLanguages(engines.map((e) => e.languages))
  const activeLang = dub.targets.includes(lang) ? lang : dub.targets[0]

  const focusRow = (i: number, extend = false) => {
    const next = Math.max(0, Math.min(segs.length - 1, i))
    if (extend && segs[next]) setSelected((s) => new Set([...s, segs[focused]?.id, segs[next].id].filter(Boolean) as string[]))
    setFocused(next)
  }
  const toggleRow = (sid: string) =>
    setSelected((s) => {
      const n = new Set(s)
      if (n.has(sid)) n.delete(sid)
      else n.add(sid)
      return n
    })

  // J / K / L and Space drive the picture, ↑ / ↓ walk the lines, Enter edits the focused one
  const onKey = useEffectEvent((e: KeyboardEvent) => {
    if (e.defaultPrevented || e.altKey || e.metaKey || e.ctrlKey || isTypingTarget(e.target)) return
    const el = e.target as HTMLElement | null
    if (el?.closest('[role="dialog"], [role="group"], [role="radiogroup"], [role="tablist"], video')) return
    const k = e.key
    if (k === ' ' || k === 'k' || k === 'K') player.current?.toggle()
    else if (k === 'j' || k === 'J') player.current?.nudge(-JUMP_S)
    else if (k === 'l' || k === 'L') player.current?.nudge(JUMP_S)
    else if (k === 'ArrowDown') focusRow(focused + 1, e.shiftKey)
    else if (k === 'ArrowUp') focusRow(focused - 1, e.shiftKey)
    else if (k === 'Enter' && current && !busy && !el?.closest('button, a')) editor.current?.focus()
    else return
    e.preventDefault()
  })
  useEffect(() => {
    const on = (e: KeyboardEvent) => onKey(e)
    document.addEventListener('keydown', on)
    return () => document.removeEventListener('keydown', on)
  }, [])

  const edit = (edits: SegmentEdit[], done?: () => void) => patch.mutate({ segments: edits }, { onSuccess: done })
  const saveLine = (e: SegmentEdit, next: boolean) => {
    const move = () => {
      if (!next) return
      focusRow(focused + 1)
      requestAnimationFrame(() => editor.current?.focus())
    }
    if (Object.keys(e).length > 1) edit([e], move)
    else move()
  }
  const picked = segs.filter((s) => selected.has(s.id))
  const bulk = (fn: (id: string) => SegmentEdit) => edit(picked.map((s) => fn(s.id)), () => announce(`${picked.length} lines changed.`))

  return (
    <main data-f6-region tabIndex={-1} aria-labelledby="dub-ws-title" className="relative h-full overflow-y-auto focus-visible:outline-none">
      <div className="mx-auto flex max-w-7xl flex-col gap-3 px-4 py-4 md:px-6">
        <header className="flex flex-wrap items-center gap-2">
          <Link to="/audio/dub" aria-label="All dubs" className="rounded-[4px] p-1 text-studio-muted hover:bg-studio-panel-hover hover:text-studio-text">
            <ArrowLeft aria-hidden className="size-4" />
          </Link>
          <div className="min-w-0 flex-1">
            <h1 id="dub-ws-title" className="truncate font-display text-title font-semibold">
              {dub.title}
            </h1>
            <p className="text-[11px] text-studio-muted">
              {dub.source_language ? name(dub.source_language) : 'Language being detected'} → {dub.targets.map(name).join(', ')} · {segs.length} lines · {dub.speakers.length} speakers ·{' '}
              {dub.settings.quality === 'careful' ? 'Careful translation' : 'Fast translation'}
            </p>
          </div>
          <Button type="button" onClick={() => setExporting(true)} disabled={!Object.keys(dub.tracks).length}>
            <Download aria-hidden />
            Export
          </Button>
        </header>

        <StageStepper dub={dub} />
        <Banner dub={dub} onContinue={() => cont.mutate()} pending={cont.isPending} error={cont.error} />

        <div className="grid gap-3 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
          <div className="flex flex-col gap-3">
            <DubPlayer ref={player} dub={dub} lang={activeLang} langName={name(activeLang)} listen={listen} onListen={setListen} onTime={setTime} />
            <Timeline
              segments={segs}
              duration={dub.duration_s ?? 0}
              time={time}
              lang={activeLang}
              focused={focused}
              colorOf={colorOf}
              onSeek={(t) => player.current?.seek(t)}
              onFocus={(i) => focusRow(i)}
            />
            <p className="text-[11px] text-studio-muted">
              <Kbd>J</Kbd> <Kbd>K</Kbd> <Kbd>L</Kbd> or <Kbd>Space</Kbd> play · <Kbd>↑</Kbd> <Kbd>↓</Kbd> lines · <Kbd>Enter</Kbd> edit
            </p>
          </div>

          <Tabs defaultValue="lines" className="flex min-w-0 flex-col gap-2">
            <TabsList aria-label="Dub panels">
              <TabsTrigger value="lines">Lines</TabsTrigger>
              <TabsTrigger value="cast">Cast</TabsTrigger>
              <TabsTrigger value="glossary">Glossary</TabsTrigger>
            </TabsList>

            <TabsContent value="lines" className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <Tabs value={activeLang} onValueChange={setLang}>
                  <TabsList aria-label="Language">
                    {dub.targets.map((t) => (
                      <TabsTrigger key={t} value={t}>
                        {name(t)}
                      </TabsTrigger>
                    ))}
                  </TabsList>
                </Tabs>
                <label className="sr-only" htmlFor="dub-add-lang">
                  Add a language
                </label>
                <select
                  id="dub-add-lang"
                  value=""
                  disabled={busy || dub.targets.length >= 8}
                  onChange={(e) => e.target.value && patch.mutate({ targets: [...dub.targets, e.target.value] })}
                  className={`${SELECT} h-7 w-36`}
                >
                  <option value="">Add a language…</option>
                  {langs
                    .filter((l) => !dub.targets.includes(l.code))
                    .map((l) => (
                      <option key={l.code} value={l.code}>
                        {l.name}
                      </option>
                    ))}
                </select>
                <Button
                  type="button"
                  size="sm"
                  variant="primary"
                  className="ml-auto"
                  disabled={busy || !changed.length || dub.stages.translate?.status !== 'done'}
                  loading={regen.isPending}
                  title={dub.stages.translate?.status !== 'done' ? 'Continue the pipeline past the translation first' : undefined}
                  onClick={() => regen.mutate({ lang: activeLang }, { onSuccess: () => announce(`Regenerating ${changed.length} changed lines.`) })}
                >
                  <RefreshCw aria-hidden />
                  Regen {changed.length} changed
                </Button>
              </div>
              {regen.error && <ErrorState compact title="Couldn't regenerate" error={regen.error} />}

              {picked.length > 0 && (
                <div role="toolbar" aria-label="Selected lines" className="flex flex-wrap items-center gap-2 rounded-[6px] border border-studio-accent/50 bg-studio-accent/5 px-2 py-1.5 text-small">
                  <span className="font-medium">{picked.length} selected</span>
                  <select aria-label="Set the speaker" value="" disabled={busy} onChange={(e) => e.target.value && bulk((sid) => ({ id: sid, speaker_id: e.target.value }))} className={`${SELECT} h-7 w-32`}>
                    <option value="">Speaker…</option>
                    {dub.speakers.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                  {showTarget && (
                    <>
                      <select
                        aria-label={`Set the ${name(activeLang)} voice`}
                        value=""
                        disabled={busy}
                        onChange={(e) => e.target.value && bulk((sid) => ({ id: sid, target: { [activeLang]: { voice_id: e.target.value === '-' ? null : e.target.value } } }))}
                        className={`${SELECT} h-7 w-36`}
                      >
                        <option value="">Voice…</option>
                        <option value="-">Speaker's voice</option>
                        {voices.map((v) => (
                          <option key={v.id} value={v.id}>
                            {v.name}
                          </option>
                        ))}
                      </select>
                      <select
                        aria-label="Set the timing fit"
                        value=""
                        disabled={busy}
                        onChange={(e) => e.target.value && bulk((sid) => ({ id: sid, target: { [activeLang]: { fit: e.target.value as FitMode } } }))}
                        className={`${SELECT} h-7 w-32`}
                      >
                        <option value="">Fit…</option>
                        {(Object.keys(FIT_LABEL) as FitMode[]).map((f) => (
                          <option key={f} value={f}>
                            {FIT_LABEL[f]}
                          </option>
                        ))}
                      </select>
                    </>
                  )}
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={busy || picked.length < 2}
                    loading={merge.isPending}
                    onClick={() => merge.mutate(picked.map((s) => s.id), { onSuccess: () => setSelected(new Set()) })}
                  >
                    <Merge aria-hidden />
                    Merge
                  </Button>
                  {showTarget && (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={busy || dub.stages.translate?.status !== 'done'}
                      onClick={() => regen.mutate({ lang: activeLang, segment_ids: picked.map((s) => s.id) })}
                    >
                      <RefreshCw aria-hidden />
                      Regen selected
                    </Button>
                  )}
                  <Button type="button" size="icon-sm" variant="ghost" aria-label="Clear the selection" className="ml-auto" onClick={() => setSelected(new Set())}>
                    <X aria-hidden />
                  </Button>
                  {merge.error && <span className="basis-full text-studio-danger">{merge.error.message}</span>}
                </div>
              )}

              {segs.length === 0 ? (
                <p className="rounded-[6px] border border-dashed border-studio-border px-3 py-6 text-center text-small text-studio-muted">
                  The lines appear here once the transcript is ready.
                </p>
              ) : (
                <>
                  <SegmentTable
                    segments={segs}
                    speakers={dub.speakers}
                    lang={activeLang}
                    langName={name(activeLang)}
                    showTarget={showTarget}
                    focused={focused}
                    selected={selected}
                    playing={playing}
                    colorOf={colorOf}
                    onFocus={focusRow}
                    onToggle={toggleRow}
                    onEdit={() => editor.current?.focus()}
                    onSeek={(t) => player.current?.seek(t)}
                  />
                  {current && (
                    <LineEditor
                      ref={editor}
                      seg={current}
                      index={focused}
                      lang={activeLang}
                      langName={name(activeLang)}
                      showTarget={showTarget}
                      speakers={dub.speakers}
                      voices={voices}
                      time={time}
                      disabled={busy}
                      saving={patch.isPending}
                      onSave={saveLine}
                      onSplit={(at) => split.mutate({ segment_id: current.id, at })}
                    />
                  )}
                  {(patch.error || split.error) && <ErrorState compact title="Couldn't save" error={patch.error ?? split.error} />}
                </>
              )}
            </TabsContent>

            <TabsContent value="cast">
              <CastingBoard
                dub={dub}
                voices={voices}
                engines={engines}
                language={activeLang}
                languages={langs}
                colorOf={colorOf}
                disabled={busy}
                onCast={(speakers) => patch.mutate({ speakers })}
              />
            </TabsContent>

            <TabsContent value="glossary">
              <GlossaryEditor glossary={dub.glossary} targets={dub.targets} name={name} saving={patch.isPending} onSave={(glossary) => patch.mutate({ glossary })} />
            </TabsContent>
          </Tabs>
        </div>
      </div>
      {exporting && <DubExportDrawer open={exporting} onOpenChange={setExporting} dub={dub} name={name} />}
    </main>
  )
}
