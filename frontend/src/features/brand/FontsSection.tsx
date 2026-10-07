import { useEffect, useId, useState } from 'react'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SourceDropZone } from '@/components/media/SourceDropZone'
import { FONT_PREVIEW, MAX_FONTS } from '@/lib/brand'
import { EditorSection, type AssetUrls } from './EditorSection'

const family = (id: string) => `brandfont-${id}`

/** Registers the uploaded file under its own family name; jsdom and old browsers simply skip it. */
function useFontFace(id: string, url: string | null | undefined) {
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading')
  useEffect(() => {
    if (!url || typeof FontFace === 'undefined' || !document.fonts) return
    let alive = true
    new FontFace(family(id), `url(${url})`)
      .load()
      .then((f) => {
        document.fonts.add(f)
        if (alive) setState('ready')
      })
      .catch(() => alive && setState('failed'))
    return () => {
      alive = false
    }
  }, [id, url])
  return url ? state : 'failed'
}

function FontRow({ id, index, url, name, sample, onRemove }: { id: string; index: number; url?: string | null; name?: string; sample: string; onRemove: () => void }) {
  const state = useFontFace(id, url)
  const title = name ?? `Font ${index + 1}`
  return (
    <li className="flex items-start gap-3 rounded-[6px] border border-studio-border bg-studio-raised p-3">
      <div className="min-w-0 flex-1">
        <p className="text-small text-studio-muted">
          {title}
          {index === 0 ? ' · used for cards and the logo reveal' : ''}
          {state === 'failed' ? ' · preview unavailable' : ''}
        </p>
        <p dir="auto" className="mt-1 break-words text-[22px] leading-8" style={{ fontFamily: `"${family(id)}", serif` }}>
          {sample || FONT_PREVIEW}
        </p>
      </div>
      <Button type="button" size="icon-sm" variant="ghost" aria-label={`Remove ${title}`} onClick={onRemove}>
        <X aria-hidden />
      </Button>
    </li>
  )
}

export function FontsSection({ fonts, urls, onChange }: { fonts: string[]; urls: AssetUrls; onChange: (ids: string[]) => void }) {
  const uid = useId()
  const [sample, setSample] = useState(FONT_PREVIEW)
  // uploads this session: the kit's asset map only knows them after saving
  const [local, setLocal] = useState<Record<string, { url?: string | null; name: string }>>({})

  return (
    <EditorSection
      title={`Fonts (${fonts.length}/${MAX_FONTS})`}
      hint="TTF or OTF files you're licensed to use. They set the type on end cards, lower thirds and the logo reveal. For Urdu, the font must include Urdu letters."
    >
      <div className="flex flex-col gap-1">
        <label htmlFor={`${uid}-sample`} className="text-small font-medium">
          Preview text
        </label>
        <Input id={`${uid}-sample`} dir="auto" value={sample} onChange={(e) => setSample(e.target.value)} />
      </div>
      {fonts.length > 0 && (
        <ul className="flex flex-col gap-2" aria-label="Fonts">
          {fonts.map((id, i) => (
            <FontRow
              key={id}
              id={id}
              index={i}
              url={urls[id] ?? local[id]?.url}
              name={local[id]?.name}
              sample={sample}
              onRemove={() => onChange(fonts.filter((f) => f !== id))}
            />
          ))}
        </ul>
      )}
      {fonts.length < MAX_FONTS && (
        <SourceDropZone
          label="Add a font"
          purpose="font"
          pickMax={0}
          onAdd={(items) => {
            const m = items[0]
            if (!m) return
            setLocal((x) => ({ ...x, [m.id]: { url: m.media_url, name: m.title } }))
            onChange([...fonts, m.id].slice(0, MAX_FONTS))
          }}
        />
      )}
    </EditorSection>
  )
}
