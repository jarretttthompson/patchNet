import { FULLSCREEN_VERT, PASSTHROUGH_FRAG } from "./glShaders";

/** A linked program plus a memoized uniform-location lookup. */
export interface GLProgram {
  readonly program: WebGLProgram;
  uniform(name: string): WebGLUniformLocation | null;
}

/** An off-screen render target: a color texture + its framebuffer. */
export interface RenderTarget {
  readonly tex: WebGLTexture;
  readonly fbo: WebGLFramebuffer;
  readonly w: number;
  readonly h: number;
}

/**
 * GLContext — the shared WebGL2 surface for the visualizer render core (Phase 1).
 *
 * Owns the context, a bound VAO (required for attribute-less fullscreen draws),
 * a program cache, and pooled render targets. Effects render fullscreen-triangle
 * passes into pooled targets and ping-pong between them; only the final pass
 * resolves to the canvas. See [[concepts/glrendercontext-architecture]].
 */
export class GLContext {
  readonly gl: WebGL2RenderingContext;
  private readonly vao: WebGLVertexArrayObject;
  private readonly programs = new Map<string, GLProgram>();
  private _lost = false;

  constructor(
    readonly canvas: HTMLCanvasElement,
    opts: { preserveDrawingBuffer?: boolean } = {},
  ) {
    const gl = canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      // When the canvas is sampled via drawImage() into a 2D compositor (as the
      // glBlur node does), preserve the buffer so the rendered frame is still
      // readable after the draw. For directly-presented canvases, leave false.
      preserveDrawingBuffer: opts.preserveDrawingBuffer ?? false,
      powerPreference: "high-performance",
    });
    if (!gl) throw new Error("[GLContext] WebGL2 unavailable");
    this.gl = gl;

    canvas.addEventListener("webglcontextlost", (e) => {
      e.preventDefault();
      this._lost = true;
    });
    canvas.addEventListener("webglcontextrestored", () => {
      this.programs.clear();
      this._lost = false;
    });

    // A bound VAO is required for attribute-less drawArrays in WebGL2.
    const vao = gl.createVertexArray();
    if (!vao) throw new Error("[GLContext] could not create VAO");
    this.vao = vao;
    gl.bindVertexArray(vao);
  }

  get isLost(): boolean {
    return this._lost || this.gl.isContextLost();
  }

  /** Resize the drawing buffer to match a desired pixel size. */
  resize(w: number, h: number): void {
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
  }

  // ── Programs ─────────────────────────────────────────────────────────

  /** Compile+link (or return cached) a program keyed by `key`. */
  getProgram(key: string, fragSrc: string, vertSrc = FULLSCREEN_VERT): GLProgram {
    const cached = this.programs.get(key);
    if (cached) return cached;
    const gl = this.gl;
    const vs = this.compile(gl.VERTEX_SHADER, vertSrc);
    const fs = this.compile(gl.FRAGMENT_SHADER, fragSrc);
    const program = gl.createProgram();
    if (!program) throw new Error("[GLContext] createProgram failed");
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    // Shaders can be detached/deleted once linked.
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program);
      gl.deleteProgram(program);
      throw new Error(`[GLContext] program link failed (${key}): ${log}`);
    }
    const locs = new Map<string, WebGLUniformLocation | null>();
    const wrapped: GLProgram = {
      program,
      uniform: (name) => {
        if (locs.has(name)) return locs.get(name)!;
        const loc = gl.getUniformLocation(program, name);
        locs.set(name, loc);
        return loc;
      },
    };
    this.programs.set(key, wrapped);
    return wrapped;
  }

  private compile(type: number, src: string): WebGLShader {
    const gl = this.gl;
    const sh = gl.createShader(type);
    if (!sh) throw new Error("[GLContext] createShader failed");
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      throw new Error(`[GLContext] shader compile failed: ${log}`);
    }
    return sh;
  }

  // ── Textures & targets ───────────────────────────────────────────────

  /** Create an immutable RGBA8 (or given format) render target. */
  createTarget(w: number, h: number, internalFormat?: number): RenderTarget {
    const gl = this.gl;
    const fmt = internalFormat ?? gl.RGBA8;
    const tex = gl.createTexture();
    if (!tex) throw new Error("[GLContext] createTexture failed");
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, fmt, w, h);
    this.setTexParams();
    const fbo = gl.createFramebuffer();
    if (!fbo) throw new Error("[GLContext] createFramebuffer failed");
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error(`[GLContext] framebuffer incomplete: 0x${status.toString(16)}`);
    }
    return { tex, fbo, w, h };
  }

  deleteTarget(t: RenderTarget): void {
    this.gl.deleteTexture(t.tex);
    this.gl.deleteFramebuffer(t.fbo);
  }

  private setTexParams(): void {
    const gl = this.gl;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  /** Bind a texture to a unit (call before setting its sampler uniform). */
  bindTexture(unit: number, tex: WebGLTexture): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
  }

  // ── Drawing ──────────────────────────────────────────────────────────

  /**
   * Run one fullscreen-triangle pass. `target=null` draws to the canvas.
   * Bind input textures + set uniforms inside `setup` (called after useProgram).
   */
  draw(
    target: RenderTarget | null,
    program: GLProgram,
    setup?: (p: GLProgram) => void,
  ): void {
    const gl = this.gl;
    const w = target ? target.w : this.canvas.width;
    const h = target ? target.h : this.canvas.height;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fbo : null);
    gl.viewport(0, 0, w, h);
    gl.useProgram(program.program);
    setup?.(program);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /** Present a top-left-origin texture (e.g. an uploaded frame) to the canvas. */
  present(tex: WebGLTexture, flipY = true): void {
    const prog = this.getProgram("passthrough", PASSTHROUGH_FRAG);
    this.draw(null, prog, (p) => {
      this.bindTexture(0, tex);
      this.gl.uniform1i(p.uniform("u_tex"), 0);
      this.gl.uniform1f(p.uniform("u_flipY"), flipY ? 1 : 0);
    });
  }

  destroy(): void {
    const gl = this.gl;
    for (const { program } of this.programs.values()) gl.deleteProgram(program);
    this.programs.clear();
    gl.deleteVertexArray(this.vao);
  }
}

