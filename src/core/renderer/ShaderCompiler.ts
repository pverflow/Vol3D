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

import { NoiseType, DistortionType } from '../../types/index'

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
}

const DISTORTION_SNIPPETS: Record<DistortionType, string> = {
  [DistortionType.None]: IDENTITY_DISTORTION,
  [DistortionType.DomainWarp]: domainWarp,
  [DistortionType.Curl]: curlGlsl,
  [DistortionType.Swirl]: swirlGlsl,
  [DistortionType.Polar]: polarGlsl,
}

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
    if ((distortion === DistortionType.DomainWarp || distortion === DistortionType.Curl)
        && noiseType !== NoiseType.FBM) {
      // Rename the noise function to _baseNoiseEval and add noiseEval as alias
      noiseSection = noiseSection.replace(/float noiseEval\(/g, 'float _baseNoiseEval(')
        + '\nfloat noiseEval(vec3 p) { return _baseNoiseEval(p); }\n'
    }

    const fragSource = [
      commonHeader,
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
    const compiled = { program: prog, uniforms: this.collectUniforms(prog, fragSource) }
    this.cache.set(key, compiled)
    return compiled
  }

  buildCompositeShader(): CompiledProgram {
    const key = 'composite'
    if (this.cache.has(key)) return this.cache.get(key)!
    const commonHeader = `#version 300 es\nprecision highp float;\n`
    const fragSource = [
      commonHeader,
      blendModes,
      compositeFrag.replace('#version 300 es', '').replace('precision highp float;', ''),
    ].join('\n')
    const vert = this.compile(fullscreenVert, this.gl.VERTEX_SHADER)
    const frag = this.compile(fragSource, this.gl.FRAGMENT_SHADER)
    const prog = this.link(vert, frag, 'Composite')
    const compiled = { program: prog, uniforms: this.collectUniforms(prog, fragSource) }
    this.cache.set(key, compiled)
    return compiled
  }

  buildRaymarchShader(): CompiledProgram {
    const key = 'raymarch'
    if (this.cache.has(key)) return this.cache.get(key)!
    const vert = this.compile(raymarchVert, this.gl.VERTEX_SHADER)
    const frag = this.compile(raymarchFrag, this.gl.FRAGMENT_SHADER)
    const prog = this.link(vert, frag, 'Raymarch')
    const compiled = { program: prog, uniforms: this.collectUniforms(prog, raymarchFrag) }
    this.cache.set(key, compiled)
    return compiled
  }

  buildSliceShader(): CompiledProgram {
    const key = 'slice'
    if (this.cache.has(key)) return this.cache.get(key)!
    const vert = this.compile(fullscreenVert, this.gl.VERTEX_SHADER)
    const frag = this.compile(sliceFrag, this.gl.FRAGMENT_SHADER)
    const prog = this.link(vert, frag, 'Slice')
    const compiled = { program: prog, uniforms: this.collectUniforms(prog, sliceFrag) }
    this.cache.set(key, compiled)
    return compiled
  }

  buildProjectionShader(): CompiledProgram {
    const key = 'projection'
    if (this.cache.has(key)) return this.cache.get(key)!
    const vert = this.compile(fullscreenVert, this.gl.VERTEX_SHADER)
    const frag = this.compile(projectionFrag, this.gl.FRAGMENT_SHADER)
    const prog = this.link(vert, frag, 'Projection')
    const compiled = { program: prog, uniforms: this.collectUniforms(prog, projectionFrag) }
    this.cache.set(key, compiled)
    return compiled
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

  private collectUniforms(program: WebGLProgram, source: string): Map<string, WebGLUniformLocation | null> {
    const { gl } = this
    const uniforms = new Map<string, WebGLUniformLocation | null>()
    // Extract uniform names from source via regex
    const regex = /uniform\s+\S+\s+(\w+)/g
    let match: RegExpExecArray | null
    while ((match = regex.exec(source)) !== null) {
      const name = match[1]
      if (!uniforms.has(name)) {
        uniforms.set(name, gl.getUniformLocation(program, name))
      }
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

  setUniformMat4(prog: CompiledProgram, name: string, matrix: Float32Array): void {
    const loc = prog.uniforms.get(name)
    if (loc === undefined || loc === null) return
    this.gl.uniformMatrix4fv(loc, false, matrix)
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
