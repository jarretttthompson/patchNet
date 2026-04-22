import type { FixtureProfile } from "./FixtureProfile";

/**
 * Starter profile set shipped with PatchNet. These are always available in
 * the Profiles tab regardless of what the user has imported.
 *
 * Default values pick safe "home" positions — pan/tilt centered, shutter open
 * where applicable, dimmer at 0 (fixture won't blast on unexpectedly).
 */
export const BUNDLED_PROFILES: readonly FixtureProfile[] = [
  {
    id: "generic-dimmer-1ch",
    name: "Generic 1ch Dimmer",
    manufacturer: "Generic",
    mode: "1ch",
    channelCount: 1,
    attributes: [
      { name: "dimmer", offset: 0, type: "8bit", default: 0, role: "intensity" },
    ],
  },

  {
    id: "generic-rgb-3ch",
    name: "Generic RGB Par",
    manufacturer: "Generic",
    mode: "3ch",
    channelCount: 3,
    attributes: [
      { name: "red",   offset: 0, type: "8bit", default: 0, role: "color.r" },
      { name: "green", offset: 1, type: "8bit", default: 0, role: "color.g" },
      { name: "blue",  offset: 2, type: "8bit", default: 0, role: "color.b" },
    ],
  },

  {
    id: "generic-rgbw-4ch",
    name: "Generic RGBW Par",
    manufacturer: "Generic",
    mode: "4ch",
    channelCount: 4,
    attributes: [
      { name: "red",   offset: 0, type: "8bit", default: 0, role: "color.r" },
      { name: "green", offset: 1, type: "8bit", default: 0, role: "color.g" },
      { name: "blue",  offset: 2, type: "8bit", default: 0, role: "color.b" },
      { name: "white", offset: 3, type: "8bit", default: 0, role: "color.w" },
    ],
  },

  {
    id: "generic-rgbaw-uv-6ch",
    name: "Generic RGBAW+UV Par",
    manufacturer: "Generic",
    mode: "6ch",
    channelCount: 6,
    attributes: [
      { name: "red",   offset: 0, type: "8bit", default: 0, role: "color.r" },
      { name: "green", offset: 1, type: "8bit", default: 0, role: "color.g" },
      { name: "blue",  offset: 2, type: "8bit", default: 0, role: "color.b" },
      { name: "amber", offset: 3, type: "8bit", default: 0, role: "color.a" },
      { name: "white", offset: 4, type: "8bit", default: 0, role: "color.w" },
      { name: "uv",    offset: 5, type: "8bit", default: 0, role: "color.uv" },
    ],
  },

  /**
   * Chauvet Intimidator Spot 375Z IRC — 9-channel mode.
   * Matches the "09CH" table in the Rev. 7 user manual (pp. 11-12).
   * Select this when the fixture's DMX menu shows CH01 = 9.
   *
   * This mode has no dedicated dimmer — the shutter channel is the only
   * intensity control. 0-3 = closed, 4-7 = open, 8-215 = various strobe
   * patterns, 216-255 = open. Default 0 keeps the fixture dark until the
   * user explicitly raises shutter to a non-strobing open range.
   */
  {
    id: "chauvet-intimidator-spot-375z-irc-9ch",
    name: "Chauvet Intimidator Spot 375Z IRC (9ch)",
    manufacturer: "Chauvet DJ",
    mode: "9ch",
    channelCount: 9,
    attributes: [
      { name: "pan",          offset: 0, type: "8bit", default: 128, role: "position.pan" },
      { name: "tilt",         offset: 1, type: "8bit", default: 128, role: "position.tilt" },
      { name: "color",        offset: 2, type: "8bit", default: 0,   role: "other" },
      { name: "gobo",         offset: 3, type: "8bit", default: 0,   role: "gobo" },
      { name: "goboRotation", offset: 4, type: "8bit", default: 0,   role: "other" },
      { name: "prism",        offset: 5, type: "8bit", default: 0,   role: "prism" },
      { name: "focus",        offset: 6, type: "8bit", default: 128, role: "focus" },
      { name: "shutter",      offset: 7, type: "8bit", default: 0,   role: "shutter" },
      { name: "zoom",         offset: 8, type: "8bit", default: 128, role: "zoom" },
    ],
  },

  /**
   * Chauvet Intimidator Spot 375Z IRC — 15-channel mode.
   * Matches the "15Ch" table in the Rev. 7 user manual (pp. 9-10).
   * Select this when the fixture's DMX menu shows CH01 = 15.
   *
   * Defaults: pan/tilt centered (32768 on the 16-bit range), shutter open
   * (255 is in the manual's "Open" range 216-255), dimmer 0. `defaults`
   * therefore leaves the fixture in a safe, dark, centered state — raising
   * `dimmer` immediately lights. Ch13 is "Function" (reset/blackout
   * triggers); ch14 is "Movement Macros"; ch15 is zoom.
   */
  {
    id: "chauvet-intimidator-spot-375z-irc-15ch",
    name: "Chauvet Intimidator Spot 375Z IRC (15ch)",
    manufacturer: "Chauvet DJ",
    mode: "15ch",
    channelCount: 15,
    attributes: [
      { name: "pan",          offset: 0,  fineOffset: 1, type: "16bit", default: 32768, role: "position.pan" },
      { name: "tilt",         offset: 2,  fineOffset: 3, type: "16bit", default: 32768, role: "position.tilt" },
      { name: "speed",        offset: 4,                 type: "8bit",  default: 0,     role: "speed" },
      { name: "color",        offset: 5,                 type: "8bit",  default: 0,     role: "other" },
      { name: "gobo",         offset: 6,                 type: "8bit",  default: 0,     role: "gobo" },
      { name: "goboRotation", offset: 7,                 type: "8bit",  default: 0,     role: "other" },
      { name: "prism",        offset: 8,                 type: "8bit",  default: 0,     role: "prism" },
      { name: "focus",        offset: 9,                 type: "8bit",  default: 128,   role: "focus" },
      { name: "dimmer",       offset: 10,                type: "8bit",  default: 0,     role: "intensity" },
      { name: "shutter",      offset: 11,                type: "8bit",  default: 255,   role: "shutter" },
      { name: "function",     offset: 12,                type: "8bit",  default: 0,     role: "other" },
      { name: "macro",        offset: 13,                type: "8bit",  default: 0,     role: "macro" },
      { name: "zoom",         offset: 14,                type: "8bit",  default: 128,   role: "zoom" },
    ],
  },
];
