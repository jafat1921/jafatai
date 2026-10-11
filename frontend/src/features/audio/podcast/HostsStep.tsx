import { useCallback, useEffect, useId, useState } from 'react'
import { Mic, Plus, Save, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useVoiceChoices } from '@/hooks/useGallery'
import { usePatchEpisode, useUpdateShow } from '@/hooks/usePodcast'
import { useVoiceEngines } from '@/hooks/useVoices'
import { MAX_HOSTS, ROLE_LABEL, hostProblem, newHost, type Episode, type Host, type HostRole } from '@/lib/podcast'
import type { Voice, VoiceEngine } from '@/lib/types'
import { announce } from '@/stores/ui'
import { SELECT } from '../voice/AddVoiceDialog'
import { VoiceChip } from '../voice/VoiceChips'

const SAVE_AFTER_MS = 600

export function HostsStep({ ep }: { ep: Episode }) {
  const patch = usePatchEpisode(ep.id)
  const showPatch = useUpdateShow()
  const voices = useVoiceChoices()
  const { engines } = useVoiceEngines()
  const [hosts, setHosts] = useState<Host[]>(ep.hosts)
  const [ver, setVer] = useState(0)
  const [savedVer, setSavedVer] = useState(0)
  const dirty = ver !== savedVer
  const [seen, setSeen] = useState(ep.hosts)
  if (seen !== ep.hosts) {
    setSeen(ep.hosts)
    if (!dirty) setHosts(ep.hosts)
  }
  const problem = hostProblem(hosts)

  const { mutateAsync } = patch
  const save = useCallback(
    (v: number, list: Host[]) =>
      mutateAsync({ hosts: list })
        .then(() => setSavedVer((s) => Math.max(s, v)))
        .catch(() => {}),
    [mutateAsync],
  )
  useEffect(() => {
    if (!dirty || problem) return
    const t = setTimeout(() => save(ver, hosts), SAVE_AFTER_MS)
    return () => clearTimeout(t)
  }, [ver, dirty, problem, hosts, save])

  const edit = (next: Host[]) => {
    setHosts(next)
    setVer((v) => v + 1)
  }
  const change = (id: string, p: Partial<Host>) => edit(hosts.map((h) => (h.id === id ? { ...h, ...p } : h)))
  const add = () => {
    const h = newHost(hosts)
    edit([...hosts, h])
    announce(`${h.name} added.`)
  }
  const remove = (h: Host) => {
    edit(hosts.filter((x) => x.id !== h.id))
    announce(`${h.name} removed. Their lines stay in the script.`)
  }

  return (
    <>
      <div>
        <h2 className="font-display text-title font-semibold">Hosts</h2>
        <p className="text-small text-studio-muted">One to four voices. The persona shapes how the writer has them talk; pick a voice from the Gallery or your own, or record a host yourself.</p>
      </div>
      <ul aria-label="Hosts" className="grid gap-3 md:grid-cols-2">
        {hosts.map((h, i) => (
          <HostCard key={h.id} host={h} n={i + 1} voices={voices} engines={engines} language={ep.language} onChange={(p) => change(h.id, p)} onRemove={hosts.length > 1 ? () => remove(h) : undefined} />
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" disabled={hosts.length >= MAX_HOSTS} onClick={add}>
          <Plus aria-hidden />
          Add a host
        </Button>
        {ep.show_id && (
          <Button
            type="button"
            variant="ghost"
            loading={showPatch.isPending}
            disabled={!!problem}
            onClick={() => showPatch.mutate({ id: ep.show_id!, patch: { hosts } }, { onSuccess: () => announce(`These hosts are now ${ep.show_name ?? 'the show'}'s defaults.`) })}
          >
            <Save aria-hidden />
            Make these the show’s hosts
          </Button>
        )}
        <span aria-live="polite" className="ml-auto text-[12px] text-studio-muted">
          {problem ? <span className="text-studio-warning">{problem}</span> : dirty ? 'Saving…' : 'Saved'}
        </span>
      </div>
      {patch.isError && (
        <p role="alert" className="text-small text-studio-danger">
          {patch.error.message}
        </p>
      )}
    </>
  )
}

function HostCard({
  host,
  n,
  voices,
  engines,
  language,
  onChange,
  onRemove,
}: {
  host: Host
  n: number
  voices: Voice[]
  engines: VoiceEngine[]
  language: string
  onChange: (p: Partial<Host>) => void
  onRemove?: () => void
}) {
  const uid = useId()
  return (
    <li className="flex flex-col gap-2 rounded-[6px] border border-studio-border-strong bg-studio-panel p-3 shadow-card">
      <div className="flex items-end gap-2">
        <label className="flex min-w-0 flex-1 flex-col gap-1 text-small">
          <span className="section-label">Host {n} name</span>
          <Input value={host.name} maxLength={80} dir="auto" onChange={(e) => onChange({ name: e.target.value })} />
        </label>
        <label className="flex w-32 flex-col gap-1 text-small">
          <span className="section-label">Role</span>
          <select value={host.role} onChange={(e) => onChange({ role: e.target.value as HostRole })} className={SELECT}>
            {(Object.keys(ROLE_LABEL) as HostRole[]).map((r) => (
              <option key={r} value={r}>
                {ROLE_LABEL[r]}
              </option>
            ))}
          </select>
        </label>
        {onRemove && (
          <Button type="button" size="icon-sm" variant="ghost" aria-label={`Remove ${host.name || `host ${n}`}`} onClick={onRemove}>
            <Trash2 aria-hidden />
          </Button>
        )}
      </div>
      <label className="flex flex-col gap-1 text-small">
        <span className="section-label">Persona</span>
        <Input value={host.persona} maxLength={400} dir="auto" placeholder="Warm, curious, asks the questions listeners would" onChange={(e) => onChange({ persona: e.target.value })} />
      </label>
      <div className="flex flex-wrap items-center gap-3">
        {!host.me && (
          <VoiceChip name={`Voice for ${host.name || `host ${n}`}`} voices={voices} engines={engines} language={language} value={host.voice_id} onChange={(v) => onChange({ voice_id: v })} />
        )}
        <label htmlFor={`${uid}-me`} className="flex items-center gap-2 text-small">
          <input id={`${uid}-me`} type="checkbox" checked={host.me} onChange={(e) => onChange({ me: e.target.checked, voice_id: e.target.checked ? null : host.voice_id })} className="accent-studio-accent" />
          <Mic aria-hidden className="size-3.5 text-studio-muted" />
          Me — I’ll record these lines
        </label>
      </div>
    </li>
  )
}
