/** Eyedropper layer over the frame: one click hands back where, as 0..1 of the frame. */
export function PickOverlay({ label, onPick }: { label: string; onPick: (x: number, y: number) => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={`${label} (Esc cancels)`}
      className="absolute inset-0 size-full cursor-crosshair"
      onClick={(e) => {
        const b = e.currentTarget.getBoundingClientRect()
        onPick((e.clientX - b.left) / b.width, (e.clientY - b.top) / b.height)
      }}
    />
  )
}
