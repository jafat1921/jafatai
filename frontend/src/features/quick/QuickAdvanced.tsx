import { useId, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { ChipGroup } from '@/components/studio/chip'
import { ModelSelect } from '@/components/models/ModelSelect'
import { useModels } from '@/hooks/useModels'
import { pickModel, VIDEO_HQ } from '@/lib/models'
import type { QuickForm } from '@/lib/quick'
import { cn } from '@/lib/utils'

const QUALITY = [
  { value: 'standard', label: 'Standard' },
  { value: 'hq', label: 'High quality' },
] as const

/** Image model for cast and frames, and the video quality for the takes. Folded away; the defaults are good. */
export function QuickAdvanced({ form, onChange }: { form: QuickForm; onChange: (patch: Partial<QuickForm>) => void }) {
  const uid = useId()
  const [open, setOpen] = useState(!!(form.imageModel || form.videoQuality === 'hq'))
  const image = useModels('image').models
  const hq = useModels('video').models.find((m) => m.id === VIDEO_HQ)
  const imageModel = pickModel(image, form.imageModel)

  return (
    <div className="md:col-span-2">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={`${uid}-adv`}
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 rounded-[6px] px-1 text-small text-studio-muted hover:text-studio-text"
      >
        <ChevronDown aria-hidden className={cn('size-3.5 transition-transform duration-150', open && 'rotate-180')} />
        Advanced options
      </button>
      {open && (
        <div id={`${uid}-adv`} className="mt-2 grid gap-4 md:grid-cols-2">
          <div className="flex flex-col gap-1">
            <label htmlFor={`${uid}-img`} className="section-label">
              Image model
            </label>
            <ModelSelect id={`${uid}-img`} models={image} value={imageModel?.id} onChange={(id) => onChange({ imageModel: id })} describedBy={`${uid}-img-n`} />
            <p id={`${uid}-img-n`} className="text-small text-studio-muted">
              For portraits, places and storyboard frames. {imageModel?.description}
            </p>
          </div>
          <div className="flex flex-col gap-1">
            {hq?.available ? (
              <>
                <ChipGroup
                  label="Video quality"
                  options={QUALITY}
                  value={form.videoQuality ?? 'standard'}
                  allowEmpty={false}
                  onChange={(v) => v && onChange({ videoQuality: v })}
                />
                <p className="text-small text-studio-muted">
                  {form.videoQuality === 'hq'
                    ? 'Sharper, higher resolution and slower. Long takes still render in Standard.'
                    : 'LTX-2.3 with sound. The fastest way to a finished film.'}
                </p>
              </>
            ) : (
              <>
                <span className="section-label">Video quality</span>
                <p className="text-small text-studio-muted">
                  Standard (LTX-2.3). {hq?.reason || 'High quality isn\u2019t installed on this server yet.'}
                </p>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
