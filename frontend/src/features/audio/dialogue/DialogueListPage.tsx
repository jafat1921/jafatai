import { useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { MessagesSquare, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState, ErrorState } from '@/components/studio/states'
import { useCreateScript, useScripts } from '@/hooks/useDialogue'
import { useVoiceEngines } from '@/hooks/useVoices'
import type { ScriptSummary } from '@/lib/dialogue'
import { allLanguages, languageName } from '@/lib/voice'
import { cn } from '@/lib/utils'
import { SELECT } from '../voice/AddVoiceDialog'

export function DialogueListPage() {
  const list = useScripts()
  const create = useCreateScript()
  const navigate = useNavigate()
  const { engines } = useVoiceEngines()
  const languages = allLanguages(engines.map((e) => e.languages))
  const [title, setTitle] = useState('')
  const [language, setLanguage] = useState('en')
  const scripts = list.data ?? []

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    const t = title.trim()
    if (!t) return
    create.mutate({ title: t, language }, { onSuccess: (s) => navigate(`/audio/dialogue/${s.id}`) })
  }

  return (
    <main data-f6-region tabIndex={-1} aria-labelledby="dialogue-title" className="h-full overflow-y-auto focus-visible:outline-none">
      <div className="mx-auto flex max-w-5xl flex-col gap-4 px-4 py-6 md:px-8">
        <header>
          <h1 id="dialogue-title" className="font-display text-title font-semibold">
            Dialogue
          </h1>
          <p className="text-small text-studio-muted">Radio plays, narration and voice-over: a cast of voices, one take per line, and a mixed track.</p>
        </header>

        <form onSubmit={submit} aria-label="New script" className="flex flex-wrap items-end gap-2 rounded-[6px] border border-studio-border-strong bg-studio-panel p-3 shadow-card">
          <label className="flex min-w-56 flex-1 flex-col gap-1 text-small">
            <span className="section-label">Title</span>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="The night train" maxLength={200} />
          </label>
          <label className="flex w-44 flex-col gap-1 text-small">
            <span className="section-label">Language</span>
            <select value={language} onChange={(e) => setLanguage(e.target.value)} className={SELECT}>
              {(languages.length ? languages : [{ code: 'en', name: 'English' }]).map((l) => (
                <option key={l.code} value={l.code}>
                  {l.name}
                </option>
              ))}
            </select>
          </label>
          <Button type="submit" variant="primary" disabled={!title.trim()} loading={create.isPending}>
            <Plus aria-hidden />
            New script
          </Button>
          {create.isError && (
            <p role="alert" className="basis-full text-small text-studio-danger">
              {create.error.message}
            </p>
          )}
        </form>

        {list.isPending ? (
          <div className="flex flex-col gap-2">
            {Array.from({ length: 3 }, (_, i) => (
              <Skeleton key={i} className="h-14" />
            ))}
          </div>
        ) : list.isError ? (
          <ErrorState error={list.error} onRetry={() => list.refetch()} />
        ) : scripts.length === 0 ? (
          <EmptyState icon={<MessagesSquare />} title="No scripts yet">
            Start one above, then paste a script or import one from a film project.
          </EmptyState>
        ) : (
          <ul aria-label="Scripts" className="divide-y divide-studio-border rounded-[6px] border border-studio-border bg-studio-panel">
            {scripts.map((s) => (
              <ScriptRow key={s.id} script={s} language={languageName(s.language, engines)} />
            ))}
          </ul>
        )}
      </div>
    </main>
  )
}

function ScriptRow({ script, language }: { script: ScriptSummary; language: string }) {
  const c = script.counts
  const changed = c.stale + c.empty + c.failed
  return (
    <li className="flex items-center gap-3 px-3 py-2.5">
      <MessagesSquare aria-hidden className="size-4 shrink-0 text-studio-muted" />
      <div className="min-w-0 flex-1">
        <Link to={`/audio/dialogue/${script.id}`} className="block truncate text-body font-medium hover:underline">
          {script.title}
        </Link>
        <p className="text-[11px] text-studio-muted">
          {language} · {c.lines} line{c.lines === 1 ? '' : 's'} · {c.ready} ready
          {changed ? ` · ${changed} to render` : ''}
        </p>
      </div>
      <span className={cn('shrink-0 rounded-[4px] border px-1.5 text-[11px] leading-5', script.has_mix ? 'border-studio-success text-studio-success' : 'border-studio-border text-studio-muted')}>
        {script.has_mix ? 'Mixed' : 'No mix yet'}
      </span>
    </li>
  )
}
