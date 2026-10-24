// The burnt sheet edges and the quill's gold-leaf grain both point at these filters by id; render once per page.
export function JafatDefs() {
  return (
    <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden focusable="false">
      <filter id="jafat-burn" x="-5%" y="-5%" width="110%" height="110%">
        <feTurbulence type="fractalNoise" baseFrequency=".022 .03" numOctaves={4} seed={7} result="noise" />
        <feDisplacementMap in="SourceGraphic" in2="noise" scale={18} xChannelSelector="R" yChannelSelector="G" />
      </filter>
      <filter id="jafat-leaf">
        <feTurbulence type="fractalNoise" baseFrequency=".9" numOctaves={2} result="grain" />
        <feDiffuseLighting in="grain" surfaceScale={1.6} lightingColor="#fff3c4" result="lit">
          <feDistantLight azimuth={235} elevation={55} />
        </feDiffuseLighting>
        <feComposite in="lit" in2="SourceGraphic" operator="in" result="litLeaf" />
        <feBlend in="SourceGraphic" in2="litLeaf" mode="multiply" />
      </filter>
    </svg>
  )
}
