import { useState } from 'react'
import { Link } from 'react-router'
import { Plus, Trash2, Wand2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Kbd } from '@/components/ui/kbd'
import { Progress } from '@/components/ui/progress'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Tooltip } from '@/components/ui/tooltip'
import { AspectTiles } from '@/components/studio/aspect-tile'
import { Chip, ChipGroup } from '@/components/studio/chip'
import { Section } from '@/components/studio/section'
import { SourceBadge } from '@/components/studio/source-badge'
import { EmptyState, ErrorState } from '@/components/studio/states'
import { StatusPill } from '@/components/studio/status-pill'
import { ReviewBar } from '@/components/review/ReviewBar'
import { generationStatus, jobStatus, projectStatus, staleStatus } from '@/lib/status'
import type { GenerationStatus, JobStatus, ProjectStatus } from '@/lib/types'

const GEN: GenerationStatus[] = ['queued', 'generating', 'ready', 'approved', 'rejected', 'failed']
const JOB: JobStatus[] = ['queued', 'running', 'done', 'failed', 'cancelled']
const PROJ: ProjectStatus[] = ['draft', 'in_progress', 'rendering', 'done']

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-[8px] border border-studio-border bg-studio-panel p-4">
      <h2 className="section-label mb-3">{title}</h2>
      <div className="flex flex-wrap items-start gap-3">{children}</div>
    </section>
  )
}

const noop = () => {}

export function DevUiPage() {
  const [tod, setTod] = useState<string | null>('day')
  const [aspect, setAspect] = useState('16:9')
  const [log, setLog] = useState('—')
  const say = (m: string) => () => setLog(m)

  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-4 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-title font-display font-semibold">UI kit · visual QA</h1>
        <Link to="/projects" className="text-body text-studio-accent-hover underline-offset-2 hover:underline">
          Back to app
        </Link>
      </div>

      <Block title="Quill cursor (nib = hotspot) — on paper and on darkroom">
        {(['--quill', '--quill-tilt'] as const).map((v) => (
          <div key={v} className="flex items-end gap-3">
            <span className="size-7 bg-no-repeat" style={{ backgroundImage: `var(${v})` }} aria-hidden />
            <span className="size-[84px] bg-no-repeat [background-size:84px]" style={{ backgroundImage: `var(${v})` }} aria-hidden />
            <span className="darkroom flex size-[100px] items-center justify-center rounded-[6px]">
              <span className="size-[84px] bg-no-repeat [background-size:84px]" style={{ backgroundImage: `var(${v})` }} aria-hidden />
            </span>
            <span className="text-small text-studio-muted">{v === '--quill' ? 'default' : 'clickable'}</span>
          </div>
        ))}
      </Block>

      <Block title="Buttons">
        <Button variant="primary">
          <Wand2 aria-hidden /> Generate <Kbd>Ctrl+Enter</Kbd>
        </Button>
        <Button variant="secondary">Secondary</Button>
        <Button variant="ghost">Ghost</Button>
        <Button variant="danger">
          <Trash2 aria-hidden /> Delete
        </Button>
        <Button variant="primary" loading>
          Loading keeps width
        </Button>
        <Button size="sm">Small</Button>
        <Button disabled>Disabled</Button>
        <Tooltip content="Icon buttons always get a tooltip and aria-label">
          <Button size="icon" variant="ghost" aria-label="Add">
            <Plus aria-hidden />
          </Button>
        </Tooltip>
      </Block>

      <Block title="Inputs">
        <Input placeholder="Search assets" className="w-60" />
        <Input aria-invalid placeholder="Invalid" className="w-60" />
        <Textarea placeholder="Prompt…" className="w-80" />
        <Switch defaultChecked aria-label="Demo switch" />
      </Block>

      <Block title="Segmented · tabs">
        <ToggleGroup type="single" defaultValue="t2v" aria-label="Mode">
          <ToggleGroupItem value="t2v">Text → Video</ToggleGroupItem>
          <ToggleGroupItem value="i2v">Image → Video</ToggleGroupItem>
          <ToggleGroupItem value="ref">Reference</ToggleGroupItem>
        </ToggleGroup>
        <Tabs defaultValue="a">
          <TabsList aria-label="Demo tabs">
            <TabsTrigger value="a">Generate</TabsTrigger>
            <TabsTrigger value="b">Shot</TabsTrigger>
            <TabsTrigger value="c">Camera</TabsTrigger>
          </TabsList>
          <TabsContent value="a" className="pt-2 text-small text-studio-muted">
            Tab panel
          </TabsContent>
        </Tabs>
      </Block>

      <Block title="Chips">
        <Chip>Unselected</Chip>
        <Chip selected>Selected</Chip>
        <ChipGroup
          label="Time of day"
          value={tod}
          onChange={setTod}
          options={['dawn', 'day', 'dusk', 'night'].map((v) => ({ value: v, label: v }))}
        />
      </Block>

      <Block title="Aspect tiles">
        <div className="w-[420px]">
          <AspectTiles value={aspect} onChange={setAspect} />
        </div>
      </Block>

      <Block title="Status pills">
        {GEN.map((s) => (
          <StatusPill key={s} status={generationStatus(s, 0.42)} />
        ))}
        <Separator orientation="vertical" className="h-5" />
        {JOB.map((s) => (
          <StatusPill key={s} status={jobStatus(s, 0.7)} />
        ))}
        <Separator orientation="vertical" className="h-5" />
        {PROJ.map((s) => (
          <StatusPill key={s} status={projectStatus(s)} />
        ))}
        <StatusPill status={staleStatus} />
        <Badge tone="warning">Mock renderer</Badge>
      </Block>

      <Block title="Source badges">
        <SourceBadge source="user" />
        <SourceBadge source="ai" />
        <SourceBadge source="ai_edited" locked />
      </Block>

      <Block title={`Review bar — last action: ${log}`}>
        <div className="grid w-full gap-3 md:grid-cols-2">
          {GEN.map((s) => (
            <div key={s} className="rounded-[6px] border border-studio-border p-3">
              <div className="section-label mb-2">{s}</div>
              <ReviewBar
                status={s}
                version={3}
                versionCount={5}
                progress={0.42}
                error={s === 'failed' ? 'ComfyUI returned an out-of-memory error.' : null}
                onApprove={say(`approve (${s})`)}
                onUnapprove={say(`unapprove (${s})`)}
                onRegenerate={(m) => setLog(`regenerate:${m} (${s})`)}
                onReject={say(`reject (${s})`)}
                onRestore={say(`restore (${s})`)}
                onToggleVersions={say(`versions (${s})`)}
                onCancel={say(`cancel (${s})`)}
              />
            </div>
          ))}
        </div>
      </Block>

      <Block title="Progress · skeleton">
        <div className="flex w-72 flex-col gap-2">
          <Progress value={0.42} label="Demo progress" />
          <Progress value={null} label="Waiting" />
          <Skeleton className="h-16" />
        </div>
      </Block>

      <Block title="Section · empty · error">
        <div className="w-64">
          <Section title="Characters" count={3}>
            <p className="text-small text-studio-muted">Section body</p>
          </Section>
        </div>
        <div className="w-72 rounded-[6px] border border-studio-border">
          <EmptyState icon={<Plus />} title="No scenes yet" action={<Button size="sm" variant="primary" onClick={noop}>Add scene</Button>}>
            A film is a list of scenes. Start with one.
          </EmptyState>
        </div>
        <ErrorState className="w-80" error={new Error('Request failed (503)')} onRetry={noop} />
      </Block>
    </main>
  )
}
