// A Rad Racer-style sunset drive, behind the whole app. The sky, sun and mountains are SVG/CSS; the road is drawn on a small
// canvas. (A CSS 3D plane for the road needed a drawing surface about 39x the screen, which exhausted the GPU's tile memory.)

import { useEffect, useRef } from 'react'

// Deterministic star field so it does not jump on re-render.
const stars = (() => {
  let s = 7
  const rnd = (): number => { s = (s * 16807) % 2147483647; return s / 2147483647 }
  return Array.from({ length: 90 }, () => `${(rnd() * 100).toFixed(1)}vw ${(rnd() * 52).toFixed(1)}vh 0 ${rnd() > 0.85 ? 1 : 0}px #fff`).join(',')
})()

/**
 * The road: a ground plane in perspective, drawn directly. Everything is simple 2D polygons at half resolution, so it costs
 * a fixed, small amount of memory however large the window is, and it only animates while the window is visible.
 */
function Road() {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const cv = ref.current!
    const ctx = cv.getContext('2d')!
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches
    const PX = 2 // one canvas pixel = 2 screen pixels: chunky on purpose
    let w = 0, h = 0, raf = 0, last = 0, phase = 0

    const draw = (): void => {
      if (!w) return
      const cx = w / 2, Wr = 1.4, A = (w * 0.3) / Wr // A: pixels per world unit at the bottom edge
      const bg = ctx.createLinearGradient(0, 0, 0, h)
      bg.addColorStop(0, '#1a0646'); bg.addColorStop(1, '#07011a')
      ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h)
      const base = Math.floor(phase), f = phase - base
      const Z = 70
      const y = (z: number): number => h / z // distance z -> screen y below the horizon (z = 1 is the bottom edge)
      ctx.lineCap = 'butt'
      // grid lines receding to the vanishing point, then cross lines
      ctx.strokeStyle = 'rgba(25,240,255,.8)'
      for (let j = -16; j <= 16; j++) { ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx + j * A, h); ctx.stroke() }
      for (let i = 1; i <= Z; i++) {
        const z = i - f, yy = y(z)
        if (z < 0.4 || yy > h + 2) continue
        ctx.strokeStyle = `rgba(255,42,157,${Math.min(0.95, 0.25 + (yy / h) * 3)})`
        ctx.lineWidth = Math.max(1, (yy / h) * 2.2)
        ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(w, yy); ctx.stroke()
      }
      // road, rumble strips and centre line, one band per gap between cross lines
      const quad = (y1: number, y2: number, x1: number, x2: number, color: string): void => {
        const a = y1 / h, b = y2 / h
        ctx.fillStyle = color; ctx.beginPath()
        ctx.moveTo(cx + x1 * A * a, y1); ctx.lineTo(cx + x2 * A * a, y1); ctx.lineTo(cx + x2 * A * b, y2); ctx.lineTo(cx + x1 * A * b, y2); ctx.closePath(); ctx.fill()
      }
      for (let i = 1; i < Z; i++) {
        const zn = i - f, zf = i + 1 - f
        const yn = Math.min(h + 2, y(Math.max(zn, 0.4))), yf = y(zf)
        if (yn < 0.5 || yn <= yf) continue
        const odd = (i + base) % 2 === 0
        quad(yn, yf, -Wr, Wr, odd ? '#251648' : '#301c5e')
        quad(yn, yf, -Wr * 1.12, -Wr, odd ? '#ff2a2a' : '#ffffff')
        quad(yn, yf, Wr, Wr * 1.12, odd ? '#ff2a2a' : '#ffffff')
        if (odd) quad(yn, yf, -0.05, 0.05, '#ffe14d')
      }
    }

    const size = (): void => {
      const r = cv.getBoundingClientRect()
      w = Math.max(160, Math.round(r.width / PX)); h = Math.max(80, Math.round(r.height / PX))
      cv.width = w; cv.height = h
      draw()
    }
    const tick = (t: number): void => {
      raf = requestAnimationFrame(tick)
      if (t - last < 33) return // about 30 frames a second is plenty for a backdrop
      phase += Math.min(0.1, (t - last) / 1000) * 2.4; last = t
      draw()
    }
    const start = (): void => { cancelAnimationFrame(raf); if (!reduce && !document.hidden) { last = performance.now(); raf = requestAnimationFrame(tick) } }
    const ro = new ResizeObserver(size)
    ro.observe(cv)
    document.addEventListener('visibilitychange', start) // no animation, and no work, while the window is hidden
    size(); start()
    return () => { cancelAnimationFrame(raf); ro.disconnect(); document.removeEventListener('visibilitychange', start) }
  }, [])
  return <canvas ref={ref} className="road-canvas" />
}

function Palm() {
  return (
    <svg viewBox="0 0 110 170" aria-hidden="true">
      <g fill="none" strokeLinecap="round">
        <path d="M52 168 C50 128 56 96 60 62" stroke="#ff2a9d" strokeWidth="11" />
        <path d="M52 168 C50 128 56 96 60 62" stroke="#12042e" strokeWidth="7" />
        {['M60 62 C34 38 12 46 2 70', 'M60 62 C44 30 26 24 8 30', 'M60 62 C64 30 58 14 46 4', 'M60 62 C80 34 96 30 108 42', 'M60 62 C84 50 98 62 102 84'].map((d) => (
          <g key={d}><path d={d} stroke="#ff2a9d" strokeWidth="9" /><path d={d} stroke="#12042e" strokeWidth="5" /></g>))}
      </g>
    </svg>
  )
}

export function Scene() {
  return (
    <div className="scene" aria-hidden="true">
      <div className="sky" />
      <div className="stars" style={{ boxShadow: stars }} />

      <svg className="sun" viewBox="0 0 200 200">
        <defs>
          <linearGradient id="sunfill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#fff36b" /><stop offset=".5" stopColor="#ff9a3c" /><stop offset="1" stopColor="#ff2a9d" />
          </linearGradient>
          <mask id="sunstripes">
            <rect width="200" height="200" fill="#fff" />
            {[118, 136, 152, 166, 178, 188].map((y, i) => <rect key={y} y={y} width="200" height={2 + i * 1.6} fill="#000" />)}
          </mask>
        </defs>
        <circle cx="100" cy="100" r="98" fill="url(#sunfill)" mask="url(#sunstripes)" />
      </svg>

      <svg className="mountains" viewBox="0 0 1600 220" preserveAspectRatio="none">
        <defs><linearGradient id="mfill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#3b0a6e" /><stop offset="1" stopColor="#12042e" /></linearGradient></defs>
        <polygon points="0,220 0,150 90,70 170,130 270,40 380,140 470,95 560,160 640,130 700,220" fill="url(#mfill)" stroke="#19f0ff" strokeWidth="2.5" />
        <polygon points="900,220 960,140 1050,100 1130,150 1230,50 1330,135 1420,85 1510,140 1600,70 1600,220" fill="url(#mfill)" stroke="#19f0ff" strokeWidth="2.5" />
      </svg>
      <div className="horizon" />

      <div className="floor-wrap"><Road /></div>

      {/* roadside palms that rush past, left and right, at staggered distances */}
      {[0, 1, 2, 3].map((i) => (
        <div key={'l' + i} className="palm left" style={{ animationDelay: `${-i * 1.6}s` }}><Palm /></div>))}
      {[0, 1, 2, 3].map((i) => (
        <div key={'r' + i} className="palm right" style={{ animationDelay: `${-i * 1.6 - 0.8}s` }}><Palm /></div>))}

      <div className="vignette" />
    </div>
  )
}
