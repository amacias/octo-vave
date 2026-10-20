// fwcards.js: the firmware cards, octopus validation badges, trait icons and the
// "Also popular" list, shared by the app's Firmware tab and the GitHub Pages homepage.
// The homepage loads a copy (docs/js/fwcards.js) kept identical by tools/fm1_site.py.
//
// Everything renders from the /api/firmware payload, or its published snapshot
// docs/data/firmware.json. Library actions (download into the library, import, reveal,
// log installed) need the local server: the app passes them in as `app` hooks, and
// without hooks a card links straight to the release files instead.

// ================================================================ helpers

export function h(tag, props = {}, ...kids) {
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

export const fmtBytes = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`);
export const normVer = (v) => String(v || "").trim().replace(/^v/i, "").toLowerCase();

/** The next 20 most popular projects after the cards (#11–#30), one line each. */
export function fwDirectory(fw) {
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
          val && octoFor(val.v, valTitle(val), val.current),
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
export function icon(k) {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("class", "ic");
  const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
  p.setAttribute("d", ICON[k]); s.append(p);
  return s;
}

// ---------------------------------------------------------------- validation
// firmware/validated.json is written by hands-on validation sessions (see
// VALIDATION.md). The octopus colour is the outcome: orange = validated cleanly
// (installed, ran, reverted to stock), purple = validated with issues, red = failed.
// Grey = a newer stable release hasn't been tested yet. Partial records show nothing.

const OCTO = '<svg viewBox="0 0 32 32" class="octo" aria-hidden="true">'
  + '<path style="fill:var(--octo,#F07A2B)" d="M16 3C10 3 6 7.3 6 13c0 3.2 1.4 5.6 3.4 7.1L7 24.5c-.6 1.1-1.9 1.5-3 1-.6-.3-1.3.1-1.2.8.2 1.6 2 2.6 3.7 2.1 1.6-.5 2.6-1.8 3.4-3.2l1.6-2.8.5 4.2c.1 1.2-.6 2.3-1.7 2.7-.6.2-.6 1.1.1 1.2 2 .4 3.8-1 4-3l.4-4.3h2.4l.4 4.3c.2 2 2 3.4 4 3 .7-.1.7-1 .1-1.2-1.1-.4-1.8-1.5-1.7-2.7l.5-4.2 1.6 2.8c.8 1.4 1.8 2.7 3.4 3.2 1.7.5 3.5-.5 3.7-2.1.1-.7-.6-1.1-1.2-.8-1.1.5-2.4.1-3-1l-2.4-4.4C24.6 18.6 26 16.2 26 13c0-5.7-4-10-10-10z"/>'
  + '<circle cx="12.4" cy="13" r="2" fill="#fff"/><circle cx="19.6" cy="13" r="2" fill="#fff"/>'
  + '<circle cx="12.8" cy="13.4" r="1" fill="#2b1a10"/><circle cx="20" cy="13.4" r="1" fill="#2b1a10"/></svg>';

// Card traits: source (egg cracked open / closed), checksum published (green check),
// one-click revert to stock in the project's installer (blue first aid). Grey = no / unknown.
const TRAIT_SVG = {
  open: '<svg viewBox="0 0 24 24" aria-hidden="true"><path class="shell" d="M5 13.2l2.3 2 2.3-2.4 2.4 2.4 2.4-2.4 2.3 2.4 2.3-2C19 18.4 16 22 12 22s-7-3.6-7-8.8z"/>'
    + '<circle class="yolk" cx="12" cy="14.6" r="2.3"/>'
    + '<path class="shell" transform="rotate(-16 12 9) translate(0 -2)" d="M5.4 10.2C6.2 5.4 8.8 2 12 2s5.8 3.4 6.6 8.2l-2.2-1.6-2.3 2.3-2.1-2.3-2.2 2.3-2.2-2.3z"/></svg>',
  closed: '<svg viewBox="0 0 24 24" aria-hidden="true"><path class="shell" d="M12 2C8.2 2 5 8 5 13.4 5 18.4 8 22 12 22s7-3.6 7-8.6C19 8 15.8 2 12 2z"/></svg>',
  sum: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle class="bg" cx="12" cy="12" r="10"/><path class="fg" d="M7.2 12.4l3.2 3.2 6.4-6.8" fill="none" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  aid: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect class="bg" x="2.5" y="2.5" width="19" height="19" rx="4.5"/><path class="fg-fill" d="M10 6.5h4v3.5h3.5v4H14v3.5h-4V14H6.5v-4H10z"/></svg>',
  // requires a stock ("original gangster") firmware version first: a bronze seal
  og: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle class="bg" cx="12" cy="12" r="10.5"/><circle class="ring" cx="12" cy="12" r="8.4"/><text class="fg-text" x="12" y="15.4" text-anchor="middle">OG</text></svg>',
  // install methods: web installer (globe), Python script (snake), M-UPGRADE (M with an up arrow)
  web: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect class="bg" x="2.5" y="2.5" width="19" height="19" rx="4.5"/><g class="fg" fill="none" stroke-width="1.5"><circle cx="12" cy="12" r="6.2"/><ellipse cx="12" cy="12" rx="2.7" ry="6.2"/><path d="M5.8 12h12.4M6.8 8.8h10.4M6.8 15.2h10.4"/></g></svg>',
  python: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect class="bg" x="2.5" y="2.5" width="19" height="19" rx="4.5"/><path class="fg" fill="none" stroke-width="2.2" stroke-linecap="round" d="M7 17.5c2.5 0 3.4-1.4 3.4-3s-1.6-2.6-1.6-4.2S10 7 12.4 7h2"/><circle class="fg-fill" cx="15.8" cy="7" r="2.1"/><circle class="eye" cx="16.4" cy="6.5" r=".55"/></svg>',
  mupgrade: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect class="bg" x="2.5" y="2.5" width="19" height="19" rx="4.5"/><text class="fg-text" x="10.6" y="16.6" text-anchor="middle">M</text><path class="fg" fill="none" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" d="M17.6 11V5.6M15.6 7.6l2-2 2 2"/></svg>',
};

const INSTALL_METHODS = {
  web: "Web installer: Chrome or Edge over USB, nothing to install",
  python: "Python script installer (command line)",
  "m-upgrade": "M-UPGRADE: M-VAVE's Windows updater",
};

function trait(kind, cls, title) {
  const s = h("span", { class: `trait ${kind} ${cls}`, title });
  s.innerHTML = TRAIT_SVG[kind === "egg" ? cls : kind === "m-upgrade" ? "mupgrade" : kind];
  return s;
}

/** The three trait icons for a card. latest/primary: its newest release and main file (may be absent). */
function fwTraits(f, latest, primary) {
  const t = f.traits || {};
  // uncurated cards come from GitHub repos that had to carry a license to rank
  const open = t.source ? t.source === "open" : f.source?.type === "github";
  const sum = !latest ? null : !!(latest.sha256sums || latest.sha256files?.[primary?.name] || primary?.sha256);
  const rev = typeof t.revert === "boolean" ? t.revert : null;
  const note = (s) => (s ? "\n" + s : "");
  return h("span", { class: "fw-traits" },
    trait("egg", open ? "open" : "closed", (open ? "Open source" : "Closed source") + note(t.sourceNote)),
    trait("sum", sum ? "on" : "off",
      sum === true ? `Checksum published: downloads of ${shortVer(latest.version)} are checked against the project's SHA256`
        : sum === false ? (latest.assets?.length ? `No checksum published for ${shortVer(latest.version)}: downloads can't be verified`
          : "No checksum: there is no separate firmware file to check")
          : "Checksum unknown until Check for updates"),
    trait("aid", rev ? "on" : "off",
      rev === true ? "Revert to stock from its own installer" + note(t.revertNote)
        : rev === false ? "No one-click revert to stock in its installer" + note(t.revertNote)
          : "Revert to stock: not checked yet (card not curated)"));
}

