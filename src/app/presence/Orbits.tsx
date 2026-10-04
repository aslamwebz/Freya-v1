/**
 * The reference light rings that frame the centre — animated, and shared by
 * every screen so the middle reads as one instrument.
 */
export function Orbits() {
  return <svg className="hd-orbits" viewBox="0 0 550 550" fill="none" aria-hidden="true">
    <defs><linearGradient id="hd-orbit-color" x1="0" y1="0" x2="550" y2="550" gradientUnits="userSpaceOnUse"><stop stopColor="#96d9fa" /><stop offset=".5" stopColor="#6593c1" stopOpacity=".24" /><stop offset="1" stopColor="#ac9bff" /></linearGradient></defs>
    {/* Outer instrument rings and the beacons that ride them, slowly turning. */}
    <g className="hd-spin hd-spin-a">
      <circle cx="275" cy="275" r="262" stroke="url(#hd-orbit-color)" strokeWidth=".8" opacity=".38" />
      <circle cx="275" cy="275" r="240" stroke="url(#hd-orbit-color)" strokeWidth=".9" opacity=".42" />
      {/* Beacons glow with two stacked translucent discs rather than an SVG
          Gaussian-blur filter: the filter forced the whole group to re-rasterise
          every animation frame, for a halo a soft disc reproduces for free. */}
      {[[494, 173], [358, 48], [173, 56], [48, 358], [56, 377], [192, 502], [377, 494], [502, 192]].map(([x, y], i) => <g key={i} className="hd-beacon" style={{ animationDelay: `${i * 0.4}s` }}>
        <circle cx={x} cy={y} r={i % 2 ? 15 : 11} fill={i % 2 ? '#b79cff' : '#8cedff'} opacity=".13" />
        <circle cx={x} cy={y} r={i % 2 ? 7 : 5} fill={i % 2 ? '#b79cff' : '#8cedff'} opacity=".72" />
        <circle cx={x} cy={y} r={i % 2 ? 3.2 : 2.4} fill={i % 2 ? '#e1ceff' : '#b6f7ff'} />
      </g>)}
    </g>
    {/* The dotted guidance ring turns the other way. */}
    <g className="hd-spin hd-spin-b">
      <circle cx="275" cy="275" r="214" stroke="#82c7f0" strokeDasharray="1 14" opacity=".5" />
    </g>
    {/* The bright rim that frames Freya, breathing. */}
    <g className="hd-rim">
      <circle cx="275" cy="275" r="190" stroke="#8fe9ff" strokeWidth="2.2" opacity=".92" />
      <path d="M85 275a190 190 0 0 1 380 0" stroke="#c9f8ff" strokeWidth="2.6" />
      <circle cx="275" cy="275" r="176" stroke="#7ca7cb" strokeWidth=".8" opacity=".3" />
    </g>
  </svg>
}
