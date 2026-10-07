import { useId } from 'react'
import type { CameraAngle, CameraMotion, ShotSize } from '@/lib/camera'
import './camera.css'

// useId has colons, which url(#…) can't take
const useClipId = () => `cam${useId().replace(/[^\w-]/g, '')}`

// a person 20 units tall, head at the top; scaled and placed per shot size
function Figure({ x = 16, y = 0, s = 1 }: { x?: number; y?: number; s?: number }) {
  return (
    <g transform={`translate(${x} ${y}) scale(${s})`}>
      <circle cx="0" cy="3" r="2.6" fill="currentColor" />
      <rect x="-3.6" y="6" width="7.2" height="7.5" rx="2" fill="currentColor" />
      <path d="M-2 13 v7 M2 13 v7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </g>
  )
}

const SIZE: Record<ShotSize, { y: number; s: number }> = {
  ecu: { y: -2.5, s: 4.5 },
  cu: { y: 0.6, s: 2.8 },
  mcu: { y: 1, s: 2 },
  ms: { y: 1.3, s: 1.4 },
  mls: { y: 2, s: 1.05 },
  ls: { y: 3, s: 0.8 },
  ews: { y: 12, s: 0.32 },
}

function Frame({ children, clip }: { children: React.ReactNode; clip: string }) {
  return (
    <svg viewBox="0 0 32 22" width="32" height="22" aria-hidden focusable="false" className="shrink-0">
      <defs>
        <clipPath id={clip}>
          <rect x="1" y="1" width="30" height="20" rx="1.5" />
        </clipPath>
      </defs>
      <g clipPath={`url(#${clip})`} className="text-studio-accent-hover">
        {children}
      </g>
      <rect x="1" y="1" width="30" height="20" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.2" className="text-studio-border-strong" />
    </svg>
  )
}

function Cam({ x, y, rot = 0 }: { x: number; y: number; rot?: number }) {
  return (
    <g transform={`translate(${x} ${y}) rotate(${rot})`} className="text-studio-text">
      <rect x="-3" y="-1.8" width="4.5" height="3.6" rx="0.6" fill="currentColor" />
      <path d="M1.5 0 l2.4 -1.6 v3.2z" fill="currentColor" />
    </g>
  )
}

const sight = { stroke: 'currentColor', strokeWidth: 0.8, strokeDasharray: '1.4 1.2', fill: 'none' } as const

function AngleArt({ angle }: { angle: CameraAngle }) {
  switch (angle) {
    case 'eye':
      return (
        <>
          <Figure x={23} y={1} s={0.95} />
          <path d="M9 4 H19.5" {...sight} />
          <Cam x={6} y={4} />
        </>
      )
    case 'low':
      return (
        <>
          <Figure x={23} y={1} s={0.95} />
          <path d="M9 17 L20 5" {...sight} />
          <Cam x={6} y={18} rot={-45} />
        </>
      )
    case 'high':
      return (
        <>
          <Figure x={23} y={4} s={0.85} />
          <path d="M9 3.5 L20 7" {...sight} />
          <Cam x={6} y={3} rot={20} />
        </>
      )
    case 'overhead':
      // seen from above: shoulders and the top of the head
      return (
        <>
          <ellipse cx="16" cy="11" rx="6.5" ry="3" fill="currentColor" opacity="0.55" />
          <circle cx="16" cy="11" r="2.8" fill="currentColor" />
        </>
      )
    case 'dutch':
      return (
        <g transform="rotate(-14 16 11)">
          <path d="M-2 17 H34" stroke="currentColor" strokeWidth="0.8" />
          <Figure y={2} s={0.85} />
        </g>
      )
    case 'pov':
      return (
        <>
          <Figure y={3} s={0.8} />
          <path d="M1 21 Q6 13 11 21 Z M21 21 Q26 13 31 21 Z" fill="currentColor" opacity="0.45" />
        </>
      )
    case 'ots':
      return (
        <>
          <Figure x={21} y={3} s={0.8} />
          <path d="M-2 22 Q2 9 9 10 Q13 11 14 22 Z" fill="currentColor" opacity="0.5" />
        </>
      )
  }
}

// small direction marks drawn over the frame; the moving subject does the rest
function MotionMark({ motion }: { motion: CameraMotion }) {
  const p = { stroke: 'currentColor', strokeWidth: 1, fill: 'none', strokeLinecap: 'round', strokeLinejoin: 'round' } as const
  switch (motion) {
    case 'static':
      return <path d="M4 18 l2 -3 l2 3 M6 15 v-2" {...p} />
    case 'push_in':
    case 'zoom_in':
      return <path d="M3.5 3.5 l3 3 m0 -2.2 v2.2 h-2.2 M28.5 18.5 l-3 -3 m0 2.2 v-2.2 h2.2" {...p} />
    case 'pull_out':
    case 'zoom_out':
      return <path d="M6.5 6.5 l-3 -3 m0 2.2 v-2.2 h2.2 M25.5 15.5 l3 3 m0 -2.2 v2.2 h-2.2" {...p} />
    case 'pan_left':
      return <path d="M10 4 Q16 1.5 22 4 M10 4 l1.6 -1.6 M10 4 l2 0.8" {...p} />
    case 'pan_right':
      return <path d="M10 4 Q16 1.5 22 4 M22 4 l-1.6 -1.6 M22 4 l-2 0.8" {...p} />
    case 'dolly_left':
      return <path d="M22 4 H10 l2 -1.5 M10 4 l2 1.5 M8 20 H24" {...p} />
    case 'dolly_right':
      return <path d="M10 4 H22 l-2 -1.5 M22 4 l-2 1.5 M8 20 H24" {...p} />
    case 'tilt_up':
      return <path d="M4 15 Q2 11 4 7 l-1.4 1.6 M4 7 l1.6 1.2" {...p} />
    case 'tilt_down':
      return <path d="M4 7 Q2 11 4 15 l-1.4 -1.6 M4 15 l1.6 -1.2" {...p} />
    case 'orbit_left':
    case 'orbit_right':
      return <ellipse cx="16" cy="18.5" rx="9" ry="2" {...p} strokeDasharray="1.6 1.2" />
    case 'handheld':
      return <path d="M3 5 l1.5 -1.5 l1.5 1.5 l1.5 -1.5" {...p} />
    case 'crane_up':
      return <path d="M4 16 V6 l-1.6 1.8 M4 6 l1.6 1.8" {...p} />
    case 'crane_down':
      return <path d="M4 6 V16 l-1.6 -1.8 M4 16 l1.6 -1.8" {...p} />
  }
}

export function SizeDiagram({ size }: { size: ShotSize }) {
  const clip = useClipId()
  const { y, s } = SIZE[size]
  return (
    <Frame clip={clip}>
      {size === 'ews' && <path d="M1 19 L8 14 L13 17 L20 11 L31 18" stroke="currentColor" strokeWidth="0.8" fill="none" />}
      <Figure y={y} s={s} />
    </Frame>
  )
}

export function AngleDiagram({ angle }: { angle: CameraAngle }) {
  const clip = useClipId()
  return (
    <Frame clip={clip}>
      <AngleArt angle={angle} />
    </Frame>
  )
}

export function MotionDiagram({ motion }: { motion: CameraMotion }) {
  const clip = useClipId()
  return (
    <Frame clip={clip}>
      <g className={motion === 'static' ? undefined : `cam-anim cam-${motion}`}>
        <Figure y={2.5} s={0.9} />
      </g>
      <g className="text-studio-text">
        <MotionMark motion={motion} />
      </g>
    </Frame>
  )
}
