// --- Voronoi 3D noise ---
// Returns smooth cell distance pattern [0,1]

vec3 _voronoiPoint(vec3 cell) {
  return cell + hash33(cell + u_seed * 0.1);
}

float noiseEval(vec3 p) {
  vec3 ip = floor(p);
  vec3 fp = fract(p);

  float minDist = 999.0;
  float secondDist = 999.0;
  vec3 minPoint = vec3(0.0);

  for (int k = -1; k <= 1; k++) {
    for (int j = -1; j <= 1; j++) {
      for (int i = -1; i <= 1; i++) {
        vec3 cell = ip + vec3(float(i), float(j), float(k));
        vec3 cellPoint = _voronoiPoint(cell);
        float d = length(cellPoint - p);
        if (d < minDist) {
          secondDist = minDist;
          minDist = d;
          minPoint = cellPoint;
        } else if (d < secondDist) {
          secondDist = d;
        }
      }
    }
  }

  // Smooth cell edges
  float edge = secondDist - minDist;
  return clamp(edge * 2.5, 0.0, 1.0);
}
