import { useId, useState } from 'react'
import { Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { CONTACT_FIELDS, MAX_CLAIMS, type BrandContact } from '@/lib/brand'
import { EditorSection } from './EditorSection'

/** The ad footer's contact details and the offer lines Ad Studio may use word for word (contract v36). */
export function ContactSection({
  contact,
  claims,
  onContact,
  onClaims,
}: {
  contact: BrandContact
  claims: string[]
  onContact: (c: BrandContact) => void
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
    <EditorSection title="Contact and offers" hint="Used by Ad Studio: the contact details go in an advert's footer, and the copy may only use the offer lines listed here (or ones you type for a campaign).">
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
              maxLength={f.key === 'phone' ? 40 : f.key === 'social' ? 80 : 120}
              value={contact[f.key] ?? ''}
              placeholder={f.placeholder}
              onChange={(e) => onContact({ ...contact, [f.key]: e.target.value })}
            />
          </div>
        ))}
      </div>
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
