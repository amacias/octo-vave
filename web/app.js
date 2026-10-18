import * as DX from "./dx7.js";

// ================================================================ helpers

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

function h(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === "class") e.className = v;
    else if (k === "text") e.textContent = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (["value", "checked", "disabled", "selected"].includes(k)) e[k] = v;
    else e.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) e.append(c instanceof Node ? c : String(c));
  return e;
}

async function api(path, opts = {}) {
  const r = await fetch("/api/" + path, { headers: { "Content-Type": "application/json" }, ...opts });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `${r.status} ${r.statusText}`);
  return j;
}

let toastTimer;
function toast(msg, err = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast" + (err ? " err" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), err ? 6000 : 2600);
}

const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const noteName = (n) => NOTE_NAMES[n % 12] + (Math.floor(n / 12) - 1);
const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0").toUpperCase()).join(" ");
const fmtBytes = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`);
const normVer = (v) => String(v || "").trim().replace(/^v/i, "").toLowerCase();

function download(name, data, type = "application/octet-stream") {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = h("a", { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Two-step confirm on a button, avoiding blocking browser dialogs. */
function confirmClick(btn, label, action) {
  if (btn.dataset.armed) { action(); return; }
  const orig = btn.textContent;
  btn.dataset.armed = "1"; btn.textContent = label; btn.classList.add("danger");
  setTimeout(() => { delete btn.dataset.armed; btn.textContent = orig; btn.classList.remove("danger"); }, 3000);
}

// ================================================================ FM-1 data

const FX_DEFS = [
  { name: "Filter", sw: 0, params: [
    { cc: 1, label: "Type", max: 2, options: ["LPF", "BPF", "HPF"] },
    { cc: 2, label: "Cutoff", max: 107 }, { cc: 3, label: "Q", max: 10 }] },
  { name: "Reverb", sw: 4, params: [
    { cc: 5, label: "Type", max: 2, options: ["Room", "Hall", "Plate"] },
    { cc: 6, label: "Decay", max: 100 }, { cc: 7, label: "Mix", max: 100 }] },
  { name: "Delay", sw: 8, params: [
    { cc: 9, label: "Decay", max: 100 }, { cc: 10, label: "Rate", max: 100 }, { cc: 11, label: "Mix", max: 100 }] },
  { name: "Distortion", sw: 12, params: [
    { cc: 13, label: "Gain", max: 100 }, { cc: 14, label: "Tone", max: 100 }, { cc: 15, label: "Level", max: 100 }] },
  { name: "Chorus", sw: 16, params: [
    { cc: 17, label: "Freq", max: 100 }, { cc: 18, label: "Depth", max: 100 }, { cc: 19, label: "Mix", max: 100 }] },
  { name: "Phaser", sw: 20, params: [
    { cc: 21, label: "Freq", max: 100 }, { cc: 22, label: "Depth", max: 100 }, { cc: 23, label: "Mix", max: 100 }] },
];
const FX_NAME = {};
for (const fx of FX_DEFS) {
  FX_NAME[fx.sw] = `${fx.name} on/off`;
  for (const p of fx.params) FX_NAME[p.cc] = `${fx.name} ${p.label}`;
}
function defaultFx() {
  const fx = {};
  for (const d of FX_DEFS) {
    fx[d.sw] = 0;
    for (const p of d.params) fx[p.cc] = p.options ? 0 : Math.round(p.max / 2);
  }
  fx[2] = 107;
  return fx;
}

const WIDGETS = {
  status: "Device status", perform: "Perform + FX", quickfx: "Quick FX", favorites: "Favorites",
  notes: "Notes", keys: "Keyboard", voice: "Voice editor", explore: "About the FM-1",
};

const DEFAULTS = {
  outName: "", inName: "", noteCh: 1, fxCh: 2, sysexGap: 4, bpm: 120, octave: 4, velocity: 100,
  liveSend: true, widgets: Object.fromEntries(Object.keys(WIDGETS).map((k) => [k, true])),
  notes: "", theme: "auto", accent: "", voice: null, fx: null, program: 1, soundcheck: {},
};

// ================================================================ state

const S = {
  settings: structuredClone(DEFAULTS),
  voice: DX.initVoice(),
  fx: defaultFx(),
  midi: null, out: null, inp: null,
  fw: null, patches: [],
  held: new Set(),
  bank: null,
};

const saveSettings = debounce(async () => {
  S.settings.voice = S.voice;
  S.settings.fx = S.fx;
  try { await api("settings", { method: "PUT", body: JSON.stringify(S.settings) }); }
  catch (e) { toast("Couldn't save settings: " + e.message, true); }
}, 500);

// ================================================================ MIDI core

async function connectMidi(quiet = false) {
  if (!navigator.requestMIDIAccess) {
    toast("Web MIDI isn't available here. Use Chrome or Edge.", true);
    return;
  }
  try {
    S.midi = await navigator.requestMIDIAccess({ sysex: true });
  } catch (e) {
    if (!quiet) toast("MIDI access was denied: " + e.message, true);
    return;
  }
  S.midi.onstatechange = () => fillPorts();
  fillPorts();
}

function fillPorts() {
  if (!S.midi) return;
  const outs = [...S.midi.outputs.values()];
  const ins = [...S.midi.inputs.values()];
  const pick = (list, saved) =>
    list.find((p) => p.name === saved) || list.find((p) => /fm-?1/i.test(p.name)) || list[0];
  const fill = (sel, list, chosen) => {
    sel.replaceChildren(h("option", { value: "", text: "(none)" }),
      ...list.map((p) => h("option", { value: p.id, text: p.name, selected: chosen && p.id === chosen.id })));
  };
  const o = pick(outs, S.settings.outName);
  const i = pick(ins, S.settings.inName);
  fill($("#outSel"), outs, o);
  fill($("#inSel"), ins, i);
  bindPorts();
}

function bindPorts() {
  if (!S.midi) return;
  if (S.inp) S.inp.onmidimessage = null;
  S.out = S.midi.outputs.get($("#outSel").value) || null;
  S.inp = S.midi.inputs.get($("#inSel").value) || null;
  if (S.inp) S.inp.onmidimessage = onMidiIn;
  if (S.out) S.settings.outName = S.out.name;
  if (S.inp) S.settings.inName = S.inp.name;
  updateConn();
}

async function releaseMidi() {
  stopClock(false);
  if (S.inp) { S.inp.onmidimessage = null; await S.inp.close().catch(() => {}); }
  if (S.out) await S.out.close().catch(() => {});
  if (S.midi) S.midi.onstatechange = null;
  S.midi = S.out = S.inp = null;
  $("#outSel").replaceChildren(); $("#inSel").replaceChildren();
  updateConn();
  toast("MIDI ports released. Press Connect to use them again.");
}

function updateConn() {
  const on = !!S.out;
  $("#connDot").className = "dot " + (on ? "on" : "off");
  $("#connText").textContent = on ? S.out.name : S.midi ? "No output selected" : "Not connected";
  $("#connectBtn").textContent = S.midi ? "Rescan" : "Connect";
  renderHomeStatus();
}

let warnedNoOut = false;
function send(bytes, { ts, silent } = {}) {
  if (!S.out) {
    if (!warnedNoOut) { toast("Not connected. Press Connect first.", true); warnedNoOut = true; setTimeout(() => (warnedNoOut = false), 3000); }
    return false;
  }
  try { S.out.send(bytes, ts); }
  catch (e) { toast("Send failed: " + e.message, true); return false; }
  if (!silent) logMidi("out", bytes);
  return true;
}

const nch = () => (S.settings.noteCh - 1) & 15;
const fch = () => (S.settings.fxCh - 1) & 15;
const noteOn = (n, v = S.settings.velocity) => { if (n < 0 || n > 127) return; S.held.add(n); light(n, true); send([0x90 | nch(), n, v]); };
const noteOff = (n) => { if (n < 0 || n > 127) return; S.held.delete(n); light(n, false); send([0x80 | nch(), n, 0]); };
const sendCC = (ch, cc, v) => send([0xb0 | ch, cc & 127, v & 127]);
const sendPC = (n) => send([0xc0 | nch(), (n - 1) & 127]);

function panic() {
  if (!S.out) return;
  const t = performance.now();
  for (let ch = 0; ch < 16; ch++) {
    S.out.send([0xb0 | ch, 64, 0], t); S.out.send([0xb0 | ch, 123, 0], t); S.out.send([0xb0 | ch, 120, 0], t);
  }
  for (let n = 0; n < 128; n++) S.out.send([0x80 | nch(), n, 0], t + 2 + n * 0.5);
  S.held.clear();
  $$(".keyboard .on").forEach((k) => k.classList.remove("on"));
  logText("out", "Panic: sustain off, all notes off on every channel");
}

// ----- clock (lookahead scheduler, 24 ppqn)
let clock = null;
function startClock() {
  if (!S.out) return toast("Not connected", true);
  stopClock(false);
  const t0 = performance.now() + 30;
  S.out.send([0xfa], t0);
  clock = { next: t0, timer: setInterval(tickClock, 20) };
  logText("out", `Clock start @ ${S.settings.bpm} BPM`);
  $("#clockStart").classList.add("primary");
}
function tickClock() {
  if (!S.out) return stopClock(false);
  const interval = 60000 / (S.settings.bpm * 24);
  const ahead = performance.now() + 80;
  while (clock.next < ahead) { S.out.send([0xf8], clock.next); clock.next += interval; }
}
function stopClock(sendStop = true) {
  if (clock) { clearInterval(clock.timer); clock = null; }
  if (sendStop && S.out) { S.out.send([0xfc]); logText("out", "Clock stop"); }
  $("#clockStart")?.classList.remove("primary");
}

// ----- incoming
const ccSeen = new Map();
function onMidiIn(e) {
  const d = e.data;
  const st = d[0];
  if (st === 0xf8 || st === 0xfe) { if ($("#monClock").checked) logMidi("in", d); return; }
  logMidi("in", d);
  const type = st & 0xf0, ch = (st & 15) + 1;
  if (type === 0x90 && d[2] > 0) light(d[1], true);
  else if (type === 0x80 || (type === 0x90 && d[2] === 0)) light(d[1], false);
  else if (type === 0xb0) {
    const k = `${ch}:${d[1]}`;
    const prev = ccSeen.get(k) || { ch, cc: d[1], count: 0 };
    ccSeen.set(k, { ...prev, value: d[2], count: prev.count + 1 });
    renderCcTable();
  } else if (type === 0xc0) {
    $("#pcNum").value = d[1] + 1;
  }
}

function describe(d) {
  const st = d[0];
  if (st === 0xf0) {
    if (d[1] === 0x43 && d[2] === 0x10 && d.length === 7) return `SysEx param ${d[3] * 128 + d[4]} = ${d[5]}`;
    return `SysEx (${d.length} bytes)`;
  }
  const rt = { 0xf8: "Clock", 0xfa: "Start", 0xfb: "Continue", 0xfc: "Stop", 0xfe: "Active sensing", 0xff: "Reset" }[st];
  if (rt) return rt;
  const type = st & 0xf0, ch = (st & 15) + 1;
  switch (type) {
    case 0x80: return `ch${ch} Note off ${noteName(d[1])}`;
    case 0x90: return d[2] ? `ch${ch} Note on ${noteName(d[1])} vel ${d[2]}` : `ch${ch} Note off ${noteName(d[1])} (vel 0)`;
    case 0xa0: return `ch${ch} Poly AT ${noteName(d[1])} ${d[2]}`;
    case 0xb0: {
      const known = ch === S.settings.fxCh && FX_NAME[d[1]] ? ` (${FX_NAME[d[1]]})` : d[1] === 1 ? " (Mod wheel)" : d[1] === 64 ? " (Sustain)" : "";
      return `ch${ch} CC ${d[1]} = ${d[2]}${known}`;
    }
    case 0xc0: return `ch${ch} Program ${d[1] + 1}`;
    case 0xd0: return `ch${ch} Aftertouch ${d[1]}`;
    case 0xe0: return `ch${ch} Pitch bend ${((d[2] << 7) | d[1]) - 8192}`;
  }
  return "?";
}

const MAX_LOG = 400;
function appendLog(box, row) {
  box.append(row);
  while (box.childElementCount > MAX_LOG) box.firstChild.remove();
  box.scrollTop = box.scrollHeight;
}
function logRow(dir, text, raw) {
  const t = new Date().toLocaleTimeString([], { hour12: false });
  return h("div", { class: dir }, `${t} ${dir === "in" ? "◀" : "▶"} `, h("b", { text }), raw ? `   ${raw}` : "");
}
function logMidi(dir, bytes) {
  if (dir === "out" && !$("#monOut").checked) return;
  const text = describe(bytes);
  const raw = bytes.length > 12 ? hex(bytes.slice(0, 12)) + " …" : hex(bytes);
  appendLog($("#monitor"), logRow(dir, text, raw));
}
function logText(dir, text) {
  if (dir === "out" && !$("#monOut").checked) return;
  appendLog($("#monitor"), logRow(dir, text));
}

function renderCcTable() {
  const rows = [...ccSeen.values()].sort((a, b) => a.ch - b.ch || a.cc - b.cc);
  $("#ccTable tbody").replaceChildren(...rows.map((r) =>
    h("tr", {}, h("td", { text: r.ch }), h("td", { text: r.cc }), h("td", { text: r.value }), h("td", { text: r.count }),
      h("td", { text: r.ch === S.settings.fxCh && FX_NAME[r.cc] ? FX_NAME[r.cc] : r.cc === 1 ? "Mod wheel" : r.cc === 64 ? "Sustain" : "" }))));
}

// ================================================================ keyboards

const KEYMAP = {
  z: 0, s: 1, x: 2, d: 3, c: 4, v: 5, g: 6, b: 7, h: 8, n: 9, j: 10, m: 11, ",": 12, l: 13, ".": 14,
  q: 12, 2: 13, w: 14, 3: 15, e: 16, r: 17, 5: 18, t: 19, 6: 20, y: 21, 7: 22, u: 23, i: 24, 9: 25, o: 26, 0: 27, p: 28,
};
const BLACK = new Set([1, 3, 6, 8, 10]);

function buildKeyboard(container, octaves) {
  const base = (S.settings.octave + 1) * 12;
  container.replaceChildren();
  const whites = [];
  for (let n = base; n <= base + octaves * 12; n++) if (!BLACK.has(n % 12)) whites.push(n);
  const ww = 100 / whites.length;
  let wi = 0;
  for (let n = base; n <= base + octaves * 12; n++) {
    let key;
    if (BLACK.has(n % 12)) {
      key = h("div", { class: "b", "data-note": n });
      key.style.left = `${wi * ww - ww * 0.3}%`;
      key.style.width = `${ww * 0.6}%`;
    } else {
      key = h("div", { class: "w", "data-note": n }, n % 12 === 0 ? h("span", { text: noteName(n) }) : null);
      wi++;
    }
    if (S.held.has(n)) key.classList.add("on");
    key.addEventListener("pointerdown", (e) => { e.preventDefault(); key.releasePointerCapture?.(e.pointerId); noteOn(n); });
    key.addEventListener("pointerenter", (e) => { if (e.buttons & 1) noteOn(n); });
    key.addEventListener("pointerup", () => noteOff(n));
    key.addEventListener("pointerleave", () => { if (S.held.has(n)) noteOff(n); });
    container.append(key);
  }
}
function buildKeyboards() {
  buildKeyboard($("#kbHome"), 2);
  buildKeyboard($("#kbPlay"), 3);
  $("#octLabel").textContent = S.settings.octave;
}
function light(n, on) { $$(`.keyboard [data-note="${n}"]`).forEach((k) => k.classList.toggle("on", on)); }

const typing = (e) => /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) && e.target.type !== "range" && e.target.type !== "checkbox";
const qwertyDown = new Map();
document.addEventListener("keydown", (e) => {
  if (typing(e) || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
    if (e.target.type === "range") return;
    S.settings.octave = Math.max(0, Math.min(8, S.settings.octave + (e.key === "ArrowRight" ? 1 : -1)));
    buildKeyboards(); saveSettings(); e.preventDefault(); return;
  }
  const off = KEYMAP[e.key.toLowerCase()];
  if (off === undefined || e.repeat || qwertyDown.has(e.key.toLowerCase())) return;
  const n = (S.settings.octave + 1) * 12 + off;
  qwertyDown.set(e.key.toLowerCase(), n);
  noteOn(n);
});
document.addEventListener("keyup", (e) => {
  const n = qwertyDown.get(e.key.toLowerCase());
  if (n !== undefined) { qwertyDown.delete(e.key.toLowerCase()); noteOff(n); }
});
window.addEventListener("blur", () => { for (const n of qwertyDown.values()) noteOff(n); qwertyDown.clear(); });

// ================================================================ voice editor

const controls = {};          // param number -> { input, out, fmt }
const opEls = {};             // op -> { card, freq, eg, tag, enable }
const pendingParams = new Set();
let flushQueued = false;

function queueParam(p) {
  pendingParams.add(p);
  if (flushQueued) return;
  flushQueued = true;
  requestAnimationFrame(() => {
    flushQueued = false;
    for (const q of pendingParams) send(DX.paramMessage(q, S.voice[q]));
    pendingParams.clear();
  });
}

function setParam(p, v, { live = true } = {}) {
  S.voice[p] = Math.max(0, Math.min(DX.paramMax(p), v | 0));
  refreshParam(p);
  if (p < 126) {
    const op = 6 - Math.floor(p / 21), off = p % 21;
    if (off <= 7) drawEg(op);
    if (off >= 17) updateFreq(op);
  }
  if (p === 134) updateCarriers();
  if (live && S.settings.liveSend) queueParam(p);
  saveSettings();
}

function refreshParam(p) {
  const c = controls[p];
  if (!c) return;
  c.input.value = S.voice[p];
  if (c.out) c.out.textContent = c.fmt ? c.fmt(S.voice[p]) : S.voice[p];
}

function paramControl(p, label, { fmt, options } = {}) {
  const max = DX.paramMax(p);
  const out = options ? null : h("output");
  const input = options
    ? h("select", { onchange: () => setParam(p, +input.value) }, options.map((o, i) => h("option", { value: i, text: o })))
    : h("input", { type: "range", min: 0, max, oninput: () => setParam(p, +input.value) });
  controls[p] = { input, out, fmt };
  return h("div", { class: "param" }, h("label", { text: label }), out || h("span"), input);
}

const OFF_OPTS = ["Off", "On"];
const GLOBAL_FMT = {
  oks: { options: OFF_OPTS }, lsync: { options: OFF_OPTS }, lwave: { options: DX.LFO_WAVES },
  trans: { fmt: (v) => (v - 24 > 0 ? "+" : "") + (v - 24) + " st" },
};

function buildVoiceEditor() {
  const g = $("#globalParams");
  g.replaceChildren();
  for (const [p, key, label] of DX.GLOBAL_FIELDS) {
    if (key === "alg") continue;
    g.append(paramControl(p, label, GLOBAL_FMT[key] || {}));
  }
  const grid = $("#opGrid");
  grid.replaceChildren();
  for (let op = 1; op <= 6; op++) {
    const P = (off) => DX.opParam(op, off);
    const freq = h("span", { class: "freq" });
    const tag = h("span", { class: "tag" });
    const enable = h("input", { type: "checkbox", title: "Operator on/off (param 155)", onchange: () => {
      const bit = 1 << (6 - op);
      setParam(DX.OP_ENABLE, enable.checked ? S.voice[DX.OP_ENABLE] | bit : S.voice[DX.OP_ENABLE] & ~bit);
      updateCarriers();
    } });
    const eg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    eg.setAttribute("class", "eg"); eg.setAttribute("viewBox", "0 0 200 60"); eg.setAttribute("preserveAspectRatio", "none");
    eg.append(document.createElementNS("http://www.w3.org/2000/svg", "path"));
    const sect = (title, ...kids) => [h("h4", { text: title }), h("div", { class: "param-grid" }, ...kids)];
    const card = h("div", { class: "op-card" },
      h("div", { class: "op-head" }, h("label", {}, enable), h("b", { text: `OP${op}` }), tag, freq),
      sect("Oscillator",
        paramControl(P(17), "Mode", { options: ["Ratio", "Fixed"] }),
        paramControl(P(18), "Coarse"), paramControl(P(19), "Fine"),
        paramControl(P(20), "Detune", { fmt: (v) => (v - 7 > 0 ? "+" : "") + (v - 7) })),
      h("h4", { text: "Envelope" }), eg,
      h("div", { class: "param-grid" }, [0, 1, 2, 3, 4, 5, 6, 7].map((o) => paramControl(P(o), DX.OP_FIELDS[o][2]))),
      sect("Output",
        paramControl(P(16), "Level"), paramControl(P(15), "Velocity sens"), paramControl(P(14), "Amp mod sens")),
      h("details", {}, h("summary", { class: "muted", text: "Keyboard scaling" }),
        h("div", { class: "param-grid" },
          paramControl(P(8), "Break point", { fmt: (v) => noteName(v + 21) }),
          paramControl(P(9), "L depth"), paramControl(P(10), "R depth"),
          paramControl(P(11), "L curve", { options: DX.CURVES }), paramControl(P(12), "R curve", { options: DX.CURVES }),
          paramControl(P(13), "Rate scale"))));
    opEls[op] = { card, freq, eg, tag, enable };
    grid.append(card);
  }
}

function drawEg(op) {
  const b = DX.opParam(op, 0);
  const v = S.voice;
  const r = [v[b], v[b + 1], v[b + 2], v[b + 3]];
  const l = [v[b + 4], v[b + 5], v[b + 6], v[b + 7]];
  const dur = (rate) => 4 + Math.pow((99 - rate) / 99, 1.6) * 40;
  const y = (lv) => 56 - (lv / 99) * 52;
  let x = 0;
  let d = `M0 ${y(l[3])}`;
  for (let i = 0; i < 3; i++) { x += dur(r[i]); d += ` L${x.toFixed(1)} ${y(l[i])}`; }
  x += 30; d += ` L${x.toFixed(1)} ${y(l[2])}`;
  x += dur(r[3]); d += ` L${Math.min(200, x).toFixed(1)} ${y(l[3])}`;
  opEls[op].eg.firstChild.setAttribute("d", d);
}

function updateFreq(op) {
  const b = DX.opParam(op, 0);
  opEls[op].freq.textContent = DX.freqLabel(S.voice[b + 17], S.voice[b + 18], S.voice[b + 19]);
}

function updateCarriers() {
  const alg = S.voice[134];
  const car = DX.CARRIERS[alg];
  $("#algNum").value = alg + 1;
  $("#carriers").textContent = `Carriers: ${car.map((c) => "OP" + c).join(", ")}`;
  for (let op = 1; op <= 6; op++) {
    const isCar = car.includes(op);
    const on = !!(S.voice[DX.OP_ENABLE] & (1 << (6 - op)));
    const e = opEls[op];
    e.card.classList.toggle("carrier", isCar);
    e.card.classList.toggle("muted-op", !on);
    e.tag.textContent = isCar ? "carrier" : "modulator";
    e.tag.className = "tag" + (isCar ? " car" : "");
    e.enable.checked = on;
  }
  updateVoiceSummary();
}

/** One-line summary in the Voice editor bar, so it says something when collapsed. */
function updateVoiceSummary() {
  $("#voiceSummary").textContent = `${DX.getName(S.voice).trim() || "(no name)"} · algorithm ${S.voice[134] + 1}`;
}

function refreshVoiceUI() {
  for (let p = 0; p < DX.VOICE_LEN; p++) refreshParam(p);
  for (let op = 1; op <= 6; op++) { drawEg(op); updateFreq(op); }
  updateCarriers();
  $("#voiceName").value = DX.getName(S.voice);
}

function loadVoice(data, { sendNow = S.settings.liveSend } = {}) {
  S.voice = DX.clampVoice(data);
  refreshVoiceUI();
  saveSettings();
  if (sendNow) sendWholeVoice();
}

function sendWholeVoice(delay = 0) {
  if (!S.out) return toast("Not connected", true);
  const gap = Math.max(0, +S.settings.sysexGap || 0);
  const t0 = performance.now() + 5 + delay;
  for (let p = 0; p < DX.VOICE_LEN; p++) S.out.send(DX.paramMessage(p, S.voice[p]), t0 + p * gap);
  logText("out", `SysEx ×156: whole voice "${DX.getName(S.voice)}"`);
  toast(`Sent "${DX.getName(S.voice)}" (${Math.round(DX.VOICE_LEN * gap + delay)} ms)`);
}

function randomVoice() {
  const v = DX.initVoice();
  const R = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
  v[134] = R(0, 31);
  const car = DX.CARRIERS[v[134]];
  for (let op = 1; op <= 6; op++) {
    const b = DX.opParam(op, 0);
    const isCar = car.includes(op);
    v[b] = R(isCar ? 60 : 40, 99); v[b + 1] = R(20, 90); v[b + 2] = R(10, 80); v[b + 3] = R(30, 80);
    v[b + 4] = 99; v[b + 5] = R(60, 99); v[b + 6] = R(isCar ? 50 : 0, 95); v[b + 7] = 0;
    v[b + 16] = isCar ? R(85, 99) : R(30, 88);
    v[b + 18] = [0, 1, 1, 2, 2, 3, 4, 5, 7, 1, 1][R(0, 10)];
    v[b + 19] = Math.random() < 0.8 ? 0 : R(0, 99);
    v[b + 20] = R(4, 10);
    v[b + 15] = R(0, 4);
  }
  v[135] = R(0, 7);
  v[137] = R(20, 60);
  setDXName(v, "RANDOM " + R(100, 999));
  loadVoice(v);
}
const setDXName = (v, n) => DX.setName(v, n);

// ================================================================ FX

const fxEls = {};
function buildFx() {
  const grid = $("#fxGrid");
  grid.replaceChildren();
  const quick = $("#quickFx");
  quick.replaceChildren();
  for (const d of FX_DEFS) {
    const sw = h("button", { class: "switch", title: `CC ${d.sw}`, onclick: () => setFx(d.sw, S.fx[d.sw] ? 0 : 127) });
    const qsw = h("button", { class: "switch", onclick: () => setFx(d.sw, S.fx[d.sw] ? 0 : 127) });
    const card = h("div", { class: "fx-card" }, h("div", { class: "fx-head" }, h("b", { text: d.name }), sw));
    const ctrls = {};
    for (const p of d.params) {
      const out = p.options ? null : h("output");
      const input = p.options
        ? h("select", { onchange: () => setFx(p.cc, +input.value) }, p.options.map((o, i) => h("option", { value: i, text: o })))
        : h("input", { type: "range", min: 0, max: p.max, oninput: () => setFx(p.cc, +input.value) });
      ctrls[p.cc] = { input, out };
      card.append(h("div", { class: "param" }, h("label", { text: `${p.label}  ·  CC ${p.cc}` }), out || h("span"), input));
    }
    fxEls[d.sw] = { card, sw, qsw, ctrls };
    grid.append(card);
    quick.append(h("div", { class: "q" }, h("span", { text: d.name }), qsw));
  }
  refreshFx();
}

function refreshFx() {
  for (const d of FX_DEFS) {
    const e = fxEls[d.sw];
    const on = S.fx[d.sw] > 0;
    e.sw.classList.toggle("on", on); e.qsw.classList.toggle("on", on); e.card.classList.toggle("off", !on);
    for (const [cc, c] of Object.entries(e.ctrls)) {
      c.input.value = S.fx[cc];
      if (c.out) c.out.textContent = S.fx[cc];
    }
  }
  const n = FX_DEFS.filter((d) => S.fx[d.sw] > 0).length;
  $("#fxOnCount").textContent = n ? ` · ${n} on` : "";
}

/** The "FX ▾" pull-down on FM-1 Home. */
function toggleFxPanel(open = $("#fxPanel").classList.contains("hidden")) {
  $("#fxPanel").classList.toggle("hidden", !open);
  $("#fxToggle").setAttribute("aria-expanded", open);
  $("#fxToggle").classList.toggle("open", open);
  $(".home-panel").classList.toggle("fx-open", open);
}

function setFx(cc, v, { live = true } = {}) {
  S.fx[cc] = v;
  refreshFx();
  if (live) sendCC(fch(), cc, v);
  saveSettings();
}

function sendAllFx(delay = 0) {
  if (!S.out) return toast("Not connected", true);
  const t0 = performance.now() + delay;
  Object.keys(S.fx).sort((a, b) => a - b).forEach((cc, i) => S.out.send([0xb0 | fch(), +cc, S.fx[cc] & 127], t0 + i * 2));
  logText("out", `FX snapshot: ${Object.keys(S.fx).length} CCs on ch ${S.settings.fxCh}`);
}

// ================================================================ library

let saveDlg;
function buildSaveDialog() {
  saveDlg = h("dialog", { class: "card", style: "min-width:360px" },
    h("form", { method: "dialog" },
      h("h3", { text: "Save to Library" }),
      h("label", { class: "stack" }, "Name", h("input", { id: "sdName", required: true, maxlength: 64, pattern: "[A-Za-z0-9][A-Za-z0-9 _.()\\-]*" })),
      h("div", { class: "row" },
        h("label", {}, h("input", { id: "sdVoice", type: "checkbox", checked: true }), " Voice"),
        h("label", {}, h("input", { id: "sdFx", type: "checkbox", checked: true }), " FX"),
        h("label", {}, h("input", { id: "sdPc", type: "checkbox" }), " Program #")),
      h("label", { class: "stack" }, "Tags (comma separated)", h("input", { id: "sdTags" })),
      h("label", { class: "stack" }, "Notes", h("textarea", { id: "sdNotes", rows: 3 })),
      h("div", { class: "row" },
        h("button", { value: "cancel", formnovalidate: true, text: "Cancel" }),
        h("button", { value: "save", class: "primary", text: "Save" }))));
  document.body.append(saveDlg);
  saveDlg.addEventListener("close", async () => {
    if (saveDlg.returnValue !== "save") return;
    const name = $("#sdName").value.trim();
    const patch = {
      favorite: false,
      notes: $("#sdNotes").value,
      tags: $("#sdTags").value.split(",").map((t) => t.trim()).filter(Boolean),
      voice: $("#sdVoice").checked ? S.voice : null,
      fx: $("#sdFx").checked ? S.fx : null,
      program: $("#sdPc").checked ? +$("#pcNum").value : null,
      firmware: S.fw?.installed?.id || "official",
    };
    const existing = S.patches.find((p) => p.name === name);
    if (existing) patch.favorite = existing.favorite;
    try { await api("patches/" + encodeURIComponent(name), { method: "PUT", body: JSON.stringify(patch) }); toast(`Saved "${name}"`); loadPatches(); }
    catch (e) { toast(e.message, true); }
  });
}
function openSave({ voice = true, fx = true, pc = false } = {}) {
  $("#sdName").value = DX.getName(S.voice).replace(/[^A-Za-z0-9 _.()\-]/g, "").trim() || "My patch";
  $("#sdVoice").checked = voice; $("#sdFx").checked = fx; $("#sdPc").checked = pc;
  $("#sdTags").value = ""; $("#sdNotes").value = "";
  saveDlg.showModal();
}

async function loadPatches() {
  try { S.patches = await api("patches"); } catch (e) { S.patches = []; toast("Library: " + e.message, true); }
  renderLibrary(); renderFavorites();
}

async function applyPatch(name, { sendNow = true } = {}) {
  const p = await api("patches/" + encodeURIComponent(name));
  let delay = 0;
  if (p.program && sendNow) { sendPC(p.program); $("#pcNum").value = p.program; delay = 200; }
  if (p.voice) { S.voice = DX.clampVoice(p.voice); refreshVoiceUI(); if (sendNow) sendWholeVoice(delay); delay += 700; }
  if (p.fx) { S.fx = { ...defaultFx(), ...p.fx }; refreshFx(); if (sendNow) sendAllFx(delay); }
  saveSettings();
  if (!sendNow) toast(`Loaded "${name}" into the editors`);
}

async function toggleFavorite(name) {
  const p = await api("patches/" + encodeURIComponent(name));
  p.favorite = !p.favorite;
  await api("patches/" + encodeURIComponent(name), { method: "PUT", body: JSON.stringify(p) });
  loadPatches();
}

function renderLibrary() {
  const q = $("#libSearch").value.trim().toLowerCase();
  const items = S.patches
    .filter((p) => !q || [p.name, p.notes, ...(p.tags || [])].join(" ").toLowerCase().includes(q))
    .sort((a, b) => b.favorite - a.favorite || a.name.localeCompare(b.name));
  const list = $("#libList");
  if (!items.length) {
    list.replaceChildren(h("p", { class: "muted", text: S.patches.length ? "No matches." : "No patches yet. Edit a voice or the FX, then press Save current…" }));
    return;
  }
  list.replaceChildren(...items.map((p) => {
    const del = h("button", { class: "ghost", text: "Delete" });
    del.onclick = () => confirmClick(del, "Confirm delete", async () => {
      await api("patches/" + encodeURIComponent(p.name), { method: "DELETE" }); loadPatches();
    });
    return h("div", { class: "lib-item" },
      h("div", { class: "title" },
        h("button", { class: "star" + (p.favorite ? " on" : ""), title: "Favorite (shows on Home)", text: p.favorite ? "★" : "☆", onclick: () => toggleFavorite(p.name) }),
        h("b", { text: p.name })),
      h("div", { class: "badges" },
        p.hasVoice && h("span", { class: "badge accent", text: "voice" }),
        p.hasFx && h("span", { class: "badge", text: "fx" }),
        p.program && h("span", { class: "badge", text: `PC ${p.program}` }),
        (p.tags || []).map((t) => h("span", { class: "badge", text: "#" + t }))),
      p.notes && h("div", { class: "muted", text: p.notes }),
      h("div", { class: "muted", style: "font-size:12px", text: p.modified ? "modified " + p.modified.replace("T", " ") : "" }),
      h("div", { class: "row" },
        h("button", { class: "primary", text: "Send", onclick: () => applyPatch(p.name).catch((e) => toast(e.message, true)) }),
        h("button", { text: "Load", title: "Load into editors without sending", onclick: () => applyPatch(p.name, { sendNow: false }).catch((e) => toast(e.message, true)) }),
        h("button", { class: "ghost", text: "JSON", onclick: async () => download(`${p.name}.json`, JSON.stringify(await api("patches/" + encodeURIComponent(p.name)), null, 2), "application/json") }),
        del));
  }));
}

function renderFavorites() {
  const favs = S.patches.filter((p) => p.favorite);
  $("#favList").replaceChildren(...(favs.length
    ? favs.map((p) => h("button", { class: "chip", text: p.name, onclick: () => applyPatch(p.name).catch((e) => toast(e.message, true)) }))
    : [h("span", { class: "muted", text: "Star patches in the Library to pin them here." })]));
}

async function importPatchFile(file) {
  try {
    const obj = JSON.parse(await file.text());
    const name = String(obj.name || file.name.replace(/\.json$/i, "")).replace(/[^A-Za-z0-9 _.()\-]/g, "").slice(0, 64).trim() || "Imported";
    if (obj.voice) obj.voice = DX.clampVoice(obj.voice);
    await api("patches/" + encodeURIComponent(name), { method: "PUT", body: JSON.stringify(obj) });
    toast(`Imported "${name}"`); loadPatches();
  } catch (e) { toast("Import failed: " + e.message, true); }
}

// ================================================================ firmware

async function loadFirmware({ autoRefresh = false } = {}) {
  try { S.fw = await api("firmware"); } catch (e) { toast("Firmware: " + e.message, true); return; }
  const checked = S.fw.releases?.checked;
  if (autoRefresh && (!checked || Date.now() - Date.parse(checked) > 12 * 3600e3)) return refreshFirmware();
  renderFirmware();
}

async function refreshFirmware() {
  const btn = $("#fwRefresh");
  btn.disabled = true; btn.textContent = "Checking…";
  try { await api("firmware/refresh", { method: "POST", body: "{}" }); S.fw = await api("firmware"); renderFirmware(); toast("Release info updated"); }
  catch (e) { toast("Update check failed: " + e.message, true); }
  finally { btn.disabled = false; btn.textContent = "Check for updates"; }
}

function fwName(id) { return S.fw?.catalog.find((f) => f.id === id)?.name || id; }

function renderFirmware() {
  const fw = S.fw;
  if (!fw) return;
  const inst = fw.installed;
  $("#fwChecked").textContent = fw.releases?.checked ? "checked " + relTime(fw.releases.checked) : "not checked yet";
  $("#fwBadge").textContent = inst ? `firmware: ${fwName(inst.id)} ${inst.version}` : "firmware: not logged";
  $("#homeFw").textContent = inst ? `${fwName(inst.id)} ${inst.version}` : "not logged (see Firmware tab)";
  updateStockWarn();

  const sel = $("#fwInstalledSel");
  sel.replaceChildren(...fw.catalog.map((f) => h("option", { value: f.id, text: f.name, selected: inst?.id === f.id })));
  $("#fwHistory tbody").replaceChildren(...(fw.history || []).map((r) =>
    h("tr", {}, h("td", { text: r.date.replace("T", " ") }), h("td", { text: fwName(r.id) }), h("td", { text: r.version }), h("td", { class: "muted", text: r.note }))));

  const stats = (f) => fw.releases?.sources?.[f.id]?.stats;
  const score = (f) => { const s = stats(f); return s ? Math.log1p(s.stars) + Math.log1p(s.downloads) : -1; };
  const official = fw.catalog.filter((f) => f.kind !== "community");
  const community = fw.catalog.filter((f) => f.kind === "community")
    .sort((a, b) => score(b) - score(a) || a.name.localeCompare(b.name));

  const known = new Set(fw.catalog.map((f) => f.id));
  const orphans = Object.entries(fw.library || {}).filter(([id]) => !known.has(id));

  $("#fwCards").replaceChildren(
    h("h2", { class: "fw-section" }, "Official"),
    h("div", { class: "fw-cards" }, official.map((f) => fwCard(f, fw, null))),
    h("h2", { class: "fw-section" }, "Community · top 10 free & open source ",
      h("span", { class: "info", title: fw.ranking || "", text: "ⓘ" })),
    h("div", { class: "fw-cards" }, community.map((f, i) => fwCard(f, fw, i + 1))),
    validatedSection(fw, orphans),
    fwDirectory(fw));
  buildChecks();
}

/** The next 20 most popular projects after the cards (#11–#30), one line each. */
function fwDirectory(fw) {
  const dir = fw.directory?.projects || [];
  if (!dir.length) return null;
  const TAG = { closed: "closed source", other: "not a synth" };
  const first = fw.catalog.filter((f) => f.kind === "community").length + 1;
  return h("section", { class: "card dir" },
    h("div", { class: "section-head" },
      h("h3", { text: `Also popular · #${first}–#${first + dir.length - 1}` }),
      h("a", { class: "muted", href: fw.directory.source, target: "_blank", rel: "noopener", text: "full list ↗" })),
    h("ol", { class: "dir-list" }, dir.map((p, i) =>
      h("li", { title: `${p.name}: ${p.desc}${p.license ? ` (${p.license})` : ""}` },
        h("span", { class: "dir-rank", text: `#${first + i}` }),
        h("span", { class: "dir-main" },
          h("a", { href: p.url, target: "_blank", rel: "noopener", text: p.name }),
          TAG[p.group] && h("span", { class: "dir-tag", text: TAG[p.group] }),
          h("span", { class: "dir-desc", text: " · " + p.desc })),
        h("span", { class: "dir-stats", text: `★ ${fmtNum(p.stars)}  ⬇ ${fmtNum(p.downloads)}` })))));
}

