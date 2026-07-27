import type { Layer } from '../types/index'
import { RAMP_PRESETS } from '../core/colorRamp'

// Old presets (pre-VFX-2) have no per-layer colorRamp (and a now-removed
// `temperature`). Default a missing ramp to Fire so existing scenes still
// look like fire. Idempotent.
export function migrateLayer(layer: Layer): Layer {
  if (layer.colorRamp) return layer
  return { ...layer, colorRamp: { enabled: true, stops: [...RAMP_PRESETS.fire] } }
}
