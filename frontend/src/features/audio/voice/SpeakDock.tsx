import { useId, useRef } from 'react'
import { Mic, MessageSquareQuote, SquareSplitHorizontal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ErrorState } from '@/components/studio/states'
import { SwitchRow } from '@/components/studio/switch-row'
import { GenerateButton } from '@/components/generate/GenerateButton'
import { AerabButton } from '@/components/text/AerabButton'
import { PromptDock } from '@/components/generate/PromptDock'
import { hasArabicScript, isArabicScriptLang } from '@/lib/aerab'
import {
  AUTO_ENGINE,
  can,
  EXPRESSION_TAGS,
  hasTags,
  insertTag,
  languageName,
  resolveEngine,
  SCRIPT_MAX,
  speakBlockedReason,
  speakPayload,
  speaks,
  speedText,
  type SpeakForm,
  type SpeakSide,
} from '@/lib/voice'
import type { SpeakRequest, Voice, VoiceEngine } from '@/lib/types'
import { cn } from '@/lib/utils'
import { announce } from '@/stores/ui'
import { EngineChip, SpeechLanguageChip, SpeechTakesChip, SpeedChip, VoiceChip } from './VoiceChips'

export interface SpeakRun {
  form: SpeakForm
  // one body, or A then B when comparing
  bodies: SpeakRequest[]
  labels: string[]
  summary: string
}

const TAG_NOTE = 'tags are removed; pauses become silence'

interface Props {
  form: SpeakForm
  setForm: React.Dispatch<React.SetStateAction<SpeakForm>>
  voices: Voice[]
  engines: VoiceEngine[]
  onRun: (r: SpeakRun) => void
  pending?: boolean
  error?: unknown
}

