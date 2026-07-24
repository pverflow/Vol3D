import { PROXY_RES_FACTOR, PROXY_MIN_RES } from '../../core/constants'

// Low-res drag proxy (Task 4): max(PROXY_MIN_RES, floor(n / PROXY_RES_FACTOR)),
// clamped to never exceed n itself (a custom depth below PROXY_MIN_RES, e.g.
// 16 slices, must not produce a "proxy" bigger than the real thing).
// Applied to both resolution and depth so the proxy volume keeps the full
// volume's aspect ratio while cutting generation cost on every axis.
export function proxyDimension(n: number): number {
  return Math.min(n, Math.max(PROXY_MIN_RES, Math.floor(n / PROXY_RES_FACTOR)))
}
