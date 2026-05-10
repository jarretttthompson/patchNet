/**
 * Bundled reference patches surfaced via the right-click menu on specific
 * object types. Each entry serializes to the on-disk patch format that
 * ScratchTabSession can deserialize.
 *
 * Tab id is stable per reference so reopening the menu item reuses the
 * existing tab rather than spawning duplicates.
 */

export interface ReferencePatch {
  label: string;
  tabId: string;
  text: string;
}

const ROUTE_REFERENCE_PATCH: ReferencePatch = {
  label: "route reference",
  tabId: "ref-route",
  text: [
    "#N canvas;",
    "#X obj 60 30 comment route reference: click any message above to see how it routes;",
    "#X size 0 720 24;",
    "#X obj 80 100 message play 60;",
    "#X name 1 msg_play;",
    "#X obj 220 100 message stop;",
    "#X name 2 msg_stop;",
    "#X obj 340 100 message vol 80;",
    "#X name 3 msg_vol;",
    "#X obj 480 100 message 42;",
    "#X name 4 msg_int;",
    "#X obj 580 100 message hello world;",
    "#X name 5 msg_other;",
    "#X obj 260 200 route play stop vol int;",
    "#X name 6 rt;",
    "#X obj 80 300 f;",
    "#X name 7 out_play;",
    "#X obj 220 300 button;",
    "#X name 8 out_stop;",
    "#X obj 340 300 f;",
    "#X name 9 out_vol;",
    "#X obj 480 300 f;",
    "#X name 10 out_int;",
    "#X obj 580 300 message (reject);",
    "#X name 11 out_reject;",
    "#X connect 1 0 6 0;",
    "#X connect 2 0 6 0;",
    "#X connect 3 0 6 0;",
    "#X connect 4 0 6 0;",
    "#X connect 5 0 6 0;",
    "#X connect 6 0 7 0;",
    "#X connect 6 1 8 0;",
    "#X connect 6 2 9 0;",
    "#X connect 6 3 10 0;",
    "#X connect 6 4 11 1;",
  ].join("\n"),
};

const BUTTON_REFERENCE_PATCH: ReferencePatch = {
  label: "button reference",
  tabId: "ref-button",
  text: [
    "#N canvas;",
    "#X obj 60 30 comment button: click to send a bang. downstream nodes receive the bang.;",
    "#X size 0 720 24;",
    "#X obj 100 120 button;",
    "#X name 1 the_button;",
    "#X obj 240 120 button;",
    "#X name 2 cascade_button;",
    "#X obj 380 120 toggle;",
    "#X name 3 cascade_toggle;",
    "#X obj 60 240 comment click the_button. cascade_button flashes too. cascade_toggle flips its state.;",
    "#X size 4 720 24;",
    "#X connect 1 0 2 0;",
    "#X connect 1 0 3 0;",
  ].join("\n"),
};

const TOGGLE_REFERENCE_PATCH: ReferencePatch = {
  label: "toggle reference",
  tabId: "ref-toggle",
  text: [
    "#N canvas;",
    "#X obj 60 30 comment toggle: click to flip between 0 and 1. emits the new state on each click.;",
    "#X size 0 720 24;",
    "#X obj 100 120 toggle;",
    "#X name 1 the_toggle;",
    "#X obj 240 120 f;",
    "#X name 2 out_value;",
    "#X obj 60 260 comment click the toggle. the f number box shows 0 or 1 alternating with each click.;",
    "#X size 3 720 24;",
    "#X connect 1 0 2 0;",
  ].join("\n"),
};

const SLIDER_REFERENCE_PATCH: ReferencePatch = {
  label: "slider reference",
  tabId: "ref-slider",
  text: [
    "#N canvas;",
    "#X obj 60 30 comment slider: drag horizontally to output a float in the 0.0 to 1.0 range.;",
    "#X size 0 720 24;",
    "#X obj 100 120 slider;",
    "#X name 1 the_slider;",
    "#X obj 280 120 f;",
    "#X name 2 out_value;",
    "#X obj 60 220 comment drag the slider. the f number box shows the current value.;",
    "#X size 3 720 24;",
    "#X connect 1 0 2 0;",
  ].join("\n"),
};

const MESSAGE_REFERENCE_PATCH: ReferencePatch = {
  label: "message reference",
  tabId: "ref-message",
  text: [
    "#N canvas;",
    "#X obj 60 30 comment message: stores text. click to send. $1-$9 fill with atoms from incoming messages.;",
    "#X size 0 720 24;",
    "#X obj 100 120 message click me;",
    "#X name 1 plain;",
    "#X obj 280 120 message (sink);",
    "#X name 2 sink_a;",
    "#X obj 100 240 f 42;",
    "#X name 3 num;",
    "#X obj 280 240 message you sent $1;",
    "#X name 4 template;",
    "#X obj 460 240 message (sink);",
    "#X name 5 sink_b;",
    "#X obj 60 360 comment top row: click 'click me' -- sink_a stores it (cold inlet). bottom row: click num -- 42 hits template hot inlet -- $1 fills with 42 -- sink_b stores 'you sent 42'.;",
    "#X size 6 760 48;",
    "#X connect 1 0 2 1;",
    "#X connect 3 0 4 0;",
    "#X connect 4 0 5 1;",
  ].join("\n"),
};

const EZSLIDER_REFERENCE_PATCH: ReferencePatch = {
  label: "ezSlider reference",
  tabId: "ref-ezSlider",
  text: [
    "#N canvas;",
    "#X obj 60 30 comment ezSlider: a slider with named lo/hi endpoints. drag the thumb to interpolate between them.;",
    "#X size 0 720 24;",
    "#X obj 100 120 ezSlider 0 100;",
    "#X name 1 percent;",
    "#X obj 360 120 ezSlider 20 200;",
    "#X name 2 bpm;",
    "#X obj 100 280 f;",
    "#X name 3 percent_out;",
    "#X obj 360 280 f;",
    "#X name 4 bpm_out;",
    "#X obj 60 380 comment drag either slider. the f below each shows the value mapped into that slider's range. int-form bounds (no dot) round output to integers.;",
    "#X size 5 760 48;",
    "#X connect 1 0 3 0;",
    "#X connect 2 0 4 0;",
  ].join("\n"),
};

export const REFERENCE_PATCHES: Record<string, ReferencePatch> = {
  route: ROUTE_REFERENCE_PATCH,
  button: BUTTON_REFERENCE_PATCH,
  toggle: TOGGLE_REFERENCE_PATCH,
  slider: SLIDER_REFERENCE_PATCH,
  message: MESSAGE_REFERENCE_PATCH,
  ezSlider: EZSLIDER_REFERENCE_PATCH,
};
