import type { VideoFXSource } from "./LayerNode";

/**
 * ShaderToyNode — GLSL fragment-shader media source.
 *
 * Renders a ShaderToy-style fragment shader onto an offscreen canvas and
 * exposes it as a VideoFXSource so LayerNode picks it up through the same
 * `setVideoFX` path used by vFX nodes. The output layer therefore works
 * identically with both `visualizer` popups and inline `patchViz` contexts.
 *
 * The user-supplied source is expected to define a ShaderToy-compatible
 * entry point:
 *
 *   void mainImage(out vec4 fragColor, in vec2 fragCoord) { ... }
 *
 * Uniforms exposed (ShaderToy-compatible subset):
 *   iResolution (vec3), iTime (float), iTimeDelta (float),
 *   iFrame (int),       iMouse (vec4), iDate (vec4).
 *
 * Multi-pass / iChannel textures are not supported in v1.
 */
export class ShaderToyNode implements VideoFXSource {
  readonly canvas: HTMLCanvasElement;
  private readonly gl: WebGL2RenderingContext;

  private program: WebGLProgram | null = null;
  private buffer:  WebGLBuffer  | null = null;
  private lastGood: string = "";

  private uRes    : WebGLUniformLocation | null = null;
  private uTime   : WebGLUniformLocation | null = null;
  private uDelta  : WebGLUniformLocation | null = null;
  private uFrame  : WebGLUniformLocation | null = null;
  private uMouse  : WebGLUniformLocation | null = null;
  private uDate   : WebGLUniformLocation | null = null;

  private startT    = performance.now() / 1000;
  private lastT     = performance.now() / 1000;
  private frameIdx  = 0;

  // Normalized mouse position (0..1) and last-click position
  private mouseX = 0.5;
  private mouseY = 0.5;
  private clickX = 0;
  private clickY = 0;

  /** Populated if the most recent compile failed; null while shader is good. */
  private _compileError: string | null = null;

  constructor(width = 512, height = 512) {
    this.canvas = document.createElement("canvas");
    this.canvas.width  = width;
    this.canvas.height = height;

    const gl = this.canvas.getContext("webgl2", {
      antialias: false,
      preserveDrawingBuffer: true,
      premultipliedAlpha: false,
    });
    if (!gl) throw new Error("[ShaderToyNode] WebGL2 is not available in this browser");
    this.gl = gl;

    this.buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1,  1, -1, -1,  1,  -1,  1,  1, -1,  1,  1]),
      gl.STATIC_DRAW,
    );

    this.setShaderCode(SHADERTOY_PRESETS.default);
  }

  // ── VideoFXSource interface ──────────────────────────────────────

  get isReady(): boolean { return this.program !== null; }

  process(): void {
    const gl = this.gl;
    const prog = this.program;
    if (!prog) return;

    const now = performance.now() / 1000;
    const delta = now - this.lastT;
    this.lastT = now;
    this.frameIdx++;

    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(prog);

    if (this.uRes)   gl.uniform3f(this.uRes,   this.canvas.width, this.canvas.height, 1);
    if (this.uTime)  gl.uniform1f(this.uTime,  now - this.startT);
    if (this.uDelta) gl.uniform1f(this.uDelta, delta);
    if (this.uFrame) gl.uniform1i(this.uFrame, this.frameIdx);
    if (this.uMouse) {
      gl.uniform4f(
        this.uMouse,
        this.mouseX * this.canvas.width,
        this.mouseY * this.canvas.height,
        this.clickX,
        this.clickY,
      );
    }
    if (this.uDate) {
      const d = new Date();
      const secs = d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds() + d.getMilliseconds() / 1000;
      gl.uniform4f(this.uDate, d.getFullYear(), d.getMonth(), d.getDate(), secs);
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    const aPos = gl.getAttribLocation(prog, "aPos");
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  // ── Public API ───────────────────────────────────────────────────

  /**
   * Replace the fragment-shader source. `source` should define
   * `void mainImage(out vec4 fragColor, in vec2 fragCoord)` (ShaderToy
   * convention); a minimal `main()` is appended by this method. If compile
   * fails the previous good shader stays bound and `getError()` returns
   * the compile log.
   */
  setShaderCode(source: string): boolean {
    const fragSource = buildFragmentShader(source);
    const program = compileProgram(this.gl, VERTEX_SHADER, fragSource);
    if (typeof program === "string") {
      this._compileError = program;
      return false;
    }
    if (this.program) this.gl.deleteProgram(this.program);
    this.program = program;
    this.lastGood = source;
    this._compileError = null;
    this.uRes   = this.gl.getUniformLocation(program, "iResolution");
    this.uTime  = this.gl.getUniformLocation(program, "iTime");
    this.uDelta = this.gl.getUniformLocation(program, "iTimeDelta");
    this.uFrame = this.gl.getUniformLocation(program, "iFrame");
    this.uMouse = this.gl.getUniformLocation(program, "iMouse");
    this.uDate  = this.gl.getUniformLocation(program, "iDate");
    this.resetTime();
    return true;
  }

  getSource(): string { return this.lastGood; }
  getError(): string | null { return this._compileError; }

  /** Applies one of the built-in presets by name. Returns false if not found. */
  setPreset(name: string): boolean {
    const src = SHADERTOY_PRESETS[name];
    if (!src) return false;
    return this.setShaderCode(src);
  }

  /** Normalized (0..1) mouse position. If click coords are omitted, keeps the last ones. */
  setMouse(x: number, y: number, clickX?: number, clickY?: number): void {
    this.mouseX = Math.max(0, Math.min(1, x));
    this.mouseY = Math.max(0, Math.min(1, y));
    if (clickX !== undefined) this.clickX = clickX;
    if (clickY !== undefined) this.clickY = clickY;
  }

  setResolution(w: number, h: number): void {
    if (w <= 0 || h <= 0) return;
    if (this.canvas.width !== w)  this.canvas.width  = w;
    if (this.canvas.height !== h) this.canvas.height = h;
  }

  resetTime(): void {
    this.startT = performance.now() / 1000;
    this.lastT  = this.startT;
    this.frameIdx = 0;
  }

  destroy(): void {
    const gl = this.gl;
    if (this.program) gl.deleteProgram(this.program);
    if (this.buffer)  gl.deleteBuffer(this.buffer);
    this.program = null;
    this.buffer  = null;
  }
}

// ── Shader program helpers ─────────────────────────────────────────

const VERTEX_SHADER = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`;

const FRAGMENT_PRELUDE = `#version 300 es
precision highp float;
precision highp int;

uniform vec3  iResolution;
uniform float iTime;
uniform float iTimeDelta;
uniform int   iFrame;
uniform vec4  iMouse;
uniform vec4  iDate;

out vec4 outColor;
`;

const FRAGMENT_MAIN = `
void main() {
  vec4 color = vec4(0.0);
  mainImage(color, gl_FragCoord.xy);
  outColor = color;
}
`;

function buildFragmentShader(body: string): string {
  return FRAGMENT_PRELUDE + "\n" + body + "\n" + FRAGMENT_MAIN;
}

function compileShader(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader | string {
  const shader = gl.createShader(type);
  if (!shader) return "[ShaderToyNode] gl.createShader returned null";
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? "unknown compile error";
    gl.deleteShader(shader);
    return log;
  }
  return shader;
}

function compileProgram(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram | string {
  const vsh = compileShader(gl, gl.VERTEX_SHADER,   vs);
  if (typeof vsh === "string") return `vertex: ${vsh}`;
  const fsh = compileShader(gl, gl.FRAGMENT_SHADER, fs);
  if (typeof fsh === "string") { gl.deleteShader(vsh); return `fragment: ${fsh}`; }
  const prog = gl.createProgram();
  if (!prog) { gl.deleteShader(vsh); gl.deleteShader(fsh); return "gl.createProgram returned null"; }
  gl.attachShader(prog, vsh);
  gl.attachShader(prog, fsh);
  gl.linkProgram(prog);
  gl.deleteShader(vsh);
  gl.deleteShader(fsh);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(prog) ?? "unknown link error";
    gl.deleteProgram(prog);
    return `link: ${log}`;
  }
  return prog;
}

// ── Built-in presets ───────────────────────────────────────────────

/**
 * Each preset supplies a ShaderToy-style `mainImage` function. The prelude
 * (uniforms + out color) and the trailing `main()` are added automatically.
 */
export const SHADERTOY_PRESETS: Record<string, string> = {
  default: `
void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = fragCoord / iResolution.xy;
  vec3 col = 0.5 + 0.5 * cos(iTime + uv.xyx + vec3(0.0, 2.0, 4.0));
  fragColor = vec4(col, 1.0);
}
`.trim(),

  plasma: `