// ---------------------------------------------------------------- firmware art

const ICON = {
  dl: "M12 3v12m0 0l-5-5m5 5l5-5M4 19h16",
  ext: "M14 4h6v6m0-6L10 14M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5",
  play: "M7 4l13 8-13 8z",
  code: "M8 7l-5 5 5 5M16 7l5 5-5 5",
  doc: "M6 3h9l4 4v14H6zM14 3v5h5M9 13h7M9 17h7",
  check: "M5 12l5 5 9-10",
};
function icon(k) {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("class", "ic");
  const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
  p.setAttribute("d", ICON[k]); s.append(p);
  return s;
}

// ---------------------------------------------------------------- validation
// firmware/validated.json is written by hands-on validation sessions (see
// VALIDATION.md): a firmware counts as validated only when it was installed,
// run, and reverted to stock on a real FM-1. The orange octopus marks it.

const OCTO = '<svg viewBox="0 0 32 32" class="octo" aria-hidden="true">'
  + '<path fill="#F07A2B" d="M16 3C10 3 6 7.3 6 13c0 3.2 1.4 5.6 3.4 7.1L7 24.5c-.6 1.1-1.9 1.5-3 1-.6-.3-1.3.1-1.2.8.2 1.6 2 2.6 3.7 2.1 1.6-.5 2.6-1.8 3.4-3.2l1.6-2.8.5 4.2c.1 1.2-.6 2.3-1.7 2.7-.6.2-.6 1.1.1 1.2 2 .4 3.8-1 4-3l.4-4.3h2.4l.4 4.3c.2 2 2 3.4 4 3 .7-.1.7-1 .1-1.2-1.1-.4-1.8-1.5-1.7-2.7l.5-4.2 1.6 2.8c.8 1.4 1.8 2.7 3.4 3.2 1.7.5 3.5-.5 3.7-2.1.1-.7-.6-1.1-1.2-.8-1.1.5-2.4.1-3-1l-2.4-4.4C24.6 18.6 26 16.2 26 13c0-5.7-4-10-10-10z"/>'
  + '<circle cx="12.4" cy="13" r="2" fill="#fff"/><circle cx="19.6" cy="13" r="2" fill="#fff"/>'
  + '<circle cx="12.8" cy="13.4" r="1" fill="#2b1a10"/><circle cx="20" cy="13.4" r="1" fill="#2b1a10"/></svg>';

