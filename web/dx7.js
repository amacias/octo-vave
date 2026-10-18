// DX7-compatible voice model for the M-VAVE FM-1.
//
// The FM-1 MIDI guide documents a single-parameter SysEx write:
//   F0 43 10 pp qq vv F7   (param = pp*128 + qq, 0..155, value vv)
// which is the Yamaha DX7 voice-parameter-change format. Parameter numbers
// follow the DX7 VCED layout below. Factory voices can't be read back over
// MIDI, so the editor holds "what we last sent".

export const OP_FIELDS = [
  // [offset, key, label, max, group]
  [0, "r1", "Rate 1", 99, "eg"], [1, "r2", "Rate 2", 99, "eg"],
  [2, "r3", "Rate 3", 99, "eg"], [3, "r4", "Rate 4", 99, "eg"],
  [4, "l1", "Level 1", 99, "eg"], [5, "l2", "Level 2", 99, "eg"],
  [6, "l3", "Level 3", 99, "eg"], [7, "l4", "Level 4", 99, "eg"],
  [8, "bp", "Break point", 99, "kbd"], [9, "ld", "L depth", 99, "kbd"],
  [10, "rd", "R depth", 99, "kbd"], [11, "lc", "L curve", 3, "kbd"],
  [12, "rc", "R curve", 3, "kbd"], [13, "rs", "Rate scale", 7, "kbd"],
  [14, "ams", "Amp mod sens", 3, "out"], [15, "vel", "Velocity sens", 7, "out"],
  [16, "out", "Output level", 99, "out"], [17, "mode", "Osc mode", 1, "osc"],
  [18, "coarse", "Coarse", 31, "osc"], [19, "fine", "Fine", 99, "osc"],
  [20, "detune", "Detune", 14, "osc"],
];

export const GLOBAL_FIELDS = [
  [126, "pr1", "Pitch EG R1", 99, "peg"], [127, "pr2", "Pitch EG R2", 99, "peg"],
  [128, "pr3", "Pitch EG R3", 99, "peg"], [129, "pr4", "Pitch EG R4", 99, "peg"],
  [130, "pl1", "Pitch EG L1", 99, "peg"], [131, "pl2", "Pitch EG L2", 99, "peg"],
  [132, "pl3", "Pitch EG L3", 99, "peg"], [133, "pl4", "Pitch EG L4", 99, "peg"],
  [134, "alg", "Algorithm", 31, "core"], [135, "fb", "Feedback", 7, "core"],
  [136, "oks", "Osc key sync", 1, "core"], [144, "trans", "Transpose", 48, "core"],
  [137, "lspd", "LFO speed", 99, "lfo"], [138, "ldly", "LFO delay", 99, "lfo"],
  [139, "pmd", "Pitch mod depth", 99, "lfo"], [140, "amd", "Amp mod depth", 99, "lfo"],
  [141, "lsync", "LFO key sync", 1, "lfo"], [142, "lwave", "LFO wave", 5, "lfo"],
  [143, "pms", "Pitch mod sens", 7, "lfo"],
];

export const NAME_OFFSET = 145;   // 145..154, 10 ASCII chars
export const OP_ENABLE = 155;     // bit5 = OP1 ... bit0 = OP6
export const VOICE_LEN = 156;

export const LFO_WAVES = ["Triangle", "Saw down", "Saw up", "Square", "Sine", "S&H"];
export const CURVES = ["-LIN", "-EXP", "+EXP", "+LIN"];

// Carrier operators per algorithm (1-based), from the DX7 algorithm chart.
export const CARRIERS = [
  [1, 3], [1, 3], [1, 4], [1, 4], [1, 3, 5], [1, 3, 5], [1, 3], [1, 3],
  [1, 3], [1, 4], [1, 4], [1, 3], [1, 3], [1, 3], [1, 3], [1],
  [1], [1], [1, 4, 5], [1, 2, 4], [1, 2, 4, 5], [1, 3, 4, 5], [1, 2, 4, 5], [1, 2, 3, 4, 5],
  [1, 2, 3, 4, 5], [1, 2, 4], [1, 2, 4], [1, 3, 6], [1, 2, 3, 5], [1, 2, 3, 6], [1, 2, 3, 4, 5], [1, 2, 3, 4, 5, 6],
];

/** Parameter number for operator `op` (1..6) field offset `off`. */
export const opParam = (op, off) => (6 - op) * 21 + off;

/** Max value for any parameter number (0..155). */
export function paramMax(p) {
  if (p < 126) return OP_FIELDS[p % 21][3];
  if (p >= NAME_OFFSET && p < NAME_OFFSET + 10) return 127;
  if (p === OP_ENABLE) return 63;
  const g = GLOBAL_FIELDS.find((f) => f[0] === p);
  return g ? g[3] : 127;
}

/** The DX7 "INIT VOICE": one sine carrier at full level. */
export function initVoice() {
  const v = new Array(VOICE_LEN).fill(0);
  for (let op = 1; op <= 6; op++) {
    const b = opParam(op, 0);
    v[b + 0] = v[b + 1] = v[b + 2] = v[b + 3] = 99; // rates
    v[b + 4] = v[b + 5] = v[b + 6] = 99;            // L1-L3
    v[b + 7] = 0;                                   // L4
    v[b + 8] = 39;                                  // break point C3
    v[b + 16] = op === 1 ? 99 : 0;
    v[b + 18] = 1;                                  // ratio 1.00
    v[b + 20] = 7;                                  // detune centre
  }
  for (let i = 126; i <= 129; i++) v[i] = 99;
  for (let i = 130; i <= 133; i++) v[i] = 50;
  v[134] = 0; v[135] = 0; v[136] = 1;
  v[137] = 35; v[138] = 0; v[139] = 0; v[140] = 0; v[141] = 1; v[142] = 0; v[143] = 3;
  v[144] = 24;
  setName(v, "INIT VOICE");
  v[OP_ENABLE] = 63;
  return v;
}

