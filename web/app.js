import * as DX from "./dx7.js";
import { mountFm1Keys, fm1LowNote } from "./fm1keys.js";

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

// ----- standard MIDI names (MIDI 1.0 / General MIDI), used by the Play & MIDI monitor and CC discovery
const CC_NAMES = {
  0: "Bank Select", 1: "Modulation", 2: "Breath", 4: "Foot", 5: "Portamento Time", 6: "Data Entry",
  7: "Volume", 8: "Balance", 10: "Pan", 11: "Expression", 12: "Effect Control 1", 13: "Effect Control 2",
  16: "General Purpose 1", 17: "General Purpose 2", 18: "General Purpose 3", 19: "General Purpose 4",
  64: "Sustain", 65: "Portamento", 66: "Sostenuto", 67: "Soft Pedal", 68: "Legato", 69: "Hold 2",
  70: "Sound Variation", 71: "Resonance", 72: "Release", 73: "Attack", 74: "Cutoff / Brightness",
  75: "Decay", 76: "Vibrato Rate", 77: "Vibrato Depth", 78: "Vibrato Delay", 79: "Sound Controller 10",
  80: "General Purpose 5", 81: "General Purpose 6", 82: "General Purpose 7", 83: "General Purpose 8",
  84: "Portamento Control", 88: "High Res Velocity", 91: "Reverb", 92: "Tremolo", 93: "Chorus",
  94: "Detune", 95: "Phaser", 96: "Data Increment", 97: "Data Decrement", 98: "NRPN LSB", 99: "NRPN MSB",
  100: "RPN LSB", 101: "RPN MSB", 120: "All Sound Off", 121: "Reset All Controllers", 122: "Local Control",
  123: "All Notes Off", 124: "Omni Off", 125: "Omni On", 126: "Mono On", 127: "Poly On",
};
/** Standard name of a controller number ("" for undefined ones). 32–63 are the LSBs of 0–31. */
function ccName(cc) {
  if (CC_NAMES[cc]) return CC_NAMES[cc];
  if (cc >= 32 && cc < 64) return CC_NAMES[cc - 32] ? `${CC_NAMES[cc - 32]} LSB` : `LSB of CC ${cc - 32}`;
  return "";
}
// SysEx manufacturer IDs (MIDI Association list; 1-byte and 00 xx xx extended IDs)
const SYSEX_MFR = {
  "01": "Sequential", "04": "Moog", "06": "Lexicon", "07": "Kurzweil", "0F": "Ensoniq", "10": "Oberheim",
  "11": "Apple", "18": "E-mu", "1C": "Eventide", "40": "Kawai", "41": "Roland", "42": "Korg", "43": "Yamaha",
  "44": "Casio", "47": "Akai", "52": "Zoom", "7D": "Non-commercial", "7E": "Universal Non-Real Time",
  "7F": "Universal Real Time",
  "00 00 0E": "Alesis", "00 20 1F": "TC Electronic", "00 20 29": "Focusrite/Novation", "00 20 32": "Behringer",
  "00 20 33": "Access", "00 20 3C": "Elektron", "00 20 6B": "Arturia", "00 21 09": "Native Instruments",
};
function sysexMfr(d, i = 1) {
  const id = d[i] === 0 ? hex(d.slice(i, i + 3)) : hex([d[i] ?? 0]);
  return { id, name: SYSEX_MFR[id] || "unknown maker", len: d[i] === 0 ? 3 : 1 };
}
function describeSysex(d) {
  const end = d[d.length - 1] === 0xf7 ? d.length - 1 : d.length;
  const sub = (a, b) => d[3] === a && d[4] === b;
  if (d[1] === 0x7e) {
    if (sub(0x06, 0x01)) return `SysEx Identity request (device ${d[2] === 0x7f ? "all" : d[2]})`;
    if (sub(0x06, 0x02) && end > 5) {
      const who = sysexMfr(d, 5), o = 5 + who.len;
      if (o + 8 <= end)
        return `SysEx Identity reply: ${who.name} (${who.id}), family ${hex(d.slice(o, o + 2))}, model ${hex(d.slice(o + 2, o + 4))}, version ${hex(d.slice(o + 4, o + 8))}`;
      return `SysEx Identity reply: ${who.name} (${who.id})`;
    }
    if (sub(0x09, 0x01)) return "SysEx GM System On";
    if (sub(0x09, 0x02)) return "SysEx GM System Off";
    return `SysEx Universal Non-RT ${hex([d[3] ?? 0, d[4] ?? 0])} (${d.length} bytes)`;
  }
  if (d[1] === 0x7f) {
    if (sub(0x04, 0x01)) return `SysEx Master Volume ${d[6] ?? 0}`;
    return `SysEx Universal RT ${hex([d[3] ?? 0, d[4] ?? 0])} (${d.length} bytes)`;
  }
  if (d[1] === 0x43 && d.length === 7 && (d[2] & 0xf0) === 0x10 && d[3] < 2)
    return `SysEx Yamaha (43) parameter change ${d[3] * 128 + d[4]} = ${d[5]}`; // DX7-style VCED
  const m = sysexMfr(d);
  return `SysEx ${m.name} (${m.id}), ${d.length} bytes`;
}

function describe(d) {
  const st = d[0];
  if (st === 0xf0) return describeSysex(d);
  const sys = { 0xf6: "Tune request", 0xf8: "Clock", 0xfa: "Start", 0xfb: "Continue", 0xfc: "Stop", 0xfe: "Active sensing", 0xff: "Reset" }[st];
  if (sys) return sys;
  if (st === 0xf1) return `MTC quarter frame ${d[1] >> 4}:${d[1] & 15}`;
  if (st === 0xf2) return `Song position ${(d[2] << 7) | d[1]}`;
  if (st === 0xf3) return `Song select ${d[1]}`;
  const type = st & 0xf0, ch = (st & 15) + 1;
  switch (type) {
    case 0x80: return `ch${ch} Note off ${noteName(d[1])}`;
    case 0x90: return d[2] ? `ch${ch} Note on ${noteName(d[1])} vel ${d[2]}` : `ch${ch} Note off ${noteName(d[1])} (vel 0)`;
    case 0xa0: return `ch${ch} Poly AT ${noteName(d[1])} ${d[2]}`;
    case 0xb0: {
      const name = ccName(d[1]);
      return `ch${ch} CC ${d[1]}${name ? " " + name : ""} = ${d[1] === 122 ? (d[2] ? "on" : "off") : d[2]}`;
    }
    case 0xc0: return `ch${ch} Program ${d[1] + 1}`;
    case 0xd0: return `ch${ch} Aftertouch ${d[1]}`;
    case 0xe0: return `ch${ch} Pitch bend ${((d[2] << 7) | d[1]) - 8192}`;
  }
  return "?";
}
/** Monitor filter group of a message. */
function msgKind(d) {
  const st = d[0];
  if (st === 0xf0) return "sysex";
  if (st > 0xf0) return "system";
  return { 0x80: "note", 0x90: "note", 0xa0: "touch", 0xb0: "cc", 0xc0: "pc", 0xd0: "touch", 0xe0: "touch" }[st & 0xf0] || "other";
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
    const prev = ccSeen.get(k) || { ch, cc: d[1], count: 0, min: d[2], max: d[2] };
    ccSeen.set(k, { ...prev, value: d[2], count: prev.count + 1, min: Math.min(prev.min, d[2]), max: Math.max(prev.max, d[2]) });
    renderCcTable();
  } else if (type === 0xc0) {
    const pc = $("#pcNum");
    if (pc) pc.value = d[1] + 1;
  }
}

