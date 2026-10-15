import { useId, useState } from 'react'
import { ArrowDown, ArrowUp, Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import {
  CONTACT_FIELDS,
  MAX_CLAIMS,
  MAX_SOCIALS,
  platformLabel,
  SOCIAL_PLATFORMS,
  socialProblem,
  tidyHandle,
  type BrandContact,
  type BrandSocial,
  type SocialPlatform,
} from '@/lib/brand'
import { announce } from '@/stores/ui'
import { EditorSection } from './EditorSection'

const SELECT = 'h-8 rounded-[6px] border border-studio-border-strong bg-studio-raised px-2 text-body focus-visible:outline-2 focus-visible:outline-studio-accent'

/** The ad footer's contact details, the brand's social accounts and the offer lines Ad Studio may use word
 * for word (contract v36). */
export function ContactSection({
  contact,
  socials,
  claims,
  onContact,
  onSocials,
  onClaims,
}: {
  contact: BrandContact
  socials: BrandSocial[]
  claims: string[]
  onContact: (c: BrandContact) => void
  onSocials: (s: BrandSocial[]) => void
  onClaims: (c: string[]) => void
}) {
  const uid = useId()
  const [line, setLine] = useState('')
  const add = () => {
    const v = line.trim().replace(/\s+/g, ' ')
    if (!v || claims.includes(v) || claims.length >= MAX_CLAIMS) return
    onClaims([...claims, v])
    setLine('')
  }

  return (
    <EditorSection title="Contact, socials and offers" hint="Used by Ad Studio and the brand cards: the details and handles go in an advert's footer, and the copy may only use the offer lines listed here (or ones you type for a campaign).">
      <div className="grid gap-3 md:grid-cols-3">
        {CONTACT_FIELDS.map((f) => (
          <div key={f.key} className="flex flex-col gap-1">
            <label htmlFor={`${uid}-${f.key}`} className="text-small font-medium">
              {f.label}
            </label>
            <Input
              id={`${uid}-${f.key}`}
              type={f.type}
              dir="auto"
              maxLength={f.max}
              value={contact[f.key] ?? ''}
              placeholder={f.placeholder}
              onChange={(e) => onContact({ ...contact, [f.key]: e.target.value })}
            />
          </div>
        ))}
      </div>
      <SocialList socials={socials} onChange={onSocials} />
      <div className="flex flex-col gap-2">
        <label htmlFor={`${uid}-claim`} className="text-small font-medium">
          Approved offer lines
        </label>
        <div className="flex gap-2">
          <Input
            id={`${uid}-claim`}
            dir="auto"
            maxLength={160}
            value={line}
            onChange={(e) => setLine(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                add()
              }
            }}
            placeholder="e.g. From 215 kr/hour · 15% off moving-out cleans · No lock-in"
            aria-describedby={`${uid}-claim-hint`}
          />
          <Button type="button" variant="ghost" onClick={add} disabled={!line.trim() || claims.length >= MAX_CLAIMS}>
            <Plus aria-hidden />
            Add
          </Button>
        </div>
        <span id={`${uid}-claim-hint`} className="text-small text-studio-muted">
          Prices, discounts and promises exactly as you're happy to print them. The ad writer never makes up its own.
        </span>
        {claims.length > 0 && (
          <ul className="flex flex-wrap gap-2" aria-label="Approved offer lines">
            {claims.map((c) => (
              <li key={c} className="flex items-center gap-1 rounded-full border border-studio-border-strong bg-studio-raised py-0.5 pl-3 pr-1 text-small">
                <span dir="auto">{c}</span>
                <Button type="button" size="icon-sm" variant="ghost" aria-label={`Remove “${c}”`} onClick={() => onClaims(claims.filter((x) => x !== c))}>
                  <X aria-hidden />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </EditorSection>
  )
}

function SocialList({ socials, onChange }: { socials: BrandSocial[]; onChange: (s: BrandSocial[]) => void }) {
  const uid = useId()
  const put = (i: number, patch: Partial<BrandSocial>) => onChange(socials.map((s, j) => (j === i ? { ...s, ...patch } : s)))
  const move = (i: number, by: -1 | 1) => {
    const next = [...socials]
    ;[next[i], next[i + by]] = [next[i + by], next[i]]
    onChange(next)
    announce(`${platformLabel(socials[i].platform)} moved to position ${i + by + 1} of ${socials.length}.`)
  }
  const used = new Set(socials.map((s) => s.platform))
  const nextPlatform = SOCIAL_PLATFORMS.find((p) => !used.has(p.id))?.id ?? 'instagram'

  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="text-small font-medium">Social accounts</legend>
      <p id={`${uid}-hint`} className="text-small text-studio-muted">
        Type the handle or paste the profile link; the order here is the order in the footer. Ads show the ones switched on.
      </p>
      {socials.length > 0 && (
        <ol className="flex flex-col gap-2" aria-label="Social accounts">
          {socials.map((s, i) => {
            const label = platformLabel(s.platform)
            const shown = s.handle.trim() ? tidyHandle(s.platform, s.handle) : ''
            const problem = s.handle.trim() || s.url?.trim() ? socialProblem(s) : null
            const pid = `${uid}-${i}`
            return (
              <li key={i} aria-label={`${label}${shown ? ` ${shown}` : ''}`} className="flex flex-wrap items-end gap-2 rounded-[6px] border border-studio-border bg-studio-raised p-2">
                <div className="flex flex-col gap-1">
                  <label htmlFor={`${pid}-p`} className="text-small text-studio-muted">
                    Platform
                  </label>
                  <select id={`${pid}-p`} className={SELECT} value={s.platform} onChange={(e) => put(i, { platform: e.target.value as SocialPlatform })}>
                    {SOCIAL_PLATFORMS.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex min-w-[10rem] flex-1 flex-col gap-1">
                  <label htmlFor={`${pid}-h`} className="text-small text-studio-muted">
                    {s.platform === 'whatsapp' ? 'Number' : 'Handle'}
                  </label>
                  <Input
                    id={`${pid}-h`}
                    dir="ltr"
                    maxLength={300}
                    value={s.handle}
                    placeholder={SOCIAL_PLATFORMS.find((p) => p.id === s.platform)?.placeholder}
                    aria-invalid={problem ? true : undefined}
                    aria-describedby={problem ? `${pid}-err` : `${uid}-hint`}
                    onChange={(e) => put(i, { handle: e.target.value })}
                    onBlur={() => shown && shown !== s.handle && put(i, { handle: shown })}
                  />
                </div>
                <div className="flex min-w-[10rem] flex-1 flex-col gap-1">
                  <label htmlFor={`${pid}-u`} className="text-small text-studio-muted">
                    Link (optional)
                  </label>
                  <Input id={`${pid}-u`} dir="ltr" type="url" maxLength={300} value={s.url ?? ''} placeholder="https://…" onChange={(e) => put(i, { url: e.target.value })} />
                </div>
                <label className="flex items-center gap-2 pb-1.5 text-small">
                  <Switch checked={s.show_in_ads ?? true} onCheckedChange={(v) => put(i, { show_in_ads: v })} aria-label={`Show ${label} in ads`} />
                  In ads
                </label>
                <div className="flex gap-1 pb-0.5">
                  <Button type="button" size="icon-sm" variant="ghost" aria-label={`Move ${label} up`} disabled={i === 0} onClick={() => move(i, -1)}>
                    <ArrowUp aria-hidden />
                  </Button>
                  <Button type="button" size="icon-sm" variant="ghost" aria-label={`Move ${label} down`} disabled={i === socials.length - 1} onClick={() => move(i, 1)}>
                    <ArrowDown aria-hidden />
                  </Button>
                  <Button type="button" size="icon-sm" variant="ghost" aria-label={`Remove ${label}`} onClick={() => onChange(socials.filter((_, j) => j !== i))}>
                    <X aria-hidden />
                  </Button>
                </div>
                {problem && (
                  <p id={`${pid}-err`} role="alert" className="basis-full text-small text-studio-danger">
                    {problem}
                  </p>
                )}
              </li>
            )
          })}
        </ol>
      )}
      <div>
        <Button
          type="button"
          variant="ghost"
          disabled={socials.length >= MAX_SOCIALS}
          onClick={() => onChange([...socials, { platform: nextPlatform, handle: '', url: null, show_in_ads: true }])}
        >
          <Plus aria-hidden />
          Add a social account
        </Button>
        {socials.length >= MAX_SOCIALS && <span className="ml-2 text-small text-studio-muted">That's the most a kit holds ({MAX_SOCIALS}).</span>}
      </div>
    </fieldset>
  )
}
