import { useCallback, useState } from 'react'
import { useNavigate } from 'react-router'
import { X } from 'lucide-react'
import { BeforeAfter } from '@/components/media/BeforeAfter'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { ErrorState } from '@/components/studio/states'
import { useBreakpoint } from '@/hooks/useBreakpoint'
import { usePhotoSchema } from '@/hooks/usePhoto'
import { downloadUrl } from '@/lib/media'
import { ASPECTS } from '@/lib/photo/geometry'
import { isIdentity, paramsKey } from '@/lib/photo/params'
import type { DevelopParams, HistoryVersion, PhotoHistory } from '@/lib/photo/types'
import { cn } from '@/lib/utils'
import { announce } from '@/stores/ui'
import { CropOverlay } from './CropOverlay'
import { CutoutTab } from './CutoutTab'
import { DarkroomCanvas, type Zoom } from './DarkroomCanvas'
import { DevelopPanel } from './DevelopPanel'
import { CompareDialog, Filmstrip } from './Filmstrip'
import { GeometryControls } from './GeometryControls'
import { HistoryPanel } from './HistoryPanel'
import { LightPointsOverlay } from './LightPointsOverlay'
import { LocalPanel } from './LocalPanel'
import { LooksTab, type AppliedLook } from './LooksTab'
import { PhotoHeader } from './PhotoHeader'
import { RestoreTab } from './RestoreTab'
import { SelectPointsOverlay, type SelectPoints } from './SelectPointsOverlay'
import { lastTab } from './session'
import { StudioPanel, type StudioTab } from './StudioPanel'
import { useDevelop } from './useDevelop'
import { useLivePreview } from './useLivePreview'
import { usePhotoActions } from './usePhotoActions'
import { usePhotoShortcuts } from './usePhotoShortcuts'

interface Props {
  routeId: string
  history: PhotoHistory
  opened: HistoryVersion
  baseId: string
  sourceUrl: string | null
  initial: DevelopParams
  title: string
  initialTab?: StudioTab
}

