import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseJsfx } from "../src/runtime/jsfx/parser";
import { translateJsfxBody } from "../src/runtime/jsfx/translate";

const rt = {
  sqr: (x: number) => x * x,
  db2ratio: (db: number) => 10 ** (db / 20),
  ratio2db: (ratio: number) => ratio > 0 ? 20 * Math.log10(ratio) : -150,
  memset(mem: Float64Array, start: number, value: number, length: number) {
    const s = Math.max(0, Math.min(mem.length, start | 0));
    const n = Math.max(0, Math.min(mem.length - s, length | 0));
    mem.fill(value, s, s + n);
    return start;
  },
  memcpy(mem: Float64Array, dest: number, src: number, length: number) {
    const d = Math.max(0, Math.min(mem.length, dest | 0));
    const s = Math.max(0, Math.min(mem.length, src | 0));
    const n = Math.max(0, Math.min(mem.length - d, mem.length - s, length | 0));
    if (n > 0) mem.copyWithin(d, s, s + n);
    return dest;
  },
  freembuf: (top: number) => top,
};

function makeState(vars: readonly string[]): Record<string, number> {
  const state: Record<string, number> = {};
  for (const v of vars) state[`u_${v}`] = 0;
  return state;
}

describe("JSFX compatibility tranche", () => {
  it("parses named, file, one-choice, and high-index REAPER slider declarations", () => {
    const parsed = parseJsfx(`
desc: Slider Shapes
slider1:gain_db=-18<-60,0,.1>Gain (dB)
slider2:/ix_keymaps:none:Mapping File
slider6:0<0,0,1{Sine}>LFO Shape
slider7:SL_freeze==0<0,1,1{Off,On}>Freeze
slider8:sl_LowNote=<0,84,1>Low Note
slider96:last=1<0,2,1{Off,On,Auto}>Last
`);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(parsed.program.sliders.map(s => s.index)).toEqual([1, 2, 6, 7, 8, 96]);
    expect(parsed.program.sliders[0]).toMatchObject({
      variableName: "gain_db",
      defaultValue: -18,
      min: -60,
      max: 0,
      step: 0.1,
      label: "Gain (dB)",
    });
    expect(parsed.program.sliders[1]).toMatchObject({
      isFile: true,
      filePath: "/ix_keymaps",
      fileDefault: "none",
      label: "Mapping File",
    });
    expect(parsed.program.sliders[3]).toMatchObject({ variableName: "SL_freeze", defaultValue: 0 });
    expect(parsed.program.sliders[4]).toMatchObject({ variableName: "sl_LowNote", defaultValue: 0 });
  });

  it("translates named slider aliases and dynamic spl(channel) assignment", () => {
    const source = `
slider1:gain_db=-6<-60,12,.1>Gain (dB)

@slider
gain = 10^(gain_db / 20);

@sample
channel = -1;
loop(num_ch,
  channel += 1;
  spl(channel) = spl(channel) * gain;
);
`;
    const parsed = parseJsfx(source);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const opts = { sliders: parsed.program.sliders };
    const slider = translateJsfxBody(parsed.program.sliderBody, opts);
    const sample = translateJsfxBody(parsed.program.sampleBody, opts);
    expect(slider.ok).toBe(true);
    expect(sample.ok).toBe(true);
    if (!slider.ok || !sample.ok) return;

    const state = makeState([...slider.userVars, ...sample.userVars]);
    const sliders = new Float64Array(256);
    sliders[0] = -6;
    const mem = new Float64Array(128);
    const host = { num_ch: 2, samplesblock: 128, tempo: 120, play_state: 1, beat_position: 0, play_position: 0, tsnum: 4, tsdenom: 4, ts_num: 4, ts_denom: 4 };
    const runSlider = new Function("state", "sliders", "srate", "mem", "host", "__rt", slider.js);
    const runSample = new Function("channels", "state", "sliders", "srate", "mem", "host", "__rt", `${sample.js}\nreturn channels;`);

    runSlider(state, sliders, 48_000, mem, host, rt);
    const channels = new Float64Array(64);
    channels[0] = 1;
    channels[1] = 0.5;
    runSample(channels, state, sliders, 48_000, mem, host, rt);

    expect(channels[0]).toBeCloseTo(10 ** (-6 / 20), 6);
    expect(channels[1]).toBeCloseTo(0.5 * 10 ** (-6 / 20), 6);
  });

  it("translates common REAPER constants and helper calls", () => {
    const translated = translateJsfxBody(`
buf = 16;
memset(buf, $x90, 4);
memcpy(buf + 4, buf, 4);
out = sqr(3) + (8 >> 1);
`);
    expect(translated.ok).toBe(true);
    if (!translated.ok) return;

    const state = makeState(translated.userVars);
    const mem = new Float64Array(64);
    const host = { num_ch: 2, samplesblock: 128, tempo: 120, play_state: 1, beat_position: 0, play_position: 0, tsnum: 4, tsdenom: 4, ts_num: 4, ts_denom: 4 };
    const run = new Function("state", "sliders", "srate", "mem", "host", "__rt", translated.js);
    run(state, new Float64Array(256), 48_000, mem, host, rt);

    expect(mem[16]).toBe(0x90);
    expect(mem[20]).toBe(0x90);
    expect(state.u_out).toBe(13);
  });

  it("translates REAPER while bodies whose last expression is the loop condition", () => {
    const translated = translateJsfxBody(`
i = 0;
sum = 0;
while (
  i += 1;
  sum += i;
  i < 4;
);
`);
    expect(translated.ok).toBe(true);
    if (!translated.ok) return;

    const state = makeState(translated.userVars);
    const host = { num_ch: 2, samplesblock: 128, tempo: 120, play_state: 1, beat_position: 0, play_position: 0, tsnum: 4, tsdenom: 4, ts_num: 4, ts_denom: 4 };
    const run = new Function("state", "sliders", "srate", "mem", "host", "__rt", translated.js);
    run(state, new Float64Array(256), 48_000, new Float64Array(64), host, rt);

    expect(state.u_i).toBe(4);
    expect(state.u_sum).toBe(10);
  });

  it("accepts JSFX string buffers and string/file helper stubs", () => {
    const translated = translateJsfxBody(`
sprintf(#menustr, "gain: %f", slider(1));
fh = file_open(0);
file_close(fh);
`);
    expect(translated.ok).toBe(true);
    if (!translated.ok) return;
    expect(translated.js).not.toContain("#menustr");
  });

  it("keeps a representative local REAPER named-slider effect translatable when present", () => {
    const file = join(
      "/Users/user/Library/Application Support/REAPER/Effects",
      "Leandro Facchinetti/Programming Audio Effects/leafac_Bit crusher.jsfx",
    );
    if (!existsSync(file)) return;

    const parsed = parseJsfx(readFileSync(file, "utf8"));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const opts = { sliders: parsed.program.sliders };
    for (const body of [parsed.program.initBody, parsed.program.sliderBody, parsed.program.blockBody, parsed.program.sampleBody]) {
      const translated = translateJsfxBody(body, opts);
      expect(translated.ok).toBe(true);
    }
  });
});
