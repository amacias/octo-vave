// fm1flash.js: install a validated firmware on the FM-1 over Web MIDI, for the Install buttons
// of the Validated firmware list (app and homepage; the homepage loads a copy, docs/js/fm1flash.js,
// kept identical by tools/fm1_site.py).
//
// It speaks the FM-1's own update protocol, the one M-UPGRADE and the community installers use,
// written from FM-1-RE's notes (github.com/AL-255/FM-1-RE, docs/io/11-ota-protocol.md, WTFPL).
// Everything is SysEx on the FM-1's MIDI port, and the device drives it: after the upgrade
// command it asks for pieces of the package and we answer.
//   1. The running firmware reads part of the package, checks it and restarts into its update
//      loader (USB 4D4A:4155, identity "ota-FM-1_...").
//   2. The loader reads the whole package and writes it, then asks for the finish reply.
//   3. The FM-1 restarts and reports the installed identity, which the package names in its header.
// If step 2 is cut off, the FM-1 stays in update mode: installing again finishes the write.
//
// Only the exact validated file is ever sent: the caller's record pins its sha256, and the
// dialog refuses any other file. Nothing starts without the Install click in the dialog.

import { h, outcome } from "./fwcards.js";

const HANDSHAKE = [0xf0, 0x00, 0x32, 0x45, 0x00, 0x00, 0x00, 0x40, 0x7f, 0xf7];
const UPGRADE = [0xf0, 0x22, 0x24, 0x35, 0x7f, 0xf7];
const DONE_CHECK = 0xe0000000, DONE_WRITE = 0xf0000000;   // the device's two "finished" requests
const HEADER_BLOCKS = 20, BLOCK = 0x30;                   // .fwsc header: 47 data bytes + 1 marker per block
const MAX_REQUEST = 512;
// Ports worth a handshake: the FM-1 under stock ("FM-1 Midi"), its update loader and FM-1 Open
// ("USB-Midi") and the community firmware ("Felucca", "AMB-1 FM-1", "ChoralRoot FM-1").
// Other MIDI gear is never probed, even when it is the app's selected port.
const FM1_PORT = /fm-?1|felucca|choralroot|ota|usb-midi|composite|sinco/i;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function fail(code, message) { return Object.assign(new Error(message), { code }); }

// ---------------------------------------------------------------- package and wire format

// 8-bit bytes to the MIDI-safe 7-bit stream and back: one continuous bit stream, low bits first.
function to7(bytes) {
  const out = []; let acc = 0, bits = 0;
  for (const b of bytes) {
    acc |= b << bits; bits += 8;
    while (bits >= 7) { out.push(acc & 0x7f); acc >>>= 7; bits -= 7; }
  }
  if (bits) out.push(acc & 0x7f);
  return out;
}
function from7(bytes) {
  const out = []; let acc = 0, bits = 0;
  for (const b of bytes) {
    acc |= (b & 0x7f) << bits; bits += 7;
    while (bits >= 8) { out.push(acc & 0xff); acc >>>= 8; bits -= 8; }
  }
  return out;
}

/** The identity a package installs ("FM-1_916"): spelled by the header's marker bytes. */
export function packageInfo(file) {
  if (file.length < HEADER_BLOCKS * BLOCK + MAX_REQUEST) return null;
  let product = "";
  for (let i = 0; i < HEADER_BLOCKS; i++) {
    const m = file[i * BLOCK + BLOCK - 1];
    if (m !== 0x7d) product += String.fromCharCode((m - i - 1) & 0xff);
  }
  const m = /^([A-Za-z0-9+-]+)_(\d+)$/.exec(product);
  return m ? { product, model: m[1], version: +m[2] } : null;
}

/** The image the device asks for: the header blocks without their markers, then the rest as it is. */
export function logicalImage(file) {
  const out = new Uint8Array(file.length - HEADER_BLOCKS);
  for (let i = 0; i < HEADER_BLOCKS; i++) out.set(file.subarray(i * BLOCK, (i + 1) * BLOCK - 1), i * (BLOCK - 1));
  out.set(file.subarray(HEADER_BLOCKS * BLOCK), HEADER_BLOCKS * (BLOCK - 1));
  return out;
}

