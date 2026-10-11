import { useEffect, useRef, useState } from 'react'
import { Circle, Mic, RotateCcw, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { REF_GOOD_MAX_S, REF_GOOD_MIN_S, REF_MAX_S, REF_MIN_S } from '@/lib/voice'
import { cn } from '@/lib/utils'

type Phase = 'idle' | 'asking' | 'recording' | 'recorded' | 'denied' | 'unsupported' | 'failed'

const DENIED = "Microphone access is blocked. Allow the microphone for this site in the browser's address bar, then try again, or upload a clip instead."
const NO_MIC = 'No microphone was found. Plug one in and try again, or upload a clip instead.'
const UNSUPPORTED = "This browser can't record here. Upload a clip instead."

type Timers = { tick?: ReturnType<typeof setInterval>; raf?: number }

function teardown(stream: React.RefObject<MediaStream | null>, ctx: React.RefObject<AudioContext | null>, timers: React.RefObject<Timers>) {
  clearInterval(timers.current.tick)
  if (timers.current.raf) cancelAnimationFrame(timers.current.raf)
  timers.current = {}
  stream.current?.getTracks().forEach((t) => t.stop())
  stream.current = null
  ctx.current?.close().catch(() => {})
  ctx.current = null
}

export interface RecordLimits {
  min: number
  max: number
  goodMin: number
  goodMax: number
}

const REFERENCE: RecordLimits = { min: REF_MIN_S, max: REF_MAX_S, goodMin: REF_GOOD_MIN_S, goodMax: REF_GOOD_MAX_S }

/** Record a clip in the browser: a level meter, a guide with its sweet spot, playback, re-record. By default
 * the limits are a voice reference's (5–15 s); a podcast line passes its own. */
export function Recorder({ prompt, onRecorded, disabled, limits = REFERENCE, hint }: { prompt?: string; onRecorded: (file: File, seconds: number) => void; disabled?: boolean; limits?: RecordLimits; hint?: string }) {
  const pct = (s: number) => `${(s / limits.max) * 100}%`
  const [phase, setPhase] = useState<Phase>('idle')
  const [said, setSaid] = useState('')
  const [elapsed, setElapsed] = useState(0)
  const [level, setLevel] = useState(0)
  const [take, setTake] = useState<{ url: string; file: File; seconds: number } | null>(null)
  const rec = useRef<MediaRecorder | null>(null)
  const stream = useRef<MediaStream | null>(null)
  const ctx = useRef<AudioContext | null>(null)
  const timers = useRef<Timers>({})
  const started = useRef(0)

  const release = () => {
    teardown(stream, ctx, timers)
    setLevel(0)
  }

  useEffect(
    () => () => {
      // leaving mid-take must let go of the microphone, or the browser's red dot stays on
      const r = rec.current
      if (r?.state === 'recording') {
        r.onstop = null
        r.stop()
      }
      teardown(stream, ctx, timers)
    },
    [],
  )
  useEffect(
    () => () => {
      if (take) URL.revokeObjectURL(take.url)
    },
    [take],
  )

  const meter = (s: MediaStream) => {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AC) return
    try {
      const ac = new AC()
      const analyser = ac.createAnalyser()
      analyser.fftSize = 512
      ac.createMediaStreamSource(s).connect(analyser)
      ctx.current = ac
      const buf = new Uint8Array(analyser.fftSize)
      const loop = () => {
        analyser.getByteTimeDomainData(buf)
        let peak = 0
        for (const v of buf) peak = Math.max(peak, Math.abs(v - 128) / 128)
        setLevel(peak)
        timers.current.raf = requestAnimationFrame(loop)
      }
      loop()
    } catch {
      // no meter is fine; the recording still works
    }
  }

  const stop = () => {
    if (rec.current?.state === 'recording') rec.current.stop()
  }

  const start = async () => {
    if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setPhase('unsupported')
      setSaid(UNSUPPORTED)
      return
    }
    setPhase('asking')
    setSaid('Asking for the microphone…')
    let s: MediaStream
    try {
      s = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false } })
    } catch (e) {
      const name = (e as DOMException)?.name
      const denied = name === 'NotAllowedError' || name === 'SecurityError'
      setPhase(denied ? 'denied' : 'failed')
      setSaid(denied ? DENIED : name === 'NotFoundError' ? NO_MIC : "Couldn't start the microphone. Try again, or upload a clip instead.")
      return
    }
    stream.current = s
    const chunks: Blob[] = []
    const r = new MediaRecorder(s)
    rec.current = r
    r.ondataavailable = (e) => e.data.size && chunks.push(e.data)
    r.onstop = () => {
      const seconds = Math.round(((performance.now() - started.current) / 1000) * 10) / 10
      release()
      const type = (r.mimeType || 'audio/webm').split(';')[0]
      const ext = type.includes('ogg') ? 'ogg' : type.includes('mp4') ? 'm4a' : 'webm'
      const file = new File(chunks, `voice-reference.${ext}`, { type })
      setTake({ url: URL.createObjectURL(file), file, seconds })
      setElapsed(seconds)
      setPhase('recorded')
      setSaid(`Recording stopped at ${Math.round(seconds)} seconds. Play it back, then use it or record again.`)
    }
    r.start()
    started.current = performance.now()
    setElapsed(0)
    setTake(null)
    setPhase('recording')
    setSaid('Recording. Speak now; press Stop when you finish.')
    meter(s)
    timers.current.tick = setInterval(() => {
      const t = (performance.now() - started.current) / 1000
      setElapsed(t)
      if (t >= limits.max) stop()
    }, 100)
  }

  const recording = phase === 'recording'
  const inBand = elapsed >= limits.goodMin && elapsed <= limits.goodMax

  return (
    <div className="flex flex-col gap-2.5">
      {prompt && phase !== 'recorded' && (
        <p className="rounded-[6px] border border-studio-border bg-studio-raised/60 px-2.5 py-2 text-small" dir="auto">
          <span className="section-label mb-0.5 block">Read this, or anything natural</span>
          {prompt}
        </p>
      )}
      <div aria-hidden className="flex flex-col gap-1">
        {/* the guide: 0 to max, the sweet spot shaded */}
        <div className="relative h-2.5 overflow-hidden rounded-full bg-studio-raised ring-1 ring-studio-border">
          <span className="absolute inset-y-0 bg-studio-success/20" style={{ left: pct(limits.goodMin), width: pct(limits.goodMax - limits.goodMin) }} />
          <span className={cn('absolute inset-y-0 left-0', inBand ? 'bg-studio-success/70' : 'bg-studio-accent/70')} style={{ width: pct(Math.min(elapsed, limits.max)) }} />
        </div>
        <div className="relative h-3 font-mono text-[10px] text-studio-faint">
          <span className="absolute left-0">0</span>
          <span className="absolute -translate-x-1/2" style={{ left: pct(limits.goodMin) }}>{limits.goodMin} s</span>
          <span className="absolute -translate-x-1/2" style={{ left: pct(limits.goodMax) }}>{limits.goodMax} s</span>
          <span className="absolute right-0">{limits.max} s</span>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {recording ? (
          <Button type="button" size="sm" variant="danger" onClick={stop}>
            <Square aria-hidden className="fill-current" />
            Stop
          </Button>
        ) : (
          <Button type="button" size="sm" variant={take ? 'secondary' : 'primary'} onClick={start} disabled={disabled || phase === 'asking'} loading={phase === 'asking'}>
            {take ? <RotateCcw aria-hidden /> : <Circle aria-hidden className="fill-current" />}
            {take ? 'Record again' : 'Record'}
          </Button>
        )}
        <span className="font-mono text-small tabular-nums" aria-hidden>
          {elapsed.toFixed(1)} s
        </span>
        {recording && (
          <span aria-hidden className="flex h-3 w-24 items-center overflow-hidden rounded-full bg-studio-raised ring-1 ring-studio-border" title="Input level">
            <span className={cn('h-full transition-[width] duration-75', level > 0.9 ? 'bg-studio-danger' : 'bg-studio-success')} style={{ width: `${Math.round(level * 100)}%` }} />
          </span>
        )}
        {recording && <Mic aria-hidden className="size-4 animate-pulse text-studio-danger" />}
      </div>
      {take && phase === 'recorded' && (
        <div className="flex flex-wrap items-center gap-2">
          <audio controls src={take.url} preload="metadata" aria-label="Your recording" className="h-8 max-w-full" />
          <Button type="button" size="sm" variant="primary" disabled={disabled || take.seconds < limits.min} onClick={() => onRecorded(take.file, take.seconds)}>
            Use this recording
          </Button>
          {take.seconds < limits.min && <span className="text-small text-studio-warning">Too short; record at least {limits.min} seconds.</span>}
        </div>
      )}
      <p role="status" aria-live="polite" className={cn('text-small', phase === 'denied' || phase === 'failed' || phase === 'unsupported' ? 'text-studio-danger' : 'text-studio-muted')}>
        {said || hint || 'Read naturally for 5 to 15 seconds, close to the microphone, in a quiet room.'}
      </p>
    </div>
  )
}