function octo(title, cls = "") {
  const s = h("span", { class: "octo-wrap " + cls, title });
  s.innerHTML = OCTO;
  return s;
}

const isValidated = (v) => v?.steps?.install && v?.steps?.run && v?.steps?.revert;

/** Fully validated records for a firmware id, newest first. */
function validationsFor(fw, id) {
  return (fw.validated || []).filter((v) => v.id === id && isValidated(v))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

function validationTip(v) {
  return `Validated ${v.version} on ${v.date}: installed, ran${v.checks ? ` (${v.checks})` : ""}, reverted to stock.`
    + (v.notes ? `\n${v.notes}` : "");
}

/** Library file matching a validation record (by checksum when recorded, else version + name). */
function validatedFile(fw, v) {
  return (fw.library?.[v.id] || []).find((l) =>
    v.sha256 ? l.sha256 === v.sha256 : normVer(l.version) === normVer(v.version) && (!v.file || l.name === v.file));
}

/** "Validated firmware in Library": every validated firmware, and whether its exact file is kept. */
function validatedSection(fw, orphans) {
  const recs = (fw.validated || []).filter(isValidated)
    .sort((a, b) => fwName(a.id).localeCompare(fwName(b.id)) || String(b.date).localeCompare(String(a.date)));
  const rows = recs.map((v) => {
    const file = validatedFile(fw, v);
    const f = fw.catalog.find((c) => c.id === v.id);
    const rel = fw.releases?.sources?.[v.id]?.releases?.find((r) => normVer(r.version) === normVer(v.version));
    const asset = rel?.assets.find((a) => a.name === v.file) || rel?.assets.find((a) => /\.fwsc$/i.test(a.name));
    let action;
    if (file) action = h("span", { class: "badge ok", title: "sha256 " + file.sha256, text: "✓ in library" });
    else if (f && rel && asset) {
      action = h("button", { class: "ghost", text: "Download" });
      action.onclick = () => downloadAsset(f, rel, asset, action);
    } else action = h("span", { class: "muted", text: "not in library" });
    return h("div", { class: "val-row", title: validationTip(v) },
      octo(validationTip(v)),
      h("b", { text: fwName(v.id) }),
      h("span", { class: "mono", text: shortVer(v.version) }),
      h("span", { class: "muted", text: v.date }),
      h("span", { class: "val-steps", text: "installed ✓ · ran ✓ · reverted ✓" }),
      h("span", { class: "grow" }),
      action);
  });
  return h("section", { class: "card val" },
    h("div", { class: "section-head" },
      h("h3", {}, octo("Validated"), " Validated firmware in Library"),
      h("span", { class: "muted", text: `${recs.length} validated` })),
    rows.length ? rows : h("p", { class: "muted", text: "Nothing validated yet. Validation happens in hands-on Claude Code sessions: flash, run, revert to stock (see VALIDATION.md)." }),
    orphans.length > 0 && h("details", {},
      h("summary", { class: "muted", text: `Other files in library, not in the catalog (${orphans.reduce((n, [, l]) => n + l.length, 0)})` }),
      h("div", { class: "local" }, orphans.map(([id, files]) => files.map((l) => libFileRow(id, l))))));
}

// Each firmware is shown by a real screen capture from its own repo or docs
// (stored in web/img/fw/, source linked in catalog art.credit).
function fwArt(f) {
  const wrap = h("div", { class: "fw-art" });
  if (f.art?.image) {
    wrap.append(h("img", { src: f.art.image, alt: `${f.name} screen`, title: f.art.credit ? "Screen from " + f.art.credit : "" }));
  }
  return wrap;
}

// ---------------------------------------------------------------- cards

/** "ghoulbox-v2.3.2" → "v2.3.2", "fumi-1.0.7" → "1.0.7" */
const shortVer = (v) => String(v).replace(/^[A-Za-z][A-Za-z0-9]*-(?=v?\d)/, "");
const fmtNum = (n) => (n == null ? "–" : n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "k" : String(n));
function relTime(d) {
  const days = Math.floor((Date.now() - Date.parse(d)) / 864e5);
  return isNaN(days) ? d : days <= 0 ? "today" : days === 1 ? "1 d ago" : days < 45 ? `${days} d ago` : d.slice(0, 10);
}

async function downloadAsset(f, rel, a, btn) {
  const label = [...btn.childNodes];
  btn.disabled = true; btn.textContent = "Downloading…";
  try {
    const m = await api("firmware/download", { method: "POST", body: JSON.stringify({ id: f.id, version: rel.version, asset: a.name }) });
    toast(`${a.name} saved${m.verified ? ", checksum verified" : ""}`);
    S.fw = await api("firmware"); renderFirmware();
  } catch (e) { toast(e.message, true); btn.disabled = false; btn.replaceChildren(...label); }
}

function libFileRow(id, l) {
  const del = h("button", { class: "ghost", text: "✕", title: "Delete file" });
  del.onclick = () => confirmClick(del, "Delete?", async () => {
    await api("firmware/file?key=" + encodeURIComponent(l.key), { method: "DELETE" }); S.fw = await api("firmware"); renderFirmware();
  });
  return h("div", { class: "f" },
    h("span", { class: "mono", text: `${l.version}/${l.name}` }),
    h("span", { class: "badge " + (l.verified === true ? "ok" : l.verified === false ? "bad" : ""), text: l.verified === true ? "verified" : l.verified === false ? "MISMATCH" : "no checksum" }),
    h("span", { class: "sha", title: "sha256 " + l.sha256, text: l.sha256.slice(0, 12) + "…" }),
    /\.fwsc$/i.test(l.name) && h("button", { class: "ghost", text: "Log installed", title: "Record that this file is now on the device", onclick: () => markInstalled(l.id, l.version, l.name) }),
    del);
}

function fwCard(f, fw, rank) {
  const src = fw.releases?.sources?.[f.id];
  const st = src?.stats;
  const local = fw.library?.[f.id] || [];
  const inst = fw.installed;
  const isCurrent = inst?.id === f.id;
  const rels = src?.releases || [];
  const latest = rels.find((r) => !r.prerelease) || rels[0];
  const haveLocal = (ver, name) => local.some((l) => normVer(l.version) === normVer(ver) && l.name === name);
  const updateAvail = isCurrent && latest && normVer(inst.version) !== normVer(latest.version);
  const fresh = latest?.date && Date.now() - Date.parse(latest.date) < 2 * 864e5
    && !local.some((l) => normVer(l.version) === normVer(latest.version));
  const primary = latest?.assets.find((a) => /\.fwsc$/i.test(a.name)) || latest?.assets[0];
  const L = f.links || {};

  const art = fwArt(f);
  const vals = validationsFor(fw, f.id);
  const valCurrent = vals.find((v) => latest && normVer(v.version) === normVer(latest.version));
  const valBadge = vals.length > 0 && octo(valCurrent
    ? validationTip(valCurrent)
    : `${validationTip(vals[0])}\nLatest ${latest ? shortVer(latest.version) : "release"} isn't validated yet.`,
    valCurrent ? "" : "older");
  const flags = [
    isCurrent && h("span", { class: "flag on", text: "ON DEVICE" }),
    updateAvail && h("span", { class: "flag up", text: "UPDATE" }),
    fresh && !updateAvail && h("span", { class: "flag new", text: "NEW" }),
  ];

  let dlBtn = null;
  if (primary) {
    const got = haveLocal(latest.version, primary.name);
    dlBtn = h("button", { class: got ? "got" : "primary", title: `${primary.name}${primary.size ? " · " + fmtBytes(primary.size) : ""}` },
      icon(got ? "check" : "dl"), got ? "In library" : /\.fwsc$/i.test(primary.name) ? "Download" : "Get ." + primary.name.split(".").pop());
    dlBtn.onclick = () => (got ? dlBtn.closest(".fw-card").querySelector("details").setAttribute("open", "") : downloadAsset(f, latest, primary, dlBtn));
  }
  const linkBtn = (url, ic, label, title) => url && h("a", { class: "btn" + (label ? "" : " icon-only"), href: url, target: "_blank", rel: "noopener", title: title || label }, icon(ic), label);

  const relBlock = (rel) => h("div", { class: "rel" },
    h("div", { class: "row" }, h("b", { text: rel.version }), h("span", { class: "muted", text: rel.date }),
      rel.prerelease && h("span", { class: "badge warn", text: "pre-release" }),
      (rel.sha256sums || Object.keys(rel.sha256files || {}).length > 0) && h("span", { class: "badge ok", text: "checksums" }),
      rel.url && h("a", { href: rel.url, target: "_blank", rel: "noopener", text: "notes ↗" })),
    rel.assets.length ? rel.assets.map((a) => {
      const got = haveLocal(rel.version, a.name);
      const b = h("button", { class: "ghost", text: got ? "Re-download" : "Download" });
      b.onclick = () => downloadAsset(f, rel, a, b);
      return h("div", { class: "asset" }, h("span", { class: "name", title: a.url, text: a.name }),
        a.size ? h("span", { class: "muted", text: fmtBytes(a.size) }) : null, got && h("span", { class: "badge ok", text: "in library" }), b);
    }) : h("div", { class: "muted", text: "No installable files in this release." }));

  const impVer = h("input", { placeholder: "version", style: "width:100px" });
  const impFile = h("input", { type: "file", hidden: true, accept: ".fwsc,.bin,.zip,.html" });
  impFile.onchange = async () => {
    const file = impFile.files[0];
    if (!file) return;
    try {
      await api(`firmware/import?id=${f.id}&version=${encodeURIComponent(impVer.value || "manual")}&name=${encodeURIComponent(file.name)}`,
        { method: "POST", body: await file.arrayBuffer(), headers: { "Content-Type": "application/octet-stream" } });
      toast(`Imported ${file.name}`); S.fw = await api("firmware"); renderFirmware();
    } catch (e) { toast(e.message, true); }
  };

  const iconLink = (url, ic, title) => url && h("a", { class: "mini", href: url, target: "_blank", rel: "noopener", title }, icon(ic));
  // A library line only when it adds something: files kept, but not the latest release.
  const olderOnly = local.length > 0 && !(primary && haveLocal(latest.version, primary.name));

  return h("div", { class: "fw-card" + (isCurrent ? " current" : ""), "data-id": f.id, style: `--h:${f.art?.hue ?? 20}` },
    h("div", { class: "fw-head" },
      art,
      h("div", { class: "fw-headtext" },
        h("div", { class: "fw-title" }, rank && h("span", { class: "rank", text: `#${rank}` }), h("b", { text: f.name }), valBadge,
          h("span", { class: "grow" }), iconLink(L.docs, "doc", "Manual / docs"), iconLink(L.repo, "code", "Source code")),
        h("div", { class: "by", text: f.author }),
        h("div", { class: "fw-tag", text: f.tagline || "" }))),
    h("div", { class: "fw-body" },
      h("div", { class: "fw-chips" }, (f.tags || []).slice(0, 3).map((t) => h("span", { text: t }))),
      h("div", { class: "fw-stats" },
        flags,
        st && h("span", { title: "GitHub stars" }, "★ ", fmtNum(st.stars)),
        st?.downloads > 0 && h("span", { title: "Firmware downloads, all releases" }, "⬇ ", fmtNum(st.downloads)),
        latest && h("span", { title: `${latest.version} · ${latest.date}` }, h("b", { text: shortVer(latest.version) }), " · " + relTime(latest.date)),
        src?.error && h("span", { class: "badge bad", title: src.error, text: "check failed" }),
        !src && f.source?.type !== "manual" && h("span", { class: "muted", text: "press Check for updates" })),
      h("div", { class: "fw-actions" },
        dlBtn,
        linkBtn(L.install, "ext", f.kind === "stock" ? "Updater" : "Install", "Open the installer"),
        linkBtn(L.try, "play", "Try", "Play it in the browser, no FM-1 needed")),
      olderOnly && h("div", { class: "fw-lib" }, icon("check"), `In library: ${shortVer(local[0].version)} (older)`),
      h("details", { class: "fw-more" }, h("summary", { text: "More" }),
        h("p", { text: f.summary }),
        h("p", { class: "muted" }, h("b", { text: "Install: " }), f.install),
        st && h("p", { class: "muted", text: `${st.license || "no license"} · ${st.releases} releases · last push ${st.pushed}` }),
        rels.map(relBlock),
        h("div", { class: "local" },
          h("div", { class: "row" }, h("b", { text: `Library (${local.length})` }), h("span", { class: "grow" }),
            impVer, h("button", { class: "ghost", text: "Import file…", onclick: () => impFile.click() }), impFile,
            h("button", { class: "ghost", text: "Folder", onclick: () => api("firmware/reveal", { method: "POST", body: JSON.stringify({ id: f.id }) }).catch((e) => toast(e.message, true)) })),
          local.length ? local.map((l) => libFileRow(f.id, l)) : h("div", { class: "muted", text: "Nothing downloaded yet." })))));
}

async function markInstalled(id, version, note = "") {
  try {
    await api("firmware/installed", { method: "POST", body: JSON.stringify({ id, version, note }) });
    S.fw = await api("firmware"); renderFirmware(); toast(`Logged ${fwName(id)} ${version} as installed`);
  } catch (e) { toast(e.message, true); }
}

function updateStockWarn() {
  const inst = S.fw?.installed;
  const tab = $("#tabs .active")?.dataset.tab;
  const show = inst && inst.id !== "official" && tab === "home";
  $("#stockWarn").classList.toggle("hidden", !show);
  if (inst) $("#stockWarnName").textContent = `${fwName(inst.id)} ${inst.version}`;
}

// ================================================================ sound check
// Guided listening tests. Each step plays BEFORE and AFTER with on-screen
// captions, restores the synth, and records the user's answer in settings.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const scNote = async (notes, ms, vel = 100, ch = nch()) => {
  for (const n of [].concat(notes)) send([0x90 | ch, n, vel]);
  await sleep(ms);
  for (const n of [].concat(notes)) send([0x80 | ch, n, 0]);
};
const scBend = (v14) => send([0xe0 | nch(), v14 & 127, v14 >> 7]);
/** Ramp a value from a to b over ms, calling fn(v) about every 30 ms. */
async function scRamp(a, b, ms, fn) {
  const steps = Math.max(1, Math.round(ms / 30));
  for (let i = 0; i <= steps; i++) { fn(Math.round(a + ((b - a) * i) / steps)); await sleep(ms / steps); }
}
/** Safe state for any firmware: pedals, wheels and bend reset, notes off. */
async function scGenericReset() {
  const ch = nch();
  sendCC(ch, 64, 0); sendCC(ch, 1, 0); send([0xd0 | ch, 0]); scBend(8192);
  sendCC(ch, 123, 0);
  for (const n of [48, 55, 60, 64, 67, 72]) send([0x80 | ch, n, 0]);
  await sleep(100);
}
const scFx = (pairs) => { for (const [cc, v] of pairs) sendCC(fch(), cc, v); };
const scReloadVoice1 = async () => { sendPC(2); await sleep(150); sendPC(1); await sleep(250); };
const scParam = (p, v) => send(DX.paramMessage(p, v));
async function scSendVoice(v) {
  const gap = Math.max(2, +S.settings.sysexGap || 4);
  for (let p = 0; p < DX.VOICE_LEN; p++) { scParam(p, v[p]); await sleep(gap); }
  await sleep(100);
}

