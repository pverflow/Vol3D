// Shader snippet imports (raw strings via Vite)
import mathUtils from '../../shaders/common/math_utils.glsl?raw'
import hashGlsl from '../../shaders/common/hash.glsl?raw'
import blendModes from '../../shaders/common/blend_modes.glsl?raw'

import perlin3d from '../../shaders/noise/perlin3d.glsl?raw'
import simplex3d from '../../shaders/noise/simplex3d.glsl?raw'
import worley3d from '../../shaders/noise/worley3d.glsl?raw'
import voronoi3d from '../../shaders/noise/voronoi3d.glsl?raw'
import value3d from '../../shaders/noise/value3d.glsl?raw'
import white3d from '../../shaders/noise/white3d.glsl?raw'
import fbmGlsl from '../../shaders/noise/fbm.glsl?raw'
import sdfSphere from '../../shaders/noise/sdf_sphere.glsl?raw'
import sdfBox from '../../shaders/noise/sdf_box.glsl?raw'
import sdfCone from '../../shaders/noise/sdf_cone.glsl?raw'

import domainWarp from '../../shaders/distortion/domain_warp.glsl?raw'
import curlGlsl from '../../shaders/distortion/curl.glsl?raw'
import swirlGlsl from '../../shaders/distortion/swirl.glsl?raw'
import polarGlsl from '../../shaders/distortion/polar.glsl?raw'

import layerGenFrag from '../../shaders/generation/layer_gen.frag.glsl?raw'
import compositeFrag from '../../shaders/generation/composite.frag.glsl?raw'

import fullscreenVert from '../../shaders/common/fullscreen.vert.glsl?raw'
import raymarchVert from '../../shaders/preview/raymarch.vert.glsl?raw'
import raymarchFrag from '../../shaders/preview/raymarch.frag.glsl?raw'
import sliceFrag from '../../shaders/preview/slice.frag.glsl?raw'
import projectionFrag from '../../shaders/preview/projection.frag.glsl?raw'

import { NoiseType, DistortionType, isSdfSource } from '../../types/index'
import { SHADING_GLSL } from '../volumeShaping'
import { HEAT_ACCUM_GLSL } from '../heatAccum'

const IDENTITY_DISTORTION = `
vec3 applyDistortion(vec3 p) { return p; }
`

const NOISE_SNIPPETS: Record<NoiseType, string> = {
  [NoiseType.Perlin]: perlin3d,
  [NoiseType.Simplex]: simplex3d,
  [NoiseType.Worley]: worley3d,
  [NoiseType.Voronoi]: voronoi3d,
  [NoiseType.Value]: value3d,
  [NoiseType.White]: white3d,
  [NoiseType.FBM]: '',  // handled specially
  [NoiseType.SdfSphere]: sdfSphere,
  [NoiseType.SdfBox]: sdfBox,
  [NoiseType.SdfCone]: sdfCone,
}

const DISTORTION_SNIPPETS: Record<DistortionType, string> = {
  [DistortionType.None]: IDENTITY_DISTORTION,
  [DistortionType.DomainWarp]: domainWarp,
  [DistortionType.Curl]: curlGlsl,
  [DistortionType.Swirl]: swirlGlsl,
  [DistortionType.Polar]: polarGlsl,
}

// Distortions whose GLSL calls _baseNoiseEval and thus need the alias
// injected when the layer noise is not FBM.
const DISTORTION_NEEDS_BASE_NOISE = new Set<DistortionType>([
  DistortionType.DomainWarp,
  DistortionType.Curl,
])

export interface CompiledProgram {
  program: WebGLProgram
  uniforms: Map<string, WebGLUniformLocation | null>
}

