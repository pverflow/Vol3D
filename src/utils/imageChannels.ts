// Volume slices are read back RGBA from an R8 texture, so G=B=0, A=255.
// For human-viewable image exports, splat red into G and B so density
// renders as grayscale instead of red-on-black.
export function redToGray(rgba: Uint8Array): Uint8Array {
  const out = new Uint8Array(rgba.length)
  for (let i = 0; i < rgba.length; i += 4) {
    const r = rgba[i]
    out[i] = r
    out[i + 1] = r
    out[i + 2] = r
    out[i + 3] = 255
  }
  return out
}
