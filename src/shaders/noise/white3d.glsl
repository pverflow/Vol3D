// --- White / random noise ---
// Returns [0,1] random value per voxel

float noiseEval(vec3 p) {
  return hash13(floor(p) + u_seed * 0.91);
}