/** Install icons, next to the Install button: stock version needed first (OG) and how it installs. */
function fwInstallTraits(f) {
  const t = f.traits || {};
  const rs = t.requires_stock_version; // "V15" | null (none) | undefined (unknown)
  const methods = Array.isArray(t.install_method) ? t.install_method.filter((m) => INSTALL_METHODS[m]) : [];
  const note = (s) => (s ? "\n" + s : "");
  return h("span", { class: "fw-install" },
    trait("og", rs ? "on" : "off",
      rs ? `Requires stock ${rs} on the FM-1 before installing` + note(t.requires_stock_note)
        : rs === null ? "No stock version required" + note(t.requires_stock_note)
          : "Stock version requirement: not checked yet (card not curated)"),
    methods.map((m) => trait(m, "on", "Install with: " + INSTALL_METHODS[m])));
}

export function octoLegend() {
  return h("span", { class: "val-legend muted" },
    octo("Validated", "clean"), "validated", octo("Validated with issues", "issues"), "with issues", octo("Failed validation", "failed"), "failed",
    octo("Newer release not tested yet", "clean older"), "newer release not tested yet");
}

export function traitLegend() {
  return h("span", { class: "trait-legend muted" },
    trait("egg", "open", "Open source"), "open", trait("egg", "closed", "Closed source"), "closed source",
    trait("sum", "on", "Checksum published"), "checksum", trait("aid", "on", "Revert to stock in the installer"), "revert in installer",
    trait("og", "on", "Requires a stock firmware version first"), "needs stock first",
    trait("web", "on", INSTALL_METHODS.web), "web", trait("python", "on", INSTALL_METHODS.python), "python",
    trait("m-upgrade", "on", INSTALL_METHODS["m-upgrade"]), "M-UPGRADE",
    h("span", { class: "trait-off-note", text: "(grey = no or unknown)" }));
}

