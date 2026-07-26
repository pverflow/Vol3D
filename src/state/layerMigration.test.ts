import { describe, it, expect } from 'vitest'
import { migrateLayer } from './layerMigration'
import { defaultLayer } from './AppState'
import { RAMP_PRESETS } from '../core/colorRamp'
import type { Layer } from '../types/index'

describe('migrateLayer', () => {
  it('adds a Fire colorRamp to an old-preset layer that lacks one', () => {
    const old = { ...defaultLayer() } as Partial<Layer>
    delete old.colorRamp
    const migrated = migrateLayer(old as Layer)
    expect(migrated.colorRamp).toEqual({ enabled: true, stops: RAMP_PRESETS.fire })
  })

  it('leaves an existing colorRamp unchanged (idempotent)', () => {
    const layer = { ...defaultLayer(), colorRamp: { enabled: false, stops: [...RAMP_PRESETS.smoke] } }
    const migrated = migrateLayer(layer)
    expect(migrated).toBe(layer)
    expect(migrated.colorRamp).toEqual({ enabled: false, stops: RAMP_PRESETS.smoke })
  })
})
