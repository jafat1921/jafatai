import { useId, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { RadioGroup } from 'radix-ui'
import { Loader2, Play } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { fieldClass } from '@/components/ui/input'
import { ErrorState } from '@/components/studio/states'
import { qk } from '@/hooks/keys'
import { useLogoReveal } from '@/hooks/useBrandKits'
import { api } from '@/lib/api'
import { CLOSING_OPTIONS, type ClosingPref, type LogoRevealRequest } from '@/lib/brand'
import type { MediaItem } from '@/lib/types'
import { cn } from '@/lib/utils'
import { EditorSection } from './EditorSection'

const ASPECTS: LogoRevealRequest['aspect'][] = ['16:9', '9:16', '1:1', '4:5']

const ready = (m: MediaItem | undefined) => !!m?.media_url && !(m.status === 'queued' || m.status === 'generating')

function RevealPreview({ kitId, hasLogo, dirty }: { kitId: string; hasLogo: boolean; dirty: boolean }) {
  const uid = useId()
  const [aspect, setAspect] = useState<LogoRevealRequest['aspect']>('16:9')
  const [itemId, setItemId] = useState<string | null>(null)
  const reveal = useLogoReveal(kitId)
  // SSE usually lands first; the poll is the fallback for a missed event
  const item = useQuery({
    queryKey: qk.mediaItem(itemId ?? ''),
    queryFn: () => api.media.get(itemId!),
    enabled: !!itemId,
    refetchInterval: (q) => (ready(q.state.data) || q.state.data?.status === 'failed' ? false : 3000),
  }).data
  const failed = item?.status === 'failed'

  return (
    <div className="flex flex-col gap-2 rounded-[6px] border border-studio-border bg-studio-raised p-3">
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-1">
          <label htmlFor={`${uid}-a`} className="text-small font-medium">
            Shape
          </label>
          <select id={`${uid}-a`} value={aspect} onChange={(e) => setAspect(e.target.value as typeof aspect)} className={cn(fieldClass, 'h-8 w-24')}>
            {ASPECTS.map((a) => (
              <option key={a}>{a}</option>
            ))}
          </select>
        </div>
        <Button
          type="button"
          variant="secondary"
          disabled={!hasLogo}
          loading={reveal.isPending}
          onClick={() =>
            reveal.mutate(
              { duration_s: 3, aspect, background: { kind: 'color' }, show_tagline: true },
              { onSuccess: ({ item: made }) => setItemId(made.id) },
            )
          }
        >
          <Play aria-hidden />
          Preview logo reveal
        </Button>
        <p className="text-small text-studio-muted">
          {!hasLogo ? 'Add a main logo first.' : dirty ? 'Uses the saved kit; save first to see your changes.' : 'A 3 s clip from your real logo file. It also lands in your Library.'}
        </p>
      </div>
      {reveal.isError && <ErrorState compact title="Couldn't make the preview" error={reveal.error} />}
      {itemId && (
        <div aria-live="polite">
          {ready(item) ? (
            <video src={item!.media_url!} controls autoPlay muted playsInline className="darkroom max-h-72 w-full rounded-[6px]" aria-label="Logo reveal preview" />
          ) : failed ? (
            <p role="alert" className="text-small text-studio-danger">
              The preview didn't render. Check the logo file and try again.
            </p>
          ) : (
            <p className="flex items-center gap-2 text-small text-studio-muted">
              <Loader2 aria-hidden className="size-4 animate-spin" />
              Rendering the reveal… it plays here when it's ready.
            </p>
          )}
        </div>
      )}
    </div>
  )
}

export function ClosingSection({
  kitId,
  value,
  onChange,
  hasLogo,
  dirty,
}: {
  kitId: string
  value: ClosingPref
  onChange: (v: ClosingPref) => void
  hasLogo: boolean
  dirty: boolean
}) {
  const uid = useId()
  return (
    <EditorSection title="Closing shot" hint="Adverts end on a brand moment. Pick how it's made.">
      <RadioGroup.Root aria-label="Closing shot" value={value} onValueChange={(v) => onChange(v as ClosingPref)} className="grid gap-2 md:grid-cols-3">
        {CLOSING_OPTIONS.map((o) => (
          <RadioGroup.Item
            key={o.value}
            value={o.value}
            aria-label={o.title}
            aria-describedby={`${uid}-${o.value}`}
            className="flex flex-col items-start gap-1 rounded-[6px] border border-studio-border-strong bg-studio-raised p-2.5 text-left transition-colors duration-150 hover:bg-studio-panel-hover data-[state=checked]:border-studio-accent data-[state=checked]:bg-studio-accent-soft"
          >
            <span className="flex items-center gap-2 text-body font-medium">
              <span aria-hidden className="flex size-4 items-center justify-center rounded-full border border-studio-border-strong bg-studio-panel">
                <RadioGroup.Indicator className="size-2 rounded-full bg-studio-accent" />
              </span>
              {o.title}
            </span>
            <span id={`${uid}-${o.value}`} className="text-small text-studio-muted">
              {o.hint}
            </span>
          </RadioGroup.Item>
        ))}
      </RadioGroup.Root>
      <RevealPreview kitId={kitId} hasLogo={hasLogo} dirty={dirty} />
    </EditorSection>
  )
}