const STOCK_CHECKS = [
  {
    id: "notes", title: "1. Notes reach the synth",
    expect: "A chord, then three single notes going up.",
    async run(cap) {
      await scReloadVoice1();
      cap("Playing: chord");
      await scNote([60, 64, 67], 1200);
      await sleep(300);
      cap("Playing: three notes going up");
      for (const n of [60, 64, 67]) { await scNote(n, 400); await sleep(100); }
    },
  },
  {
    id: "program", title: "2. Program Change switches voices",
    expect: "The same note four times, each with a different sound (voices 001 to 004).",
    async run(cap) {
      for (let pc = 1; pc <= 4; pc++) {
        sendPC(pc); await sleep(250);
        cap(`Playing: voice ${String(pc).padStart(3, "0")}`);
        await scNote(60, 900); await sleep(300);
      }
    },
    restore: scReloadVoice1,
  },
  {
    id: "reverb", title: "3. FX CCs: reverb",
    expect: "BEFORE: two short dry notes. AFTER: the same notes ring on with a long hall tail.",
    async run(cap) {
      await scReloadVoice1();
      scFx([[4, 0]]); await sleep(100);
      cap("BEFORE: reverb off");
      for (let i = 0; i < 2; i++) { await scNote(67, 150); await sleep(250); }
      await sleep(1200);
      scFx([[4, 127], [5, 1], [6, 90], [7, 90]]); await sleep(150);
      cap("AFTER: reverb on (hall, long, wet)");
      for (let i = 0; i < 2; i++) { await scNote(67, 150); await sleep(250); }
      await sleep(2500);
    },
    restore: async () => scFx([[4, 0]]),
  },
  {
    id: "distortion", title: "4. FX CCs: distortion",
    expect: "BEFORE: a clean note. AFTER: the same note, gritty and fuzzy.",
    async run(cap) {
      await scReloadVoice1();
      scFx([[12, 0]]); await sleep(100);
      cap("BEFORE: clean");
      await scNote(48, 1300); await sleep(500);
      scFx([[12, 127], [13, 100], [14, 60], [15, 70]]); await sleep(150);
      cap("AFTER: distortion on");
      await scNote(48, 1300); await sleep(400);
    },
    restore: async () => scFx([[12, 0]]),
  },
  {
    id: "filter", title: "5. FX CCs: filter sweep",
    expect: "One long note that gets muffled, then opens up again (a slow \"wow\").",
    async run(cap) {
      await scReloadVoice1();
      scFx([[0, 127], [1, 0], [3, 6], [2, 107]]); await sleep(100);
      cap("Playing: one long note, cutoff sweeping down then up");
      send([0x90 | nch(), 48, 100]);
      for (let v = 107; v >= 5; v -= 3) { sendCC(fch(), 2, v); await sleep(35); }
      for (let v = 5; v <= 107; v += 3) { sendCC(fch(), 2, v); await sleep(35); }
      send([0x80 | nch(), 48, 0]);
      await sleep(400);
    },
    restore: async () => scFx([[0, 0], [2, 107]]),
  },
  {
    id: "sysex-voice", title: "6. SysEx: whole voice",
    expect: "BEFORE: voice 001 as usual. AFTER: a plain, pure sine beep (the DX7 INIT VOICE).",
    async run(cap) {
      await scReloadVoice1();
      cap("BEFORE: voice 001");
      await scNote(60, 1000); await sleep(400);
      cap("Sending INIT VOICE over SysEx (156 messages)…");
      await scSendVoice(DX.initVoice());
      cap("AFTER: should be a pure sine beep");
      await scNote(60, 1000); await sleep(300);
    },
    restore: scReloadVoice1,
  },
  {
    id: "sysex-param", title: "7. SysEx: single parameter",
    expect: "The same key three times: base pitch, one octave higher, then higher again (octave + fifth).",
    async run(cap) {
      await scReloadVoice1();
      await scSendVoice(DX.initVoice());
      const coarse = DX.opParam(1, 18);
      cap("Playing: base pitch (ratio 1)");
      await scNote(60, 700); await sleep(300);
      scParam(coarse, 2); await sleep(80);
      cap("Playing: OP1 ratio 2 (one octave up)");
      await scNote(60, 700); await sleep(300);
      scParam(coarse, 3); await sleep(80);
      cap("Playing: OP1 ratio 3 (octave + fifth)");
      await scNote(60, 700); await sleep(300);
    },
    restore: scReloadVoice1,
  },
  {
    id: "bend", title: "8. Pitch bend",
    expect: "One note that slides up and back down.",
    async run(cap) {
      await scReloadVoice1();
      cap("Playing: note with a bend up and back");
      send([0x90 | nch(), 60, 100]);
      await sleep(300);
      await scRamp(8192, 16383, 600, scBend);
      await sleep(300);
      await scRamp(16383, 8192, 600, scBend);
      await sleep(300);
      send([0x80 | nch(), 60, 0]);
    },
    restore: async () => scBend(8192),
  },
];

