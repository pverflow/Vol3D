export class WebGLContext {
  readonly gl: WebGL2RenderingContext
  readonly canvas: HTMLCanvasElement

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    const gl = canvas.getContext('webgl2', {
      antialias: false,
      alpha: false,
      depth: false,
      stencil: false,
      powerPreference: 'high-performance',
    }) as WebGL2RenderingContext | null

    if (!gl) {
      throw new Error(
        'WebGL2 is not supported in your browser. Please use Chrome, Edge, or Firefox with a modern GPU.'
      )
    }
    this.gl = gl
    this.setupLostContext()
  }

  private setupLostContext() {
    this.canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault()
      console.warn('[WebGL] Context lost')
    })
    this.canvas.addEventListener('webglcontextrestored', () => {
      console.info('[WebGL] Context restored')
      window.dispatchEvent(new Event('webgl-restored'))
    })
  }

  checkExtensions(): { float32Tex: boolean; floatBlend: boolean } {
    const { gl } = this
    return {
      float32Tex: !!gl.getExtension('EXT_color_buffer_float'),
      floatBlend: !!gl.getExtension('EXT_float_blend'),
    }
  }
}