export class ShaderCompiler {
  private gl: WebGL2RenderingContext
  private cache = new Map<string, CompiledProgram>()

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl
  }

  // Assemble generation shader for a given noise type, FBM base, and distortion
  buildLayerGenShader(
    noiseType: NoiseType,
    fbmBase: NoiseType,
    distortion: DistortionType
  ): CompiledProgram {
    const key = `gen_${noiseType}_${fbmBase}_${distortion}`
    if (this.cache.has(key)) return this.cache.get(key)!

    const commonHeader = `#version 300 es\nprecision highp float;\n`
    // Compile-time only: SDF sources (a single localized shape) need the
    // main()/sampleNoiseAtVolumePos #ifdef SDF_SOURCE branch in layer_gen so
    // they render centered and without the periodic-noise tiling/domain-
    // animation that would otherwise smear/cancel them. Zero runtime cost,
    // and the #else branch that non-SDF noise types take is untouched.
    const sdfDefine = isSdfSource(noiseType) ? '#define SDF_SOURCE\n' : ''
    const earlyUniforms = `uniform float u_seed;\n`

    // Build noise section
    let noiseSection = ''
    if (noiseType === NoiseType.FBM) {
      // For FBM, load base noise first (renamed to _baseNoiseEval), then FBM wrapper
      const baseSnippet = NOISE_SNIPPETS[fbmBase]
        .replace(/float noiseEval\(/g, 'float _baseNoiseEval(')
      noiseSection = baseSnippet + '\n' + fbmGlsl
    } else {
      noiseSection = NOISE_SNIPPETS[noiseType]
    }

    // For distortion that uses _baseNoiseEval (domain_warp, curl), we need a _baseNoiseEval alias
    const distortionSection = DISTORTION_SNIPPETS[distortion]
    if (DISTORTION_NEEDS_BASE_NOISE.has(distortion) && noiseType !== NoiseType.FBM) {
      // Rename the noise function to _baseNoiseEval and add noiseEval as alias
      noiseSection = noiseSection.replace(/float noiseEval\(/g, 'float _baseNoiseEval(')
        + '\nfloat noiseEval(vec3 p) { return _baseNoiseEval(p); }\n'
    }

    const fragSource = [
      commonHeader,
      sdfDefine,
      earlyUniforms,
      mathUtils,
      hashGlsl,
      noiseSection,
      distortionSection,
      blendModes,
      // Strip the version line since we already have it
      layerGenFrag
        .replace('#version 300 es', '')
        .replace('precision highp float;', '')
        .replace('uniform float u_seed;', ''),
    ].join('\n')

    const vert = this.compile(fullscreenVert, this.gl.VERTEX_SHADER)
    const frag = this.compile(fragSource, this.gl.FRAGMENT_SHADER)
    const prog = this.link(vert, frag, `LayerGen_${key}`)
    const compiled = { program: prog, uniforms: this.collectUniforms(prog) }
    this.cache.set(key, compiled)
    return compiled
  }

  private buildSimpleProgram(key: string, vertSrc: string, fragSrc: string, name: string): CompiledProgram {
    const cached = this.cache.get(key)
    if (cached) return cached
    const vert = this.compile(vertSrc, this.gl.VERTEX_SHADER)
    const frag = this.compile(fragSrc, this.gl.FRAGMENT_SHADER)
    const prog = this.link(vert, frag, name)
    const compiled = { program: prog, uniforms: this.collectUniforms(prog) }
    this.cache.set(key, compiled)
    return compiled
  }

  buildCompositeShader(): CompiledProgram {
    const header = `#version 300 es\nprecision highp float;\n`
    const frag = [header, blendModes, HEAT_ACCUM_GLSL, compositeFrag.replace('#version 300 es', '').replace('precision highp float;', '')].join('\n')
    return this.buildSimpleProgram('composite', fullscreenVert, frag, 'Composite')
  }

  buildRaymarchShader(): CompiledProgram {
    return this.buildSimpleProgram('raymarch', raymarchVert, this.injectShading(raymarchFrag), 'Raymarch')
  }

  buildSliceShader(): CompiledProgram {
    return this.buildSimpleProgram('slice', fullscreenVert, this.injectShading(sliceFrag), 'Slice')
  }

  buildProjectionShader(): CompiledProgram {
    return this.buildSimpleProgram('projection', fullscreenVert, this.injectShading(projectionFrag), 'Projection')
  }

  // Concatenate SHADING_GLSL (applyDensityShaping) right after the version/
  // precision preamble shared by all three preview fragment shaders, so they
  // can apply cutoff/contrast to sampled density at preview time (Task 3).
  private injectShading(source: string): string {
    return source.replace(
      /(#version 300 es\s*\nprecision highp float;\s*\nprecision highp sampler3D;\s*\n)/,
      `$1\n${SHADING_GLSL}\n`
    )
  }

  private compile(source: string, type: number): WebGLShader {
    const { gl } = this
    const shader = gl.createShader(type)!
    gl.shaderSource(shader, source)
    gl.compileShader(shader)
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const info = gl.getShaderInfoLog(shader) ?? 'Unknown error'
      const typeName = type === gl.VERTEX_SHADER ? 'VERTEX' : 'FRAGMENT'
      // Annotate source with line numbers for debugging
      const annotated = source.split('\n').map((l, i) => `${i + 1}: ${l}`).join('\n')
      console.error(`[Shader] ${typeName} compile error:\n${info}\n\nSource:\n${annotated}`)
      gl.deleteShader(shader)
      throw new Error(`${typeName} shader compile failed: ${info}`)
    }
    return shader
  }

  private link(vert: WebGLShader, frag: WebGLShader, name: string): WebGLProgram {
    const { gl } = this
    const program = gl.createProgram()!
    gl.attachShader(program, vert)
    gl.attachShader(program, frag)
    gl.linkProgram(program)
    gl.deleteShader(vert)
    gl.deleteShader(frag)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const info = gl.getProgramInfoLog(program) ?? 'Unknown error'
      console.error(`[Shader] Program "${name}" link error: ${info}`)
      throw new Error(`Shader program link failed: ${info}`)
    }
    return program
  }

  private collectUniforms(program: WebGLProgram): Map<string, WebGLUniformLocation | null> {
    const { gl } = this
    const uniforms = new Map<string, WebGLUniformLocation | null>()
    const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) as number
    for (let i = 0; i < count; i++) {
      const info = gl.getActiveUniform(program, i)
      if (!info) continue
      // Array uniforms report a name like "u_foo[0]"; normalize to "u_foo".
      const name = info.name.replace(/\[0\]$/, '')
      uniforms.set(name, gl.getUniformLocation(program, name))
    }
    return uniforms
  }

  setUniform(prog: CompiledProgram, name: string, ...args: number[]): void {
    const loc = prog.uniforms.get(name)
    if (loc === undefined || loc === null) return
    const { gl } = this
    switch (args.length) {
      case 1: gl.uniform1f(loc, args[0]); break
      case 2: gl.uniform2f(loc, args[0], args[1]); break
      case 3: gl.uniform3f(loc, args[0], args[1], args[2]); break
      case 4: gl.uniform4f(loc, args[0], args[1], args[2], args[3]); break
    }
  }

  setUniformi(prog: CompiledProgram, name: string, ...args: number[]): void {
    const loc = prog.uniforms.get(name)
    if (loc === undefined || loc === null) return
    const { gl } = this
    switch (args.length) {
      case 1: gl.uniform1i(loc, args[0]); break
      case 2: gl.uniform2i(loc, args[0], args[1]); break
      case 3: gl.uniform3i(loc, args[0], args[1], args[2]); break
    }
  }

  setUniformMat3(prog: CompiledProgram, name: string, matrix: Float32Array): void {
    const loc = prog.uniforms.get(name)
    if (loc === undefined || loc === null) return
    this.gl.uniformMatrix3fv(loc, false, matrix)
  }

  setUniformBool(prog: CompiledProgram, name: string, value: boolean): void {
    const loc = prog.uniforms.get(name)
    if (loc === undefined || loc === null) return
    this.gl.uniform1i(loc, value ? 1 : 0)
  }

  invalidateCache() {
    for (const prog of this.cache.values()) {
      this.gl.deleteProgram(prog.program)
    }
    this.cache.clear()
  }
}