// ----- monitor: entries are kept for filtering and export; the DOM shows the last MAX_LOG matching ones
const MAX_LOG = 400, MAX_KEEP = 3000;
const monLog = [];
const monShows = (r) => { const f = $("#monFilter")?.value || "all"; return f === "all" || r.kind === f; };
const clockTime = () => new Date().toLocaleTimeString([], { hour12: false });
function appendLog(box, row) {
  box.append(row);
  while (box.childElementCount > MAX_LOG) box.firstChild.remove();
  box.scrollTop = box.scrollHeight;
}
function logRow(dir, text, raw, t = clockTime()) {
  return h("div", { class: dir, title: text }, `${t} ${dir === "in" ? "◀" : "▶"} `, h("b", { text }), raw ? `   ${raw}` : "");
}
function monAdd(r) {
  monLog.push(r);
  if (monLog.length > MAX_KEEP) monLog.splice(0, monLog.length - MAX_KEEP);
  if (monShows(r)) appendLog($("#monitor"), logRow(r.dir, r.text, r.short, r.t));
}
function renderMonitor() {
  const box = $("#monitor");
  box.replaceChildren(...monLog.filter(monShows).slice(-MAX_LOG).map((r) => logRow(r.dir, r.text, r.short, r.t)));
  box.scrollTop = box.scrollHeight;
}
function exportMonitor() {
  const rows = monLog.filter(monShows);
  if (!rows.length) return toast("Nothing to export: the monitor is empty", true);
  const lines = rows.map((r) => [r.t, r.dir === "in" ? "IN " : "OUT", r.text, r.raw].filter(Boolean).join("\t"));
  const n = new Date(), p2 = (x) => String(x).padStart(2, "0");
  const stamp = `${n.getFullYear()}${p2(n.getMonth() + 1)}${p2(n.getDate())}-${p2(n.getHours())}${p2(n.getMinutes())}${p2(n.getSeconds())}`;
  download(`midi-log-${stamp}.txt`, lines.join("\r\n") + "\r\n", "text/plain");
}
function logMidi(dir, bytes) {
  if (dir === "out" && !$("#monOut").checked) return;
  const text = describe(bytes), t = clockTime();
  const short = bytes.length > 12 ? hex(bytes.slice(0, 12)) + " …" : hex(bytes);
  const raw = bytes.length > 256 ? hex(bytes.slice(0, 256)) + ` … (${bytes.length} bytes)` : hex(bytes);
  monAdd({ t, dir, kind: msgKind(bytes), text, short, raw });
}
function logText(dir, text) {
  if (dir === "out" && !$("#monOut").checked) return;
  monAdd({ t: clockTime(), dir, kind: "info", text, short: "", raw: "" });
}