export async function sha256Hex(bytes) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// [00 59 30][body length:3][flash type][address:4][length:3][data][checksum], all little-endian;
// the checksum is the complement of the sum from the flash type on.
function answer(type, addr, data) {
  const n = data.length, body = n + 8;
  const msg = [0x00, 0x59, 0x30, body & 255, (body >> 8) & 255, (body >> 16) & 255, type,
    addr & 255, (addr >>> 8) & 255, (addr >>> 16) & 255, (addr >>> 24) & 255, n & 255, (n >> 8) & 255, (n >> 16) & 255];
  for (const b of data) msg.push(b);
  let sum = 0;
  for (let i = 6; i < msg.length; i++) sum += msg[i];
  msg.push(~sum & 255);
  return [0xf0, ...to7(msg), 0xf7];
}
function checksumOk(u) {
  let sum = 0;
  for (let i = 6; i < u.length - 1; i++) sum += u[i];
  return (~sum & 255) === u[u.length - 1];
}
function readRequest(msg) {
  const u = from7(msg.slice(1, -1));
  if (u.length !== 15 || u[0] !== 0x00 || u[1] !== 0x59 || u[2] !== 0x30 || (u[3] | (u[4] << 8) | (u[5] << 16)) !== 8 || !checksumOk(u)) return null;
  return { type: u[6], addr: (u[7] | (u[8] << 8) | (u[9] << 16) | (u[10] << 24)) >>> 0, len: u[11] | (u[12] << 8) | (u[13] << 16) };
}
function readIdentity(msg) {
  const u = from7(msg.slice(1, -1));
  if (u.length !== 34 || u[0] !== 0x00 || u[1] !== 0x59 || u[2] !== 0x11) return null;
  let text = "";
  for (let i = 6; i < 33 && u[i]; i++) text += String.fromCharCode(u[i]);
  const m = /^([^_]+)_(\d+)$/.exec(text);
  if (!m) return null;
  const ota = /^ota-/i.test(m[1]);
  return { text, model: m[1].replace(/^ota-/i, ""), version: +m[2], ota };
}

// ---------------------------------------------------------------- device link

class Link {
  constructor(input, output) {
    this.input = input; this.output = output; this.queue = []; this.wake = null;
    this.onMessage = (e) => {
      if (e.data[0] !== 0xf0) return;
      this.queue.push(Array.from(e.data));
      if (this.wake) this.wake();
    };
    input.addEventListener("midimessage", this.onMessage);
  }
  get gone() { return this.input.state === "disconnected" || this.output.state === "disconnected"; }
  send(bytes) { try { this.output.send(bytes); return true; } catch { return false; } }
  async next(ms) {
    if (!this.queue.length) {
      await new Promise((r) => { const t = setTimeout(r, ms); this.wake = () => { clearTimeout(t); r(); }; });
      this.wake = null;
    }
    return this.queue.shift() || null;
  }
  close() { this.input.removeEventListener("midimessage", this.onMessage); }
}

async function identify(link) {
  link.queue.length = 0;
  for (let t = 0; t < 3; t++) {
    if (!link.send(HANDSHAKE)) return null;
    const end = Date.now() + 1000;
    for (let msg; Date.now() < end && (msg = await link.next(end - Date.now()));) {
      const id = readIdentity(msg);
      if (id) return id;
    }
  }
  return null;
}

