import { useState } from 'react'
import { Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { NARRATOR, newCastId, type CastMember } from '@/lib/dialogue'
import type { Voice, VoiceEngine } from '@/lib/types'
import { VoiceChip } from '../voice/VoiceChips'

interface Props {
  cast: CastMember[]
  lineCounts: Record<string, number>
  voices: Voice[]
  engines: VoiceEngine[]
  onChange: (cast: CastMember[]) => void
  // the script's language, for the voice picker's Gallery section
  language?: string
}

export function CastPanel({ cast, lineCounts, voices, engines, onChange, language }: Props) {
  const [name, setName] = useState('')
  const update = (id: string, patch: Partial<CastMember>) => onChange(cast.map((c) => (c.id === id ? { ...c, ...patch } : c)))
  const taken = (n: string) => cast.some((c) => c.name.trim().toLowerCase() === n.trim().toLowerCase())

  const add = (e: React.FormEvent) => {
    e.preventDefault()
    const n = name.trim()
    if (!n || taken(n)) return
    // the server picks the colour when it saves
    onChange([...cast, { id: newCastId(), name: n, voice_id: null, color: null }])
    setName('')
  }

  return (
    <aside aria-labelledby="cast-title" className="flex w-full shrink-0 flex-col gap-2 border-studio-border bg-studio-panel p-3 md:w-72 md:border-r">
      <h2 id="cast-title" className="section-label">
        Cast
      </h2>
      <ul aria-label="Cast" className="flex flex-col gap-2">
        {cast.map((c) => {
          const fixed = c.id === NARRATOR
          const n = lineCounts[c.id] ?? 0
          return (
            <li key={c.id} className="flex flex-col gap-1.5 rounded-[6px] border border-studio-border bg-studio-raised p-2">
              <div className="flex items-center gap-2">
                <span aria-hidden className="size-3 shrink-0 rounded-full border border-studio-border-strong" style={{ background: c.color ?? 'transparent' }} />
                {fixed ? (
                  <span className="flex-1 text-body font-medium">{c.name}</span>
                ) : (
                  <Input
                    aria-label={`Name of ${c.name}`}
                    value={c.name}
                    maxLength={80}
                    onChange={(e) => update(c.id, { name: e.target.value })}
                    onBlur={(e) => !e.target.value.trim() && update(c.id, { name: 'Unnamed' })}
                    className="h-7 flex-1 px-2"
                  />
                )}
                <span className="shrink-0 font-mono text-[11px] text-studio-faint" aria-label={`${n} line${n === 1 ? '' : 's'}`}>
                  {n}
                </span>
                {!fixed && (
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`Remove ${c.name}${n ? ` (their ${n} line${n === 1 ? '' : 's'} go to the narrator)` : ''}`}
                    onClick={() => onChange(cast.filter((x) => x.id !== c.id))}
                  >
                    <X aria-hidden />
                  </Button>
                )}
              </div>
              <VoiceChip name={`Voice of ${c.name}`} voices={voices} engines={engines} language={language} value={c.voice_id} onChange={(v) => update(c.id, { voice_id: v })} />
            </li>
          )
        })}
      </ul>
      <form onSubmit={add} className="flex gap-1.5" aria-label="Add a character">
        <Input aria-label="New character name" placeholder="Add a character" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} className="h-8 flex-1" />
        <Button type="submit" size="icon" aria-label="Add character" disabled={!name.trim() || taken(name)}>
          <Plus aria-hidden />
        </Button>
      </form>
      {name.trim() && taken(name) && <p className="text-[11px] text-studio-warning">{name.trim()} is already in the cast.</p>}
    </aside>
  )
}
