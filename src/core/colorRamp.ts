// Density -> RGBA transfer function (color ramp) for the preview/bake path
// (VFX-0 Task 3). Pure, deterministic LUT builder — no GL/DOM deps so it's
// unit-testable and reusable from Viewport (texture upload) and export/bake
// code alike. The R8 density volume itself is never touched; this only maps
// the already-shaped [0,1] density (see volumeShaping.ts) to a color+opacity
// at preview/render time.

export interface RampStop {
  t: number
  color: [number, number, number]
  alpha: number
}

export interface ColorRamp {
  enabled: boolean
  stops: RampStop[]
}

function clampByte(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)))
}

function lerp(a: number, b: number, f: number): number {
  return clampByte(a + (b - a) * f)
}

// Sample the (sorted) stop list at t, clamping to the first/last stop
// outside their range and linearly interpolating color+alpha between the
// bracketing pair otherwise.
function sampleStops(stops: RampStop[], t: number): [number, number, number, number] {
  const first = stops[0]
  if (t <= first.t) return [first.color[0], first.color[1], first.color[2], first.alpha]

  const last = stops[stops.length - 1]
  if (t >= last.t) return [last.color[0], last.color[1], last.color[2], last.alpha]

  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i]
    const b = stops[i + 1]
    if (t >= a.t && t <= b.t) {
      const span = Math.max(b.t - a.t, 1e-6)
      const f = (t - a.t) / span
      return [
        lerp(a.color[0], b.color[0], f),
        lerp(a.color[1], b.color[1], f),
        lerp(a.color[2], b.color[2], f),
        lerp(a.alpha, b.alpha, f),
      ]
    }
  }
  return [last.color[0], last.color[1], last.color[2], last.alpha]
}

// Build a `size`-texel RGBA8 LUT (size*4 bytes) from `ramp.stops`, ready to
// upload as a 2D texture row (texel i <-> t = i/(size-1)). Ignores
// `ramp.enabled` — that's a render-time gate (u_colorRampEnabled), not a LUT
// concern. Empty stop list -> fully transparent black LUT.
export function buildRampLUT(ramp: ColorRamp, size = 256): Uint8Array {
  const lut = new Uint8Array(size * 4)
  if (ramp.stops.length === 0) return lut

  const stops = [...ramp.stops].sort((a, b) => a.t - b.t)
  for (let i = 0; i < size; i++) {
    const t = i / (size - 1)
    const [r, g, b, a] = sampleStops(stops, t)
    const o = i * 4
    lut[o] = r
    lut[o + 1] = g
    lut[o + 2] = b
    lut[o + 3] = a
  }
  return lut
}

export const RAMP_PRESETS: Record<'fire' | 'smoke' | 'explosion', RampStop[]> = {
  fire: [
    { t: 0.0, color: [0, 0, 0], alpha: 0 },
    { t: 0.25, color: [128, 0, 0], alpha: 60 },
    { t: 0.5, color: [255, 80, 0], alpha: 140 },
    { t: 0.75, color: [255, 200, 0], alpha: 200 },
    { t: 1.0, color: [255, 255, 255], alpha: 255 },
  ],
  smoke: [
    { t: 0.0, color: [40, 40, 40], alpha: 0 },
    { t: 0.5, color: [120, 120, 120], alpha: 120 },
    { t: 1.0, color: [200, 200, 200], alpha: 200 },
  ],
  explosion: [
    { t: 0.0, color: [20, 20, 20], alpha: 0 },
    { t: 0.3, color: [90, 90, 90], alpha: 90 },
    { t: 0.55, color: [255, 160, 40], alpha: 210 },
    { t: 0.75, color: [255, 255, 200], alpha: 255 },
    { t: 1.0, color: [255, 255, 255], alpha: 255 },
  ],
}