/** The FM-1 on any likely port (the preferred one first), as { link, id }; null if none answers. */
async function findDevice(access, { ota, prefer } = {}) {
  const outputs = [...access.outputs.values()];
  const inputs = [...access.inputs.values()]
    .filter((p) => p.state !== "disconnected" && FM1_PORT.test(p.name || ""))
    .sort((a, b) => (b.name === prefer) - (a.name === prefer));
  for (const input of inputs) {
    const output = outputs.find((o) => o.name === input.name && o.state !== "disconnected");
    if (!output) continue;
    try { await input.open(); await output.open(); } catch { continue; }
    const link = new Link(input, output);
    const id = await identify(link);
    if (id && (ota === undefined || id.ota === ota)) return { link, id };
    link.close();
  }
  return null;
}
async function waitForDevice(access, opts, ms) {
  for (const end = Date.now() + ms; Date.now() < end; await wait(1000)) {
    const dev = await findDevice(access, opts);
    if (dev) return dev;
  }
  return null;
}

// Answer read requests until the device asks for `finish`; { finished, lost, bytes }.
async function serve(link, image, finish, idleMs, onData) {
  let bytes = 0, last = Date.now();
  for (;;) {
    const msg = await link.next(1000);
    if (!msg) {
      if (link.gone) return { finished: false, lost: true, bytes };
      if (Date.now() - last > idleMs) return { finished: false, lost: false, bytes };
      continue;
    }
    const r = readRequest(msg);
    if (!r) continue;
    last = Date.now();
    if (r.addr === DONE_CHECK || r.addr === DONE_WRITE) {
      link.send(answer(r.type, r.addr, [...new TextEncoder().encode("success"), 0]));
      if (r.addr === finish) return { finished: true, lost: false, bytes };
      continue;
    }
    if (r.len > MAX_REQUEST || r.addr + r.len > image.length) throw fail("request", `The FM-1 asked for bytes outside the package (${r.addr.toString(16)} + ${r.len}). Nothing more was sent.`);
    await wait(10);   // the device needs a moment between answers (M-UPGRADE paces about 10 ms)
    if (!link.send(answer(r.type, r.addr, image.subarray(r.addr, r.addr + r.len)))) return { finished: false, lost: true, bytes };
    bytes += r.len;
    if (onData) onData(bytes, r.addr);
  }
}

/**
 * Install a package (the whole .fwsc file as a Uint8Array). `step(name, detail)` reports
 * progress: find, check, loader, resume, write ({ bytes, total }), restart.
 * Resolves to { identity, expected } (identity null when the FM-1 restarted but didn't answer).
 */
export async function installPackage(access, file, { prefer, step = () => {} } = {}) {
  const pkg = packageInfo(file);
  if (!pkg) throw fail("package", "This file isn't an FM-1 firmware package (.fwsc).");
  const image = logicalImage(file);
  step("find");
  let dev = await waitForDevice(access, { prefer }, 10000);   // it may still be restarting after a cut-off try
  if (!dev) {
    const seen = [...access.inputs.values()].map((p) => p.name).filter(Boolean);
    throw fail("notfound", "The FM-1 didn't answer. Plug it in by USB and close any other program using it (M-UPGRADE, a web installer, a MIDI editor): on Windows only one program can use it at a time. Under FM-1 Open, use its Workbench to go back to stock first. "
      + (seen.length ? `MIDI ports seen: ${seen.join(", ")}.` : "No MIDI ports are visible."));
  }
  if (dev.id.model !== pkg.model) { dev.link.close(); throw fail("model", `The device reports ${dev.id.text}, but this package is for ${pkg.product}.`); }
  if (!dev.id.ota) {
    step("check", dev.id.text);
    dev.link.send(UPGRADE);
    await wait(2000);
    const s1 = await serve(dev.link, image, DONE_CHECK, 8000);
    if (!s1.finished) {
      dev.link.close();
      throw fail(s1.lost ? "lost" : "refused", s1.lost
        ? "The FM-1 disconnected while checking the package. Nothing was written: reconnect it and try again."
        : `The FM-1 didn't accept the package. Nothing was written. It ignores an update to the version it already runs${dev.id.text === pkg.product ? ` (it reports ${dev.id.text})` : ""}.`);
    }
    await wait(3000);   // let the last answer drain before the device restarts
    dev.link.close();
    step("loader");
    dev = await waitForDevice(access, { ota: true }, 30000);
    if (!dev) throw fail("noloader", "The FM-1 didn't come back in update mode. Unplug and reconnect it, then try again.");
  } else {
    step("resume");
  }
  step("write", { bytes: 0, total: image.length });
  dev.link.send(UPGRADE);
  await wait(2000);
  const s2 = await serve(dev.link, image, DONE_WRITE, 180000, (bytes) => step("write", { bytes, total: image.length }));
  dev.link.close();
  if (!s2.finished) {
    throw fail(s2.lost ? "lost" : "stopped", `The write ${s2.lost ? "was cut off" : "stopped"}. The FM-1 stays in update mode until it is finished: reconnect it if needed and try again to finish it.`);
  }
  step("restart");
  await wait(3000);
  const back = await waitForDevice(access, { ota: false }, 40000);
  if (back) back.link.close();
  return { identity: back ? back.id.text : null, expected: pkg.product };
}