export function getName(v) {
  return String.fromCharCode(...v.slice(NAME_OFFSET, NAME_OFFSET + 10).map((c) => (c >= 32 && c < 127 ? c : 32))).trimEnd();
}

export function setName(v, name) {
  const s = (name || "").padEnd(10, " ").slice(0, 10);
  for (let i = 0; i < 10; i++) {
    const c = s.charCodeAt(i);
    v[NAME_OFFSET + i] = c >= 32 && c < 127 ? c : 32;
  }
}

export function clampVoice(v) {
  const out = new Array(VOICE_LEN).fill(0);
  for (let p = 0; p < VOICE_LEN; p++) {
    const n = Number(v?.[p]) | 0;
    out[p] = Math.max(0, Math.min(paramMax(p), n));
  }
  return out;
}

/** SysEx bytes for one parameter write. */
export function paramMessage(p, value) {
  return [0xf0, 0x43, 0x10, (p >> 7) & 0x7f, p & 0x7f, value & 0x7f, 0xf7];
}

/** Ratio/fixed-frequency display for an operator. */
export function freqLabel(mode, coarse, fine) {
  if (mode === 1) {
    const hz = Math.pow(10, coarse % 4) * Math.exp((Math.LN10 * fine) / 100);
    return hz >= 1000 ? `${(hz / 1000).toFixed(2)} kHz` : `${hz.toFixed(hz < 10 ? 3 : 1)} Hz`;
  }
  const base = coarse === 0 ? 0.5 : coarse;
  return `×${(base * (1 + fine / 100)).toFixed(2)}`;
}

// ---------------------------------------------------------------- .syx files

function checksum(bytes) {
  let s = 0;
  for (const b of bytes) s += b;
  return (128 - (s & 0x7f)) & 0x7f;
}

/** Unpack one 128-byte VMEM (32-voice bank) record into a 156-param voice. */
function unpackVmem(d) {
  const v = new Array(VOICE_LEN).fill(0);
  for (let i = 0; i < 6; i++) {          // packed op 0 = OP6 ... op 5 = OP1
    const s = d.subarray(i * 17, i * 17 + 17);
    const b = i * 21;
    for (let k = 0; k < 11; k++) v[b + k] = s[k];
    v[b + 11] = s[11] & 3;
    v[b + 12] = (s[11] >> 2) & 3;
    v[b + 13] = s[12] & 7;
    v[b + 20] = (s[12] >> 3) & 15;
    v[b + 14] = s[13] & 3;
    v[b + 15] = (s[13] >> 2) & 7;
    v[b + 16] = s[14];
    v[b + 17] = s[15] & 1;
    v[b + 18] = (s[15] >> 1) & 31;
    v[b + 19] = s[16];
  }
  for (let k = 0; k < 8; k++) v[126 + k] = d[102 + k];
  v[134] = d[110] & 31;
  v[135] = d[111] & 7;
  v[136] = (d[111] >> 3) & 1;
  v[137] = d[112]; v[138] = d[113]; v[139] = d[114]; v[140] = d[115];
  v[141] = d[116] & 1;
  v[142] = (d[116] >> 1) & 7;
  v[143] = (d[116] >> 4) & 7;
  v[144] = d[117];
  for (let k = 0; k < 10; k++) v[NAME_OFFSET + k] = d[118 + k];
  v[OP_ENABLE] = 63;
  return clampVoice(v);
}

/**
 * Parse a DX7 .syx file (single-voice VCED or 32-voice VMEM bank, possibly
 * several messages concatenated). Returns { voices: [{name, data}], warnings }.
 */
export function parseSyx(buf) {
  const bytes = new Uint8Array(buf);
  const voices = [];
  const warnings = [];
  let i = 0;
  while (i < bytes.length) {
    if (bytes[i] !== 0xf0) { i++; continue; }
    const end = bytes.indexOf(0xf7, i);
    if (end < 0) { warnings.push("unterminated SysEx message"); break; }
    const msg = bytes.subarray(i, end + 1);
    i = end + 1;
    if (msg[1] !== 0x43) { warnings.push("skipped non-Yamaha message"); continue; }
    const fmt = msg[3];
    const count = (msg[4] << 7) | msg[5];
    const data = msg.subarray(6, 6 + count);
    const cs = msg[6 + count];
    if (data.length !== count) { warnings.push("truncated message"); continue; }
    if (checksum(data) !== cs) warnings.push(`checksum mismatch (format ${fmt}); loaded anyway`);
    if (fmt === 0 && count === 155) {
      const v = clampVoice([...data, 63]);
      voices.push({ name: getName(v), data: v });
    } else if (fmt === 9 && count === 4096) {
      for (let n = 0; n < 32; n++) {
        const v = unpackVmem(data.subarray(n * 128, n * 128 + 128));
        voices.push({ name: getName(v), data: v });
      }
    } else {
      warnings.push(`unsupported format ${fmt} (${count} bytes)`);
    }
  }
  return { voices, warnings };
}

/** Export a voice as a standard DX7 single-voice (VCED) .syx message. */
export function voiceToSyx(v) {
  const data = clampVoice(v).slice(0, 155);
  return new Uint8Array([0xf0, 0x43, 0x00, 0x00, 0x01, 0x1b, ...data, checksum(data), 0xf7]);
}