// Standard MIDI only: works with any firmware that accepts MIDI input.
// Uses the note channel from Play & MIDI; the channel scan helps find it.
const GENERIC_CHECKS = [
  {
    id: "g-notes", title: "1. Notes on the note channel",
    expect: () => `A chord, then three single notes going up, on ch ${S.settings.noteCh}. Silence? Run the channel scan (step 2).`,
    async run(cap) {
      cap(`Playing: chord on ch ${S.settings.noteCh}`);
      await scNote([60, 64, 67], 1200);
      await sleep(300);
      cap("Playing: three notes going up");
      for (const n of [60, 64, 67]) { await scNote(n, 400); await sleep(100); }
    },
  },
  {
    id: "g-channels", title: "2. Channel scan",
    expect: () => "One note on each MIDI channel, 1 to 16, with the channel shown in the caption. Write down which channels sounded, then set Play & MIDI → Note channel to one of them.",
    async run(cap) {
      for (let ch = 0; ch < 16; ch++) {
        cap(`Playing: channel ${ch + 1}`);
        await scNote(60 + (ch % 2) * 7, 450, 100, ch);
        await sleep(350);
      }
    },
    noteHint: "channels that sounded, e.g. 1, 2",
  },
  {
    id: "g-velocity", title: "3. Velocity",
    expect: () => "The same note three times: soft, medium, hard. Louder or brighter each time if the firmware uses velocity.",
    async run(cap) {
      for (const [v, label] of [[20, "soft (vel 20)"], [70, "medium (vel 70)"], [127, "hard (vel 127)"]]) {
        cap(`Playing: ${label}`);
        await scNote(60, 600, v); await sleep(350);
      }
    },
  },
  {
    id: "g-sustain", title: "4. Sustain pedal (CC 64)",
    expect: () => "BEFORE: a short note that stops. AFTER: the same short note keeps ringing until the pedal lifts about 2 s later.",
    async run(cap) {
      cap("BEFORE: short note, no sustain");
      await scNote(60, 200); await sleep(1500);
      sendCC(nch(), 64, 127); await sleep(50);
      cap("AFTER: short note, sustain held…");
      await scNote(60, 200); await sleep(2000);
      cap("Pedal up");
      sendCC(nch(), 64, 0); await sleep(800);
    },
    restore: scGenericReset,
  },
  {
    id: "g-mod", title: "5. Mod wheel (CC 1)",
    expect: () => "One long note. Vibrato or another change fades in, then out, if the firmware maps the mod wheel.",
    async run(cap) {
      cap("Playing: held note, mod wheel 0 → 127 → 0");
      send([0x90 | nch(), 60, 100]);
      await sleep(400);
      await scRamp(0, 127, 1200, (v) => sendCC(nch(), 1, v));
      await sleep(800);
      await scRamp(127, 0, 1000, (v) => sendCC(nch(), 1, v));
      send([0x80 | nch(), 60, 0]);
    },
    restore: scGenericReset,
  },
  {
    id: "g-bend", title: "6. Pitch bend",
    expect: () => "One note that slides up and back down.",
    async run(cap) {
      cap("Playing: note with a bend up and back");
      send([0x90 | nch(), 60, 100]);
      await sleep(300);
      await scRamp(8192, 16383, 600, scBend);
      await sleep(300);
      await scRamp(16383, 8192, 600, scBend);
      await sleep(300);
      send([0x80 | nch(), 60, 0]);
    },
    restore: scGenericReset,
  },
  {
    id: "g-aftertouch", title: "7. Channel aftertouch",
    expect: () => "One long note that changes (louder, brighter or vibrato) while pressure rises, if the firmware uses aftertouch.",
    async run(cap) {
      cap("Playing: held note, aftertouch 0 → 127 → 0");
      send([0x90 | nch(), 60, 100]);
      await sleep(400);
      await scRamp(0, 127, 1200, (v) => send([0xd0 | nch(), v]));
      await sleep(600);
      await scRamp(127, 0, 800, (v) => send([0xd0 | nch(), v]));
      send([0x80 | nch(), 60, 0]);
    },
    restore: scGenericReset,
  },
  {
    id: "g-program", title: "8. Program Change (optional)",
    expect: () => "The same note four times with different sounds (programs 1–4). Many community firmwares ignore Program Change, so silence here is fine.",
    async run(cap) {
      for (let pc = 1; pc <= 4; pc++) {
        sendPC(pc); await sleep(250);
        cap(`Playing: program ${pc}`);
        await scNote(60, 800); await sleep(300);
      }
      sendPC(1);
    },
  },
  {
    id: "g-clock", title: "9. Clock sync (arp / sequencer)",
    expect: () => "Prepare first: on the FM-1, set up a pattern or the arpeggiator so it plays (or waits) on external clock. On Run it starts, plays 4 s at 80 BPM, 4 s at 160 BPM (noticeably faster), then stops.",
    async run(cap) {
      const t0 = performance.now() + 50;
      S.out.send([0xfa], t0);
      let t = t0;
      for (const [bpm, ms] of [[80, 4000], [160, 4000]]) {
        const iv = 60000 / (bpm * 24);
        const end = t + ms;
        for (; t < end; t += iv) S.out.send([0xf8], t);
      }
      S.out.send([0xfc], t);
      logText("out", "Sound check clock: start, 80 BPM 4 s, 160 BPM 4 s, stop");
      cap("Clock: 80 BPM"); await sleep(4050);
      cap("Clock: 160 BPM (faster)"); await sleep(4000);
      cap("Clock: stopped"); await sleep(400);
    },
    restore: async () => { send([0xfc]); await scGenericReset(); },
  },
  {
    id: "g-allnotesoff", title: "10. All Notes Off (CC 123)",
    expect: () => "A chord starts with no note-off. After about 1.5 s an All Notes Off message should cut it. If it keeps sounding until the safety note-offs 2 s later, CC 123 isn't supported.",
    async run(cap) {
      cap("Playing: chord, no note-off sent");
      for (const n of [55, 60, 64]) send([0x90 | nch(), n, 100]);
      await sleep(1500);
      cap("Sent All Notes Off: should stop now");
      sendCC(nch(), 123, 0);
      await sleep(2000);
      cap("Safety note-offs sent");
      for (const n of [55, 60, 64]) send([0x80 | nch(), n, 0]);
    },
  },
  {
    id: "g-ccprobe", title: "11. CC probe",
    expect: (v) => `A held note while CC ${v.cc} sweeps 0 → 127 → 0 on ch ${v.ch}. Use this to find what a firmware maps to a CC, or to test MIDI learn (common ones: 74 cutoff, 71 resonance, 7 volume, 10 pan, 91 reverb).`,
    params: [
      { key: "cc", label: "CC", min: 0, max: 127, def: () => 74 },
      { key: "ch", label: "Ch", min: 1, max: 16, def: () => S.settings.noteCh },
    ],
    async run(cap, v) {
      const ch = (v.ch - 1) & 15;
      cap(`Playing: held note, CC ${v.cc} on ch ${v.ch}: 0 → 127 → 0`);
      send([0x90 | nch(), 48, 100]);
      await sleep(300);
      await scRamp(0, 127, 1500, (x) => sendCC(ch, v.cc, x));
      await sleep(400);
      await scRamp(127, 0, 1500, (x) => sendCC(ch, v.cc, x));
      send([0x80 | nch(), 48, 0]);
    },
    noteHint: "what the CC did",
  },
];