// ---------------------------------------------------------------- Install button and dialog

const STEPS = [["find", "Find the FM-1"], ["check", "Check the package"], ["loader", "Restart into update mode"],
  ["write", "Write the firmware"], ["restart", "Restart and check"]];

/**
 * The Install action for one validated record, or null when it can't be installed from here.
 * opts: name (shown), file record v, downloadUrl, installUrl (the project's own installer),
 * getFile() → Uint8Array, or null when the user has to pick the downloaded file,
 * getAccess() → MIDIAccess with SysEx, prefer (port name), before(), after(result | null), mount.
 */
export function installAction(v, opts) {
  if (!["clean", "issues"].includes(outcome(v))) return null;   // only passing validations
  if (!/\.fwsc$/i.test(v.file || "") || !v.sha256) {
    // FM-1 Open ships as a Workbench page that flashes itself
    return opts.installUrl && h("a", { class: "btn ghost fw-install-btn", href: opts.installUrl, target: "_blank", rel: "noopener",
      title: `${opts.name} installs from its own page`, text: "Installer ↗" });
  }
  const b = h("button", { class: "ghost fw-install-btn", text: "Install",
    title: opts.stock ? "Put stock V15 back on the FM-1 (the validated file)" : `Install the validated ${opts.name} ${v.version} on the FM-1` });
  b.onclick = () => openInstall(v, opts);
  return b;
}

