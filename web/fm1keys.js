// fm1keys.js: an on-screen copy of the FM-1's own key bed (27 silicone pill keys, F to G).
//
// Bottom row: 16 wide pills (the white notes). Top row: 11 narrower pills (the black notes)
// sitting between them, with the function labels printed on the device. Styles: css/keys.css.
//
//   mountFm1Keys(container, { low, held, noteOn, noteOff, onOctave, octave, canDown, canUp })
//
//   low       MIDI note of the lowest key (an F). Use fm1LowNote(octave).
//   held      Set of notes currently sounding, lit on (re)mount.
//   noteOn / noteOff(n)  called on pointer press/drag/release.
//   onOctave(delta)      called by the OCT- / OCT+ buttons (-1 / +1).
//   octave, canDown, canUp  readout and button states.
//
// Keys carry data-note and get the class "on" while lit, so the app's light(n, on) works on them.
// Mounting again (e.g. after an octave change) rebuilds the keys in place.

const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const noteName = (n) => NAMES[n % 12] + (Math.floor(n / 12) - 1);

// Semitone offsets from the lowest F.
const WHITE = [0, 2, 4, 6, 7, 9, 11, 12, 14, 16, 18, 19, 21, 23, 24, 26];
// Top row: [semitone offset, index of the white key on its left, printed label]
const TOP = [
  [1, 0, "OP1"], [3, 1, "OP2"], [5, 2, "OP3"],
  [8, 4, "OP4"], [10, 5, "OP5"],
  [13, 7, "OP6"], [15, 8, "PIT"], [17, 9, "GLO"],
  [20, 11, "MONO"], [22, 12, "POLY"],
  [25, 14, ""],
];
// Gaps in the top row (B-C and E-F) get the small dot printed on the device.
const DOTS = [3, 6, 10, 13];

/** The lowest key for an octave setting: the F just below that octave's C, so the bed's
 *  first C is the same C as the computer-key row Z (and the classic keyboard's lowest key). */
export const fm1LowNote = (octave) => (octave + 1) * 12 - 7;

function el(tag, cls, attrs = {}) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

export function mountFm1Keys(container, opts) {
  const { low, held = new Set(), noteOn, noteOff, onOctave } = opts;
  container.classList.add("fm1");
  container.replaceChildren();

  const body = el("div", "fm1-body");

  // Strip above the keys: OCT- / OCT+ in their recessed frame, plus a range readout.
  const strip = el("div", "fm1-strip");
  const octFrame = el("div", "fm1-oct");
  for (const [d, label, title] of [[-1, "OCT−", "Octave down (←)"], [1, "OCT+", "Octave up (→)"]]) {
    const b = el("button", "fm1-octbtn", { type: "button", title, "aria-label": title });
    b.textContent = label;
    if ((d < 0 && opts.canDown === false) || (d > 0 && opts.canUp === false)) b.disabled = true;
    b.addEventListener("click", () => onOctave?.(d));
    octFrame.append(b);
  }
  const read = el("div", "fm1-read");
  read.innerHTML = `<span>OCT <b>${opts.octave ?? ""}</b></span><span>${noteName(low)}–${noteName(low + 26)}</span>`;
  strip.append(octFrame, read);

  // Key bed: a 32-column grid; each white key spans two columns, each top key straddles two whites.
  const bed = el("div", "fm1-bed", { role: "group", "aria-label": "FM-1 keys" });

  const bind = (key, n) => {
    if (held.has(n)) key.classList.add("on");
    key.addEventListener("pointerdown", (e) => { e.preventDefault(); key.releasePointerCapture?.(e.pointerId); noteOn(n); });
    key.addEventListener("pointerenter", (e) => { if (e.buttons & 1) noteOn(n); });
    key.addEventListener("pointerup", () => { if (held.has(n)) noteOff(n); });
    key.addEventListener("pointerleave", () => { if (held.has(n)) noteOff(n); });
    key.addEventListener("pointercancel", () => { if (held.has(n)) noteOff(n); });
    key.addEventListener("contextmenu", (e) => e.preventDefault());
  };

  for (const [off, left, label] of TOP) {
    const n = low + off;
    const key = el("div", "fk top" + (label ? " lab" : ""), { "data-note": n, title: noteName(n) + (label ? ` · ${label}` : "") });
    key.style.gridColumn = `${2 * left + 2} / span 2`;
    key.append(el("i", "led"));
    if (label) { const t = el("b", "lbl"); t.textContent = label; key.append(t); }
    bind(key, n);
    bed.append(key);
  }
  for (const left of DOTS) {
    const dot = el("span", "fm1-dot");
    dot.style.gridColumn = `${2 * left + 2} / span 2`;
    bed.append(dot);
  }
  WHITE.forEach((off, i) => {
    const n = low + off;
    const key = el("div", "fk white", { "data-note": n, title: noteName(n) });
    key.style.gridColumn = `${2 * i + 1} / span 2`;
    key.append(el("i", "led"));
    bind(key, n);
    bed.append(key);
  });

  body.append(strip, bed);
  container.append(body);
  return { low, high: low + 26 };
}
