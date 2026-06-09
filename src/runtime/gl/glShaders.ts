/**
 * GLSL sources for the WebGL2 render core (Phase 1).
 *
 * All passes draw a single attribute-less fullscreen triangle (3 verts) whose
 * positions and UVs are derived from gl_VertexID — no vertex buffer needed.
 * The triangle is oversized (covers [-1,3] in clip space) so a single primitive
 * fills the viewport with no diagonal seam (cheaper than a two-triangle quad).
 */

export const FULLSCREEN_VERT = /* glsl */ `#version 300 es
out vec2 v_uv;
void main() {
  // id0 -> (-1,-1), id1 -> (3,-1), id2 -> (-1,3): one big triangle.
  vec2 pos = vec2(
    (gl_VertexID == 1) ? 3.0 : -1.0,
    (gl_VertexID == 2) ? 3.0 : -1.0
  );
  v_uv = pos * 0.5 + 0.5;          // 0..1 across the screen (top-left origin)
  gl_Position = vec4(pos, 0.0, 1.0);
}
`;

/** Sample one texture. u_flipY=1 mirrors V (for presenting a top-left-origin
 *  texture, e.g. an uploaded video frame, to the bottom-left-origin canvas). */
export const PASSTHROUGH_FRAG = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D u_tex;
uniform float u_flipY;
in vec2 v_uv;
out vec4 fragColor;
void main() {
  vec2 uv = vec2(v_uv.x, mix(v_uv.y, 1.0 - v_uv.y, u_flipY));
  fragColor = texture(u_tex, uv);
}
`;

/**
 * One axis of a separable Gaussian blur, with hardware-bilinear tap merging.
 * A 9-tap Gaussian collapses to 5 texture fetches (center + 2 linear taps each
 * side) by sampling between texels at weighted offsets — mathematically exact,
 * ~2× fewer fetches than discrete sampling (RasterGrid). Run it twice per frame
 * (u_dir = (1,0) then (0,1)) for a full 2D blur at O(2N) instead of O(N²).
 *
 *   u_tex    source texture
 *   u_texel  1.0 / source resolution (per-axis texel size)
 *   u_dir    (1,0) horizontal pass, (0,1) vertical pass
 *   u_radius scales the tap offsets — blur strength (audio-modulatable)
 */
export const BLUR_FRAG = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D u_tex;
uniform vec2 u_texel;
uniform vec2 u_dir;
uniform float u_radius;
in vec2 v_uv;
out vec4 fragColor;
void main() {
  vec2 o1 = u_dir * u_texel * 1.3846153846 * u_radius;
  vec2 o2 = u_dir * u_texel * 3.2307692308 * u_radius;
  vec4 c = texture(u_tex, v_uv) * 0.2270270270;
  c += texture(u_tex, v_uv + o1) * 0.3162162162;
  c += texture(u_tex, v_uv - o1) * 0.3162162162;
  c += texture(u_tex, v_uv + o2) * 0.0702702703;
  c += texture(u_tex, v_uv - o2) * 0.0702702703;
  fragColor = c;
}
`;

/** Procedural animated pattern — no input texture. Used by the self-test to
 *  prove the draw path works even before any source is wired in. */
export const TESTPATTERN_FRAG = /* glsl */ `#version 300 es
precision highp float;
uniform float u_time;
in vec2 v_uv;
out vec4 fragColor;
void main() {
  float g = 0.5 + 0.5 * sin(u_time * 2.0 + v_uv.x * 6.2831853);
  float b = 0.5 + 0.5 * cos(u_time * 1.3 + v_uv.y * 6.2831853);
  fragColor = vec4(v_uv.x, v_uv.y, mix(g, b, 0.5), 1.0);
}
`;
