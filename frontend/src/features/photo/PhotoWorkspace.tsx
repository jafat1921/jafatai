import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { ErrorState } from '@/components/studio/states'
import { useBreakpoint } from '@/hooks/useBreakpoint'
import { usePhotoSchema } from '@/hooks/usePhoto'
import { api } from '@/lib/api'
import { exposureLine } from '@/lib/catalogue'
import { downloadUrl } from '@/lib/media'
import { ASPECTS } from '@/lib/photo/geometry'
import { compact, isIdentity, paramsKey } from '@/lib/photo/params'
import type { DevelopParams, HistoryVersion, PhotoHistory } from '@/lib/photo/types'
import { DEFAULT_COPY, bypass, pasteGroups, pickGroups, readClipboard, readPrevious, writeClipboard, writePrevious } from '@/lib/photo/workflow'
import type { MediaItem } from '@/lib/types'
import { cn } from '@/lib/utils'
import { trackJobs } from '@/stores/toasts'
import { announce } from '@/stores/ui'
import { CanvasToolbar, GridOverlay, InfoOverlay, SplitOverlay } from './CanvasToolbar'
import { ratioZoom, type CompareMode } from '@/lib/photo/view'
import { CopySettingsDialog } from './CopySettingsDialog'
import { CropOverlay } from './CropOverlay'
import { CutoutTab } from './CutoutTab'
import { DarkroomCanvas, type CanvasView, type Zoom } from './DarkroomCanvas'
import { DevelopPanel } from './DevelopPanel'
import { CompareDialog, Filmstrip } from './Filmstrip'
import { GeometryControls } from './GeometryControls'
import { HistogramPanel } from './HistogramPanel'
import { HistoryPanel } from './HistoryPanel'
import { LeftPanel, Navigator } from './LeftPanel'
import { LightPointsOverlay } from './LightPointsOverlay'
import { LocalPanel } from './LocalPanel'
import { LooksTab, type AppliedLook } from './LooksTab'
import { PhotoHeader } from './PhotoHeader'
import { RestoreTab } from './RestoreTab'
import { SelectPointsOverlay, type SelectPoints } from './SelectPointsOverlay'
import { lastTab } from './session'
import { SourceStrip, type StripPlace } from './SourceStrip'
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
  item?: MediaItem | null
}

function stored<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key)
    return v == null ? fallback : (JSON.parse(v) as T)
  } catch {
    return fallback
  }
}
function store(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v))
  } catch {
    /* private mode */
  }
}

// the edit panels in Lightroom's order; Ctrl+1…9 opens them in this order
const PANEL_ORDER = ['basic', 'curve', 'hsl', 'detail', 'effects', 'local']

/**
 * Develop, laid out like Lightroom's: Navigator, Presets, Snapshots and History on the left; the photo
 * with its toolbar and a filmstrip of the source; histogram, tool strip and edit panels on the right.
 * Keyed by version.
 */
