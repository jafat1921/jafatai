import { useDeferredValue, useState } from 'react'
import { useSearchParams } from 'react-router'
import { LayoutGrid, List, Plus, Search, Star, UsersRound } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { EmptyState, ErrorState } from '@/components/studio/states'
import { useUpdateVoice, useVoiceEngines, useVoices } from '@/hooks/useVoices'
import { clock } from '@/lib/audio'
import { allLanguages, KIND_LABEL, languageName } from '@/lib/voice'
import type { Voice, VoiceEngine, VoiceKind, VoiceQuery } from '@/lib/types'
import { cn } from '@/lib/utils'
import { announce } from '@/stores/ui'
import { AddVoiceDialog, SELECT } from './AddVoiceDialog'
import { VoiceAvatar } from './VoiceAvatar'
import { RefPlay, VoiceSheet } from './VoiceSheet'

const VIEW_KEY = 'mixai.voices.view'

type View = 'grid' | 'list'

function readView(): View {
  try {
    return localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'grid'
  } catch {
    return 'grid'
  }
}

export function VoicesPage() {
  const [params, setParams] = useSearchParams()
  const [view, setView] = useState<View>(readView)
  const [q, setQ] = useState('')
  const [language, setLanguage] = useState('')
  const [kind, setKind] = useState<VoiceKind | ''>('')
  const [starred, setStarred] = useState(false)
  const [openId, setOpenId] = useState<string | null>(null)
  const query: VoiceQuery = { q: useDeferredValue(q.trim()) || undefined, language: language || undefined, kind: kind || undefined, starred: starred || undefined }
  const list = useVoices(query)
  const { engines } = useVoiceEngines()
  const languages = allLanguages(engines.map((e) => e.languages))
  const voices = list.data ?? []
  const open = voices.find((v) => v.id === openId) ?? null
  const adding = params.get('add') === '1'
  const filtered = !!(query.q || language || kind || starred)

  const setAdding = (on: boolean) =>
    setParams(
      (p) => {
        const next = new URLSearchParams(p)
        if (on) next.set('add', '1')
        else next.delete('add')
        return next
      },
      { replace: true },
    )
  const changeView = (v: View) => {
    setView(v)
    try {
      localStorage.setItem(VIEW_KEY, v)
    } catch {
      /* private mode */
    }
  }

  return (
    <main data-f6-region tabIndex={-1} aria-labelledby="voices-title" className="h-full overflow-y-auto focus-visible:outline-none">
      <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-6 md:px-8">
        <header className="flex flex-wrap items-end gap-3">
          <div className="min-w-0 flex-1">
            <h1 id="voices-title" className="font-display text-title font-semibold">
              Voices
            </h1>
            <p className="text-small text-studio-muted">Cloned, designed and preset voices for Speak, Dialogue and Dub. Each clone keeps its consent record.</p>
          </div>
          <ToggleGroup type="single" aria-label="View" value={view} onValueChange={(v) => v && changeView(v as View)} className="h-8">
            <ToggleGroupItem value="grid" aria-label="Grid" className="h-6 px-2">
              <LayoutGrid aria-hidden className="size-3.5" />
            </ToggleGroupItem>
            <ToggleGroupItem value="list" aria-label="List" className="h-6 px-2">
              <List aria-hidden className="size-3.5" />
            </ToggleGroupItem>
          </ToggleGroup>
          <Button type="button" variant="primary" onClick={() => setAdding(true)}>
            <Plus aria-hidden />
            Add a voice
          </Button>
        </header>

        <div role="search" aria-label="Filter voices" className="flex flex-wrap items-center gap-2 border-b border-studio-border pb-3">
          <div className="relative min-w-48 flex-1">
            <Search aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-studio-muted" />
            <Input type="search" aria-label="Search voices" placeholder="Search voices" value={q} onChange={(e) => setQ(e.target.value)} className="pl-8" />
          </div>
          <select aria-label="Language" value={language} onChange={(e) => setLanguage(e.target.value)} className={cn(SELECT, 'w-40')}>
            <option value="">All languages</option>
            {languages.map((l) => (
              <option key={l.code} value={l.code}>
                {l.name}
              </option>
            ))}
          </select>
          <select aria-label="Kind" value={kind} onChange={(e) => setKind(e.target.value as VoiceKind | '')} className={cn(SELECT, 'w-32')}>
            <option value="">All kinds</option>
            {(Object.keys(KIND_LABEL) as VoiceKind[]).map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </select>
          <Button type="button" size="md" aria-pressed={starred} onClick={() => setStarred(!starred)} className="aria-pressed:border-studio-accent aria-pressed:bg-studio-accent-soft">
            <Star aria-hidden className={starred ? 'fill-current text-studio-accent' : undefined} />
            Starred
          </Button>
        </div>

        {list.isPending ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-20" />
            ))}
          </div>
        ) : list.isError ? (
          <ErrorState error={list.error} onRetry={() => list.refetch()} />
        ) : voices.length === 0 ? (
          <EmptyState
            icon={<UsersRound />}
            title={filtered ? 'No voice matches' : 'No voices yet'}
            action={
              !filtered && (
                <Button type="button" variant="primary" onClick={() => setAdding(true)}>
                  <Plus aria-hidden />
                  Add a voice
                </Button>
              )
            }
          >
            {filtered ? 'Try fewer filters.' : 'Clone one from a short clip, or design one from a description on the Design page.'}
          </EmptyState>
        ) : (
          <ul aria-label="Voices" className={view === 'grid' ? 'grid gap-3 sm:grid-cols-2 lg:grid-cols-3' : 'divide-y divide-studio-border rounded-[6px] border border-studio-border bg-studio-panel'}>
            {voices.map((v) => (
              <VoiceCard key={v.id} voice={v} view={view} engines={engines} onOpen={() => setOpenId(v.id)} />
            ))}
          </ul>
        )}
      </div>
      <AddVoiceDialog open={adding} onOpenChange={setAdding} languages={languages} />
      <VoiceSheet voice={open} onClose={() => setOpenId(null)} engines={engines} languages={languages} />
    </main>
  )
}

