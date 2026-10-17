import { useId, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router'
import { Captions, Download, Film, Music, Pause, Play, Search, Sparkles, Upload } from 'lucide-react'
import { Button, buttonVariants } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState, ErrorState } from '@/components/studio/states'
import { MediaPicker } from '@/components/media/MediaPicker'
import { AerabButton } from '@/components/text/AerabButton'
import { useCleanupTranscript, useSetCleanLines, useStartTranscribe, useSubtitleVideo, useTranscript, useTranscripts } from '@/hooks/useDub'
import { useUploads } from '@/hooks/useUploads'
import { useVoiceEngines } from '@/hooks/useVoices'
import { joinLines, splitLines } from '@/lib/aerab'
import { searchSegments, segmentAt, stamp, subtitlesUrl, transcriptBusy, type Transcript } from '@/lib/dub'
import type { MediaItem } from '@/lib/types'
import { acceptFor } from '@/lib/upload'
import { allLanguages, languageName } from '@/lib/voice'
import { cn } from '@/lib/utils'
import { announce } from '@/stores/ui'
import { SELECT } from '../voice/AddVoiceDialog'
import { cueAudio, togglePlay, usePlayer } from '../sharedAudio'

export function TranscribePage() {
  const [params, setParams] = useSearchParams()
  const open = params.get('t')
  const list = useTranscripts()
  const { engines } = useVoiceEngines()
  const name = (c: string) => languageName(c, engines)
  const show = (id: string) => setParams({ t: id })

  return (
    <main data-f6-region tabIndex={-1} aria-labelledby="tx-title" className="relative h-full overflow-y-auto focus-visible:outline-none">
      <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-6 md:px-8">
        <header>
          <h1 id="tx-title" className="font-display text-title font-semibold">
            Transcribe
          </h1>
          <p className="text-small text-studio-muted">A timed transcript of any clip or video, ready as SRT or VTT subtitles. Urdu, Hindi and 90-odd other languages.</p>
        </header>
        <StartPanel languages={allLanguages(engines.map((e) => e.languages))} onStarted={show} />
        <div className="grid gap-4 md:grid-cols-[16rem_minmax(0,1fr)]">
          <nav aria-label="Transcripts" className="flex flex-col gap-1">
            <h2 className="section-label">Recent</h2>
            {list.isPending ? (
              <Skeleton className="h-24" />
            ) : list.isError ? (
              <ErrorState compact error={list.error} onRetry={() => list.refetch()} />
            ) : !list.data.length ? (
              <p className="text-small text-studio-muted">Nothing transcribed yet.</p>
            ) : (
              <ul className="flex flex-col">
                {list.data.map((t) => (
                  <li key={t.id}>
                    <button
                      type="button"
                      onClick={() => show(t.id)}
                      aria-current={t.id === open || undefined}
                      className={cn('w-full rounded-[4px] px-2 py-1.5 text-left text-small hover:bg-studio-panel-hover', t.id === open && 'bg-studio-panel-hover font-medium')}
                    >
                      <span className="block truncate">{t.title || 'Untitled'}</span>
                      <span className="text-[11px] text-studio-muted">
                        {t.language ? name(t.language) : 'Detecting'} · {t.status === 'done' ? `${stamp(t.duration_s ?? 0)}` : t.status}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </nav>
          {open ? (
            <TranscriptView key={open} id={open} name={name} />
          ) : (
            <EmptyState icon={<Captions />} title="Pick something to transcribe">
              Choose a clip or a video above, or open one you did before.
            </EmptyState>
          )}
        </div>
      </div>
    </main>
  )
}

function StartPanel({ languages, onStarted }: { languages: { code: string; name: string }[]; onStarted: (id: string) => void }) {
  const uid = useId()
  const [picking, setPicking] = useState<'audio' | 'video' | null>(null)
  const [media, setMedia] = useState<MediaItem | null>(null)
  const [language, setLanguage] = useState('auto')
  const [cleanup, setCleanup] = useState(false)
  const start = useStartTranscribe()
  const uploads = useUploads(['audio', 'video'], (item) => setMedia(item))
  const row = uploads.rows[uploads.rows.length - 1]

  const go = () =>
    media &&
    start.mutate(
      { media_id: media.id, language, words: true, cleanup },
      {
        onSuccess: (r) => {
          announce('Transcribing. The transcript opens below.')
          onStarted(r.transcript_id)
        },
      },
    )

  return (
    <section aria-label="New transcript" className="flex flex-col gap-3 rounded-[6px] border border-studio-border-strong bg-studio-panel p-3 shadow-card">
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" onClick={() => setPicking('audio')}>
          <Music aria-hidden />
          Pick audio
        </Button>
        <Button type="button" onClick={() => setPicking('video')}>
          <Film aria-hidden />
          Pick a video
        </Button>
        <label className={cn(buttonVariants({ variant: 'ghost' }), 'cursor-pointer')}>
          <Upload aria-hidden />
          Upload
          <input
            type="file"
            accept={acceptFor(['audio', 'video'])}
            className="sr-only"
            onChange={(e) => {
              if (e.target.files?.length) uploads.add(e.target.files)
              e.target.value = ''
            }}
          />
        </label>
        <span className="min-w-0 truncate text-small" aria-live="polite">
          {media ? (
            <>
              <span className="text-studio-muted">{media.kind === 'video' ? 'Video' : 'Audio'}:</span> <span className="font-medium">{media.title || 'Untitled'}</span>
            </>
          ) : row?.state === 'uploading' ? (
            `Uploading ${row.name}…`
          ) : row?.state === 'error' ? (
            <span className="text-studio-danger">{row.error}</span>
          ) : (
            <span className="text-studio-muted">Nothing picked yet</span>
          )}
        </span>
      </div>
      {row?.state === 'uploading' && <Progress value={row.progress} label={`Uploading ${row.name}`} />}
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex w-48 flex-col gap-1 text-small">
          <span className="section-label">Language</span>
          <select value={language} onChange={(e) => setLanguage(e.target.value)} className={SELECT}>
            <option value="auto">Detect it</option>
            {languages.map((l) => (
              <option key={l.code} value={l.code}>
                {l.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 pb-1.5 text-body">
          <input id={`${uid}-clean`} type="checkbox" checked={cleanup} onChange={(e) => setCleanup(e.target.checked)} className="size-4 accent-studio-accent" />
          Tidy it with the LLM afterwards (fillers out, names kept)
        </label>
        <Button type="button" variant="primary" className="ml-auto" disabled={!media} loading={start.isPending} onClick={go}>
          <Captions aria-hidden />
          Transcribe
        </Button>
      </div>
      {start.error && <ErrorState compact title="Couldn't start" error={start.error} />}
      <MediaPicker
        open={!!picking}
        onOpenChange={(o) => !o && setPicking(null)}
        kind={picking ?? 'audio'}
        max={1}
        title={picking === 'video' ? 'Pick a video' : 'Pick a clip'}
        confirmLabel="Use this"
        onConfirm={([m]) => m && setMedia(m)}
      />
    </section>
  )
}

function TranscriptView({ id, name }: { id: string; name: (c: string) => string }) {
  const q = useTranscript(id)
  if (q.isPending) return <Skeleton className="h-64" />
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />
  return <TranscriptBody t={q.data} name={name} />
}

function Highlight({ text, q }: { text: string; q: string }) {
  const needle = q.trim()
  if (!needle) return <>{text}</>
  const at = text.toLocaleLowerCase().indexOf(needle.toLocaleLowerCase())
  if (at < 0) return <>{text}</>
  return (
    <>
      {text.slice(0, at)}
      <mark className="rounded-[2px] bg-studio-warning/30 text-inherit">{text.slice(at, at + needle.length)}</mark>
      {text.slice(at + needle.length)}
    </>
  )
}

function TranscriptBody({ t, name }: { t: Transcript; name: (c: string) => string }) {
  const [query, setQuery] = useState('')
  const [tidy, setTidy] = useState(!!t.cleanup_text)
  const cleanup = useCleanupTranscript(t.id)
  const setClean = useSetCleanLines(t.id)
  const burn = useSubtitleVideo(t.id)
  const src = t.media?.media_url ?? null
  const trackId = `transcript:${t.id}`
  const mine = usePlayer((s) => s.id === trackId)
  const playing = usePlayer((s) => s.id === trackId && s.playing)
  const time = usePlayer((s) => (s.id === trackId ? s.time : -1))
  const clean = tidy && !!t.cleanup_text
  const cleanLines = t.segments.map((s) => s.clean ?? s.text)
  const hits = useMemo(() => searchSegments(t.segments, query, clean), [t.segments, query, clean])
  const now = segmentAt(t.segments, time)
  const busy = transcriptBusy(t)
  const isVideo = t.media?.kind === 'video'
  const meta = { title: t.title, mediaId: t.media_id, peaks: t.media?.kind === 'audio' }

  const seek = (at: number) => src && cueAudio(trackId, src, meta, at, true)

  return (
    <section aria-labelledby="tx-view" className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="tx-view" className="min-w-0 flex-1 truncate font-display text-[1.15rem] font-semibold">
          {t.title || 'Transcript'}
        </h2>
        {src && (
          <Button type="button" size="sm" onClick={() => togglePlay(trackId, src, meta)} aria-label={`${playing ? 'Pause' : 'Play'} ${t.title}`}>
            {playing ? <Pause aria-hidden /> : <Play aria-hidden />}
            {playing ? 'Pause' : mine ? 'Resume' : 'Play'}
          </Button>
        )}
      </div>
      <p className="text-[11px] text-studio-muted">
        {t.language ? name(t.language) : 'Language not known yet'} · {t.segments.length} lines{t.duration_s ? ` · ${stamp(t.duration_s)}` : ''}
      </p>

      {busy && (
        <div role="status" className="flex flex-col gap-1.5 rounded-[6px] border border-studio-border bg-studio-panel px-3 py-2 text-small">
          <span>{t.status === 'cleaning' ? 'Tidying the transcript…' : t.job?.message || 'Transcribing…'}</span>
          <Progress value={t.job?.status === 'running' ? t.job.progress : null} label="Transcript progress" />
        </div>
      )}
      {t.status === 'failed' && <ErrorState compact title="The transcript failed" error={t.error} />}
      {t.status === 'done' && t.error && <p className="text-small text-studio-warning">{t.error}</p>}

      {t.segments.length > 0 && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <label className="relative min-w-48 flex-1">
              <span className="sr-only">Search the transcript</span>
              <Search aria-hidden className="absolute left-2 top-2 size-4 text-studio-muted" />
              <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search" className="h-8 pl-8" />
            </label>
            {t.cleanup_text ? (
              <>
                <label className="flex items-center gap-1.5 text-small">
                  <input type="checkbox" checked={tidy} onChange={(e) => setTidy(e.target.checked)} className="size-4 accent-studio-accent" />
                  Tidied text
                </label>
                {clean && !busy && (
                  <AerabButton
                    text={joinLines(cleanLines)}
                    onText={(marked) => {
                      const next = splitLines(cleanLines, marked)
                      if (next) setClean.mutate(next)
                    }}
                    language={t.language}
                    label="Add aerab to the tidied text"
                    disabled={setClean.isPending}
                  />
                )}
              </>
            ) : (
              <Button type="button" size="sm" variant="ghost" disabled={busy} loading={cleanup.isPending} onClick={() => cleanup.mutate()}>
                <Sparkles aria-hidden />
                Tidy with the LLM
              </Button>
            )}
            <a href={subtitlesUrl(t.id, 'srt', clean)} download className={buttonVariants({ size: 'sm' })}>
              <Download aria-hidden />
              SRT
            </a>
            <a href={subtitlesUrl(t.id, 'vtt', clean)} download className={buttonVariants({ size: 'sm' })}>
              <Download aria-hidden />
              VTT
            </a>
          </div>
          {cleanup.error && <ErrorState compact title="Couldn't tidy it" error={cleanup.error} />}
          {isVideo && (
            <div className="flex flex-wrap items-center gap-2 rounded-[6px] border border-studio-border bg-studio-panel px-3 py-2 text-small">
              <Film aria-hidden className="size-4 text-studio-muted" />
              <span className="mr-auto">Make subtitles for this video, as a new version in the Library</span>
              <Button type="button" size="sm" disabled={busy} loading={burn.isPending && burn.variables?.mode === 'soft'} onClick={() => burn.mutate({ mode: 'soft', clean })}>
                Soft subtitles
              </Button>
              <Button type="button" size="sm" disabled={busy} loading={burn.isPending && burn.variables?.mode === 'burn'} onClick={() => burn.mutate({ mode: 'burn', clean })}>
                Burn them in
              </Button>
              {burn.data && (
                <span role="status" className="basis-full text-studio-muted">
                  On its way: the new version appears on the video when it's done.
                </span>
              )}
              {burn.error && <span className="basis-full text-studio-danger">{burn.error.message}</span>}
            </div>
          )}
          <p className="sr-only" aria-live="polite">
            {query.trim() ? `${hits.length} matching lines` : ''}
          </p>
          <ol aria-label="Transcript" className="flex flex-col divide-y divide-studio-border rounded-[6px] border border-studio-border bg-studio-panel">
            {hits.map((i) => {
              const s = t.segments[i]
              const text = (clean && s.clean) || s.text
              return (
                <li key={i} className={cn('flex gap-3 px-3 py-2', i === now && 'bg-studio-accent/10')}>
                  <button
                    type="button"
                    onClick={() => seek(s.start)}
                    disabled={!src}
                    aria-label={`Play from ${stamp(s.start)}`}
                    className="w-14 shrink-0 text-left font-mono text-[11px] text-studio-muted hover:text-studio-text"
                  >
                    {stamp(s.start)}
                  </button>
                  <p dir="auto" lang={t.language ?? undefined} className="min-w-0 flex-1 text-body">
                    <Highlight text={text} q={query} />
                  </p>
                </li>
              )
            })}
          </ol>
          {query.trim() && hits.length === 0 && <p className="text-small text-studio-muted">No line says “{query.trim()}”.</p>}
        </>
      )}
    </section>
  )
}