const CHECK_SETS = {
  stock: { label: "Stock M-VAVE", checks: STOCK_CHECKS,
    blurb: "Uses the stock firmware's own map: FX CCs 0–23 on the FX channel, DX7-style SysEx voice editing, Program Change to voices 001–128. Steps restore the synth by reloading voice 001." },
  generic: { label: "Generic MIDI", checks: GENERIC_CHECKS,
    blurb: "Standard MIDI only, for community firmware (Felucca, Melodee, SLOOP, X0X…) or any synth. Sends on the note channel set in Play & MIDI. Start with the channel scan if nothing sounds." },
};

let checkRunning = false;

function checkMode() {
  const inst = S.fw?.installed;
  const m = S.settings.checkMode || "auto";
  if (m !== "auto") return m;
  return inst && inst.id !== "official" ? "generic" : "stock";
}

/** Results are kept per test mode and per logged firmware. */
function checkProfile() {
  const inst = S.fw?.installed;
  const mode = checkMode();
  const fwKey = inst ? `${inst.id}@${inst.version}` : "unlogged";
  const fwLabel = inst ? `${fwName(inst.id)} ${inst.version}` : "firmware not logged";
  const all = S.settings.soundcheck || (S.settings.soundcheck = {});
  // Migrate the first, flat format ({stepId: result}) to a profile.
  if (Object.values(all).some((v) => v && "result" in v)) {
    const flat = {};
    for (const [k, v] of Object.entries(all)) if (v && "result" in v) { flat[k] = v; delete all[k]; }
    all["stock|unlogged"] = { mode: "stock", label: "Stock M-VAVE · firmware not logged", steps: flat };
  }
  const key = `${mode}|${fwKey}`;
  all[key] ||= { mode, label: `${CHECK_SETS[mode].label} · ${fwLabel}`, steps: {} };
  return { key, mode, fwLabel, entry: all[key], all };
}

