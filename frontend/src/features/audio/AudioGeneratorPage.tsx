import { useState } from 'react'
import { useLocation, useSearchParams } from 'react-router'
import { Music, Music4, Volume2 } from 'lucide-react'
import { EmptyState } from '@/components/studio/states'
import { GeneratorPage, ResultsHeading } from '@/components/generate/GeneratorPage'
import { SessionResults } from '@/components/generate/SessionResults'
import { useRecordRun } from '@/components/generate/useRecordRun'
import { flatItems, useMediaList } from '@/hooks/useMedia'
import { useAudioGenerate } from '@/hooks/useModels'
import { audioFormFrom, audioResult, DEFAULT_AUDIO_FORM, KIND_NOUN, type AudioForm } from '@/lib/audio'
import { modelUsedId, normalizeModelId } from '@/lib/models'
import type { TemplatePrefill } from '@/lib/templates'
import type { AudioKind, MediaItem } from '@/lib/types'
import { announce } from '@/stores/ui'
import { AudioDock, type AudioRun } from './AudioDock'

const EMPTY: Record<AudioKind, { icon: React.ReactNode; title: string; body: string }> = {
  song: { icon: <Music />, title: 'No songs yet', body: 'Add style tags and lyrics above. Each take appears here as it finishes.' },
  music: { icon: <Music4 />, title: 'No music yet', body: 'Describe a mood above. Each track appears here as it finishes.' },
  sfx: { icon: <Volume2 />, title: 'No sounds yet', body: 'Describe a sound or tap a preset. Each one appears here as it finishes.' },
}

const LABEL: Record<AudioKind, string> = { song: 'Song', music: 'Music & Score', sfx: 'Sound effects' }

export function AudioGeneratorPage({ kind }: { kind: AudioKind }) {
  // a fresh dock when arriving again from the menu with a new ?prompt / ?model
  return <AudioGenerator key={useLocation().key} kind={kind} />
}

// older items may not say what made them; they show everywhere rather than nowhere
const madeAs = (m: MediaItem, kind: AudioKind) => !m.params?.kind || m.params.kind === kind

function AudioGenerator({ kind }: { kind: AudioKind }) {
  const page = `audio-${kind}`
  const [params] = useSearchParams()
  const template = (useLocation().state as { template?: TemplatePrefill } | null)?.template
  const model = normalizeModelId(params.get('model')) ?? undefined
  const [form, setForm] = useState<AudioForm>(() => {
    const base = template ? audioFormFrom(kind, template.prefill) : DEFAULT_AUDIO_FORM[kind]
    return { ...base, prompt: params.get('prompt') ?? base.prompt, model: model ?? base.model }
  })
  const results = useMediaList({ kind: 'audio', origin: 'generated' })
  const generate = useAudioGenerate()
  const record = useRecordRun<AudioRun>(page)
  const noun = KIND_NOUN[kind]

  const run = (r: AudioRun) =>
    generate.mutate(r.body, {
      onSuccess: (res) => {
        const { items, jobs } = audioResult(res)
        record({ prompt: r.body.prompt, summary: r.summary, settings: r, items, jobs, label: items.length > 1 ? `Your ${noun.many}` : `Your ${noun.one}` })
        announce(`Making your ${items.length > 1 ? noun.many : noun.one}. ${items.length > 1 ? 'They appear' : 'It appears'} below when ready.`)
      },
    })
  const refill = (next: AudioForm) => {
    setForm({ ...next, kind })
    announce('Settings copied into the prompt dock.')
  }
  const fromItem = (m: MediaItem) => {
    const f = audioFormFrom(kind, { ...(m.params ?? {}), prompt: m.prompt ?? m.params?.prompt, duration_s: m.duration_s ?? m.params?.duration_s })
    return { ...f, model: modelUsedId(m.params, { model: m.model }) ?? undefined }
  }

  return (
    <GeneratorPage label={LABEL[kind]} targets={[]}>
      <AudioDock form={form} setForm={setForm} modelPicked={!!model && form.model === model} onRun={run} pending={generate.isPending} error={generate.error} />
      <ResultsHeading>Your {noun.many}</ResultsHeading>
      <SessionResults<AudioRun>
        page={page}
        label="Results"
        items={flatItems(results.data).filter((m) => madeAs(m, kind))}
        loading={results.isPending}
        error={results.isError ? results.error : undefined}
        onRetryLoad={() => results.refetch()}
        hasMore={results.hasNextPage}
        loadingMore={results.isFetchingNextPage}
        onLoadMore={() => results.fetchNextPage()}
        onRetry={(req) => run(req.settings)}
        onReuse={(row) => refill(row.request?.settings.form ?? (row.items[0] ? fromItem(row.items[0]) : { ...DEFAULT_AUDIO_FORM[kind], prompt: row.prompt }))}
        reuseItem={(m) => refill(fromItem(m))}
        empty={
          <EmptyState icon={EMPTY[kind].icon} title={EMPTY[kind].title}>
            {EMPTY[kind].body}
          </EmptyState>
        }
      />
    </GeneratorPage>
  )
}