// ----- CC discovery and the "Send a message" card
function renderCcTable() {
  const rows = [...ccSeen.values()].sort((a, b) => a.ch - b.ch || a.cc - b.cc);
  $("#ccTable tbody").replaceChildren(...rows.map((r) =>
    h("tr", { title: "Load into Send a message", onclick: () => pickCc(r) },
      h("td", { text: r.ch }), h("td", { text: r.cc }), h("td", { text: ccName(r.cc) || "–" }),
      h("td", { text: r.value }), h("td", { text: r.min === r.max ? r.min : `${r.min}–${r.max}` }), h("td", { text: r.count }))));
}
function pickCc(r) {
  $("#msgCh").value = r.ch;
  $("#msgCc").value = r.cc;
  $("#msgCcVal").value = r.value;
  updateMsgCc();
}
const clampInt = (v, lo, hi, def = lo) => (v === "" || isNaN(+v) ? def : Math.max(lo, Math.min(hi, Math.round(+v))));
const msgCh = () => (+$("#msgCh").value - 1) & 15;
function updateMsgCc() {
  const cc = clampInt($("#msgCc").value, 0, 127);
  $("#msgCcName").textContent = `CC ${cc}: ${ccName(cc) || "not defined by the MIDI spec (free for any use)"}`;
  $("#msgCcValOut").textContent = $("#msgCcVal").value;
  return cc;
}
function sendProgram() {
  const ch = msgCh();
  const msb = $("#msgBankMsb").value, lsb = $("#msgBankLsb").value;
  if (msb !== "") sendCC(ch, 0, clampInt(msb, 0, 127));
  if (lsb !== "") sendCC(ch, 32, clampInt(lsb, 0, 127));
  const n = clampInt($("#msgPc").value, 1, 128, 1);
  $("#msgPc").value = n;
  send([0xc0 | ch, n - 1]);
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
const OCT_MIN = 0, OCT_MAX = 8;
function shiftOctave(d) {
  const o = Math.max(OCT_MIN, Math.min(OCT_MAX, S.settings.octave + d));
  if (o === S.settings.octave) return;
  S.settings.octave = o;
  buildKeyboards(); saveSettings();
}
function buildKeyboards() {
  const home = $("#kbHome"), play = $("#kbPlay"), o = S.settings.octave;
  if (home) mountFm1Keys(home, {
    low: fm1LowNote(o), octave: o, canDown: o > OCT_MIN, canUp: o < OCT_MAX,
    held: S.held, noteOn, noteOff, onOctave: shiftOctave,
  });
  if (play) buildKeyboard(play, 3);
  const lbl = $("#octLabel");
  if (lbl) lbl.textContent = o;
}
// Lights a note on every on-screen keyboard (classic and FM-1 key bed); both carry data-note.
function light(n, on) { $$(`.keyboard [data-note="${n}"]`).forEach((k) => k.classList.toggle("on", on)); }

const typing = (e) => /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) && e.target.type !== "range" && e.target.type !== "checkbox";
const qwertyDown = new Map();
document.addEventListener("keydown", (e) => {
  if (typing(e) || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
    if (e.target.type === "range") return;
    shiftOctave(e.key === "ArrowRight" ? 1 : -1); e.preventDefault(); return;
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
// Patches are firmware-aware (schema v2): each one records firmware {id, version?} and a
// format from the registry in firmware/formats/*.json (GET /api/formats). Stock patches keep
// voice/fx; other firmwares store params / cc / sysex, sent by the format's "send" steps.
// v1 files (no schemaVersion) come back from the server as stock patches.

const OFFICIAL_FORMAT = "official/dx7-voice+fx";
// Used until /api/formats answers (or if it fails), so stock patches always work.
const FALLBACK_FORMATS = {
  [OFFICIAL_FORMAT]: {
    id: OFFICIAL_FORMAT, name: "DX7 voice + FX", file: "official", firmware: ["official"], status: "confirmed", sendable: true, params: [],
    send: [{ type: "program-change", field: "program", channel: "note" }, { type: "dx7-param-sysex", field: "voice", editor: "voice" },
      { type: "cc-map", field: "fx", channel: "fx", editor: "fx" }],
  },
};
const FORMAT_STATUS = {
  confirmed: "Tested on a real FM-1",
  discovered: "Found by testing or in the docs, not fully verified",
  unknown: "Not tested yet",
};
const LIB = { reg: null, filter: "device" };
const PATCH_FIELDS = ["voice", "fx", "program", "params", "cc", "sysex", "legacyFirmware"];

const libFormats = () => LIB.reg?.formats || FALLBACK_FORMATS;
const libFormat = (id) => libFormats()[id] || null;
const libCatalog = () => (S.fw?.catalog?.length ? S.fw.catalog : LIB.reg?.catalog) || [];
const libFwName = (id) => libCatalog().find((f) => f.id === id)?.name || id || "unknown";
// The firmware logged as on the device (Firmware tab), or null when nothing is logged.
// S.fw and the registry both carry it; take the more recent log entry.
const libDevice = () => [S.fw?.installed, LIB.reg?.installed].filter(Boolean)
  .sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")))[0] || null;
const libDeviceId = () => libDevice()?.id || "official";
function fwText(fw) {
  const n = libFwName(fw?.id), v = fw?.version;
  return v && !n.toLowerCase().includes(normVer(v)) ? `${n} ${v}` : n;
}
const formatsFor = (fwId) => Object.values(libFormats()).filter((f) => f.firmware.includes(fwId) || f.firmware.includes("*"));
const libPrefs = () => (S.settings.library ||= { sort: "name", group: false });
const patchUrl = (name) => "patches/" + encodeURIComponent(name);
const safePatchName = (s) => String(s || "").replace(/[^A-Za-z0-9 _.()\-]/g, "").replace(/^[^A-Za-z0-9]+/, "").slice(0, 64).trim();

/** Why sending this patch needs a confirmation (other firmware or version), or null. */
function fwMismatch(fw) {
  const dev = libDevice();
  if ((fw?.id || "official") !== libDeviceId())
    return `Saved for ${fwText(fw)}; the device is logged as ${dev ? fwText(dev) : "stock (nothing logged)"}.`;
  if (fw?.version && dev?.version && normVer(fw.version) !== normVer(dev.version))
    return `Saved on ${fwText(fw)}; the device has ${fwText(dev)}.`;
  return null;
}

/** Why this patch can't be sent at all, or null. */
function sendBlock(p) {
  if (p.error) return `The patch file can't be read (${p.error}).`;
  const fmt = libFormat(p.format);
  if (!fmt) return `Unknown format "${p.format}". Add its definition to firmware/formats/ to send it.`;
  if (!fmt.sendable) return fmt.notSendableReason || "This format can't be sent yet.";
  return null;
}

async function loadFormats() {
  try { LIB.reg = await api("formats"); } catch (e) { LIB.reg = null; toast("Patch formats: " + e.message, true); }
}

// ----- sending, driven by the format's "send" steps

const chanOf = (c) => (c === "fx" ? fch() : c == null || c === "note" ? nch() : (+c - 1) & 15);

function sysexBytes(msg) {
  const b = Array.isArray(msg) ? msg.map(Number) : String(msg).trim().split(/[\s,]+/).map((x) => parseInt(x, 16));
  if (b.length < 2 || b[0] !== 0xf0 || b[b.length - 1] !== 0xf7 || b.slice(1, -1).some((x) => !(x >= 0 && x < 128)))
    throw new Error(`Not a SysEx message: ${String(msg).slice(0, 40)}`);
  return b;
}

/** MIDI messages that set one format parameter at its address ([] when it has none). */
function paramBytes(def, value) {
  const a = def.address;
  if (!a) return [];
  const v = Math.max(def.min ?? 0, Math.min(def.max ?? 127, Math.round(+value || 0))) & 127;
  if (a.cc != null) return [[0xb0 | chanOf(a.channel), a.cc & 127, v]];
  if (Array.isArray(a.nrpn)) { const st = 0xb0 | chanOf(a.channel); return [[st, 99, a.nrpn[0] & 127], [st, 98, a.nrpn[1] & 127], [st, 6, v]]; }
  if (a.dx7 != null) return [DX.paramMessage(a.dx7, v)];
  if (typeof a.sysex === "string") return [sysexBytes(a.sysex.replace(/\{v\}/gi, v.toString(16).padStart(2, "0")))];
  return [];
}

function addressText(a) {
  if (!a) return "not sendable";
  if (a.cc != null) return `CC ${a.cc} · ch ${a.channel ?? "note"}`;
  if (Array.isArray(a.nrpn)) return `NRPN ${a.nrpn.join("/")} · ch ${a.channel ?? "note"}`;
  if (a.dx7 != null) return `DX7 param ${a.dx7}`;
  if (a.sysex) return a.sysex;
  return "?";
}

/** Run a patch through its format's send steps. With sendNow false only the editors are loaded. */
function playPatch(p, fmt, sendNow) {
  const gap = Math.max(0, +S.settings.sysexGap || 0);
  const t0 = performance.now() + 5;
  const queue = [];   // [bytes, ms after t0]
  const done = [];
  let delay = 0, skipped = 0;
  for (const step of fmt.send || []) {
    const val = p[step.field];
    if (val == null || val === "") continue;
    switch (step.type) {
      case "program-change": {
        if (!sendNow) break;
        const n = Math.max(1, Math.min(128, +val | 0));
        queue.push([[0xc0 | chanOf(step.channel), n - 1], delay]);
        const pc = $("#pcNum"); if (pc) pc.value = n;
        done.push(`program ${n}`); delay += 200;
        break;
      }
      case "dx7-param-sysex": {
        if (!Array.isArray(val) || !val.length) break;
        const v = DX.clampVoice(val);
        if (step.editor === "voice") { S.voice = v; refreshVoiceUI(); if (sendNow) sendWholeVoice(delay); done.push("voice"); }
        else if (sendNow) { v.forEach((x, i) => queue.push([DX.paramMessage(i, x), delay + i * gap])); done.push("DX7 voice"); }
        if (sendNow) delay += Math.max(700, DX.VOICE_LEN * gap + 80);
        break;
      }
      case "cc-map": {
        if (typeof val !== "object") break;
        if (step.editor === "fx") { S.fx = { ...defaultFx(), ...val }; refreshFx(); if (sendNow) sendAllFx(delay); done.push("FX"); }
        else if (sendNow) {
          Object.keys(val).sort((a, b) => a - b).forEach((cc, i) => queue.push([[0xb0 | chanOf(step.channel), +cc & 127, val[cc] & 127], delay + i * 2]));
          done.push(`${Object.keys(val).length} CCs`);
        }
        if (sendNow) delay += Object.keys(val).length * 2 + 50;
        break;
      }
      case "cc-list": {
        if (!sendNow || !Array.isArray(val)) break;
        val.forEach((e, i) => queue.push([[0xb0 | (e.ch ? (e.ch - 1) & 15 : chanOf(step.channel)), e.cc & 127, e.value & 127], delay + i * 2]));
        done.push(`${val.length} CCs`); delay += val.length * 2 + 50;
        break;
      }
      case "params": {
        if (!sendNow || typeof val !== "object") break;
        const defs = (fmt.params || []).filter((d) => (d.field || "params") === step.field);
        let n = 0;
        for (const d of defs) {
          if (val[d.id] == null) continue;
          const msgs = paramBytes(d, val[d.id]);
          if (!msgs.length) { skipped++; continue; }
          for (const m of msgs) queue.push([m, delay + n++ * Math.max(gap, 2)]);
        }
        skipped += Object.keys(val).filter((k) => !defs.some((d) => d.id === k)).length;
        done.push(`${defs.filter((d) => val[d.id] != null).length} params`); delay += n * Math.max(gap, 2) + 50;
        break;
      }
      case "raw-sysex": {
        if (!sendNow || !Array.isArray(val)) break;
        for (const m of val) { queue.push([sysexBytes(m), delay]); delay += Math.max(gap, 10); }
        done.push(`${val.length} SysEx`);
        break;
      }
    }
  }
  if (sendNow) {
    for (const [b, d] of queue) S.out.send(b, t0 + d);
    if (queue.length) logText("out", `Patch "${p.name}": ${queue.length} messages (${fmt.name})`);
  }
  return { done, skipped };
}

async function applyPatch(name, { sendNow = true, force = false } = {}) {
  if (!LIB.reg) await loadFormats();
  const p = await api(patchUrl(name));
  const fmt = libFormat(p.format);
  if (sendNow) {
    const block = sendBlock(p);
    if (block) throw new Error(block);
    const mm = fwMismatch(p.firmware);
    if (mm && !force) throw new Error(`${mm} Use Send in the Library to confirm.`);
    if (!S.out) throw new Error("Not connected. Press Connect first.");
  } else if (!fmt?.send?.some((s) => s.editor)) {
    throw new Error(`"${name}" is a ${fmt?.name || p.format} patch; there's no editor for it here. Use Send.`);
  }
  const { done, skipped } = playPatch(p, fmt, sendNow);
  if (fmt.send.some((s) => s.editor && p[s.field] != null)) saveSettings();
  if (!done.length) return toast(`"${name}" has nothing to ${sendNow ? "send" : "load"}`, true);
  toast(`${sendNow ? "Sent" : "Loaded"} "${name}": ${done.join(", ")}${skipped ? ` (${skipped} values without an address skipped)` : ""}`);
}

async function loadPatches() {
  const [list] = await Promise.all([
    api("patches").catch((e) => { toast("Library: " + e.message, true); return []; }),
    loadFormats(),
  ]);
  S.patches = list;
  renderLibrary(); renderFavorites();
}

async function toggleFavorite(name) {
  try {
    const p = await api(patchUrl(name));
    p.favorite = !p.favorite;
    await api(patchUrl(name), { method: "PUT", body: JSON.stringify(p) });
  } catch (e) { toast(e.message, true); }
  loadPatches();
}

// ----- save dialog

let saveDlg, saveOpts = {};
function buildSaveDialog() {
  saveDlg = h("dialog", { class: "card lib-save" },
    h("form", { method: "dialog" },
      h("h3", { text: "Save to Library" }),
      h("label", { class: "stack" }, "Name", h("input", { id: "sdName", required: true, maxlength: 64, pattern: "[A-Za-z0-9][A-Za-z0-9 _.()\\-]*" })),
      h("div", { id: "sdExists", class: "hint hidden" }),
      h("div", { class: "row" },
        h("label", { class: "stack grow" }, "Firmware", h("select", { id: "sdFw" })),
        h("label", { class: "stack" }, "Version", h("input", { id: "sdFwVer", maxlength: 48, placeholder: "optional", size: 10 }))),
      h("label", { class: "stack" }, "Format", h("select", { id: "sdFormat" })),
      h("div", { id: "sdFormatInfo", class: "hint" }),
      h("div", { id: "sdContent", class: "lib-save-content" }),
      h("label", { class: "stack" }, "Tags (comma separated)", h("input", { id: "sdTags" })),
      h("label", { class: "stack" }, "Notes", h("textarea", { id: "sdNotes", rows: 3 })),
      h("div", { class: "row" },
        h("button", { value: "cancel", formnovalidate: true, text: "Cancel" }),
        h("button", { value: "save", class: "primary", text: "Save" }))));
  document.body.append(saveDlg);
  $("#sdFw").onchange = () => {
    const dev = libDevice();
    $("#sdFwVer").value = dev && dev.id === $("#sdFw").value ? dev.version || "" : "";
    fillSaveFormats();
  };
  $("#sdFormat").onchange = renderSaveContent;
  $("#sdName").oninput = updateSaveExists;
  saveDlg.addEventListener("close", () => { if (saveDlg.returnValue === "save") savePatchFromDialog(); });
}

function fillSaveFormats(preferred) {
  const fwId = $("#sdFw").value;
  // The firmware's own formats first (sendable ones before the rest), then the generic ones.
  const rank = (f) => (f.firmware.includes("*") ? 2 : 0) + (f.sendable ? 0 : 1);
  const list = formatsFor(fwId).sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  const pick = list.find((f) => f.id === preferred) || list[0];
  $("#sdFormat").replaceChildren(...list.map((f) =>
    h("option", { value: f.id, text: `${f.name}${f.status !== "confirmed" ? ` (${f.status})` : ""}`, selected: f === pick })));
  renderSaveContent();
}

const ccCaptured = () => (typeof ccSeen !== "undefined" ? [...ccSeen.values()] : [])
  .sort((a, b) => a.ch - b.ch || a.cc - b.cc).map(({ ch, cc, value }) => ({ ch, cc, value }));

function renderSaveContent() {
  const fmt = libFormat($("#sdFormat").value);
  const box = $("#sdContent");
  if (!fmt) { box.replaceChildren(h("p", { class: "muted", text: "No format for this firmware." })); $("#sdFormatInfo").textContent = ""; return; }
  $("#sdFormatInfo").replaceChildren(
    h("span", { class: "badge" + (fmt.status === "confirmed" ? " ok" : " warn"), title: FORMAT_STATUS[fmt.status] || "", text: fmt.status }), " ",
    fmt.description || "", " ", h("code", { text: `firmware/formats/${fmt.file}.json` }));
  const check = (id, label, on, disabled) =>
    h("label", {}, h("input", { id, type: "checkbox", checked: on && !disabled, disabled }), " ", label);
  const rows = [];
  for (const s of fmt.send || []) {
    if (s.type === "dx7-param-sysex" && s.editor === "voice") rows.push(check("sdVoice", `Voice "${DX.getName(S.voice)}" (156 DX7 params)`, saveOpts.voice));
    else if (s.type === "cc-map" && s.editor === "fx") rows.push(check("sdFx", "FX snapshot (CC 0–23)", saveOpts.fx));
    else if (s.type === "program-change") rows.push(check("sdPc", `Program # ${$("#pcNum")?.value || S.settings.program || 1}`, saveOpts.pc));
    else if (s.type === "cc-list") {
      const n = ccCaptured().length;
      rows.push(check("sdCc", `CCs from CC discovery (${n} seen)`, true, !n));
      if (!n) rows.push(h("span", { class: "hint", text: "Nothing captured yet: turn the device's knobs with the dashboard open, or add a cc list to the JSON by hand." }));
    } else if (s.type === "raw-sysex") rows.push(h("label", { class: "stack" }, "SysEx messages (hex, one per line, optional)",
      h("textarea", { id: "sdSysex", rows: 2, class: "mono", placeholder: "F0 7D 01 02 F7" })));
    else if (s.type === "params") {
      const n = (fmt.params || []).filter((d) => !d.field || d.field === s.field).length;
      rows.push(h("span", { class: "hint", text: `Starts from the format's ${n} default values; change them under Details on the card.` }));
    } else if (s.type === "none") rows.push(h("span", { class: "hint", text: `Not sendable yet: ${String(s.reason || "no transport known").replace(/\.$/, "")}. The patch is kept for reference.` }));
  }
  box.replaceChildren(...(rows.length ? rows : [h("span", { class: "muted", text: "This format has no content to capture." })]));
}

function updateSaveExists() {
  const name = $("#sdName").value.trim();
  const ex = S.patches.find((p) => p.name === name);
  $("#sdExists").textContent = ex ? `"${name}" exists (${fwText(ex.firmware)}). Saving replaces its content and keeps its star and any extra fields.` : "";
  $("#sdExists").classList.toggle("hidden", !ex);
  return ex;
}

/**
 * Open the Save dialog. Called with {voice, fx, pc} by the stock Voice/FX editors and Home:
 * their content is a stock DX7 voice + FX, so it is saved for the official firmware. Pass
 * {firmware} to save for another firmware (the Library's "Save current…" uses the device's).
 */
function openSave({ voice = true, fx = true, pc = false, firmware = "official", format } = {}) {
  saveOpts = { voice, fx, pc };
  const ids = new Set([...libCatalog().map((f) => f.id), ...Object.values(libFormats()).flatMap((f) => f.firmware)]);
  ids.delete("*"); ids.add("official"); ids.add(firmware);
  $("#sdFw").replaceChildren(...[...ids].sort((a, b) => (b === "official") - (a === "official") || libFwName(a).localeCompare(libFwName(b)))
    .map((id) => h("option", { value: id, text: libFwName(id) + (id === libDevice()?.id ? " (on the device)" : ""), selected: id === firmware })));
  const dev = libDevice();
  $("#sdFwVer").value = dev && dev.id === firmware ? dev.version || "" : "";
  fillSaveFormats(format || (firmware === "official" ? OFFICIAL_FORMAT : undefined));
  const stock = $("#sdFormat").value === OFFICIAL_FORMAT;
  $("#sdName").value = safePatchName(stock ? DX.getName(S.voice) : `${libFwName(firmware)} patch`) || "My patch";
  const ex = updateSaveExists();
  $("#sdTags").value = ex ? (ex.tags || []).join(", ") : "";
  $("#sdNotes").value = ex ? ex.notes || "" : "";
  saveDlg.showModal();
}

async function savePatchFromDialog() {
  const name = $("#sdName").value.trim();
  const fwId = $("#sdFw").value;
  const ver = $("#sdFwVer").value.trim();
  const fmt = libFormat($("#sdFormat").value);
  if (!fmt) return toast("Pick a format first", true);
  const content = {};
  const on = (id) => $("#" + id)?.checked;
  try {
    if (on("sdVoice")) content.voice = [...S.voice];
    if (on("sdFx")) content.fx = { ...S.fx };
    if (on("sdPc")) content.program = Math.max(1, Math.min(128, +($("#pcNum")?.value || S.settings.program || 1)));
    if (on("sdCc")) content.cc = ccCaptured();
    const sx = $("#sdSysex")?.value.trim();
    if (sx) content.sysex = sx.split(/\n+/).map((l) => l.trim()).filter(Boolean).map((l) => hex(sysexBytes(l)));
    const pStep = fmt.send?.find((s) => s.type === "params");
    if (pStep) content[pStep.field] = Object.fromEntries((fmt.params || [])
      .filter((d) => (d.field || "params") === pStep.field).map((d) => [d.id, d.default ?? d.min ?? 0]));
  } catch (e) { return toast(e.message, true); }
  if (!Object.keys(content).length && fmt.sendable) return toast("Nothing to save: tick at least one part", true);
  try {
    let base = {};
    if (S.patches.some((p) => p.name === name)) base = await api(patchUrl(name)).catch(() => ({}));
    for (const k of PATCH_FIELDS) delete base[k];
    const firmware = { ...(base.firmware?.id === fwId ? base.firmware : {}), id: fwId };
    if (ver) firmware.version = ver; else delete firmware.version;
    const patch = {
      ...base, schemaVersion: 2, name, firmware, format: fmt.id, favorite: !!base.favorite,
      notes: $("#sdNotes").value, tags: $("#sdTags").value.split(",").map((t) => t.trim()).filter(Boolean), ...content,
    };
    await api(patchUrl(name), { method: "PUT", body: JSON.stringify(patch) });
    toast(`Saved "${name}" for ${fwText(firmware)}`);
    loadPatches();
  } catch (e) { toast(e.message, true); }
}

// ----- list

function renderLibrary() {
  const list = $("#libList");
  if (!list) return;
  const prefs = libPrefs();
  const dev = libDevice();
  const counts = {};
  for (const p of S.patches) counts[p.firmware?.id] = (counts[p.firmware?.id] || 0) + 1;
  if (LIB.filter === "device" && !dev) LIB.filter = "all";
  if (!["device", "all"].includes(LIB.filter) && !counts[LIB.filter]) LIB.filter = dev ? "device" : "all";
  const others = Object.keys(counts).filter((id) => id !== dev?.id).sort((a, b) => libFwName(a).localeCompare(libFwName(b)));
  $("#libFw").replaceChildren(
    dev && h("option", { value: "device", text: `On the device: ${fwText(dev)} (${counts[dev.id] || 0})`, selected: LIB.filter === "device" }),
    h("option", { value: "all", text: `All firmwares (${S.patches.length})`, selected: LIB.filter === "all" }),
    ...others.map((id) => h("option", { value: id, text: `${libFwName(id)} (${counts[id]})`, selected: LIB.filter === id })));
  renderLibStatus(dev);

  const fwFilter = LIB.filter === "device" ? dev.id : LIB.filter === "all" ? null : LIB.filter;
  const q = $("#libSearch").value.trim().toLowerCase();
  const byName = (a, b) => a.name.localeCompare(b.name);
  const byFw = (a, b) => libFwName(a.firmware?.id).localeCompare(libFwName(b.firmware?.id))
    || String(a.firmware?.version || "").localeCompare(String(b.firmware?.version || ""), undefined, { numeric: true });
  const cmp = {
    name: (a, b) => b.favorite - a.favorite || byName(a, b),
    modified: (a, b) => String(b.modified || "").localeCompare(String(a.modified || "")) || byName(a, b),
    firmware: (a, b) => byFw(a, b) || b.favorite - a.favorite || byName(a, b),
  }[prefs.sort] || ((a, b) => b.favorite - a.favorite || byName(a, b));
  const items = S.patches
    .filter((p) => !fwFilter || p.firmware?.id === fwFilter)
    .filter((p) => !q || [p.name, p.notes, ...(p.tags || []), fwText(p.firmware), p.format, libFormat(p.format)?.name]
      .join(" ").toLowerCase().includes(q))
    .sort(cmp);

  if (!items.length) {
    const hidden = S.patches.length > 0 && !!fwFilter && !q;
    list.replaceChildren(h("p", { class: "muted" },
      !S.patches.length ? "No patches yet. Edit a voice or the FX, then press Save current…"
        : hidden ? `No patches for ${libFwName(fwFilter)} yet. ` : "No matches.",
      hidden && h("button", { class: "ghost", text: `Show all firmwares (${S.patches.length})`, onclick: () => { LIB.filter = "all"; renderLibrary(); } })));
    return;
  }
  if (!prefs.group) { list.replaceChildren(libRows(items)); return; }
  const groups = new Map();
  for (const p of items) {
    const id = p.firmware?.id || "unknown";
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(p);
  }
  const order = [...groups.keys()].sort((a, b) => (b === dev?.id) - (a === dev?.id) || libFwName(a).localeCompare(libFwName(b)));
  list.replaceChildren(...order.map((id) => h("section", { class: "lib-group" },
    h("h2", { class: "lib-group-head" }, libFwName(id),
      h("span", { class: "muted", text: ` ${groups.get(id).length}` }),
      id === dev?.id && h("span", { class: "badge ok", text: "on the device" })),
    libRows(groups.get(id)))));
}

function renderLibStatus(dev) {
  const box = $("#libStatus");
  if (!box) return;
  const reg = LIB.reg;
  box.replaceChildren(...[
    h("span", {}, "Device: ", h("b", { text: dev ? fwText(dev) : "not logged" }),
      dev ? "" : h("span", { class: "muted", text: " (log it on the Firmware tab; stock is assumed)" })),
    h("span", { class: "muted", title: reg ? reg.files.map((f) => `${f.id}.json: ${f.name} (${f.status})`).join("\n") : "" },
      reg ? `Formats: ${Object.keys(reg.formats).length} from ${reg.files.length} files in firmware/formats/` : "Formats: built-in stock format only"),
    reg?.errors?.length > 0 && h("details", { class: "lib-errors" },
      h("summary", { class: "badge warn", text: `${reg.errors.length} format file problem${reg.errors.length > 1 ? "s" : ""}` }),
      h("ul", {}, reg.errors.map((e) => h("li", { class: "mono", text: e })))),
  ].filter(Boolean)); // replaceChildren would print a bare `false`
}

function libCard(p) {
  const fmt = libFormat(p.format);
  const block = sendBlock(p);
  const mm = fwMismatch(p.firmware);
  const confirmBox = h("div", { class: "lib-confirm hidden", role: "alert" });
  const details = h("div", { class: "lib-details hidden" });
  const err = (e) => toast(e.message, true);

  const sendBtn = h("button", { class: "primary", text: "Send", disabled: !!block, title: block || mm || `Send to the FM-1 (${fmt?.name})` });
  sendBtn.onclick = () => {
    if (!mm) return applyPatch(p.name).catch(err);
    confirmBox.replaceChildren(
      h("span", { text: `${mm} Send it anyway?` }),
      h("div", { class: "row" },
        h("button", { class: "primary", text: "Send anyway", onclick: () => { confirmBox.classList.add("hidden"); applyPatch(p.name, { force: true }).catch(err); } }),
        h("button", { class: "ghost", text: "Cancel", onclick: () => confirmBox.classList.add("hidden") })));
    confirmBox.classList.remove("hidden");
  };
  const canLoad = !p.error && !!fmt?.send?.some((s) => s.editor);
  const detBtn = h("button", { class: "ghost", text: "Details", "aria-expanded": "false" });
  detBtn.onclick = async () => {
    const open = details.classList.toggle("hidden") === false;
    detBtn.setAttribute("aria-expanded", String(open));
    if (open) {
      try { details.replaceChildren(libDetails(p, await api(patchUrl(p.name)), fmt)); }
      catch (e) { details.replaceChildren(h("p", { class: "muted", text: e.message })); }
    }
  };
  const del = h("button", { class: "ghost", text: "Delete" });
  del.onclick = () => confirmClick(del, "Confirm delete", async () => {
    await api(patchUrl(p.name), { method: "DELETE" }).catch(err); loadPatches();
  });

  // Inline edit of name and hashtags (✎ on the row, Enter saves, Esc cancels).
  const editBtn = !p.error && h("button", { class: "lib-edit", title: "Edit name and tags", text: "✎", "aria-label": `Edit ${p.name}` });
  if (editBtn) editBtn.onclick = () => startPatchEdit(row, p);

  // Second line only when there's something worth reading.
  const sub = [
    block && h("span", { class: "lib-why", text: block }),
    p.legacyFirmware && h("span", { text: `Saved while ${libFwName(p.legacyFirmware)} was logged; the content is a stock voice/FX.` }),
    p.notes && h("span", { text: p.notes }),
  ].filter(Boolean);

  const row = h("div", { class: "lib-row" + (mm ? " other-fw" : ""), "data-fw": p.firmware?.id || "" },
    h("button", { class: "star" + (p.favorite ? " on" : ""), title: "Favorite (shows on Home)", text: p.favorite ? "★" : "☆", onclick: () => toggleFavorite(p.name) }),
    h("div", { class: "lib-name" },
      h("b", { text: p.name, title: p.name }),
      p.schemaVersion < 2 && h("span", { class: "badge", text: "v1", title: "Older file: read as a stock patch, upgraded to schema v2 the next time it's saved" }),
      editBtn),
    h("span", { class: "fw-chip " + (mm ? "warn" : "ok"), title: mm || "Matches the firmware logged on the device" }, fwText(p.firmware)),
    h("div", { class: "lib-info" },
      h("span", { class: "fmt-chip", title: `${p.format}${fmt?.description ? "\n" + fmt.description : ""}`, text: fmt ? fmt.name : `unknown format ${p.format}` }),
      fmt && fmt.status !== "confirmed" && h("span", { class: "badge warn", text: fmt.status, title: FORMAT_STATUS[fmt.status] || "" }),
      p.hasVoice && h("span", { class: "badge accent", text: "voice" }),
      p.hasFx && h("span", { class: "badge", text: "fx" }),
      p.program && h("span", { class: "badge", text: `PC ${p.program}` }),
      p.params > 0 && h("span", { class: "badge accent", text: `${p.params} params` }),
      p.cc > 0 && h("span", { class: "badge", text: `${p.cc} CC` }),
      p.sysex > 0 && h("span", { class: "badge", text: `${p.sysex} SysEx` }),
      (p.tags || []).map((t) => h("span", { class: "badge", text: "#" + t }))),
    h("span", { class: "lib-date", title: p.modified ? "modified " + p.modified.replace("T", " ") : "", text: p.modified ? p.modified.slice(0, 10) : "" }),
    h("div", { class: "lib-actions" },
      sendBtn,
      canLoad && h("button", { text: "Load", title: "Load into the editors without sending", onclick: () => applyPatch(p.name, { sendNow: false }).catch(err) }),
      detBtn,
      !p.error && h("button", { class: "ghost", text: "JSON", title: "Export (schema v2)", onclick: async () => download(`${p.name}.json`, JSON.stringify(await api(patchUrl(p.name)), null, 2), "application/json") }),
      del),
    sub.length > 0 && h("div", { class: "lib-sub", title: sub.map((s) => s.textContent).join("\n") }, sub),
    confirmBox, details);
  return row;
}

/** "#bells live, ambient" → ["bells", "live", "ambient"] */
const parseTags = (s) => [...new Set(String(s).split(/[\s,]+/).map((t) => t.replace(/^#+/, "").trim().slice(0, 64)).filter(Boolean))];

/** Swap a row's name and contents cells for inputs; the actions become ✓ / ✕. */
function startPatchEdit(row, p) {
  const nameCell = row.querySelector(".lib-name"), infoCell = row.querySelector(".lib-info"), actions = row.querySelector(".lib-actions");
  const keep = [nameCell, infoCell, actions].map((el) => [...el.childNodes]);
  const nameIn = h("input", { class: "lib-edit-name", value: p.name, maxlength: 64, "aria-label": "Patch name" });
  const tagsIn = h("input", { class: "lib-edit-tags", value: (p.tags || []).map((t) => "#" + t).join(" "),
    placeholder: "#tag #another", "aria-label": "Tags, separated by spaces or commas" });
  const restore = () => { [nameCell, infoCell, actions].forEach((el, i) => el.replaceChildren(...keep[i])); row.classList.remove("editing"); };
  const save = async () => {
    const to = nameIn.value.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9 _.()\-]{0,63}$/.test(to)) {
      toast("Names: letters, digits, space _ . - ( ), starting with a letter or digit", true); nameIn.focus(); return;
    }
    const tags = parseTags(tagsIn.value);
    try {
      if (JSON.stringify(tags) !== JSON.stringify(p.tags || [])) {
        const full = await api(patchUrl(p.name));
        await api(patchUrl(p.name), { method: "PUT", body: JSON.stringify({ ...full, tags }) });
      }
      if (to !== p.name) await api(patchUrl(p.name) + "/rename", { method: "POST", body: JSON.stringify({ to }) });
      toast(to !== p.name ? `Renamed to "${to}"` : "Tags saved");
      loadPatches();
    } catch (e) { toast(e.message, true); }
  };
  const onKey = (e) => { if (e.key === "Enter") save(); else if (e.key === "Escape") restore(); };
  nameIn.onkeydown = tagsIn.onkeydown = onKey;
  row.classList.add("editing");
  nameCell.replaceChildren(nameIn);
  infoCell.replaceChildren(tagsIn);
  actions.replaceChildren(
    h("button", { class: "primary", text: "Save", onclick: save }),
    h("button", { class: "ghost", text: "Cancel", onclick: restore }));
  nameIn.focus(); nameIn.select();
}

/** Compact list: a header row plus one row per patch. */
function libRows(items) {
  return h("div", { class: "lib-rows" },
    h("div", { class: "lib-row lib-head", "aria-hidden": "true" },
      h("span"), h("span", { text: "Name" }), h("span", { text: "Firmware" }), h("span", { text: "Format · contents" }),
      h("span", { text: "Modified" }), h("span", { class: "lib-head-actions", text: "Actions" })),
    items.map(libCard));
}

/** The Details panel: what's in the patch, labelled by its format. Params are editable. */
function libDetails(p, full, fmt) {
  const out = [h("div", { class: "muted small" }, "Format ", h("code", { text: full.format }),
    fmt ? [" from ", h("code", { text: `firmware/formats/${fmt.file}.json` })] : " (not in the registry)")];
  if (Array.isArray(full.voice) && full.voice.length) {
    const v = DX.clampVoice(full.voice);
    out.push(h("div", { text: `Voice "${DX.getName(v)}", algorithm ${v[134] + 1}, feedback ${v[135]}` }));
  }
  if (full.fx && typeof full.fx === "object") {
    const on = FX_DEFS.filter((d) => (full.fx[d.sw] ?? 0) >= 64).map((d) => d.name);
    out.push(h("div", { text: `FX on: ${on.join(", ") || "none"} (${Object.keys(full.fx).length} CCs stored)` }));
  }
  if (full.program) out.push(h("div", { text: `Program ${full.program}` }));
  if (Array.isArray(full.cc) && full.cc.length) {
    // Label CCs from any format known for this firmware, on today's note/FX channels.
    const chNum = (c) => (c === "fx" ? S.settings.fxCh : c == null || c === "note" ? S.settings.noteCh : +c);
    const known = {};
    for (const f of formatsFor(full.firmware?.id)) for (const d of f.params || []) {
      if (d.address?.cc != null) known[`${chNum(d.address.channel)}:${d.address.cc}`] = d.label;
    }
    const label = (e) => known[`${chNum(e.ch)}:${e.cc}`] || "";
    out.push(h("table", { class: "table lib-table" },
      h("thead", {}, h("tr", {}, h("th", { text: "Ch" }), h("th", { text: "CC" }), h("th", { text: "Value" }), h("th", { text: "Known as" }))),
      h("tbody", {}, full.cc.map((e) => h("tr", {}, h("td", { text: e.ch ?? "note" }), h("td", { text: e.cc }), h("td", { text: e.value }), h("td", { text: label(e) }))))));
  }
  if (Array.isArray(full.sysex) && full.sysex.length) {
    out.push(h("div", { class: "lib-sysex mono" }, full.sysex.map((m) => h("div", { text: String(m) }))));
  }
  if (full.params && typeof full.params === "object") out.push(paramsEditor(p, full, fmt));
  return h("div", {}, out);
}

function paramsEditor(p, full, fmt) {
  const defs = (fmt?.params || []).filter((d) => !d.field || d.field === "params");
  const vals = { ...full.params };
  const groups = new Map();
  for (const d of defs) { const g = d.group || ""; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(d); }
  const input = (d) => {
    const set = (x) => { vals[d.id] = x; save.disabled = false; };
    if (Array.isArray(d.options)) return h("select", { onchange: (e) => set(+e.target.value) },
      d.options.map((o, i) => h("option", { value: (d.min ?? 0) + i, text: o, selected: (d.min ?? 0) + i === +vals[d.id] })));
    return h("input", { type: "number", min: d.min ?? 0, max: d.max ?? 127, value: vals[d.id] ?? "", class: "num",
      onchange: (e) => set(Math.max(d.min ?? 0, Math.min(d.max ?? 127, Math.round(+e.target.value || 0)))) });
  };
  const save = h("button", { class: "primary", text: "Save values", disabled: true });
  save.onclick = async () => {
    try {
      await api(patchUrl(p.name), { method: "PUT", body: JSON.stringify({ ...full, params: vals }) });
      full.params = { ...vals }; save.disabled = true; toast(`Saved "${p.name}"`);
    } catch (e) { toast(e.message, true); }
  };
  const extra = Object.keys(vals).filter((k) => !defs.some((d) => d.id === k));
  return h("div", { class: "lib-params" },
    [...groups].map(([g, ds]) => h("div", {},
      g && h("h4", { text: fmt?.groups?.[g] || g }),
      h("table", { class: "table lib-table" }, h("tbody", {}, ds.map((d) => h("tr", {},
        h("td", { text: d.label || d.id, title: d.id }),
        h("td", {}, input(d)),
        h("td", { class: "muted small", text: `${d.min ?? 0}–${d.max ?? 127}` }),
        h("td", { class: "muted small", text: addressText(d.address) }),
        h("td", {}, d.status && d.status !== "confirmed" && h("span", { class: "badge warn", text: d.status, title: FORMAT_STATUS[d.status] || "" })))))))),
    extra.length > 0 && h("p", { class: "hint", text: `Not in the format (kept, not sent): ${extra.map((k) => `${k} = ${vals[k]}`).join(", ")}` }),
    !defs.length && h("p", { class: "hint", text: "The format defines no parameters yet." }),
    defs.length > 0 && h("div", { class: "row" }, save));
}

function renderFavorites() {
  const box = $("#favList");
  if (!box) return;
  const favs = S.patches.filter((p) => p.favorite);
  box.replaceChildren(...(favs.length
    ? favs.map((p) => {
      const why = sendBlock(p) || fwMismatch(p.firmware);
      return h("button", { class: "chip" + (why ? " fw-other" : ""), text: p.name, title: why ? `${why} Open the Library to send it.` : fwText(p.firmware),
        onclick: () => applyPatch(p.name).catch((e) => toast(e.message, true)) });
    })
    : [h("span", { class: "muted", text: "Star patches in the Library to pin them here." })]));
}

async function importPatchFile(file) {
  try {
    const obj = JSON.parse(await file.text());
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new Error("not a patch (expected a JSON object)");
    let name = safePatchName(obj.name || file.name.replace(/\.json$/i, "")) || "Imported";
    const taken = new Set(S.patches.map((p) => p.name));
    if (taken.has(name)) {
      const stem = name.slice(0, 58);
      let i = 2;
      while (taken.has(`${stem} (${i})`)) i++;
      name = `${stem} (${i})`;
    }
    if (Array.isArray(obj.voice) && obj.voice.length) obj.voice = DX.clampVoice(obj.voice);
    obj.name = name;
    // The server upgrades v1 files to schema v2 and checks the format id.
    const saved = await api(patchUrl(name), { method: "PUT", body: JSON.stringify(obj) });
    toast(`Imported "${name}" (${fwText(saved.firmware)})`); loadPatches();
  } catch (e) { toast("Import failed: " + e.message, true); }
}

// ================================================================ firmware

async function loadFirmware({ autoRefresh = false } = {}) {
  try { S.fw = await api("firmware"); } catch (e) { toast("Firmware: " + e.message, true); return; }
  const checked = S.fw.discovery?.checked || S.fw.releases?.checked;
  if (autoRefresh && (!checked || Date.now() - Date.parse(checked) > 12 * 3600e3)) return refreshFirmware();
  renderFirmware();
}

/** "Check for updates": the server rescans awesome-fm-1 + GitHub, re-ranks and refreshes releases. */
async function refreshFirmware() {
  const btn = $("#fwRefresh");
  btn.disabled = true; btn.textContent = "Checking…";
  try {
    const before = new Set((S.fw?.ranked || []).slice(0, 10).map((p) => p.id));
    const r = await api("firmware/refresh", { method: "POST", body: "{}" });
    S.fw = await api("firmware"); renderFirmware();
    const entered = before.size ? (r.top || []).filter((id) => !before.has(id)).map(fwName) : [];
    toast(r.notes?.length ? r.notes[r.notes.length - 1]
      : entered.length ? `New in the top 10: ${entered.join(", ")}` : "Firmware ranking updated", !!r.notes?.length);
  }
  catch (e) { toast("Update check failed: " + e.message, true); }
  finally { btn.disabled = false; btn.textContent = "Check for updates"; }
}

function fwName(id) { return S.fw?.catalog.find((f) => f.id === id)?.name || id; }

/** Header status: when the ranking was checked, and whether it is partial or the offline snapshot. */
function fwStatus(fw) {
  const d = fw.discovery || {};
  const el = $("#fwChecked");
  const st = d.stats;
  el.textContent = d.checked ? "checked " + relTime(d.checked) : d.fallback ? `ranking from ${d.fallback} snapshot` : "not checked yet";
  el.title = [
    d.checked && `Ranking: awesome-fm-1 + GitHub search${st ? `, ${st.scanned} projects checked, ${st.requests} GitHub requests (${st.notModified} unchanged)` : ""}`,
    d.auth && `GitHub API: ${d.auth === "anonymous" ? "anonymous (60/h); set GITHUB_TOKEN or FM1_USE_GH=1 for more" : d.auth === "gh" ? "GitHub CLI login" : "GITHUB_TOKEN"}`,
    ...(d.notes || []),
  ].filter(Boolean).join("\n");
  if (d.notes?.length) el.append(" ", h("span", { class: "fw-partial", text: "partial" }));
}

function renderFirmware() {
  const fw = S.fw;
  if (!fw) return;
  const inst = fw.installed;
  fwStatus(fw);
  $("#fwBadge").textContent = inst ? `firmware: ${fwName(inst.id)} ${inst.version}` : "firmware: not logged";
  $("#homeFw").textContent = inst ? `${fwName(inst.id)} ${inst.version}` : "not logged (see Firmware tab)";
  updateStockWarn();

  const sel = $("#fwInstalledSel");
  const opt = (f) => h("option", { value: f.id, text: f.name, selected: inst?.id === f.id });
  const uncur = fw.catalog.filter((f) => f.curated === false);
  sel.replaceChildren(...fw.catalog.filter((f) => f.curated !== false).map(opt),
    uncur.length > 0 && h("optgroup", { label: "Not curated yet" }, uncur.map(opt)));
  $("#fwHistory tbody").replaceChildren(...(fw.history || []).map((r) =>
    h("tr", {}, h("td", { text: r.date.replace("T", " ") }), h("td", { text: fwName(r.id) }), h("td", { text: r.version }), h("td", { class: "muted", text: r.note }))));

  // Community cards = the live top 10 (server-ranked by ln(1+stars) + ln(1+downloads)).
  const byId = new Map(fw.catalog.map((f) => [f.id, f]));
  const official = fw.catalog.filter((f) => f.kind !== "community");
  const top = (fw.ranked || []).slice(0, 10).filter((p) => byId.has(p.id));

  const known = new Set(fw.catalog.map((f) => f.id));
  const orphans = Object.entries(fw.library || {}).filter(([id]) => !known.has(id));

  $("#fwCards").replaceChildren(
    h("h2", { class: "fw-section" }, "Official"),
    h("div", { class: "fw-cards" }, official.map((f) => fwCard(f, fw, null))),
    h("h2", { class: "fw-section" }, "Community · top 10 free & open source ",
      h("span", { class: "info", title: fw.ranking || "", text: "ⓘ" })),
    h("div", { class: "fw-cards" }, top.map((p) => fwCard(byId.get(p.id), fw, p.rank))),
    validatedSection(fw, orphans),
    fwDirectory(fw));
  buildChecks();
}

/** The next 20 most popular projects after the cards (#11–#30), one line each. */
function fwDirectory(fw) {
  const dir = (fw.ranked || []).slice(10);
  if (!dir.length) return null;
  const first = dir[0].rank;
  return h("section", { class: "card dir" },
    h("div", { class: "section-head" },
      h("h3", { text: `Also popular · #${first}–#${dir[dir.length - 1].rank}` }),
      h("a", { class: "muted", href: fw.discovery?.source || "https://github.com/cicloid/awesome-fm-1", target: "_blank", rel: "noopener", text: "full list ↗" })),
    h("ol", { class: "dir-list" }, dir.map((p) => {
      const f = fw.catalog.find((c) => c.id === p.id);
      const val = f && validationState(fw, f);
      const lat = p.latest ? `\nLatest ${shortVer(p.latest.version)} · ${p.latest.date}` : "";
      return h("li", { title: `${p.name}: ${p.desc}${p.license ? ` (${p.license})` : ""}${lat}${p.live ? "" : "\nNumbers from the offline snapshot"}` },
        h("span", { class: "dir-rank", text: `#${p.rank}` }),
        h("span", { class: "dir-main" },
          h("a", { href: p.url, target: "_blank", rel: "noopener", text: p.name }),
          val && octo(valTitle(val), val.current ? "" : "older"),
          p.desc && h("span", { class: "dir-desc", text: " · " + p.desc })),
        h("span", { class: "dir-stats", text: `★ ${fmtNum(p.stars)}  ⬇ ${fmtNum(p.downloads)}` }));
    })));
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

/**
 * Comparable version: "ghoulbox-v2.3.2", "v2.3.2" and "2.3.2" are the same release,
 * "1.6" equals "1.6.0", "V15" → "15"; suffixes like "-rc1" stay significant.
 */
function verKey(v) {
  const s = String(v || "").trim().toLowerCase();
  const m = s.match(/(\d+(?:\.\d+)+)(.*)$/);
  if (!m) return normVer(shortVer(s));
  return m[1].replace(/(\.0+)+$/, "") + m[2].replace(/[\s()[\]]/g, "");
}

/**
 * Octopus state for a card: the best validated record and whether it is current.
 * A newer *stable* release greys it out until revalidated; pre-releases never do.
 * Without release info (offline, not checked) a validation shows as current.
 */
function validationState(fw, f) {
  const vals = validationsFor(fw, f.id);
  if (!vals.length) return null;
  const rels = fw.releases?.sources?.[f.id]?.releases || [];
  let best = null, idx = -1;
  for (const v of vals) {
    const i = rels.findIndex((r) => verKey(r.version) === verKey(v.version));
    if (i >= 0 && (idx < 0 || i < idx)) { best = v; idx = i; }
  }
  if (!rels.length) return { v: vals[0], current: true };
  // releases are newest first; anything listed before the validated one is newer
  const newer = (idx >= 0 ? rels.slice(0, idx) : rels).find((r) => !r.prerelease);
  return { v: best || vals[0], current: !newer, newer };
}

function valTitle(st) {
  return validationTip(st.v) + (st.current ? "" : `\nNewer release ${shortVer(st.newer.version)} isn't validated yet.`);
}

function validationTip(v) {
  return `Validated ${v.version} on ${v.date}: installed, ran${v.checks ? ` (${v.checks})` : ""}, reverted to stock.`
    + (v.notes ? `\n${v.notes}` : "");
}

/** Library file matching a validation record (by checksum when recorded, else version + name). */
function validatedFile(fw, v) {
  return (fw.library?.[v.id] || []).find((l) =>
    v.sha256 ? l.sha256 === v.sha256 : verKey(l.version) === verKey(v.version) && (!v.file || l.name === v.file));
}

/** "Validated firmware in Library": every validated firmware, and whether its exact file is kept. */
function validatedSection(fw, orphans) {
  const recs = (fw.validated || []).filter(isValidated)
    .sort((a, b) => fwName(a.id).localeCompare(fwName(b.id)) || String(b.date).localeCompare(String(a.date)));
  const rows = recs.map((v) => {
    const file = validatedFile(fw, v);
    const f = fw.catalog.find((c) => c.id === v.id);
    const rel = fw.releases?.sources?.[v.id]?.releases?.find((r) => verKey(r.version) === verKey(v.version));
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
  } else {
    // neutral stand-in screen: no screenshot is ever downloaded automatically
    wrap.classList.add("ph");
    wrap.append(h("span", { text: f.name.replace(/[^A-Za-z0-9]+/g, " ").trim().slice(0, 10).toUpperCase() || "FM-1" }));
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
  const haveLocal = (ver, name) => local.some((l) => verKey(l.version) === verKey(ver) && l.name === name);
  const updateAvail = isCurrent && latest && verKey(inst.version) !== verKey(latest.version);
  const fresh = latest?.date && Date.now() - Date.parse(latest.date) < 2 * 864e5
    && !local.some((l) => verKey(l.version) === verKey(latest.version));
  const primary = latest?.assets.find((a) => /\.fwsc$/i.test(a.name)) || latest?.assets[0];
  const L = f.links || {};

  const art = fwArt(f);
  const val = validationState(fw, f);
  const valBadge = val && octo(valTitle(val), val.current ? "" : "older");
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
        h("div", { class: "by" }, f.author, f.curated === false && h("span", { class: "fw-uncur", title: "Built from GitHub metadata: entered the top 10 but has no curated catalog entry (screen, tagline) yet", text: "not curated yet" })),
        h("div", { class: "fw-tag", text: f.tagline || "" }))),
    h("div", { class: "fw-body" },
      h("div", { class: "fw-chips" }, (f.tags || []).slice(0, 3).map((t) => h("span", { text: t }))),
      h("div", { class: "fw-stats" },
        flags,
        st && h("span", { title: "GitHub stars" }, "★ ", fmtNum(st.stars)),
        st?.downloads > 0 && h("span", { title: "Firmware downloads, all releases" }, "⬇ ", fmtNum(st.downloads)),
        latest && h("span", { title: `${latest.version} · ${latest.date}` }, h("b", { text: shortVer(latest.version) }), " · " + relTime(latest.date)),
        src?.error && !st && h("span", { class: "badge bad", title: src.error, text: "check failed" }),
        src?.stale && st && h("span", { class: "fw-partial", title: src.stale, text: "cached" }),
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
  const rawSend = () => {
    const parts = $("#rawHex").value.trim().split(/[\s,]+/).filter(Boolean);
    const bytes = parts.map((x) => (/^(0x)?[0-9a-f]{1,2}$/i.test(x) ? parseInt(x, 16) : NaN));
    if (!bytes.length || bytes.some(isNaN)) return toast("Enter hex bytes like 90 3C 64", true);
    if (bytes[0] < 0x80) return toast("The first byte must be a status byte (80–FF)", true);
    send(bytes);
  };
  $("#rawSend").onclick = rawSend;
  $("#rawHex").onkeydown = (e) => { if (e.key === "Enter") rawSend(); };
  $("#idReq").onclick = () => send([0xf0, 0x7e, 0x7f, 0x06, 0x01, 0xf7]);

  // send a message (Program Change / any CC)
  chOptions($("#msgCh"), S.settings.noteCh);
  $("#msgPcSend").onclick = sendProgram;
  $("#msgPc").onkeydown = (e) => { if (e.key === "Enter") sendProgram(); };
  $("#msgCc").oninput = updateMsgCc;
  $("#msgCcVal").oninput = () => sendCC(msgCh(), updateMsgCc(), +$("#msgCcVal").value);
  $("#msgCcSend").onclick = () => sendCC(msgCh(), updateMsgCc(), +$("#msgCcVal").value);
  updateMsgCc();

  // monitor
  $("#monFilter").onchange = renderMonitor;
  $("#monExport").onclick = exportMonitor;
  $("#monClear").onclick = () => { monLog.length = 0; $("#monitor").replaceChildren(); };
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
  $("#libFw").onchange = (e) => { LIB.filter = e.target.value; renderLibrary(); };
  $("#libSort").value = libPrefs().sort;
  $("#libSort").onchange = (e) => { libPrefs().sort = e.target.value; saveSettings(); renderLibrary(); };
  $("#libGroup").checked = !!libPrefs().group;
  $("#libGroup").onchange = (e) => { libPrefs().group = e.target.checked; saveSettings(); renderLibrary(); };
  $("#libNew").onclick = () => openSave({ voice: true, fx: true, firmware: libDeviceId() });
  $("#libImport").onchange = (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) importPatchFile(f); };
  // Re-read on every visit: patch files and the format registry can change outside the app.
  $('#tabs [data-tab="library"]')?.addEventListener("click", () => loadPatches());

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
