// --- Blend mode functions ---
// All operate on scalar values in [0,1]

float blendNormal(float base, float layer) { return layer; }
float blendAdd(float base, float layer) { return clamp(base + layer, 0.0, 1.0); }
float blendMultiply(float base, float layer) { return base * layer; }
float blendScreen(float base, float layer) { return 1.0 - (1.0 - base) * (1.0 - layer); }
float blendOverlay(float base, float layer) {
  return base < 0.5
    ? 2.0 * base * layer
    : 1.0 - 2.0 * (1.0 - base) * (1.0 - layer);
}
float blendSubtract(float base, float layer) { return clamp(base - layer, 0.0, 1.0); }

// Apply blend mode by index: 0=normal,1=add,2=multiply,3=screen,4=overlay,5=subtract
float applyBlend(int mode, float base, float layer) {
  if (mode == 0) return blendNormal(base, layer);
  if (mode == 1) return blendAdd(base, layer);
  if (mode == 2) return blendMultiply(base, layer);
  if (mode == 3) return blendScreen(base, layer);
  if (mode == 4) return blendOverlay(base, layer);
  if (mode == 5) return blendSubtract(base, layer);
  return layer;
}