export function PhotoWorkspace({ routeId, history, opened, baseId, sourceUrl, initial, title, initialTab = 'develop', item }: Props) {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const bp = useBreakpoint()
  const schema = usePhotoSchema().data
  const develop = useDevelop(initial)
  const { params } = develop
  const actions = usePhotoActions({ routeId, baseId, title, develop })
  const mediaId = history.target_type === 'media' ? history.target_id : null

  const [tab, setTabState] = useState<StudioTab>(() => lastTab.get(routeId) ?? initialTab)
  const setTab = (t: StudioTab) => {
    lastTab.set(routeId, t)
    setTabState(t)
    setCropping(t === 'crop')
  }
  const [cropping, setCropping] = useState(tab === 'crop')
  const [aspect, setAspect] = useState('free')
  const [placing, setPlacing] = useState(false)
  const [point, setPoint] = useState<number | null>(null)
  const [zoom, setZoom] = useState<Zoom>('fit')
  const [lastRatio, setLastRatio] = useState<Zoom>(() => ratioZoom(1))
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [view, setView] = useState<CanvasView | null>(null)
  const [before, setBefore] = useState(false)
  const [compare, setCompare] = useState<CompareMode>('off')
  const [grid, setGrid] = useState(() => stored('mixai.develop.grid', 0))
  const [info, setInfo] = useState(false)
  const [clip, setClip] = useState(false)
  const [lights, setLights] = useState(0)
  const [hideAll, setHideAll] = useState(false)
  const [left, setLeft] = useState(() => stored('mixai.develop.left', true))
  const [right, setRight] = useState(true)
  const [strip, setStrip] = useState<StripPlace>(() => stored('mixai.develop.strip', 'bottom'))
  const [stripFilter, setStripFilter] = useState(() => stored('mixai.develop.stripFilter', ''))
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [panels, setPanels] = useState<Record<string, boolean>>(() => stored('mixai.develop.panels', { basic: true }))
  const [leftOpen, setLeftOpen] = useState<Record<string, boolean>>(() => stored('mixai.develop.leftPanels', { navigator: true, presets: true, snapshots: true, history: true }))
  const [solo, setSolo] = useState(() => stored('mixai.develop.solo', false))
  const [preset, setPreset] = useState<DevelopParams | null>(null)
  const [readout, setReadout] = useState<[number, number, number] | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [panelOpen, setPanelOpen] = useState(false)
  const [leftSheet, setLeftSheet] = useState(false)
  const [sheetOpen, setSheetOpen] = useState(true)
  const [pair, setPair] = useState<[HistoryVersion, HistoryVersion] | null>(null)
  const [maxSide, setMaxSide] = useState(1600)
  const [applied, setApplied] = useState<AppliedLook | null>(null)
  const [selectPts, setSelectPts] = useState<SelectPoints>({ include: [], exclude: [] })
  const [clickMode, setClickMode] = useState<'include' | 'exclude' | null>(null)
  const [copying, setCopying] = useState<'copy' | 'sync' | null>(null)
  const [snapshotAsk, setSnapshotAsk] = useState(0)
  const [clipboard, setClipboard] = useState(() => readClipboard())
  const selecting = tab === 'cutout' && (clickMode != null || selectPts.include.length + selectPts.exclude.length > 0)
  const onMaxSide = useCallback((px: number) => setMaxSide(px), [])

  // "Previous" means the photo edited before this one, so take it before this one starts writing
  const [prevAtOpen] = useState(() => readPrevious())
  useEffect(() => {
    if (!isIdentity(params)) writePrevious(compact(params), title)
  }, [params, title])

  // crop works on the whole, unturned source; so do cut-out clicks, which SAM reads in source pixels
  // TODO: draw the crop box on the turned frame so straightening and cropping can happen together
  const working = preset ?? params
  const shown = cropping || selecting ? { ...working, crop: null, rotate: 0, flipH: false, flipV: false } : working
  const preview = useLivePreview({ sourceUrl, previewId: baseId, params: bypass(shown), before, maxSide, clip, wantBefore: compare !== 'off' })
  const dirty = paramsKey(params) !== paramsKey(initial) && !isIdentity(params)
  const src = preview.source

  // ---------------------------------------------------------------- settings: copy / paste / sync / previous
  const paste = (from = clipboard) => {
    if (!from) return
    develop.replace(pasteGroups(params, from.params, from.groups), null)
    announce(`Pasted ${from.groups.length} group${from.groups.length === 1 ? '' : 's'} of settings from ${from.from}.`)
  }
  const previous = () => {
    const p = prevAtOpen
    if (!p) return announce('No previous photo settings yet.')
    develop.replace(pasteGroups(params, p.params, DEFAULT_COPY), null)
    announce(`Applied the settings of ${p.from} (crop left alone).`)
  }
  const syncIds = [...picked].filter((id) => id !== mediaId)
  const runSync = async (groups: string[]) => {
    setCopying(null)
    try {
      const res = await api.photo.sync({ ids: syncIds, params: compact(params), groups })
      trackJobs(res.results.filter((r) => r.job_id).map((r) => ({ id: r.job_id! })), `Sync settings · ${res.queued} photos`, `/image/studio/${routeId}`)
      const failed = res.results.filter((r) => r.error).length
      announce(`Syncing to ${res.queued} photo${res.queued === 1 ? '' : 's'}${failed ? `; ${failed} couldn't be synced` : ''}. Each gets a new version.`)
      qc.invalidateQueries({ queryKey: ['photos'] })
      setPicked(new Set())
    } catch (e) {
      announce(`Sync didn't start: ${(e as Error).message}`)
    }
  }
  const reset = () => {
    develop.replace({}, null)
    setApplied(null)
    announce('All adjustments reset. Undo brings them back.')
  }

  const openPanel = (id: string, on: boolean) => {
    setPanels((ps) => {
      const next = solo && on ? { [id]: true } : { ...ps, [id]: on }
      store('mixai.develop.panels', next)
      return next
    })
  }
  const setLeftSection = (id: string, on: boolean) =>
    setLeftOpen((ps) => {
      const next = { ...ps, [id]: on }
      store('mixai.develop.leftPanels', next)
      return next
    })

  usePhotoShortcuts({
    save: () => dirty && actions.save(),
    undo: develop.undo,
    redo: develop.redo,
    toggleBefore: () => setBefore((b) => !b),
    toggleZoom: () => {
      if (zoom === 'fit') setZoom(lastRatio)
      else {
        setLastRatio(zoom)
        setZoom('fit')
      }
    },
    toggleCrop: () => setTab(tab === 'crop' ? 'develop' : 'crop'),
    escape: () => {
      if (tab === 'crop') setTab('develop')
      setPlacing(false)
      setLights(0)
    },
    compare: (m) => setCompare((c) => (c === m ? 'off' : m)),
    lights: () => setLights((l) => (l + 1) % 3),
    info: () => setInfo((v) => !v),
    clip: () => setClip((v) => !v),
    panels: (all) => {
      if (all) setHideAll((v) => !v)
      else {
        const show = !(left || right)
        setLeft(show)
        setRight(show)
      }
    },
    fullscreen: () => {
      if (document.fullscreenElement) document.exitFullscreen?.()
      else document.documentElement.requestFullscreen?.().catch(() => {})
    },
    grid: () => {
      const g = grid ? 0 : 3
      setGrid(g)
      store('mixai.develop.grid', g)
    },
    copy: () => setCopying('copy'),
    paste: () => paste(),
    previous,
    sync: () => syncIds.length && setCopying('sync'),
    reset,
    snapshot: () => {
      setLeft(true)
      setLeftSection('snapshots', true)
      setSnapshotAsk((n) => n + 1)
    },
    panel: (n) => {
      const id = PANEL_ORDER[n - 1]
      if (!id) return
      if (tab !== 'develop') setTab('develop')
      setPanels(() => {
        const next = { [id]: true }
        store('mixai.develop.panels', next)
        return next
      })
    },
  })

  const ratio = (() => {
    const a = ASPECTS.find((x) => x.id === aspect)
    if (!a || a.ratio == null) return null
    return a.ratio || (src ? src.w / src.h : null)
  })()

  const infoLines = [
    `${title}${opened.generation.version ? ` · v${opened.generation.version}` : ''}`,
    [item?.camera, item ? exposureLine(item) : '', preview.frame ? `${preview.frame.width} × ${preview.frame.height}` : ''].filter(Boolean).join(' · '),
  ]

  const overlay = (box: { width: number; height: number }) => {
    const layers: React.ReactNode[] = []
    if (preview.clipUrl && !before) layers.push(<img key="clip" src={preview.clipUrl} alt="" aria-hidden className="pointer-events-none absolute inset-0 size-full mix-blend-normal" />)
    if (grid && !cropping) layers.push(<GridOverlay key="grid" n={grid} box={box} />)
    if (info) layers.push(<InfoOverlay key="info" lines={infoLines} />)
    if (!before && (compare === 'lr-split' || compare === 'tb-split') && preview.beforeUrl) {
      layers.push(<SplitOverlay key="split" src={preview.beforeUrl} vertical={compare === 'tb-split'} box={box} />)
      return layers
    }
    if (before) return layers
    if (selecting && clickMode) layers.push(<SelectPointsOverlay key="sel" points={selectPts} mode={clickMode} box={box} onChange={setSelectPts} />)
    else if (cropping && src) {
      layers.push(
        <CropOverlay
          key="crop"
          crop={params.crop ?? { x: 0, y: 0, width: src.w, height: src.h }}
          src={src}
          box={box}
          ratio={ratio}
          onChange={(crop, group) => develop.update((p) => ({ ...p, crop }), group)}
        />,
      )
    } else if (preview.frame && (placing || params.lightPoints?.length)) {
      layers.push(
        <LightPointsOverlay
          key="points"
          points={params.lightPoints ?? []}
          frame={preview.frame}
          box={box}
          placing={placing}
          selected={point}
          onSelect={setPoint}
          onChange={(pts, group) => develop.update((p) => ({ ...p, lightPoints: pts }), group)}
        />,
      )
    }
    return layers
  }

  const ranges = schema?.ranges ?? {}
  const geometry = (
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
  )
  const exif = item ? [item.camera, exposureLine(item)].filter(Boolean).join(' · ') || null : null
  const panel = (
    <StudioPanel
      tab={tab}
      onTab={setTab}
      top={
        <HistogramPanel
          data={preview.histogram}
          params={params}
          onSet={develop.set}
          clip={clip}
          onClip={() => setClip((v) => !v)}
          readout={readout}
          exif={exif}
        />
      }
      develop={
        <>
          <label className="mb-1 flex items-center gap-1.5 text-[12px] text-studio-muted" title="Opening a panel closes the others">
            <input
              type="checkbox"
              checked={solo}
              onChange={(e) => {
                setSolo(e.target.checked)
                store('mixai.develop.solo', e.target.checked)
              }}
            />
            Solo mode
          </label>
          <DevelopPanel
            schema={schema}
            params={params}
            open={panels}
            onOpen={openPanel}
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
            }}
          />
        </>
      }
      crop={geometry}
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
      footer={
        <div className="flex gap-2">
          <Button size="sm" className="flex-1" onClick={previous} title="Apply the last photo's settings (Ctrl+Alt+P)">Previous</Button>
          <Button size="sm" className="flex-1" onClick={reset} disabled={isIdentity(params)} title="Reset (Ctrl+Alt+R)">Reset</Button>
        </div>
      }
    />
  )

  const leftPanel = (
    <LeftPanel
      photoId={baseId}
      baseId={baseId}
      params={params}
      navigator={<Navigator thumb={preview.server?.url ?? sourceUrl} view={view} zoom={zoom} onZoom={setZoom} onPan={setPan} />}
      presets={
        <LooksTab
          photoId={baseId}
          sourceUrl={sourceUrl}
          params={params}
          applied={applied}
          onApplied={setApplied}
          onParams={develop.replace}
          onPreview={setPreset}
        />
      }
      timeline={develop.timeline}
      onJump={develop.jump}
      onParams={(p, label) => {
        develop.replace(p, null)
        announce(`${label} applied.`)
      }}
      open={leftOpen}
      onOpen={setLeftSection}
      snapshotRequest={snapshotAsk}
      onNewSnapshot={() => setSnapshotAsk((n) => n + 1)}
      versions={<Filmstrip versions={history.versions} openedId={opened.generation.id} onOpen={(id) => navigate(`/image/studio/${id}`)} />}
    />
  )

  const desktop = bp === 'wide' || bp === 'medium'
  const phone = bp === 'mobile'
  const showLeft = desktop && left && !hideAll
  const showRight = desktop && right && !hideAll

  const darkroom = (
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
      pan={pan}
      onPan={setPan}
      onView={setView}
      onSample={(at) => setReadout(at ? preview.sample(at.x, at.y) : null)}
    />
  )
  // side-by-side modes: the untouched frame next to the edit
  const sideBySide = compare === 'lr' || compare === 'tb'
  const canvas = sideBySide && preview.beforeUrl ? (
    <div className={cn('flex size-full gap-1 bg-studio-darkroom', compare === 'tb' ? 'flex-col' : 'flex-row')}>
      <figure className="darkroom relative min-h-0 min-w-0 flex-1">
        <img src={preview.beforeUrl} alt={`${title}, before`} className="absolute inset-0 size-full object-contain p-3" />
        <figcaption className="absolute left-2 top-2 rounded bg-black/55 px-1.5 text-[11px] text-white">Before</figcaption>
      </figure>
      <div className="relative min-h-0 min-w-0 flex-1">
        {darkroom}
        <span className="pointer-events-none absolute left-2 top-2 rounded bg-black/55 px-1.5 text-[11px] text-white">After</span>
      </div>
    </div>
  ) : darkroom

  const stripEl = (
    <SourceStrip
      currentId={mediaId}
      place={strip}
      onPlace={(p) => {
        setStrip(p)
        store('mixai.develop.strip', p)
      }}
      size={56}
      filter={stripFilter}
      onFilter={(f) => {
        setStripFilter(f)
        store('mixai.develop.stripFilter', f)
      }}
      selected={picked}
      onSelected={setPicked}
    />
  )
  const dim = lights === 1 ? 'opacity-25' : lights === 2 ? 'invisible' : ''

  return (
    <main
      data-f6-region
      tabIndex={-1}
      aria-label="Photo Studio"
      className={cn('flex h-full min-h-0 flex-col focus-visible:outline-none', lights === 2 && 'bg-black')}
    >
      {!hideAll && (
        <div className={cn('transition-opacity', dim)}>
          <PhotoHeader
            title={title}
            version={opened.generation.version}
            dirty={dirty}
            canUndo={develop.canUndo}
            canRedo={develop.canRedo}
            autoPending={actions.autoPending}
            savePending={actions.saving}
            exportPending={actions.exporting}
            formats={schema?.formats}
            downloadHref={downloadUrl(opened.generation.id)}
            onUndo={develop.undo}
            onRedo={develop.redo}
            onHistory={() => setHistoryOpen(true)}
            onAuto={actions.runAuto}
            onSave={actions.save}
            onExport={actions.exportAs}
            onCopy={() => setCopying('copy')}
            onPaste={clipboard ? () => paste() : null}
            onSync={syncIds.length ? () => setCopying('sync') : null}
            syncCount={syncIds.length}
            left={left}
            right={right}
            onLeft={() => {
              setLeft((v: boolean) => !v)
              store('mixai.develop.left', !left)
            }}
            onRight={() => setRight((v) => !v)}
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
        </div>
      )}

      <div
        className={cn('min-h-0 flex-1', desktop ? 'grid' : 'flex flex-col')}
        style={desktop ? { gridTemplateColumns: `${showLeft ? '260px ' : ''}minmax(0,1fr)${showRight ? ' 330px' : ''}` } : undefined}
      >
        {showLeft && (
          <aside aria-label="Navigator, presets, snapshots and history" className={cn('min-h-0 overflow-y-auto border-r border-studio-border bg-studio-panel px-2 py-1 transition-opacity', dim)}>
            {leftPanel}
          </aside>
        )}

        <section aria-label="Darkroom" className={cn('flex min-h-0 flex-col', phone ? 'h-[46vh] shrink-0' : 'flex-1')}>
          <div className="flex min-h-0 flex-1">
            {strip === 'left' && !hideAll && !phone && <div className={cn('w-24 shrink-0 border-r border-studio-border', dim)}>{stripEl}</div>}
            <div className="relative min-h-0 min-w-0 flex-1">{canvas}</div>
            {strip === 'right' && !hideAll && !phone && <div className={cn('w-24 shrink-0 border-l border-studio-border', dim)}>{stripEl}</div>}
          </div>
          {!hideAll && (
            <div className={cn('transition-opacity', dim)}>
              <CanvasToolbar
                compare={compare}
                onCompare={setCompare}
                before={before}
                onBefore={() => setBefore((b) => !b)}
                zoom={zoom}
                onZoom={setZoom}
                grid={grid}
                onGrid={(n) => {
                  setGrid(n)
                  store('mixai.develop.grid', n)
                }}
                info={info}
                onInfo={() => setInfo((v) => !v)}
              />
              {(strip === 'bottom' || phone) && <div className="border-t border-studio-border">{stripEl}</div>}
            </div>
          )}
        </section>

        {showRight && (
          <aside aria-label="Adjustments" className={cn('flex min-h-0 flex-col border-l border-studio-border bg-studio-panel transition-opacity', dim)}>
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
        <>
          <Sheet open={panelOpen} onOpenChange={setPanelOpen} modal={false}>
            <SheetContent overlay={false} data-photo-panel className="w-[360px] pt-10" onInteractOutside={(e) => e.preventDefault()}>
              <SheetTitle className="sr-only">Adjustments</SheetTitle>
              {panel}
            </SheetContent>
          </Sheet>
          <Sheet open={leftSheet} onOpenChange={setLeftSheet} modal={false}>
            <SheetContent overlay={false} data-photo-panel className="w-[300px] overflow-y-auto p-2 pt-10" onInteractOutside={(e) => e.preventDefault()}>
              <SheetTitle className="sr-only">Navigator, presets, snapshots and history</SheetTitle>
              {leftPanel}
            </SheetContent>
          </Sheet>
          <Button size="sm" variant="secondary" className="fixed bottom-20 left-24 z-30 shadow-pop" onClick={() => setLeftSheet(true)}>Presets & history</Button>
        </>
      )}
      <Sheet open={historyOpen} onOpenChange={setHistoryOpen}>
        <SheetContent className="w-[420px] gap-3 overflow-y-auto p-4 pt-12">
          <SheetTitle className="font-display text-title font-semibold">Versions</SheetTitle>
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
      <CopySettingsDialog
        mode={copying}
        params={params}
        initial={clipboard?.groups ?? DEFAULT_COPY}
        count={syncIds.length}
        onClose={() => setCopying(null)}
        onConfirm={(groups) => {
          if (copying === 'sync') return runSync(groups)
          const c = { params: pickGroups(params, groups), groups, from: title, at: Date.now() }
          writeClipboard(c)
          setClipboard(c)
          setCopying(null)
          announce(`Copied ${groups.length} group${groups.length === 1 ? '' : 's'} of settings. Paste with Ctrl+Alt+V on another photo.`)
        }}
      />
    </main>
  )
}
