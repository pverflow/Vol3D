import { ANIMATION_CACHE_BUDGET_BYTES, ANIMATION_CACHE_MAX_FRAMES } from '../../core/constants'

export function computeCacheFrameCount(resolution: number, depth: number): number {
  const bytesPerFrame = resolution * resolution * depth
  const byBudget = Math.floor(ANIMATION_CACHE_BUDGET_BYTES / Math.max(bytesPerFrame, 1))
  return Math.min(ANIMATION_CACHE_MAX_FRAMES, Math.max(0, byBudget))
}