export function octo(title, cls = "") {
  const s = h("span", { class: "octo-wrap " + cls, title });
  s.innerHTML = OCTO;
  return s;
}

const allSteps = (v) => !!(v?.steps?.install && v?.steps?.run && v?.steps?.revert);
/** clean | issues | failed, or null for a partial record (not shown). */
export function outcome(v) {
  if (["clean", "issues", "failed"].includes(v?.result)) return v.result;
  return allSteps(v) ? "clean" : null;
}
export const isValidated = (v) => outcome(v) !== null;
export const OUTCOME_LABEL = { clean: "Validated", issues: "Validated with issues", failed: "Failed validation" };
export const octoFor = (v, title, current = true) => octo(title, `${outcome(v)}${current ? "" : " older"}`);

/** Records with an outcome for a firmware id, newest first. */
function validationsFor(fw, id) {
  return (fw.validated || []).filter((v) => v.id === id && isValidated(v))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

/**
 * Comparable version: "ghoulbox-v2.3.2", "v2.3.2" and "2.3.2" are the same release,
 * "1.6" equals "1.6.0", "V15" → "15"; suffixes like "-rc1" stay significant.
 */
export function verKey(v) {
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
export function validationState(fw, f) {
  const vals = validationsFor(fw, f.id);
  if (!vals.length) return null;
  const rels = fw.releases?.sources?.[f.id]?.releases || [];
  let best = null, idx = -1;
  for (const v of vals) {
    const i = rels.findIndex((r) => verKey(r.version) === verKey(v.version));
    if (i >= 0 && (idx < 0 || i < idx)) { best = v; idx = i; }
  }
  // No live release info: fall back on the nightly watcher's verdict in validated.json.
  if (!rels.length) return { v: vals[0], current: !vals[0].supersededBy, newer: vals[0].supersededBy && { version: vals[0].supersededBy } };
  // releases are newest first; anything listed before the validated one is newer
  const newer = (idx >= 0 ? rels.slice(0, idx) : rels).find((r) => !r.prerelease);
  return { v: best || vals[0], current: !newer, newer };
}

export function valTitle(st) {
  return validationTip(st.v) + (st.current ? "" : `\nNewer release ${shortVer(st.newer.version)} hasn't been tested yet.`);
}

export function stepsText(v) {
  const m = (k, label) => `${label} ${v.steps?.[k] ? "✓" : "✗"}`;
  return [m("install", "installed"), m("run", "ran"), m("revert", "reverted")].join(" · ");
}

export function validationTip(v) {
  return `${OUTCOME_LABEL[outcome(v)]}: ${v.version} on ${v.date}. ${stepsText(v)}${v.checks ? `\nChecks: ${v.checks}` : ""}`
    + (v.notes ? `\n${v.notes}` : "");
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
export const shortVer = (v) => String(v).replace(/^[A-Za-z][A-Za-z0-9]*-(?=v?\d)/, "");
export const fmtNum = (n) => (n == null ? "–" : n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "k" : String(n));
export function relTime(d) {
  const days = Math.floor((Date.now() - Date.parse(d)) / 864e5);
  return isNaN(days) ? d : days <= 0 ? "today" : days === 1 ? "1 d ago" : days < 45 ? `${days} d ago` : d.slice(0, 10);
}

/**
 * One firmware card. `app` holds the local library actions:
 * { download(f, rel, asset, btn), fileRow(id, file), importFile(f, version, file), reveal(f), toast(msg, err) }.
 * Without it (the homepage) downloads are plain links to the release files and the library block is left out.
 */
export function fwCard(f, fw, rank, app = null) {
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
  const valBadge = val && octoFor(val.v, valTitle(val), val.current);
  const flags = [
    isCurrent && h("span", { class: "flag on", text: "ON DEVICE" }),
    updateAvail && h("span", { class: "flag up", text: "UPDATE" }),
    fresh && !updateAvail && h("span", { class: "flag new", text: "NEW" }),
  ];

  const dlLabel = (a) => (/\.fwsc$/i.test(a.name) ? "Download" : "Get ." + a.name.split(".").pop());
  const sizeTitle = (a) => `${a.name}${a.size ? " · " + fmtBytes(a.size) : ""}`;
  let dlBtn = null;
  if (primary && app) {
    const got = haveLocal(latest.version, primary.name);
    dlBtn = h("button", { class: got ? "got" : "primary", title: sizeTitle(primary) },
      icon(got ? "check" : "dl"), got ? "In library" : dlLabel(primary));
    dlBtn.onclick = () => (got ? dlBtn.closest(".fw-card").querySelector("details").setAttribute("open", "") : app.download(f, latest, primary, dlBtn));
  } else if (primary?.url) {
    dlBtn = h("a", { class: "btn primary", href: primary.url, rel: "noopener", title: sizeTitle(primary) }, icon("dl"), dlLabel(primary));
  }
  const linkBtn = (url, ic, label, title) => url && h("a", { class: "btn" + (label ? "" : " icon-only"), href: url, target: "_blank", rel: "noopener", title: title || label }, icon(ic), label);

  const assetAction = (rel, a) => {
    if (!app) return a.url && h("a", { class: "btn ghost", href: a.url, rel: "noopener", text: "Download" });
    const b = h("button", { class: "ghost", text: haveLocal(rel.version, a.name) ? "Re-download" : "Download" });
    b.onclick = () => app.download(f, rel, a, b);
    return b;
  };
  const relBlock = (rel) => h("div", { class: "rel" },
    h("div", { class: "row" }, h("b", { text: rel.version }), h("span", { class: "muted", text: rel.date }),
      rel.prerelease && h("span", { class: "badge warn", text: "pre-release" }),
      (rel.sha256sums || Object.keys(rel.sha256files || {}).length > 0) && h("span", { class: "badge ok", text: "checksums" }),
      rel.url && h("a", { href: rel.url, target: "_blank", rel: "noopener", text: "notes ↗" })),
    rel.assets.length ? rel.assets.map((a) => h("div", { class: "asset" }, h("span", { class: "name", title: a.url, text: a.name }),
      a.size ? h("span", { class: "muted", text: fmtBytes(a.size) }) : null,
      haveLocal(rel.version, a.name) && h("span", { class: "badge ok", text: "in library" }), assetAction(rel, a)))
      : h("div", { class: "muted", text: "No installable files in this release." }));

  let libBlock = null;
  if (app) {
    const impVer = h("input", { placeholder: "version", style: "width:100px" });
    const impFile = h("input", { type: "file", hidden: true, accept: ".fwsc,.bin,.zip,.html" });
    impFile.onchange = () => impFile.files[0] && app.importFile(f, impVer.value || "manual", impFile.files[0]);
    libBlock = h("div", { class: "local" },
      h("div", { class: "row" }, h("b", { text: `Library (${local.length})` }), h("span", { class: "grow" }),
        impVer, h("button", { class: "ghost", text: "Import file…", onclick: () => impFile.click() }), impFile,
        h("button", { class: "ghost", text: "Folder", onclick: () => app.reveal(f) })),
      local.length ? local.map((l) => app.fileRow(f.id, l)) : h("div", { class: "muted", text: "Nothing downloaded yet." }));
  }

  const iconLink = (url, ic, title) => url && h("a", { class: "mini", href: url, target: "_blank", rel: "noopener", title }, icon(ic));
  // A library line only when it adds something: files kept, but not the latest release.
  const olderOnly = local.length > 0 && !(primary && haveLocal(latest.version, primary.name));

  return h("div", { class: "fw-card" + (isCurrent ? " current" : ""), "data-id": f.id, style: `--h:${f.art?.hue ?? 20}` },
    h("div", { class: "fw-head" },
      art,
      h("div", { class: "fw-headtext" },
        h("div", { class: "fw-title" }, rank && h("span", { class: "rank", text: `#${rank}` }), h("b", { text: f.name }),
          h("span", { class: "grow" }), valBadge),
        h("div", { class: "by" }, h("span", { class: "by-name", text: f.author }),
          f.curated === false && h("span", { class: "fw-uncur", title: "Built from GitHub metadata: no curated catalog entry (screen, tagline) yet", text: "not curated yet" })),
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
      valPin(val, app?.toast),
      h("div", { class: "fw-actions" },
        dlBtn,
        linkBtn(L.install, "ext", f.kind === "stock" ? "Updater" : "Install", "Open the installer"),
        linkBtn(L.try, "play", "Try", "Play it in the browser, no FM-1 needed")),
      // every card icon in one row: links, then traits, then install requirements and methods
      h("div", { class: "fw-icons" },
        (L.docs || L.repo) && h("span", { class: "fw-tools" }, iconLink(L.docs, "doc", "Manual / docs"), iconLink(L.repo, "code", "Source code")),
        fwTraits(f, latest, primary),
        fwInstallTraits(f)),
      olderOnly && h("div", { class: "fw-lib" }, icon("check"), `In library: ${shortVer(local[0].version)} (older)`),
      h("details", { class: "fw-more" }, h("summary", { text: "More" }),
        h("p", { text: f.summary }),
        h("p", { class: "muted" }, h("b", { text: "Install: " }), f.install),
        st && h("p", { class: "muted", text: `${st.license || "no license"} · ${st.releases} releases · last push ${st.pushed}` }),
        rels.map(relBlock),
        libBlock)));
}

/** Copy a validated file's full sha256; `toast` reports the result (the homepage flashes the button instead). */
export function copySha(v, btn, toast) {
  const say = (msg, err) => {
    if (toast) return toast(msg, err);
    const was = btn.textContent;
    btn.textContent = err ? "Select it" : "Copied";
    setTimeout(() => { btn.textContent = was; }, 1500);
  };
  navigator.clipboard.writeText(v.sha256)
    .then(() => say(`SHA256 of ${v.file || v.version} copied`), () => say("Couldn't copy: select it from the tooltip", true));
}

/** The exact file a validation tested (sha256 pinned in validated.json), to compare a download against. */
function valPin(val, toast) {
  const v = val?.v;
  if (!v?.sha256) return null;
  const tip = `${OUTCOME_LABEL[outcome(v)]}: ${v.file || v.version}\nsha256 ${v.sha256}\n`
    + "Check a file you got elsewhere: certutil -hashfile FILE SHA256 (Windows) or shasum -a 256 FILE (macOS, Linux)";
  const copy = h("button", { class: "ghost mini-btn", text: "Copy", title: "Copy the full SHA256" });
  copy.onclick = () => copySha(v, copy, toast);
  return h("div", { class: "fw-pin", title: tip },
    octo("Tested file", outcome(v) + (val.current ? "" : " older")),
    h("span", { class: "muted", text: `tested ${shortVer(v.version)} sha256` }),
    h("code", { text: `${v.sha256.slice(0, 8)}…${v.sha256.slice(-6)}` }),
    copy);
}

const CLOSED_TIP = "Free firmware without public source. Not ranked: there are no GitHub stars or download counts to compare. Paid firmware is never listed.";

/**
 * The card sections of the Firmware page, in order: legend, Official, community top 10,
 * free closed source. With `merged` (the homepage) the community is one group instead: the
 * top 12 open source, then up to 3 closed source. Returns { nodes, carded } so the caller can
 * list files without a card.
 */
export function fwSections(fw, app = null, { merged = false } = {}) {
  // Community cards = the live top 10 (server-ranked by ln(1+stars) + ln(1+downloads)).
  const byId = new Map(fw.catalog.map((f) => [f.id, f]));
  const official = fw.catalog.filter((f) => f.kind !== "community");
  const top = (fw.ranked || []).slice(0, merged ? 12 : 10).filter((p) => byId.has(p.id));
  // Free closed-source firmware has no stars or download counts to rank by: curated, shown unranked.
  const closed = fw.catalog.filter((f) => f.kind === "community" && f.traits?.source === "closed").slice(0, merged ? 3 : undefined);
  const carded = new Set([...official, ...closed].map((f) => f.id).concat(top.map((p) => p.id)));
  const topCards = top.map((p) => fwCard(byId.get(p.id), fw, p.rank, app));
  const closedCards = closed.map((f) => fwCard(f, fw, null, app));
  const nodes = [
    h("div", { class: "fw-legend-row" }, octoLegend(), h("span", { class: "legend-sep" }), traitLegend()),
    h("h2", { class: "fw-section" }, "Official"),
    h("div", { class: "fw-cards" }, official.map((f) => fwCard(f, fw, null, app))),
  ];
  if (merged) {
    nodes.push(
      h("h2", { class: "fw-section" }, `Community · top ${top.length} free firmware `,
        h("span", { class: "info", title: `${fw.ranking || ""}\nClosed source, at the end: ${CLOSED_TIP}`, text: "ⓘ" })),
      h("div", { class: "fw-cards" }, topCards, closedCards));
    return { nodes, carded };
  }
  nodes.push(
    h("h2", { class: "fw-section" }, "Community · top 10 free & open source ",
      h("span", { class: "info", title: fw.ranking || "", text: "ⓘ" })),
    h("div", { class: "fw-cards" }, topCards));
  if (closed.length) {
    nodes.push(h("h2", { class: "fw-section" }, "Community · free, closed source ", h("span", { class: "info", title: CLOSED_TIP, text: "ⓘ" })),
      h("div", { class: "fw-cards" }, closedCards));
  }
  return { nodes, carded };
}