export function SpeakDock({ form, setForm, voices, engines, onRun, pending, error }: Props) {
  const uid = useId()
  const field = useRef<HTMLTextAreaElement>(null)
  const set = <K extends keyof SpeakForm>(k: K, v: SpeakForm[K]) => setForm((f) => ({ ...f, [k]: v }))
  const voiceOf = (id: string | null) => (id ? voices.find((v) => v.id === id) : undefined)
  const voice = voiceOf(form.voiceId)
  const engine = resolveEngine(form.engine, voice, form.language, engines)
  const voiceB = voiceOf(form.b.voiceId)
  const engineB = resolveEngine(form.b.engine, voiceB, form.language, engines)
  const tagless = [engine, ...(form.compare ? [engineB] : [])].filter((e): e is VoiceEngine => !!e && !can(e, 'tags'))
  const arabicScript = hasArabicScript(form.text)
  const blocked = speakBlockedReason(form, voices, engines)
  // OmniVoice's list for the default; each engine's own once one is chosen
  const languages = engine?.languages ?? engines.find((e) => e.id === 'omnivoice')?.languages ?? []

  const pickVoice = (id: string | null) => {
    const v = voiceOf(id)
    setForm((f) => ({ ...f, voiceId: id, language: v?.language ?? f.language }))
  }
  const setB = (patch: Partial<SpeakSide>) => setForm((f) => ({ ...f, b: { ...f.b, ...patch } }))

  const addTag = (tag: string) => {
    const el = field.current
    const { text, cursor } = insertTag(form.text, el?.selectionStart ?? form.text.length, tag)
    if (text.length > SCRIPT_MAX) return announce('The script is at the limit.')
    set('text', text)
    requestAnimationFrame(() => {
      el?.focus()
      el?.setSelectionRange(cursor, cursor)
    })
  }

  const sideLabel = (v: Voice | undefined, e: VoiceEngine | undefined) => [v?.name ?? 'Engine default', e?.label].filter(Boolean).join(' · ')

  const submit = () => {
    if (blocked || pending) return
    const a = speakPayload(form, voices, engines)
    const bodies = form.compare ? [a, speakPayload(form, voices, engines, form.b)] : [a]
    const labels = form.compare ? [sideLabel(voice, engine), sideLabel(voiceB, engineB)] : [sideLabel(voice, engine)]
    const summary = [
      form.compare ? `A/B: ${labels.join(' vs ')}` : labels[0],
      languageName(form.language, engines),
      form.speed !== 1 ? speedText(form.speed) : null,
      form.count > 1 ? `${form.count} takes` : null,
    ]
      .filter(Boolean)
      .join(' · ')
    onRun({ form, bodies, labels, summary })
  }

  const near = form.text.length > SCRIPT_MAX * 0.9

  const belowPrompt = (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" size="sm" variant="ghost">
              <MessageSquareQuote aria-hidden />
              Insert tag
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-64">
            {tagless.length > 0 && (
              <DropdownMenuLabel className="normal-case tracking-normal text-studio-warning">
                {tagless.map((e) => e.label).join(' and ')}: {TAG_NOTE}.
              </DropdownMenuLabel>
            )}
            {EXPRESSION_TAGS.map((t) => (
              <DropdownMenuItem key={t.tag} onSelect={() => addTag(t.tag)}>
                <span className="font-mono text-[12px]">{t.tag}</span>
                <span className="ml-auto text-small text-studio-muted">{t.label}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <AerabButton text={form.text} onText={(v) => set('text', v)} language={form.language} max={SCRIPT_MAX} />
        {arabicScript && !isArabicScriptLang(form.language) && speaks(engine, 'ur') && (
          <Button type="button" size="sm" variant="ghost" onClick={() => set('language', 'ur')}>
            Speak it in Urdu
          </Button>
        )}
      </div>
      {tagless.length > 0 && hasTags(form.text) && (
        <p className="text-small text-studio-warning">
          {tagless.map((e) => e.label).join(' and ')} can't perform expression tags: {TAG_NOTE}.
        </p>
      )}
      {(arabicScript || isArabicScriptLang(form.language)) && (
        <SwitchRow
          id={`${uid}-aerab`}
          checked={form.aerab}
          onChange={(on) => set('aerab', on)}
          title="Aerab before speaking"
          hint="Urdu, Arabic and other Arabic-script lines without their vowel marks (aerab / tashkeel) get them just before speaking, so vowels aren't guessed."
          className="max-w-md py-1.5"
        />
      )}
    </div>
  )

  return (
    <PromptDock
      into="audio"
      title="Speak"
      icon={<Mic aria-hidden className="size-4 text-studio-accent-hover" />}
      headerExtra={<p className="text-small text-studio-muted max-lg:hidden">Type a line, pick a voice, hear it.</p>}
      promptLabel="Script"
      prompt={form.text}
      onPrompt={(v) => set('text', v)}
      promptRef={field}
      promptHint={
        <span className={cn('font-mono', near && 'text-studio-warning')}>
          {form.text.length.toLocaleString('en')} / {SCRIPT_MAX.toLocaleString('en')} <span className="sr-only">characters</span>
        </span>
      }
      maxLength={SCRIPT_MAX}
      mentions={false}
      placeholder="e.g. The train was late again, and somehow [sigh] nobody was surprised."
      belowPrompt={belowPrompt}
      chips={
        <>
          {form.compare && <span className="mr-0.5 font-mono text-small text-studio-muted" aria-hidden>A</span>}
          <VoiceChip voices={voices} engines={engines} language={form.language} value={form.voiceId} onChange={pickVoice} />
          <EngineChip engines={engines} value={form.engine} onChange={(id) => set('engine', id)} language={form.language} voice={voice} />
          <SpeechLanguageChip languages={languages} engines={engines} value={form.language} onChange={(c) => set('language', c)} />
          <SpeedChip value={form.speed} onChange={(v) => set('speed', v)} />
          <SpeechTakesChip value={form.count} onChange={(n) => set('count', n)} />
          <button
            type="button"
            aria-pressed={form.compare}
            onClick={() => {
              set('compare', !form.compare)
              announce(form.compare ? 'Compare off.' : 'Compare on: pick the voice or engine for B.')
            }}
            className="inline-flex h-8 items-center gap-1.5 rounded-full border border-studio-border-strong bg-studio-raised px-3 text-small hover:bg-studio-panel-hover aria-pressed:border-studio-accent aria-pressed:bg-studio-accent-soft [&_svg]:size-3.5"
          >
            <SquareSplitHorizontal aria-hidden />
            Compare
          </button>
          {form.compare && (
            <div role="group" aria-label="B side" className="flex basis-full flex-wrap items-center gap-1.5 border-t border-studio-border pt-1.5">
              <span className="mr-0.5 font-mono text-small text-studio-muted" aria-hidden>
                B
              </span>
              <VoiceChip name="Voice B" voices={voices} engines={engines} language={form.language} value={form.b.voiceId} onChange={(id) => setB({ voiceId: id })} />
              <EngineChip name="Engine B" engines={engines} value={form.b.engine} onChange={(id) => setB({ engine: id })} language={form.language} voice={voiceB} />
              <span className="text-small text-studio-faint">Same line, language and speed as A.</span>
            </div>
          )}
        </>
      }
      advanced={
        <div className="flex flex-wrap items-start gap-4">
          <NumberField id={`${uid}-steps`} label="Steps" value={form.steps} onChange={(v) => set('steps', v.replace(/\D/g, '').slice(0, 3))} placeholder="Default" />
          <NumberField id={`${uid}-guidance`} label="Guidance" value={form.guidance} onChange={(v) => set('guidance', v.replace(/[^\d.]/g, '').slice(0, 4))} placeholder="Default" decimal />
          {can(engine, 'emotion') && (
            <NumberField
              id={`${uid}-ex`}
              label="Exaggeration"
              value={form.exaggeration}
              onChange={(v) => set('exaggeration', v.replace(/[^\d.]/g, '').slice(0, 4))}
              placeholder="0.5"
              hint="Emotion strength, 0 to 2"
              decimal
            />
          )}
          <NumberField id={`${uid}-len`} label="Fixed length (s)" value={form.durationS} onChange={(v) => set('durationS', v.replace(/[^\d.]/g, '').slice(0, 5))} placeholder="Natural" decimal />
          <NumberField id={`${uid}-seed`} label="Seed" value={form.seed} onChange={(v) => set('seed', v.replace(/\D/g, ''))} placeholder="Random" wide />
          <SwitchRow
            id={`${uid}-denoise`}
            checked={form.denoise}
            onChange={(on) => set('denoise', on)}
            title="Denoise"
            hint="Cleans hiss and room noise from the take. Turn off to keep the reference's character."
            className="max-w-xs py-1"
          />
        </div>
      }
      error={error ? <ErrorState compact title="Couldn't start speaking" error={error} /> : null}
      footer={
        <GenerateButton
          verb="Speak"
          what={form.compare ? `A and B${form.count > 1 ? `, ${form.count} takes each` : ''}` : form.count > 1 ? `${form.count} takes` : null}
          estimate={null}
          icon={<Mic aria-hidden />}
          blocked={blocked}
          note={engine && form.engine === AUTO_ENGINE ? `Spoken by ${engine.label}. Nothing plays until you press play.` : 'Nothing plays until you press play.'}
          pending={pending}
        />
      }
      onSubmit={submit}
    />
  )
}

function NumberField({
  id,
  label,
  value,
  onChange,
  placeholder,
  hint,
  decimal,
  wide,
}: {
  id: string
  label: string
  value: string
  onChange: (v: string) => void
  placeholder: string
  hint?: string
  decimal?: boolean
  wide?: boolean
}) {
  return (
    <div className={wide ? 'w-32' : 'w-28'}>
      <Label htmlFor={id} className="mb-1.5">
        {label}
      </Label>
      <Input
        id={id}
        inputMode={decimal ? 'decimal' : 'numeric'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-describedby={hint ? `${id}-hint` : undefined}
        className="font-mono"
      />
      {hint && (
        <p id={`${id}-hint`} className="mt-1 text-[11px] text-studio-muted">
          {hint}
        </p>
      )}
    </div>
  )
}
