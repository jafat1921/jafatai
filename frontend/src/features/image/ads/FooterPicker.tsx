import { useId } from 'react'
import { platformLabel, socialKey, type BrandContact, type BrandSocial } from '@/lib/brand'
import { FOOTER_CONTACT, type FooterItems } from '@/lib/ads'

const BOX = 'size-4 shrink-0 accent-studio-accent focus-visible:outline-2 focus-visible:outline-studio-accent'

/** Ticks for what a footer shows, from what the kit has. Used by the brief (whole campaign) and the ad editor. */
export function FooterPicker({
  kit,
  value,
  onChange,
  legend = 'Footer shows',
}: {
  kit: { contact?: BrandContact; socials?: BrandSocial[] } | null | undefined
  value: FooterItems
  onChange: (v: FooterItems) => void
  legend?: string
}) {
  const uid = useId()
  const contact = FOOTER_CONTACT.filter((f) => kit?.contact?.[f.key]?.trim())
  const socials = kit?.socials ?? []
  const flip = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v])

  if (!contact.length && !socials.length) {
    return (
      <p className="text-small text-studio-muted" role="note">
        The brand kit has no contact details or social accounts yet.
      </p>
    )
  }
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="mb-1 text-small font-medium">{legend}</legend>
      <div className="flex flex-wrap gap-x-4 gap-y-1.5">
        {contact.map((f) => (
          <label key={f.key} htmlFor={`${uid}-${f.key}`} className="flex min-h-6 items-center gap-1.5 text-small" title={kit?.contact?.[f.key]}>
            <input id={`${uid}-${f.key}`} type="checkbox" className={BOX} checked={value.contact.includes(f.key)} onChange={() => onChange({ ...value, contact: flip(value.contact, f.key) })} />
            {f.label}
          </label>
        ))}
        {socials.map((s) => {
          const k = socialKey(s)
          return (
            <label key={k} htmlFor={`${uid}-${k}`} className="flex min-h-6 items-center gap-1.5 text-small">
              <input id={`${uid}-${k}`} type="checkbox" className={BOX} checked={value.socials.includes(k)} onChange={() => onChange({ ...value, socials: flip(value.socials, k) })} />
              {platformLabel(s.platform)} <span dir="ltr" className="text-studio-muted">{s.handle}</span>
            </label>
          )
        })}
      </div>
    </fieldset>
  )
}