function openInstall(v, o) {
  let file = null, running = false;
  const label = o.name.includes(v.version) ? o.name : `${o.name} ${v.version}`;   // "Stock V15" names its version
  const title = o.stock ? `Back to ${label}` : `Install ${label}`;
  const fileMsg = h("p", { class: "fw-i-file", text: "Getting the validated file…" });
  const picker = h("input", { type: "file", accept: ".fwsc", hidden: true });
  const pick = h("div", { class: "fw-i-pick", hidden: true },
    h("p", {}, "This page can't fetch the file from its host. ",
      o.downloadUrl ? h("a", { href: o.downloadUrl, rel: "noopener", text: `Download ${v.file}` }) : `Download ${v.file}`,
      ", then choose it or drop it here."),
    h("button", { type: "button", class: "ghost", text: "Choose the file…", onclick: () => picker.click() }), picker);
  const stepList = h("ol", { class: "fw-i-steps", hidden: true }, STEPS.map(([k, label]) => h("li", { "data-step": k, text: label })));
  const bar = h("progress", { max: 100, value: 0, hidden: true });
  const msg = h("p", { class: "fw-i-msg", role: "status" });
  const go = h("button", { class: "primary", text: o.stock ? "Install stock" : "Install", disabled: true });
  const close = h("button", { type: "button", class: "ghost", text: "Cancel" });
  const dlg = h("dialog", { class: "fw-flash" },
    h("h3", { text: title }),
    h("p", { class: "muted", text: "The FM-1 restarts twice and the whole update takes 2 to 3 minutes. Keep it plugged in and this page open until it says Done." }),
    h("ul", { class: "fw-i-notes" },
      h("li", { text: "Some firmware resets voices, patterns or projects: save what you want to keep first." }),
      h("li", { text: "Close other programs using the FM-1 (M-UPGRADE, web installers, MIDI editors)." }),
      o.stock ? null : h("li", { text: "Going back later: Install on the Stock V15 row." })),
    fileMsg, pick, stepList, bar, msg,
    h("div", { class: "fw-i-actions" }, close, go));
  (o.mount || document.body).append(dlg);

  const leave = (e) => { e.preventDefault(); e.returnValue = ""; };
  const done = () => { window.removeEventListener("beforeunload", leave); running = false; close.disabled = false; };
  dlg.addEventListener("cancel", (e) => { if (running) e.preventDefault(); });
  dlg.addEventListener("close", () => dlg.remove());
  close.onclick = () => { if (!running) dlg.close(); };

  const accept = async (bytes) => {
    const sum = await sha256Hex(bytes);
    if (sum !== v.sha256.toLowerCase()) {
      file = null; go.disabled = true;
      fileMsg.className = "fw-i-file bad";
      fileMsg.textContent = `That file isn't the validated ${v.file}: its SHA256 is ${sum.slice(0, 12)}…, the validated one ${v.sha256.slice(0, 12)}…`;
      return;
    }
    file = bytes; go.disabled = false; pick.hidden = true;
    fileMsg.className = "fw-i-file ok";
    fileMsg.textContent = `✓ ${v.file}: the validated file (SHA256 ${v.sha256.slice(0, 12)}…)`;
  };
  const fromBlob = (blob) => blob && blob.arrayBuffer().then((buf) => accept(new Uint8Array(buf)));
  picker.onchange = () => fromBlob(picker.files[0]);
  pick.addEventListener("dragover", (e) => e.preventDefault());
  pick.addEventListener("drop", (e) => { e.preventDefault(); fromBlob(e.dataTransfer.files[0]); });

  const mark = (k) => {
    const at = STEPS.findIndex(([s]) => s === k);
    stepList.querySelectorAll("li").forEach((li, i) => { li.className = i < at ? "done" : i === at ? "active" : ""; });
  };
  go.onclick = async () => {
    running = true; go.disabled = true; close.disabled = true; stepList.hidden = false;
    window.addEventListener("beforeunload", leave);
    msg.className = "fw-i-msg"; msg.textContent = ""; bar.value = 0; bar.hidden = true;
    let result = null;
    try {
      const access = await o.getAccess();
      if (o.before) await o.before();
      result = await installPackage(access, file, { prefer: o.prefer?.(), step: (k, d) => {
        mark(k === "resume" ? "write" : k);
        if (k === "check") msg.textContent = `Found ${d}.`;
        if (k === "resume") msg.textContent = "The FM-1 is in update mode: finishing the write.";
        if (k === "write") {
          bar.hidden = false; bar.value = Math.min(99, Math.round((100 * d.bytes) / d.total));
          msg.textContent = `Writing: ${bar.value}%`;
        }
      } });
      bar.value = 100;
      stepList.querySelectorAll("li").forEach((li) => { li.className = "done"; });
      msg.className = "fw-i-msg " + (result.identity === result.expected ? "ok" : "warn");
      msg.textContent = !result.identity
        ? `Written. The FM-1 restarted but didn't answer the check: look at its screen. It should run ${result.expected}.`
        : result.identity === result.expected ? `Done: the FM-1 now reports ${result.identity}.`
          : `Written, but the FM-1 now reports ${result.identity} (the package says ${result.expected}).`;
      close.textContent = "Close"; go.hidden = true;
    } catch (e) {
      msg.className = "fw-i-msg bad";
      msg.textContent = e.message;
      go.disabled = !file; go.textContent = "Try again";
    } finally {
      done();
      if (o.after) await o.after(result);
    }
  };

  dlg.showModal();
  Promise.resolve().then(() => o.getFile()).then((bytes) => {
    if (bytes) return accept(bytes);
    fileMsg.textContent = ""; pick.hidden = false;
  }).catch((e) => { fileMsg.textContent = ""; pick.hidden = false; msg.className = "fw-i-msg bad"; msg.textContent = e.message; });
}