function VoiceCard({ voice, view, engines, onOpen }: { voice: Voice; view: View; engines: VoiceEngine[]; onOpen: () => void }) {
  const update = useUpdateVoice()
  const star = () =>
    update.mutate({ id: voice.id, patch: { starred: !voice.starred } }, { onSuccess: (v) => announce(v.starred ? `${v.name} starred.` : `${v.name} unstarred.`) })
  const grid = view === 'grid'
  return (
    <li className={cn('flex items-center gap-3', grid ? 'rounded-[6px] border border-studio-border-strong bg-studio-panel p-3 shadow-card' : 'px-3 py-2')}>
      <VoiceAvatar voice={voice} className={grid ? 'size-10 text-[16px]' : undefined} />
      <div className="min-w-0 flex-1">
        <button type="button" onClick={onOpen} className="block max-w-full truncate text-left text-body font-medium hover:underline" aria-label={`Open ${voice.name}`}>
          {voice.name}
        </button>
        <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-[11px] text-studio-muted">
          <span>{languageName(voice.language, engines)}</span>
          <span aria-hidden>·</span>
          <span className="rounded-[4px] border border-studio-border px-1 leading-4">{KIND_LABEL[voice.kind]}</span>
          <span aria-hidden>·</span>
          <span className="text-studio-faint">
            {voice.uses} use{voice.uses === 1 ? '' : 's'}
          </span>
          {voice.ref?.duration_s ? <span className="font-mono text-studio-faint">{clock(voice.ref.duration_s)}</span> : null}
          {voice.locked && <span className="text-studio-faint">locked</span>}
        </p>
      </div>
      <RefPlay voice={voice} />
      <Button type="button" size="icon-sm" variant="ghost" aria-pressed={voice.starred} aria-label={`Star ${voice.name}`} onClick={star}>
        <Star aria-hidden className={voice.starred ? 'fill-current text-studio-accent' : undefined} />
      </Button>
    </li>
  )
}
