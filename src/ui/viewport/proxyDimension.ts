import { PROXY_RES_FACTOR, PROXY_MIN_RES } from '../../core/constants'

// Low-res drag proxy (Task 4): max(PROXY_MIN_RES, floor(n / PROXY_RES_FACTOR)),
// clamped to never exceed n itself (a custom depth below PROXY_MIN_RES, e.g.
// 16 slices, must not produce a "proxy" bigger than the real thing).
// Applied per-axis (resolution and depth independently) to cut generation
// cost on every axis. The PROXY_MIN_RES floor can clamp one axis but not the
// other (e.g. resolution 128 + depth 32 -> proxy 64 + 32), so the proxy's
// aspect ratio may differ from the full volume's during drag — a cosmetic
// skew only, not a correctness issue.
export function proxyDimension(n: number): number {
  return Math.min(n, Math.max(PROXY_MIN_RES, Math.floor(n / PROXY_RES_FACTOR)))
}