function checkParams(c) {
  const saved = (S.settings.checkParams ||= {})[c.id] || {};
  return Object.fromEntries((c.params || []).map((p) => [p.key, saved[p.key] ?? p.def()]));
}

function tally(steps, total) {
  const v = Object.values(steps).filter((r) => r.result);
  const n = (x) => v.filter((r) => r.result === x).length;
  return `${n("yes")} heard · ${n("no")} not heard · ${n("unsure")} unsure · ${total - v.length} to go`;
}

function buildChecks() {
  if (checkRunning) return;
  const prof = checkProfile();
  const set = CHECK_SETS[prof.mode];
  const results = prof.entry.steps;
  const inst = S.fw?.installed;

  // header: mode switch, what's being recorded, earlier profiles
  const pick = S.settings.checkMode || "auto";
  const modeBtn = (m, label) => h("button", {
    class: pick === m ? "primary" : "", text: label,
    onclick: () => { S.settings.checkMode = m; saveSettings(); buildChecks(); },
  });
  const others = Object.entries(prof.all).filter(([k]) => k !== prof.key);
  $("#checkHead").replaceChildren(
    h("div", { class: "row" },
      h("b", { text: "Mode:" }),
      modeBtn("auto", `Auto → ${inst && inst.id !== "official" ? "Generic" : "Stock"}`),
      modeBtn("stock", "Stock M-VAVE"), modeBtn("generic", "Generic MIDI")),
    h("p", { class: "hint", text: set.blurb }),
    prof.mode === "stock" && inst && inst.id !== "official"
      && h("p", { class: "badge warn", text: `The device is logged as ${prof.fwLabel}. Stock steps may not apply; Generic MIDI is the safer choice.` }),
    h("p", { class: "hint" }, "Recording results for: ", h("b", { text: prof.entry.label }),
      inst ? "" : ". Log the firmware on the Firmware tab to keep results per firmware."),
    others.length > 0 && h("details", {}, h("summary", { class: "muted", text: `Earlier results (${others.length})` }),
      h("table", { class: "table" }, h("tbody", {}, others.map(([, p]) =>
        h("tr", {}, h("td", { text: p.label }), h("td", { class: "muted", text: tally(p.steps, CHECK_SETS[p.mode]?.checks.length || 0) })))))));

  $("#checkList").replaceChildren(...set.checks.map((c) => {
    const vals = checkParams(c);
    const caption = h("div", { class: "caption" });
    const expect = h("div", { class: "expect", text: "Listen for: " + (typeof c.expect === "function" ? c.expect(vals) : c.expect) });
    const runBtn = h("button", { class: "primary", text: "▶ Run" });
    const ans = (val, label) => {
      const b = h("button", { text: label, class: results[c.id]?.result === val ? "sel-" + val : "" });
      b.onclick = () => { results[c.id] = { ...results[c.id], result: val, at: new Date().toISOString() }; saveSettings(); buildChecks(); };
      return b;
    };
    const paramInputs = (c.params || []).map((p) => h("label", { class: "stack" }, p.label,
      h("input", { type: "number", min: p.min, max: p.max, value: vals[p.key], onchange: (e) => {
        const v = Math.max(p.min, Math.min(p.max, +e.target.value || 0));
        e.target.value = v; vals[p.key] = v;
        S.settings.checkParams[c.id] = { ...vals };
        expect.textContent = "Listen for: " + c.expect(vals);
        saveSettings();
      } })));
    const note = h("input", { class: "grow", placeholder: "Notes (optional)" + (c.noteHint ? `: ${c.noteHint}` : ""), value: results[c.id]?.note || "",
      onchange: (e) => { results[c.id] = { ...results[c.id], note: e.target.value }; saveSettings(); } });
    const card = h("div", { class: "check", "data-id": c.id },
      h("div", {}, h("div", { class: "t", text: c.title }), expect),
      h("div", { class: "answers" }, runBtn, ans("yes", "Heard it"), ans("no", "Didn't hear"), ans("unsure", "Not sure")),
      h("div", { class: "row", style: "grid-column:1/-1" }, paramInputs, note),
      caption);
    runBtn.onclick = async () => {
      if (checkRunning) return toast("A step is already running", true);
      if (!S.out) return toast("Not connected. Press Connect first.", true);
      checkRunning = true;
      $$(".check button, #checkHead button").forEach((b) => (b.disabled = true));
      card.classList.add("running");
      const cap = (t) => (caption.textContent = t);
      try {
        await c.run(cap, vals);
        cap("Restoring…");
        if (c.restore) await c.restore();
        cap("Done. Did you hear it? Answer on the right, or press Run again.");
      } catch (e) {
        cap("Error: " + e.message);
        await scGenericReset().catch(() => {});
      } finally {
        checkRunning = false;
        card.classList.remove("running");
        $$(".check button, #checkHead button").forEach((b) => (b.disabled = false));
      }
    };
    return card;
  }));
  $("#checkSummary").textContent = tally(results, set.checks.length);
}

// ================================================================ explore

function buildExplore() {
  const fxRows = FX_DEFS.flatMap((d) => [[d.sw, d.name, "Switch", "0 = off, ≥1 = on"],
    ...d.params.map((p) => [p.cc, d.name, p.label, p.options ? `0–${p.max} (${p.options.join("/")})` : `0–${p.max}`])]);
  const card = (title, ...kids) => h("div", { class: "card" }, h("h3", { text: title }), ...kids);
  const ul = (...items) => h("ul", {}, items.map((i) => h("li", {}, i)));
  const link = (u, t) => h("a", { href: u, target: "_blank", rel: "noopener", text: t });
  const table = (head, rows) => h("table", { class: "table" }, h("thead", {}, h("tr", {}, head.map((c) => h("th", { text: c })))),
    h("tbody", {}, rows.map((r) => h("tr", {}, r.map((c) => h("td", { text: c }))))));

  $("#exploreBody").replaceChildren(h("div", { class: "explore-grid" },
    card("Hardware at a glance", ul(
      "6-operator FM engine, 32 algorithms (DX7-style, Dexed/msfa-derived)",
      "12-voice polyphony, 128 voice slots (4 groups A–D)",
      "27-key silicone keyboard (no velocity: always 90), 7 encoders plus volume, color TFT",
      "Arpeggiator, step sequencer (chain mode, long notes, per-pattern voice)",
      "Multi-FX: filter, reverb, delay, distortion, chorus, phaser",
      "USB-C MIDI and USB audio, 3.5 mm TRS MIDI in, Bluetooth MIDI",
      "Speaker, 3.5 mm stereo out, 2000 mAh battery (~12 h)",
      "MCU: JieLi AC791N/WL82 (pi32v2), 1 MiB flash",
      "Your unit: USB VID 4C4A, PID C755 (FM-1 Midi + FM-1 Audio)")),
    card("Things to try",
      ul(
        "Measured on this unit (2026-10-18): keys send notes on ch 1 at a fixed velocity of 90 (note-off velocity 100). Knobs and preset changes send nothing over USB MIDI, so the dashboard can't follow presets you pick on the device.",
        "Play & MIDI → CC discovery: re-check what the FM-1 transmits after a firmware change. Felucca and Melodee add MIDI learn and per-track channels.",
        "Start the clock under Perform above. The arp and sequencer follow external BPM (F8), and Start always restarts at step 0.",
        "Program Change 1–128 selects voices 001–128 (since V13).",
        "Import any DX7 .syx bank in the Voice editor above. Thousands of free banks exist, and the FM-1 takes the same parameter layout.",
        "Long-press an OPx button to mute that operator (V15).",
        "Glide (Glob page 2, 0–1 s) only works on mono voices.",
        "Gotcha: CC 1 on the FX channel (default ch 2) is Filter Type, not mod wheel. Play on ch 1.",
        "USB rescue: hold OCT− while switching on.")),
    card("Note channel (default: All/Omni)",
      table(["Message", "Status", "Data", "Response"], [
        ["Note on", "9n", "note, vel 1–127", "vel 0 = note off (V15)"],
        ["Note off", "8n", "note", "release"],
        ["Program change", "Cn", "0–127", "voice 001–128"],
        ["Pitch bend", "En", "14-bit", "pitch bend"],
        ["Aftertouch", "Dn", "0–127", "channel AT"],
        ["Mod wheel", "Bn", "CC 1", "modulation"],
        ["Sustain", "Bn", "CC 64", "sustain"]]),
      h("p", { class: "hint", text: "Real-time: F8 clock, FA start, FB continue (acts as start), FC stop." })),
    card("FX channel (default ch 2): CC 0–23", table(["CC", "Effect", "Param", "Range"], fxRows)),
    card("SysEx voice parameter write",
      h("p", {}, h("code", { text: "F0 43 10 pp qq vv F7" }), "  param = pp×128 + qq (0–155), value vv."),
      h("p", { class: "muted", text: "This is the DX7 parameter-change format. 0–125: six operators × 21 params (OP6 first). 126–133: pitch EG. 134: algorithm. 135: feedback. 136: osc sync. 137–143: LFO. 144: transpose. 145–154: name. 155: operator on/off bits." })),
    card("Official firmware history", ul(
      "V15 (2026-07-30): glide, voice reset/rename/copy, init voice, OP mute, SEQ long notes, voice binding, chain mode, FX/ENV ranges 0–100, vel-0 note off, FX CC table",
      "V13 (2026-07-03): ARP/SEQ BPM sync, voice change in SEQ, MIDI channel select (default All), Program Change 0–127, rates 1/1 and 1/2",
      "V09 (2026-06-24): ENV on/off switch, rate edits while recording")),
    card("Sources", ul(
      link("https://www.m-vave.com/download.html", "M-VAVE downloads (firmware, M-UPGRADE, MIDI guide)"),
      link("https://github.com/AL-255/FM-1-RE", "FM-1-RE: reverse-engineering notes (hardware, OTA protocol)"),
      link("https://www.synthtopia.com/content/2026/07/13/m-vave-introduces-fm-1-fm-pocket-synthesizer/", "Synthtopia: FM-1 announcement"),
      link("https://synthanatomy.com/2026/07/m-vave-fm-1-review-low-budget-pocket-fm-ynthesizer-with-iconic-sounds.html", "Synth Anatomy review"),
      link("https://www.elektronauts.com/t/m-vave-fm-1/252170", "Elektronauts FM-1 thread")))));
}

