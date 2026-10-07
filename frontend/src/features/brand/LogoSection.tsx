import { useId } from 'react'
import { Input } from '@/components/ui/input'
import { ImageSourceField } from '@/components/media/ImageSourceField'
import { LOGO_SLOTS, type KitDraft, type LogoVariant } from '@/lib/brand'
import { EditorSection, type AssetUrls } from './EditorSection'

export function LogoSection({ logos, urls, onChange }: { logos: KitDraft['logos']; urls: AssetUrls; onChange: (l: KitDraft['logos']) => void }) {
  const uid = useId()
  const setSlot = (v: LogoVariant, mediaId: string | null) => {
    const next = { ...logos }
    if (mediaId) next[v] = { media_id: mediaId, description: logos[v]?.description ?? '' }
    else delete next[v]
    onChange(next)
  }

  return (
    <EditorSection
      title="Logo"
      hint="A transparent PNG or SVG keeps clean edges; a JPEG has a box around it. The AI redraws the logo inside scenes, so simple bold marks come out best."
    >
      <div className="grid gap-4 lg:grid-cols-3">
        {LOGO_SLOTS.map((s) => (
          <div key={s.variant} className="flex flex-col gap-2">
            <ImageSourceField
              label={s.title}
              required={s.variant === 'primary'}
              hint={s.hint}
              value={logos[s.variant]?.media_id ?? null}
              previewUrl={logos[s.variant] ? urls[logos[s.variant]!.media_id] : undefined}
              onChange={(id) => setSlot(s.variant, id)}
              purpose="logo"
              checker
              aspectClass="aspect-[4/3]"
            />
            {logos[s.variant] && (
              <div className="flex flex-col gap-1">
                <label htmlFor={`${uid}-${s.variant}`} className="text-small font-medium">
                  Describe it
                </label>
                <Input
                  id={`${uid}-${s.variant}`}
                  dir="auto"
                  maxLength={300}
                  value={logos[s.variant]!.description}
                  onChange={(e) => onChange({ ...logos, [s.variant]: { ...logos[s.variant]!, description: e.target.value } })}
                  placeholder="e.g. round green leaf with white wordmark"
                  aria-describedby={`${uid}-why`}
                />
              </div>
            )}
          </div>
        ))}
      </div>
      <p id={`${uid}-why`} className="text-small text-studio-muted">
        Describe each logo so the AI places it well, e.g. “round green leaf with white wordmark”.
      </p>
    </EditorSection>
  )
}
