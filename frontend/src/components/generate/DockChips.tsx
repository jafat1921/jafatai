import { Boxes, FolderInput, Hash, Palette, RectangleHorizontal, Stamp } from 'lucide-react'
import { BrandChip } from '@/components/brand/BrandChip'
import { ChipGroup } from '@/components/studio/chip'
import { ModelPicker } from '@/components/models/ModelPicker'
import { SpeedPicker } from '@/components/models/SpeedPicker'
import type { BrandChoice } from '@/hooks/useBrandKits'
import { useFolders } from '@/hooks/useLibraryOrg'
import { useGenerateInto } from '@/stores/generateInto'
import type { MediaKind, ModelInfo } from '@/lib/types'
import { cn } from '@/lib/utils'
import { DockChip } from './DockChip'

interface ModelChipProps {
  models: ModelInfo[]
  model: ModelInfo | undefined
  onChange: (id: string) => void
  speed?: string
  onSpeed?: (id: string) => void
  blockedBy?: (m: ModelInfo) => string | null
  highlighted?: boolean
  // e.g. the sound note on Image to Video
  extra?: React.ReactNode
}

export function ModelChip({ models, model, onChange, speed, onSpeed, blockedBy, highlighted, extra }: ModelChipProps) {
  const speedLabel = model?.speeds?.find((s) => s.id === speed)?.label
  return (
    <DockChip name="Model" value={[model?.label ?? 'Model', speedLabel].filter(Boolean).join(' · ')} icon={<Boxes aria-hidden />} wide active={highlighted}>
      <ModelPicker label="Model" models={models} value={model?.id} onChange={onChange} blockedBy={blockedBy} highlighted={highlighted} />
      {model?.speeds?.length && onSpeed ? <SpeedPicker model={model} value={speed} onChange={onSpeed} /> : null}
      {extra}
    </DockChip>
  )
}

export function BrandDockChip({ choice }: { choice: BrandChoice }) {
  const value = choice.kit ? `${choice.kit.name}${choice.on ? '' : ' (off)'}` : 'none'
  return (
    <DockChip
      name="Brand"
      showName
      value={value}
      active={choice.on}
      icon={
        <span className="relative">
          <Stamp aria-hidden />
          {/* the ● from the wireframe; on/off is also in the words */}
          <span aria-hidden className={cn('absolute -right-1 -top-1 size-1.5 rounded-full', choice.on ? 'bg-studio-success' : 'bg-studio-border-strong')} />
        </span>
      }
    >
      <BrandChip choice={choice} />
      <p className="text-small text-studio-muted">The kit's palette and look are added to the prompt. Off sends nothing extra.</p>
    </DockChip>
  )
}

export function AspectChip({ value, children }: { value: string; children: React.ReactNode }) {
  return (
    <DockChip name="Aspect" value={value} icon={<RectangleHorizontal aria-hidden />} wide>
      {children}
    </DockChip>
  )
}

export function CountChip({ value, children }: { value: string; children: React.ReactNode }) {
  return (
    <DockChip name="Count" value={value} icon={<Hash aria-hidden />}>
      {children}
    </DockChip>
  )
}

export function StyleChip<T extends string>({
  options,
  value,
  onChange,
  allowEmpty = true,
}: {
  options: readonly { value: T; label: string }[]
  value: T | null
  onChange: (v: T | null) => void
  allowEmpty?: boolean
}) {
  const label = options.find((o) => o.value === value)?.label ?? 'Any style'
  return (
    <DockChip name="Style" value={label} icon={<Palette aria-hidden />} active={!!value && allowEmpty}>
      <ChipGroup label="Style" options={options} value={value} onChange={onChange} allowEmpty={allowEmpty} />
    </DockChip>
  )
}

/**
 * "Generate into…" (P4): which Library folder new results land in. Hidden until there is a folder,
 * so the dock stays as it was for people who never file anything.
 */
export function IntoChip({ kind }: { kind: MediaKind }) {
  const { folders } = useFolders(kind)
  const into = useGenerateInto((s) => s.into[kind])
  const setInto = useGenerateInto((s) => s.set)
  const picked = folders.find((f) => f.id === into)
  if (!folders.length) return null
  const options = folders.map((f) => ({ value: f.id, label: f.name }))
  return (
    <DockChip name="Into folder" showName value={picked?.name ?? 'Library'} icon={<FolderInput aria-hidden />} active={!!picked}>
      <ChipGroup label="Folder" options={options} value={picked?.id ?? null} onChange={(v) => setInto(kind, v)} />
      <p className="text-small text-studio-muted">Generate into… New {kind === 'audio' ? 'audio' : `${kind}s`} {kind === 'audio' ? 'is' : 'are'} filed here as they're made. Pick the folder again to stop.</p>
    </DockChip>
  )
}