/**
 * Wraps a single source texture (video / canvas / image) with resize-aware
 * uploads: immutable `texStorage2D` storage, in-place `texSubImage2D` per frame,
 * reallocated only when the source dimensions change.
 */
export class GLSourceTexture {
  private _tex: WebGLTexture;
  private _w = 0;
  private _h = 0;

  constructor(private readonly gl: WebGL2RenderingContext) {
    const tex = gl.createTexture();
    if (!tex) throw new Error("[GLSourceTexture] createTexture failed");
    this._tex = tex;
  }

  get tex(): WebGLTexture { return this._tex; }
  get width(): number { return this._w; }
  get height(): number { return this._h; }

  /** Upload one frame. `sw`/`sh` are the source's intrinsic pixel size. */
  update(source: TexImageSource, sw: number, sh: number): void {
    if (sw <= 0 || sh <= 0) return;
    const gl = this.gl;
    if (sw !== this._w || sh !== this._h) {
      // Immutable storage can't be re-sized — recreate the texture.
      gl.deleteTexture(this._tex);
      const tex = gl.createTexture();
      if (!tex) throw new Error("[GLSourceTexture] createTexture failed");
      this._tex = tex;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, sw, sh);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this._w = sw;
      this._h = sh;
    } else {
      gl.bindTexture(gl.TEXTURE_2D, this._tex);
    }
    // No UNPACK_FLIP_Y — flip is handled in the present shader.
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, source);
  }

  destroy(): void {
    this.gl.deleteTexture(this._tex);
  }
}
