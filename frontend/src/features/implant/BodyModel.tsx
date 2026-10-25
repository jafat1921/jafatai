import { useEffect, useId, useRef, useState } from 'react'
import { RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useOptionChecks } from '@/hooks/useImplant'
import { LETTERS, newOption, optionLine, type Patient } from '@/lib/implant'
import type { Torso } from './torso3d'
import { torsoShapes } from './torsoShape'

type Mode = 'before' | 'after' | 'both'

const MODES: { id: Mode; label: string }[] = [
  { id: 'before', label: 'Before' },
  { id: 'after', label: 'After' },
  { id: 'both', label: 'Side by side' },
]
const SKINS = [
  { id: 'light', label: 'Light', hex: '#e9c6a9' },
  { id: 'medium', label: 'Medium', hex: '#c99a74' },
  { id: 'tan', label: 'Tan', hex: '#a8734d' },
  { id: 'deep', label: 'Deep', hex: '#6f4630' },
]
const reducedMotion = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

export function BodyModel({ patient }: { patient: Patient }) {
  const uid = useId()
  const host = useRef<HTMLDivElement>(null)
  const torso = useRef<Torso | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading')
  const latest = patient.sessions[0]
  const options = latest?.options.length ? latest.options : [newOption()]
  const [pick, setPick] = useState(0)
  const [mode, setMode] = useState<Mode>('both')
  const [skin, setSkin] = useState(SKINS[1].hex)
  const [markers, setMarkers] = useState(true)
  const checks = useOptionChecks(patient.id, options, patient.measurements)
  const opt = options[Math.min(pick, options.length - 1)]
  const shapes = torsoShapes(patient.measurements, opt, checks.data?.[Math.min(pick, options.length - 1)])

  useEffect(() => {
    let gone = false
    let made: Torso | null = null
    import('./torso3d')
      .then(({ createTorso }) => {
        if (gone || !host.current) return
        made = createTorso(host.current, { reducedMotion: reducedMotion() })
        torso.current = made
        setState('ready')
      })
      // no WebGL (an old browser, or it's switched off): say so instead of a blank box
      .catch(() => !gone && setState('failed'))
    return () => {
      gone = true
      made?.dispose()
      torso.current = null
    }
  }, [])

  const key = JSON.stringify([shapes, mode, skin, markers])
  useEffect(() => {
    if (state !== 'ready') return
    const s = JSON.parse(key) as [typeof shapes, Mode, string, boolean]
    torso.current?.set({ before: s[0].before, after: s[0].after, mode: s[1], skin: s[2], markers: s[3] })
  }, [state, key])

  return (
    <section aria-labelledby={`${uid}-h`} className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 id={`${uid}-h`} className="font-display text-title font-semibold">
          3D body model
        </h2>
        <p className="text-small text-studio-muted">An illustration built from her measurements and the implant size, not her body.</p>
      </div>
      <div className="flex min-w-0 flex-wrap items-end gap-x-6 gap-y-3">
        {options.length > 1 && (
          <div className="flex flex-col gap-1">
            <label htmlFor={`${uid}-opt`} className="section-label">
              Option
            </label>
            <select id={`${uid}-opt`} className="h-8 rounded-[6px] border border-studio-border-strong bg-studio-raised px-2 text-body" value={pick} onChange={(e) => setPick(Number(e.target.value))}>
              {options.map((o, i) => (
                <option key={i} value={i}>
                  {LETTERS[i]} · {optionLine(o)}
                </option>
              ))}
            </select>
          </div>
        )}
        <fieldset className="flex flex-col gap-1">
          <legend className="section-label mb-1">Show</legend>
          <div className="flex gap-1" role="radiogroup">
            {MODES.map((m) => (
              <Button key={m.id} type="button" size="sm" role="radio" aria-checked={mode === m.id} variant={mode === m.id ? 'primary' : 'secondary'} onClick={() => setMode(m.id)}>
                {m.label}
              </Button>
            ))}
          </div>
        </fieldset>
        <fieldset className="flex flex-col gap-1">
          <legend className="section-label mb-1">Skin tone</legend>
          <div className="flex gap-1.5" role="radiogroup">
            {SKINS.map((s) => (
              <button
                key={s.id}
                type="button"
                role="radio"
                aria-checked={skin === s.hex}
                aria-label={s.label}
                title={s.label}
                className="size-7 rounded-full border-2 border-studio-border-strong aria-checked:border-studio-accent aria-checked:ring-2 aria-checked:ring-studio-gold"
                style={{ background: s.hex }}
                onClick={() => setSkin(s.hex)}
              />
            ))}
          </div>
        </fieldset>
        <label className="flex items-center gap-2 text-body">
          <input type="checkbox" className="accent-studio-accent" checked={markers} onChange={(e) => setMarkers(e.target.checked)} />
          Mark the nipple position
        </label>
        <Button type="button" size="sm" variant="ghost" onClick={() => torso.current?.reset()} disabled={state !== 'ready'}>
          <RotateCcw aria-hidden />
          Front view
        </Button>
      </div>
      <div
        ref={host}
        role="img"
        tabIndex={0}
        aria-label={`3D model, ${MODES.find((m) => m.id === mode)?.label.toLowerCase()}${opt ? `, option ${LETTERS[pick]}: ${optionLine(opt)}` : ''}. Drag or use the arrow keys to turn it.`}
        className="relative aspect-[4/3] w-full max-w-3xl overflow-hidden rounded-[6px] border border-studio-border-strong bg-studio-raised focus-visible:outline-2 focus-visible:outline-studio-accent"
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
            e.preventDefault()
            torso.current?.rotate(e.key === 'ArrowLeft' ? -0.2 : 0.2)
          }
        }}
      >
        {state === 'failed' && (
          <p className="absolute inset-0 flex items-center justify-center p-6 text-center text-body text-studio-muted">This browser can’t show 3D. Try a recent Chrome, Edge or Safari.</p>
        )}
      </div>
      {!checks.data && shapes.after === null && state === 'ready' && <p className="text-small text-studio-muted">Working out the implant size…</p>}
    </section>
  )
}
