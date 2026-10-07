import { CameraChip, CameraRack } from '@/components/camera/CameraRack'
import { useUpdateShot } from '@/hooks/useShots'
import { cameraPayload, type CameraSetting } from '@/lib/camera'
import type { Shot } from '@/lib/types'

function useSaveRack(shot: Shot) {
  const update = useUpdateShot(shot.project_id)
  // the server rewrites shot.camera in plain words from the rack and adds it to the motion prompt
  return (c: CameraSetting) => update.mutate({ id: shot.id, patch: { camera_rack: cameraPayload(c) ?? {} } })
}

/** The P2 camera rack on a storyboard shot (inspector tab). */
export function ShotCamera({ shot }: { shot: Shot }) {
  const save = useSaveRack(shot)
  return (
    <div className="flex flex-col gap-3">
      <CameraRack value={shot.camera_rack ?? {}} onChange={save} />
      <p className="text-small text-studio-muted">
        {shot.camera ? (
          <>
            Written into this shot&apos;s motion prompt as: <span className="text-studio-text">{shot.camera}</span>
          </>
        ) : (
          'Pick a size, angle or move; it is written into the motion prompt when the take renders.'
        )}
      </p>
    </div>
  )
}

/** Compact chip for the shot-list table. */
export function ShotCameraChip({ shot }: { shot: Shot }) {
  const save = useSaveRack(shot)
  return <CameraChip value={shot.camera_rack ?? {}} onChange={save} />
}