/** The editing session for one version: canvas, panel, filmstrip, history. Keyed by version. */
export function PhotoWorkspace({ routeId, history, opened, baseId, sourceUrl, initial, title, initialTab = 'develop' }: Props) {
  const navigate = useNavigate()
  const bp = useBreakpoint()
  const schema = usePhotoSchema().data
  const develop = useDevelop(initial)
  const { params } = develop
  const actions = usePhotoActions({ routeId, baseId, title, develop })

  const [tab, setTabState] = useState<StudioTab>(() => lastTab.get(routeId) ?? initialTab)
  const setTab = (t: StudioTab) => {
    lastTab.set(routeId, t)
    setTabState(t)
  }
  const [cropping, setCropping] = useState(false)
  const [aspect, setAspect] = useState('free')
  const [placing, setPlacing] = useState(false)
  const [point, setPoint] = useState<number | null>(null)
  const [zoom, setZoom] = useState<Zoom>('fit')
  const [before, setBefore] = useState(false)
  const [split, setSplit] = useState<string | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [panelOpen, setPanelOpen] = useState(false)
  const [sheetOpen, setSheetOpen] = useState(true)
  const [pair, setPair] = useState<[HistoryVersion, HistoryVersion] | null>(null)
  const [maxSide, setMaxSide] = useState(1600)
  const [applied, setApplied] = useState<AppliedLook | null>(null)
  const [selectPts, setSelectPts] = useState<SelectPoints>({ include: [], exclude: [] })
  const [clickMode, setClickMode] = useState<'include' | 'exclude' | null>(null)
  const selecting = tab === 'cutout' && (clickMode != null || selectPts.include.length + selectPts.exclude.length > 0)
  const onMaxSide = useCallback((px: number) => setMaxSide(px), [])

  // crop works on the whole, unturned source; so do cut-out clicks, which SAM reads in source pixels
  // TODO: draw the crop box on the turned frame so straightening and cropping can happen together
  const shown = cropping || selecting ? { ...params, crop: null, rotate: 0, flipH: false, flipV: false } : params
  const preview = useLivePreview({ sourceUrl, previewId: baseId, params: shown, before, maxSide })
  const dirty = paramsKey(params) !== paramsKey(initial) && !isIdentity(params)
  const src = preview.source

  const toggleSplit = () => setSplit((s) => (s ? null : preview.snapshot()))
  usePhotoShortcuts({
    save: () => dirty && actions.save(),
    undo: develop.undo,
    redo: develop.redo,
    toggleBefore: () => setBefore((b) => !b),
    toggleLoupe: () => setZoom((z) => (z === 'fit' ? 1 / (window.devicePixelRatio || 1) : 'fit')),
    toggleCrop: () => setCropping((c) => !c),
    escape: () => {
      setCropping(false)
      setPlacing(false)
    },
  })

  const ratio = (() => {
    const a = ASPECTS.find((x) => x.id === aspect)
    if (!a || a.ratio == null) return null
    return a.ratio || (src ? src.w / src.h : null)
  })()

  const overlay = (box: { width: number; height: number }) => {
    if (before || split) return null
    if (selecting && clickMode) {
      return <SelectPointsOverlay points={selectPts} mode={clickMode} box={box} onChange={setSelectPts} />
    }
    if (cropping && src) {
      return (
        <CropOverlay
          crop={params.crop ?? { x: 0, y: 0, width: src.w, height: src.h }}
          src={src}
          box={box}
          ratio={ratio}
          onChange={(crop, group) => develop.update((p) => ({ ...p, crop }), group)}
        />
      )
    }
    if (!preview.frame || (!placing && !params.lightPoints?.length)) return null
    return (
      <LightPointsOverlay
        points={params.lightPoints ?? []}
        frame={preview.frame}
        box={box}
        placing={placing}
        selected={point}
        onSelect={setPoint}
        onChange={(pts, group) => develop.update((p) => ({ ...p, lightPoints: pts }), group)}
      />
    )
  }

  const ranges = schema?.ranges ?? {}
  const panel = (
    <StudioPanel
      tab={tab}
      onTab={setTab}
      develop={
        <DevelopPanel
          schema={schema}
          params={params}
          histogram={preview.histogram}
          live={preview.mode === 'webgl'}
          onSet={develop.set}
          onUpdate={develop.update}
          custom={{
            local: (
              <LocalPanel
                params={params}
                ranges={ranges}
                photoId={baseId}
                placing={placing}
                onPlacing={(on) => {
                  setPlacing(on)
                  if (on) setCropping(false)
                }}
                selected={point}
                onSelect={setPoint}
                onChange={develop.update}
              />
            ),
            geometry: (
              <GeometryControls
                params={params}
                src={src}
                cropping={cropping}
                onCropping={(on) => {
                  setCropping(on)
                  if (on) setPlacing(false)
                }}
                aspect={aspect}
                onAspect={setAspect}
                onChange={develop.update}
              />
            ),
          }}
        />
      }
      restore={<RestoreTab photoId={baseId} routeId={routeId} title={title} history={history} />}
      cutout={
        <CutoutTab
          key={opened.generation.id}
          photoId={baseId}
          routeId={routeId}
          title={title}
          version={opened}
          points={selectPts}
          onPoints={setSelectPts}
          clickMode={clickMode}
          onClickMode={(m) => {
            setClickMode(m)
            if (m) {
              setCropping(false)
              setPlacing(false)
            }
          }}
        />
      }
      looks={<LooksTab photoId={baseId} sourceUrl={sourceUrl} params={params} applied={applied} onApplied={setApplied} onParams={develop.replace} />}
    />
  )

  const desktop = bp === 'wide' || bp === 'medium'
  const phone = bp === 'mobile'

  const canvas = split && sourceUrl ? (
    <BeforeAfter before={sourceUrl} after={split} alt={title} beforeLabel="Original" afterLabel="Edited" className="size-full" />
  ) : (
    <DarkroomCanvas
      preview={preview}
      attach={preview.attachCanvas}
      sourceUrl={sourceUrl}
      alt={title}
      before={before}
      zoom={zoom}
      onZoom={setZoom}
      onMaxSide={onMaxSide}
      overlay={overlay}
      overlayActive={cropping || placing || (selecting && clickMode != null)}
    />
  )

  return (
    <main data-f6-region tabIndex={-1} aria-label="Photo Studio" className="flex h-full min-h-0 flex-col focus-visible:outline-none">
      <PhotoHeader
        title={title}
        version={opened.generation.version}
        comparing={!!split}
        dirty={dirty}
        resettable={!isIdentity(params)}
        canUndo={develop.canUndo}
        canRedo={develop.canRedo}
        autoPending={actions.autoPending}
        savePending={actions.saving}
        exportPending={actions.exporting}
        formats={schema?.formats}
        downloadHref={downloadUrl(opened.generation.id)}
        onUndo={develop.undo}
        onRedo={develop.redo}
        onCompare={toggleSplit}
        onHistory={() => setHistoryOpen(true)}
        onAuto={actions.runAuto}
        onReset={() => {
          develop.replace({}, null)
          setApplied(null)
          announce('All adjustments reset. Undo brings them back.')
        }}
        onSave={actions.save}
        onExport={actions.exportAs}
        onPanel={bp === 'compact' ? () => setPanelOpen(true) : undefined}
      />
      {(actions.failure != null || actions.notes.length > 0) && (
        <div className="flex flex-col gap-1.5 border-b border-studio-border bg-studio-panel px-3 py-2">
          {actions.failure != null && <ErrorState compact title="That didn't work" error={actions.failure} />}
          {actions.notes.length > 0 && (
            <p className="flex items-start gap-2 text-small" role="status">
              <span className="font-medium">Auto:</span>
              <span className="flex-1 text-studio-muted">{actions.notes.join(' · ')}</span>
              <button type="button" className="rounded-[4px] p-0.5 text-studio-muted hover:text-studio-text" aria-label="Dismiss Auto notes" onClick={actions.clearNotes}>
                <X aria-hidden className="size-3.5" />
              </button>
            </p>
          )}
        </div>
      )}

      <div className={cn('min-h-0 flex-1', desktop ? 'grid grid-cols-[minmax(0,1fr)_340px]' : 'flex flex-col')}>
        <section aria-label="Darkroom" className={cn('flex min-h-0 flex-col', phone ? 'h-[46vh] shrink-0' : 'flex-1')}>
          <div className="relative min-h-0 flex-1">{canvas}</div>
          <div className="border-t border-studio-border bg-studio-panel">
            <Filmstrip versions={history.versions} openedId={opened.generation.id} onOpen={(id) => navigate(`/image/studio/${id}`)} />
          </div>
        </section>

        {desktop && (
          <aside aria-label="Adjustments" className="flex min-h-0 flex-col border-l border-studio-border bg-studio-panel">
            {panel}
          </aside>
        )}
        {phone && (
          <aside aria-label="Adjustments" className="flex min-h-0 flex-1 flex-col rounded-t-[12px] border-t border-studio-border-strong bg-studio-panel shadow-pop">
            <button
              type="button"
              className="flex w-full flex-col items-center gap-1 py-1.5 text-small text-studio-muted"
              aria-expanded={sheetOpen}
              onClick={() => setSheetOpen((o) => !o)}
            >
              <span aria-hidden className="h-1 w-10 rounded-full bg-studio-border-strong" />
              {sheetOpen ? 'Hide adjustments' : 'Show adjustments'}
            </button>
            {sheetOpen && panel}
          </aside>
        )}
      </div>

      {bp === 'compact' && (
        <Sheet open={panelOpen} onOpenChange={setPanelOpen} modal={false}>
          <SheetContent overlay={false} data-photo-panel className="w-[360px] pt-10" onInteractOutside={(e) => e.preventDefault()}>
            <SheetTitle className="sr-only">Adjustments</SheetTitle>
            {panel}
          </SheetContent>
        </Sheet>
      )}
      <Sheet open={historyOpen} onOpenChange={setHistoryOpen}>
        <SheetContent className="w-[420px] gap-3 overflow-y-auto p-4 pt-12">
          <SheetTitle className="font-display text-title font-semibold">History</SheetTitle>
          <HistoryPanel
            history={history}
            openedId={opened.generation.id}
            busy={actions.busy}
            error={null}
            onLoad={(v) => {
              develop.replace(v.develop?.params ?? {}, null)
              setHistoryOpen(false)
              announce(`Loaded the settings of version ${v.generation.version}.`)
            }}
            onOpen={(id) => {
              setHistoryOpen(false)
              navigate(`/image/studio/${id}`)
            }}
            onRevert={actions.revert}
            onApprove={actions.approve}
            onRestore={actions.restore}
            onCompare={(a, b) => setPair([a, b])}
          />
        </SheetContent>
      </Sheet>
      <CompareDialog pair={pair} title={title} onClose={() => setPair(null)} />
    </main>
  )
}
