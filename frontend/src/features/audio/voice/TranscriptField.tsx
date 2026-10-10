import { useId } from 'react'
import { Captions } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { useTranscribeVoice } from '@/hooks/useVoices'
import { announce } from '@/stores/ui'

/** The words in the reference clip: typed, or filled by Transcribe once the voice exists. */
export function TranscriptField({ voiceId, value, onChange, disabled }: { voiceId: string | null; value: string; onChange: (v: string) => void; disabled?: boolean }) {
  const uid = useId()
  const t = useTranscribeVoice((text) => {
    onChange(text)
    announce(text ? 'Transcript filled in from the clip. Check it against what was said.' : 'The clip had no words the transcriber could hear.')
  })
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <Label htmlFor={`${uid}-text`}>Reference transcript</Label>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="ml-auto"
          disabled={!voiceId || disabled}
          loading={t.working}
          onClick={() => voiceId && t.transcribe(voiceId)}
          title={voiceId ? 'Listen to the clip and write down what it says' : 'Create the voice first, then transcribe its clip'}
        >
          <Captions aria-hidden />
          Transcribe
        </Button>
      </div>
      <Textarea
        id={`${uid}-text`}
        rows={3}
        dir="auto"
        value={value}
        disabled={disabled}
        maxLength={2000}
        onChange={(e) => onChange(e.target.value)}
        placeholder="What the clip says, word for word"
        aria-describedby={`${uid}-hint`}
        className="min-h-16 resize-y text-body"
      />
      <p id={`${uid}-hint`} aria-live="polite" className="text-small text-studio-muted">
        {t.working
          ? `Transcribing the clip${t.progress != null ? `, ${Math.round(t.progress * 100)}%` : '…'}`
          : t.error
            ? <span className="text-studio-danger">{t.error.message}</span>
            : 'An exact transcript helps the clone match the speaker’s rhythm.'}
      </p>
    </div>
  )
}