void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = (fragCoord - 0.5 * iResolution.xy) / iResolution.y;
  float t = iTime * 0.5;
  float v = sin(uv.x * 6.0 + t)
          + sin(uv.y * 8.0 - t * 1.3)
          + sin((uv.x + uv.y) * 5.0 + t * 0.7)
          + sin(length(uv) * 10.0 - t * 2.0);
  v = 0.5 + 0.5 * sin(v);
  vec3 col = vec3(
    0.5 + 0.5 * sin(v * 6.28 + 0.0),
    0.5 + 0.5 * sin(v * 6.28 + 2.0),
    0.5 + 0.5 * sin(v * 6.28 + 4.0)
  );
  fragColor = vec4(col, 1.0);
}
`.trim(),

  warp: `
void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = (fragCoord - 0.5 * iResolution.xy) / iResolution.y;
  float a = atan(uv.y, uv.x);
  float r = length(uv);
  float t = iTime * 0.8;
  float stripes = 0.5 + 0.5 * sin(12.0 * a + t * 4.0);
  float rings   = 0.5 + 0.5 * sin(30.0 * r - t * 6.0);
  float mask    = smoothstep(0.05, 0.0, abs(r - 0.5 + 0.25 * sin(t)));
  vec3 col = mix(vec3(0.05, 0.02, 0.12), vec3(0.9, 0.4, 1.0), stripes * rings);
  col += mask * vec3(1.0, 0.9, 0.6);
  fragColor = vec4(col, 1.0);
}
`.trim(),

  grid: `
void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = fragCoord / iResolution.xy;
  vec2 g = fract(uv * 20.0 + vec2(iTime * 0.2, 0.0)) - 0.5;
  float d = min(abs(g.x), abs(g.y));
  float line = smoothstep(0.05, 0.0, d);
  vec3 col = mix(vec3(0.02, 0.04, 0.08), vec3(0.2, 1.0, 0.6), line);
  fragColor = vec4(col, 1.0);
}
`.trim(),
};

/** Names of the built-in presets, in display order. */
export const SHADERTOY_PRESET_NAMES = Object.keys(SHADERTOY_PRESETS);
