import { useEffect, useId, useRef, useState } from 'react'
import { ImageIcon, Upload } from 'lucide-react'
import { StatusPill } from '@/components/studio/status-pill'
import { Button } from '@/components/ui/button'
import { useUploadPhoto } from '@/hooks/useImplant'
import { cropBox, VIEW_LABEL, VIEWS, type Garment, type Patient, type View } from '@/lib/implant'
import { generationStatus } from '@/lib/status'
import { announce } from '@/stores/ui'

export function Photos({ patient }: { patient: Patient }) {
  return (
    <section aria-labelledby="implant-photos-h" className="flex min-w-0 flex-col gap-3">
      <h2 id="implant-photos-h" className="font-display text-title font-semibold">
        Photos
      </h2>
      <ul className="grid min-w-0 gap-3 md:grid-cols-3">
        {VIEWS.map((v) => (
          <PhotoSlot key={v} patient={patient} view={v} />
        ))}
      </ul>
    </section>
  )
}

function PhotoSlot({ patient, view }: { patient: Patient; view: View }) {
  const uid = useId()
  const upload = useUploadPhoto(patient.id)
  const current = patient.photos[view]
  const name = patient.views?.[view] ?? VIEW_LABEL[view]
  const toplessOk = patient.consent.topless_ok
  const [garment, setGarment] = useState<Garment>(current?.garment === 'topless' && toplessOk ? 'topless' : 'garment')
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [top, setTop] = useState(15)
  const [bottom, setBottom] = useState(100)
  const urlRef = useRef<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  useEffect(() => () => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current)
  }, [])

  const choose = (f: File | null) => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current)
    urlRef.current = f ? URL.createObjectURL(f) : null
    setFile(f)
    setPreview(urlRef.current)
    upload.reset()
  }

  // consent can be withdrawn after the choice was made
  const sendGarment: Garment = toplessOk ? garment : 'garment'
  const shown = preview ?? current?.url ?? null

  return (
    <li className="flex min-w-0 flex-col gap-2 rounded-[6px] border border-studio-border-strong bg-studio-panel p-3">
      <h3 className="text-body font-medium">{name}</h3>
      <div className="relative aspect-[3/4] overflow-hidden rounded-[4px] bg-studio-raised">
        {shown ? (
          <img src={shown} alt={preview ? `${name}: new photo, as it will be cropped` : `${name} photo`} className="size-full object-contain" />
        ) : (
          <span className="flex size-full items-center justify-center text-studio-muted">
            <ImageIcon aria-hidden className="size-6" />
            <span className="sr-only">No {name} photo yet</span>
          </span>
        )}
        {preview && (
          <>
            {/* the shaded bands are what the crop takes away */}
            <span aria-hidden className="absolute inset-x-0 top-0 bg-studio-text/55" style={{ height: `${top}%` }} />
            <span aria-hidden className="absolute inset-x-0 bottom-0 bg-studio-text/55" style={{ height: `${100 - bottom}%` }} />
          </>
        )}
      </div>
      {current && !preview && current.status !== 'ready' && current.status !== 'approved' && <StatusPill className="self-start" status={generationStatus(current.status)} />}

      <fieldset className="flex flex-col gap-1">
        <legend className="section-label mb-1">Garment</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-body">
          <label className="flex items-center gap-1.5">
            <input type="radio" name={`${uid}-garment`} className="accent-studio-accent" checked={sendGarment === 'garment'} onChange={() => setGarment('garment')} />
            Bra/top
          </label>
          <label className="flex items-center gap-1.5 aria-disabled:opacity-60" aria-disabled={!toplessOk || undefined}>
            <input
              type="radio"
              name={`${uid}-garment`}
              className="accent-studio-accent"
              checked={sendGarment === 'topless'}
              aria-disabled={!toplessOk}
              aria-describedby={toplessOk ? undefined : `${uid}-why`}
              onChange={() => toplessOk && setGarment('topless')}
            />
            Topless
          </label>
        </div>
        {!toplessOk && (
          <p id={`${uid}-why`} className="text-small text-studio-muted">
            Topless needs the patient’s separate consent. Turn it on at the top of the page.
          </p>
        )}
      </fieldset>

      <div className="flex flex-col gap-1">
        <label htmlFor={`${uid}-file`} className="section-label">
          {current ? `Replace the ${name} photo` : `${name} photo`}
        </label>
        <input
          ref={fileInput}
          id={`${uid}-file`}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          className="text-small file:mr-2 file:rounded-[6px] file:border file:border-studio-border-strong file:bg-studio-raised file:px-2 file:py-1 file:text-small"
          onChange={(e) => choose(e.target.files?.[0] ?? null)}
        />
      </div>

      {preview && (
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${uid}-top`} className="text-small">
            Cut from the top: {top}%
          </label>
          <input id={`${uid}-top`} type="range" min={0} max={60} step={1} value={top} aria-valuetext={`${top}%`} className="accent-studio-accent" onChange={(e) => setTop(Math.min(Number(e.target.value), bottom - 20))} />
          <label htmlFor={`${uid}-bottom`} className="text-small">
            Cut at the bottom: {bottom}%
          </label>
          <input id={`${uid}-bottom`} type="range" min={40} max={100} step={1} value={bottom} aria-valuetext={`${bottom}%`} className="accent-studio-accent" onChange={(e) => setBottom(Math.max(Number(e.target.value), top + 20))} />
        </div>
      )}

      {upload.isError && (
        <p role="alert" className="text-small text-studio-danger">
          {upload.error.message}
        </p>
      )}
      <Button
        type="button"
        size="sm"
        variant="primary"
        className="self-start"
        aria-label={`Upload the ${name} photo`}
        disabled={!file}
        loading={upload.isPending}
        onClick={() =>
          file &&
          upload.mutate(
            { file, view, garment: sendGarment, crop: top === 0 && bottom === 100 ? undefined : cropBox(top, bottom) },
            {
              onSuccess: () => {
                announce(`${name} photo uploaded`)
                choose(null)
                if (fileInput.current) fileInput.current.value = ''
              },
            },
          )
        }
      >
        <Upload aria-hidden />
        Upload
      </Button>
    </li>
  )
}