// ================================================================ home / customize

function applyTheme() {
  const t = S.settings.theme;
  if (t === "auto") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", t);
  if (S.settings.accent) document.documentElement.style.setProperty("--accent", S.settings.accent);
  else document.documentElement.style.removeProperty("--accent");
}

function applyWidgets() {
  for (const w of $$(".widget")) w.classList.toggle("hidden", S.settings.widgets[w.dataset.widget] === false);
  // Hide a container once every widget in it is switched off.
  for (const box of $$(".home-panel, .home-duo")) box.classList.toggle("hidden", !$(".widget:not(.hidden)", box));
}

function renderHomeStatus() {
  const on = !!S.out;
  $("#homeDot").className = "dot " + (on ? "on" : "off");
  $("#homeConn").textContent = on ? "Connected" : S.midi ? "No output selected" : "Not connected";
  $("#homeConn").title = on ? S.out.name : "";
}

/** Collapsible Home sections: a .sec-toggle shows/hides its aria-controls target, remembered per browser. */
function wireCollapsibles() {
  for (const btn of $$(".sec-toggle")) {
    const body = $("#" + btn.getAttribute("aria-controls"));
    const key = "fm1.open." + body.id;
    const set = (open) => { body.classList.toggle("hidden", !open); btn.setAttribute("aria-expanded", open); };
    try { const v = localStorage.getItem(key); if (v != null) set(v === "1"); } catch {}
    btn.onclick = () => {
      const open = body.classList.contains("hidden");
      set(open);
      try { localStorage.setItem(key, open ? "1" : "0"); } catch {}
    };
  }
}

function buildCustomize() {
  const box = $("#widgetToggles");
  box.replaceChildren(
    ...Object.entries(WIDGETS).map(([k, label]) => h("label", {},
      h("input", { type: "checkbox", checked: S.settings.widgets[k] !== false, onchange: (e) => { S.settings.widgets[k] = e.target.checked; applyWidgets(); saveSettings(); } }),
      " " + label)),
    h("label", {}, "Theme ", h("select", { onchange: (e) => { S.settings.theme = e.target.value; applyTheme(); saveSettings(); } },
      ["auto", "light", "dark"].map((t) => h("option", { value: t, text: t, selected: S.settings.theme === t })))),
    h("label", {}, "Accent ", h("input", { type: "color", value: S.settings.accent || "#d9622b", oninput: (e) => { S.settings.accent = e.target.value; applyTheme(); saveSettings(); } })),
    h("button", { class: "ghost", text: "Reset accent", onclick: () => { S.settings.accent = ""; applyTheme(); saveSettings(); } }));
}

// ================================================================ wiring

function chOptions(sel, value) {
  sel.replaceChildren(...Array.from({ length: 16 }, (_, i) => h("option", { value: i + 1, text: `ch ${i + 1}`, selected: value === i + 1 })));
}

function switchTab(name) {
  // Old saved tabs (voice, fx, explore) now live on FM-1 Home.
  if (!document.getElementById("tab-" + name)) name = "home";
  $$("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  $$(".tab").forEach((t) => t.classList.toggle("active", t.id === "tab-" + name));
  updateStockWarn();
  try { localStorage.setItem("fm1.tab", name); } catch {}
  // Always re-read: validated.json and the library change outside the app.
  if (name === "firmware") loadFirmware({ autoRefresh: !S.fw });
}

function wire() {
  $$("#tabs button").forEach((b) => (b.onclick = () => switchTab(b.dataset.tab)));
  $("#connectBtn").onclick = () => connectMidi();
  $("#outSel").onchange = () => { bindPorts(); saveSettings(); };
  $("#inSel").onchange = () => { bindPorts(); saveSettings(); };
  $("#releaseBtn").onclick = releaseMidi;
  chOptions($("#noteCh"), S.settings.noteCh);
  $("#noteCh").onchange = (e) => { S.settings.noteCh = +e.target.value; updateConn(); saveSettings(); };
  $("#sysexGap").value = S.settings.sysexGap;
  $("#sysexGap").onchange = (e) => { S.settings.sysexGap = Math.max(0, Math.min(50, +e.target.value || 0)); saveSettings(); };

  // perform
  $("#pcNum").value = S.settings.program || 1;
  const pcStep = (d) => { const n = Math.max(1, Math.min(128, +$("#pcNum").value + d)); $("#pcNum").value = n; S.settings.program = n; sendPC(n); saveSettings(); };
  $("#pcDown").onclick = () => pcStep(-1);
  $("#pcUp").onclick = () => pcStep(1);
  $("#pcSend").onclick = () => pcStep(0);
  $("#bpm").value = S.settings.bpm;
  $("#bpm").onchange = (e) => { S.settings.bpm = Math.max(30, Math.min(300, +e.target.value || 120)); e.target.value = S.settings.bpm; saveSettings(); };
  $("#clockStart").onclick = startClock;
  $("#clockStop").onclick = () => stopClock(true);
  $("#panicBtn").onclick = panic;
  $("#velocity").value = S.settings.velocity;
  $("#velocity").oninput = (e) => { S.settings.velocity = +e.target.value; saveSettings(); };

  // controllers
  $("#modWheel").oninput = (e) => sendCC(nch(), 1, +e.target.value);
  const pb = $("#pitchBend");
  pb.oninput = () => { const v = +pb.value + 8192; send([0xe0 | nch(), v & 127, v >> 7]); };
  pb.onchange = () => { pb.value = 0; send([0xe0 | nch(), 0, 64]); };
  $("#aftertouch").oninput = (e) => send([0xd0 | nch(), +e.target.value]);
  $("#sustain").onchange = (e) => sendCC(nch(), 64, e.target.checked ? 127 : 0);
  $("#rawSend").onclick = () => {
    const bytes = $("#rawHex").value.trim().split(/[\s,]+/).filter(Boolean).map((x) => parseInt(x, 16));
    if (!bytes.length || bytes.some((b) => isNaN(b) || b < 0 || b > 255)) return toast("Enter hex bytes like 90 3C 64", true);
    send(bytes);
  };
  $("#monClear").onclick = () => $("#monitor").replaceChildren();
  $("#ccClear").onclick = () => { ccSeen.clear(); renderCcTable(); };

  // voice
  $("#liveSend").checked = S.settings.liveSend;
  $("#liveSend").onchange = (e) => { S.settings.liveSend = e.target.checked; saveSettings(); };
  $("#sendVoice").onclick = () => sendWholeVoice();
  $("#algNum").onchange = (e) => setParam(134, Math.max(1, Math.min(32, +e.target.value || 1)) - 1);
  $("#voiceName").oninput = (e) => {
    DX.setName(S.voice, e.target.value);
    updateVoiceSummary();
    if (S.settings.liveSend) for (let p = DX.NAME_OFFSET; p < DX.NAME_OFFSET + 10; p++) queueParam(p);
    saveSettings();
  };
  $("#initVoiceBtn").onclick = () => loadVoice(DX.initVoice());
  $("#randVoiceBtn").onclick = randomVoice;
  $("#exportSyx").onclick = () => download(`${DX.getName(S.voice) || "voice"}.syx`, DX.voiceToSyx(S.voice));
  $("#saveVoicePatch").onclick = () => openSave({ voice: true, fx: false });
  $("#syxFile").onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    const { voices, warnings } = DX.parseSyx(await file.arrayBuffer());
    if (warnings.length) toast(warnings.join("; "), !voices.length);
    if (!voices.length) return;
    if (voices.length === 1) { $("#bankPick").classList.add("hidden"); loadVoice(voices[0].data); return; }
    S.bank = voices;
    $("#bankName").textContent = `${file.name}: ${voices.length} voices. Click one to load${S.settings.liveSend ? " and send" : ""}.`;
    $("#bankVoices").replaceChildren(...voices.map((v, i) => {
      const chip = h("button", { class: "chip", text: `${i + 1}. ${v.name}` });
      chip.onclick = () => { $$("#bankVoices .chip").forEach((c) => c.classList.remove("sel")); chip.classList.add("sel"); loadVoice(v.data); };
      return chip;
    }));
    $("#bankPick").classList.remove("hidden");
  };

  // fx (pull-down on FM-1 Home)
  chOptions($("#fxCh"), S.settings.fxCh);
  $("#fxCh").onchange = (e) => { S.settings.fxCh = +e.target.value; updateConn(); saveSettings(); };
  $("#fxToggle").onclick = () => toggleFxPanel();
  $("#fxPanel").addEventListener("keydown", (e) => { if (e.key === "Escape") { toggleFxPanel(false); $("#fxToggle").focus(); } });
  $("#fxSendAll").onclick = () => sendAllFx();
  $("#fxSave").onclick = () => openSave({ voice: false, fx: true });

  // library
  $("#libSearch").oninput = renderLibrary;
  $("#libNew").onclick = () => openSave({ voice: true, fx: true });
  $("#libImport").onchange = (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) importPatchFile(f); };

  // firmware
  $("#fwRefresh").onclick = refreshFirmware;
  $("#fwReveal").onclick = () => api("firmware/reveal", { method: "POST", body: JSON.stringify({ id: "" }) }).catch((e) => toast(e.message, true));
  $("#fwMarkInstalled").onclick = () => {
    const ver = $("#fwInstalledVer").value.trim();
    if (!ver) return toast("Enter the version that's on the device", true);
    markInstalled($("#fwInstalledSel").value, ver, $("#fwInstalledNote").value.trim());
  };

  // home
  $("#customizeBtn").onclick = () => {
    const open = !$("#customizePanel").classList.toggle("hidden");
    $("#customizeBtn").setAttribute("aria-expanded", open);
  };
  wireCollapsibles();
  $("#userNotes").value = S.settings.notes || "";
  $("#userNotes").oninput = (e) => { S.settings.notes = e.target.value; saveSettings(); };
}

async function init() {
  try {
    const saved = await api("settings");
    S.settings = { ...structuredClone(DEFAULTS), ...saved, widgets: { ...DEFAULTS.widgets, ...(saved.widgets || {}) } };
    if (Array.isArray(saved.voice) && saved.voice.length === DX.VOICE_LEN) S.voice = DX.clampVoice(saved.voice);
    if (saved.fx) S.fx = { ...defaultFx(), ...saved.fx };
  } catch (e) {
    toast("Can't reach the local server. Start it with: python server.py", true);
  }
  applyTheme();
  buildSaveDialog();
  wire();
  buildCustomize();
  applyWidgets();
  buildKeyboards();
  buildVoiceEditor();
  refreshVoiceUI();
  buildFx();
  buildExplore();
  buildChecks();
  $("#checkReset").onclick = (e) => confirmClick(e.target, "Confirm clear", () => { checkProfile().entry.steps = {}; saveSettings(); buildChecks(); });
  updateConn();
  loadPatches();
  loadFirmware({ autoRefresh: true });

  let tab = "home";
  try { tab = localStorage.getItem("fm1.tab") || "home"; } catch {}
  switchTab(tab);
  // Coming back to the window: pick up validations or downloads made meanwhile.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && $("#tabs .active")?.dataset.tab === "firmware") loadFirmware();
  });

  // Reconnect silently if MIDI+SysEx permission was granted before.
  try {
    const perm = await navigator.permissions.query({ name: "midi", sysex: true });
    if (perm.state === "granted") connectMidi(true);
  } catch {}
}

init();
