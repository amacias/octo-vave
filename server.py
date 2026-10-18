#!/usr/bin/env python3
"""FM-1 Dashboard local server.

Serves the web UI from ./web and a small JSON API for:
  - patches/configurations   (data/patches/*.json)
  - dashboard settings       (data/settings.json)
  - firmware library         (firmware/library/<id>/<version>/<file>)

Standard library only. Binds to 127.0.0.1 so nothing is exposed to the network.

    python server.py            # then open http://127.0.0.1:8765
"""
import hashlib
import json
import math
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.request
import webbrowser
from concurrent.futures import ThreadPoolExecutor
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlencode, urljoin, urlparse

ROOT = Path(__file__).resolve().parent
WEB = ROOT / "web"
DATA = ROOT / "data"
PATCHES = DATA / "patches"
SETTINGS = DATA / "settings.json"
FW_STATE = DATA / "firmware-state.json"
RELEASE_CACHE = DATA / "releases-cache.json"
DISCOVERY_CACHE = DATA / "discovery-cache.json"  # live community ranking + per-repo GitHub snapshots
CATALOG = ROOT / "firmware" / "catalog.json"
DIRECTORY = ROOT / "firmware" / "directory.json"
VALIDATED = ROOT / "firmware" / "validated.json"  # written by validation sessions, read-only here
FW_LIB = ROOT / "firmware" / "library"

HOST = "127.0.0.1"
PORT = int(os.environ.get("FM1_PORT", "8765"))
USER_AGENT = "fm1-dashboard/1.0"
_token = None


def github_token():
    """Optional token for api.github.com; it only raises the rate limit (60/h anonymous)
    for release checks. GITHUB_TOKEN if set; with FM1_USE_GH=1, the GitHub CLI's login."""
    global _token
    if _token is None:
        _token = os.environ.get("GITHUB_TOKEN", "")
        if not _token and os.environ.get("FM1_USE_GH") == "1":
            try:
                import subprocess
                r = subprocess.run(["gh", "auth", "token"], capture_output=True, text=True, timeout=5)
                _token = r.stdout.strip() if r.returncode == 0 else ""
            except (OSError, subprocess.SubprocessError):
                _token = ""
    return _token

# Downloads are only ever made from URLs found in the catalog, GitHub release
# listings or a catalogued install page, and only from these hosts (GitHub redirects to its asset CDN).
ALLOWED_DL_HOSTS = {
    "github.com",
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",
    "yms-file-store.oss-cn-hongkong.aliyuncs.com",
    "baudgirl.com",
    "beashoko.github.io",
    "open.m-vave.com",
}
NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 _.()\-]{0,63}$")
ID_RE = re.compile(r"^[a-z0-9][a-z0-9\-]{0,31}$")
MAX_BODY = 1 * 1024 * 1024
MAX_IMPORT = 16 * 1024 * 1024


# ---------------------------------------------------------------- helpers

def read_json(path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def write_json(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, indent=2), encoding="utf-8")
    tmp.replace(path)


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 16), b""):
            h.update(chunk)
    return h.hexdigest()


def http_get(url, accept=None, limit=64 * 1024 * 1024):
    host = urlparse(url).hostname or ""
    headers = {"User-Agent": USER_AGENT}
    if accept:
        headers["Accept"] = accept
    if host == "api.github.com" and github_token():
        headers["Authorization"] = f"Bearer {github_token()}"
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=60) as r:
        final_host = urlparse(r.geturl()).hostname or ""
        if host != "api.github.com" and final_host not in ALLOWED_DL_HOSTS:
            raise ValueError(f"redirected to unexpected host {final_host}")
        data = r.read(limit + 1)
        if len(data) > limit:
            raise ValueError("download too large")
        return data


def catalog():
    return read_json(CATALOG, {"firmware": []})


def catalog_entry(fid):
    for fw in catalog()["firmware"]:
        if fw["id"] == fid:
            return fw
    return None


def safe_version(v):
    v = re.sub(r"[^A-Za-z0-9._\-]", "_", str(v))[:48]
    return v or "unknown"


def safe_filename(name):
    name = os.path.basename(str(name))
    name = re.sub(r"[^A-Za-z0-9._\-()+ ]", "_", name)[:120]
    if not name or name in (".", ".."):
        raise ValueError("bad filename")
    return name


# ---------------------------------------------------------------- firmware

# Discovery: the community ranking is rebuilt on every "Check for updates" from the
# awesome-fm-1 list ("Custom firmware" sections) plus a GitHub repository search,
# then ranked by ln(1+stars) + ln(1+total .fwsc downloads). Only projects with a
# release that carries a .fwsc image count (closed-source and not-a-synth entries of
# the list are left out). GitHub data is cached per repository with ETags so
# unchanged data costs nothing (authenticated) or is skipped for a day (anonymous,
# 60 requests/hour); when the budget runs out the last known numbers are kept and
# firmware/directory.json serves as the offline fallback.

DISCOVERY = {
    "awesome": "https://raw.githubusercontent.com/cicloid/awesome-fm-1/HEAD/README.md",
    "awesomePage": "https://github.com/cicloid/awesome-fm-1",
    "searches": ["fm-1 firmware archived:false", "fm1 firmware archived:false", "topic:fm-1 archived:false"],
    "exclude": {},
}
TOP_CARDS, TOP_LIST = 10, 30
META_HOSTS = {"api.github.com", "raw.githubusercontent.com"}
PRERELEASE_RE = re.compile(r"(?:^|[-_.+\s])(rc|beta|alpha|test|preview|pre|dev|nightly|wip)\d*(?![a-z])", re.I)
GH_REPO_RE = re.compile(r"^https?://github\.com/([A-Za-z0-9_.\-]+)/([A-Za-z0-9_.\-]+?)(?:\.git)?/?(?:[#?].*)?$")
_refresh_lock = threading.Lock()


class RateLimited(Exception):
    pass


def discovery_config():
    cfg = dict(DISCOVERY)
    cfg.update(catalog().get("discovery") or {})
    return cfg


def repo_key(repo):
    return str(repo or "").strip().lower()


def gh_repo(url):
    m = GH_REPO_RE.match(str(url or "").strip())
    if not m or m.group(1).lower() in ("orgs", "topics", "sponsors", "features"):
        return None
    return f"{m.group(1)}/{m.group(2)}"


class GitHub:
    """api.github.com client with conditional requests and a shared rate-limit budget."""

    def __init__(self, rate):
        self.rate = rate  # {"core"|"search": {"limit", "remaining", "reset"}}, persisted
        self.auth = bool(github_token())
        self.reserve = {"core": 100 if self.auth else 2, "search": 1}
        self.limited = set()
        self.calls = self.not_modified = 0
        self.lock = threading.Lock()

    def _take(self, res):
        with self.lock:
            if res in self.limited:
                raise RateLimited(res)
            r = self.rate.get(res) or {}
            if r.get("remaining") is not None and r.get("reset", 0) > time.time():
                if r["remaining"] <= self.reserve.get(res, 1):
                    self.limited.add(res)
                    raise RateLimited(res)
                r["remaining"] -= 1
            self.calls += 1

    def _note(self, headers):
        res = headers.get("X-RateLimit-Resource")
        if res and headers.get("X-RateLimit-Remaining") is not None:
            with self.lock:
                self.rate[res] = {"limit": int(headers.get("X-RateLimit-Limit") or 0),
                                  "remaining": int(headers["X-RateLimit-Remaining"]),
                                  "reset": int(headers.get("X-RateLimit-Reset") or 0)}

    def get(self, url, etag=None, resource="core", raw=False):
        """(status, data, etag): status 304 means unchanged (data None)."""
        host = urlparse(url).hostname or ""
        if host not in META_HOSTS:
            raise ValueError(f"unexpected host {host}")
        api = host == "api.github.com"
        if api:
            self._take(resource)
        headers = {"User-Agent": USER_AGENT}
        if api:
            headers["Accept"] = "application/vnd.github+json"
            headers["X-GitHub-Api-Version"] = "2022-11-28"
            if github_token():
                headers["Authorization"] = f"Bearer {github_token()}"
        if etag:
            headers["If-None-Match"] = etag
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=30) as r:
                if (urlparse(r.geturl()).hostname or "") not in META_HOSTS:
                    raise ValueError("redirected to unexpected host")
                self._note(r.headers)
                body = r.read(8 * 1024 * 1024)
                return 200, (body if raw else json.loads(body)), r.headers.get("ETag")
        except urllib.error.HTTPError as e:
            self._note(e.headers)
            if e.code == 304:
                with self.lock:
                    self.not_modified += 1
                return 304, None, etag
            if e.code in (403, 429) and (e.headers.get("X-RateLimit-Remaining") == "0" or e.headers.get("Retry-After")):
                with self.lock:
                    self.limited.add(resource)
                raise RateLimited(resource) from None
            raise


def _first_sentence(text, limit=160):
    text = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", text).replace("`", "").strip()
    text = re.split(r"(?<=[a-z0-9)\]])\.\s", text, maxsplit=1)[0].rstrip(".")
    if len(text) > limit:
        text = text[:limit].rsplit(" ", 1)[0].rstrip(",;:") + "…"
    return text


def parse_awesome(md):
    """awesome-fm-1 README → open-source firmware entries, plus every other GitHub repo
    the list mentions (closed source, not a synth, tools, emulators...) for filtering."""
    h2 = h3 = ""
    open_, other = [], {}
    item_re = re.compile(r"^\s*[-*]\s+\[([^\]]+)\]\(([^)\s]+)\)\s*[-–—:]?\s*(.*)$")
    for line in md.splitlines():
        if line.startswith("## "):
            h2, h3 = line[3:].strip().lower(), ""
            continue
        if line.startswith("### "):
            h3 = line[4:].strip().lower()
            continue
        m = item_re.match(line)
        if not m:
            continue
        name, url, rest = m.groups()
        repo = gh_repo(url)
        links = re.findall(r"\[([^\]]+)\]\((https?://[^)\s]+)\)", rest)
        if h2.startswith("custom firmware") and h3.startswith("open source"):
            entry = {"name": name.strip(), "url": url, "repo": repo, "desc": _first_sentence(rest), "links": {}}
            for label, href in links:
                lab = label.lower()
                key = ("install" if "install" in lab else "try" if re.search(r"emulat|simulat|try|play|browser|demo", lab)
                       else "docs" if re.search(r"manual|guide|docs", lab) else None)
                if key and key not in entry["links"] and href.startswith("https://"):
                    entry["links"][key] = href
            open_.append(entry)
        elif repo:
            group = ("closed" if h3.startswith("closed") else "other" if h3.startswith("not a synth")
                     else "list")
            other.setdefault(repo_key(repo), group)
        for _, href in links:  # companion repos (emulators, editors) never rank on their own
            r2 = gh_repo(href)
            if r2 and repo_key(r2) != repo_key(repo):
                other.setdefault(repo_key(r2), "list")
    for e in open_:
        if e["repo"]:
            other.pop(repo_key(e["repo"]), None)
    return {"open": open_, "other": other}


def _trim_meta(d):
    return {
        "repo": d.get("full_name", ""), "owner": (d.get("owner") or {}).get("login", ""),
        "url": d.get("html_url", ""), "stars": d.get("stargazers_count", 0),
        "license": (d.get("license") or {}).get("spdx_id"), "pushed": (d.get("pushed_at") or "")[:10],
        "description": (d.get("description") or "").strip(), "homepage": (d.get("homepage") or "").strip(),
        "topics": (d.get("topics") or [])[:10], "fork": bool(d.get("fork")), "archived": bool(d.get("archived")),
    }


def is_prerelease(rel):
    return bool(rel.get("prerelease")) or bool(PRERELEASE_RE.search(rel.get("tag_name") or rel.get("version") or ""))


def _trim_releases(rels):
    rels = [r for r in rels if not r.get("draft")]
    fwsc = [a for r in rels for a in r.get("assets", []) if a["name"].lower().endswith(".fwsc")]
    return {
        "count": len(rels),
        "downloads": sum(a.get("download_count", 0) for a in fwsc),  # all releases, all .fwsc images
        "installable": bool(fwsc),
        "releases": [{
            "version": r["tag_name"], "title": r.get("name") or r["tag_name"],
            "date": (r.get("published_at") or r.get("created_at") or "")[:10],
            "prerelease": is_prerelease(r), "url": r.get("html_url"),
            "assets": [{"name": a["name"], "size": a.get("size", 0), "url": a["browser_download_url"],
                        "downloads": a.get("download_count", 0)} for a in r.get("assets", [])],
        } for r in rels[:8]],
    }


def release_entry(rec, patterns):
    """releases-cache entry (stats + latest releases with matching assets) from a repo snapshot."""
    meta, rel = rec.get("meta") or {}, rec.get("rel")
    entry = {"releases": [], "error": None if rel else rec.get("error") or "not checked yet"}
    if rec.get("stale"):
        entry["stale"] = rec["stale"]
    if not rel:
        return entry
    pats = [re.compile(p, re.I) for p in patterns or [r"\.fwsc$"]]
    entry["stats"] = {"stars": meta.get("stars", 0), "license": meta.get("license"), "pushed": meta.get("pushed", ""),
                      "releases": rel["count"], "downloads": rel["downloads"]}
    for r in rel["releases"][:6]:
        allp = r["assets"]
        entry["releases"].append({
            **{k: r[k] for k in ("version", "title", "date", "prerelease", "url")},
            "assets": [a for a in allp if any(p.search(a["name"]) for p in pats)],
            "sha256sums": next((a["url"] for a in allp if re.fullmatch(r"SHA256SUMS(-.*)?(\.txt)?", a["name"], re.I)), None),
            # per-file checksums such as foo.fwsc.sha256
            "sha256files": {a["name"][:-7]: a["url"] for a in allp if a["name"].lower().endswith(".sha256")},
        })
    return entry


def _slug(s):
    return re.sub(r"[^a-z0-9]+", "-", str(s).lower()).strip("-")[:32].strip("-") or "fw"


def fallback_directory():
    """firmware/directory.json: the last committed ranking, used until a live check succeeds."""
    d = read_json(DIRECTORY, {"projects": []})
    out = {}
    for p in d.get("projects", []):
        k = repo_key(p.get("repo") or gh_repo(p.get("url")))
        if k:
            out[k] = p
    return d, out


def build_ranking(disc=None):
    """Live ranking (cards #1-10, list #11-30) from the discovery cache; directory.json
    fills in projects not fetched yet. Returns (ranked, entries) where entries are
    card definitions for ranked projects without a curated catalog entry."""
    disc = disc if disc is not None else read_json(DISCOVERY_CACHE, {})
    cat = catalog()
    cfg = discovery_config()
    repos = disc.get("repos", {})
    _, fallback = fallback_directory()
    exclude = {repo_key(k) for k in cfg.get("exclude", {})}
    curated, official = {}, set()
    for f in cat["firmware"]:
        src = f.get("source", {})
        if src.get("type") == "github":
            (curated.__setitem__(repo_key(src["repo"]), f) if f.get("kind") == "community"
             else official.add(repo_key(src["repo"])))
    aw = disc.get("awesome", {}).get("lists") or {"open": [], "other": {}}
    other = aw.get("other", {})

    cands = {}
    for e in aw.get("open", []):
        if e.get("repo"):
            cands.setdefault(repo_key(e["repo"]), {"repo": e["repo"], "name": e["name"], "desc": e["desc"],
                                                   "links": e.get("links", {}), "origin": "awesome-fm-1"})
    for q in disc.get("search", {}).values():
        for m in q.get("items", []):
            k = repo_key(m["repo"])
            if k in cands or k in other or m["fork"] or m["archived"] or not m.get("license"):
                continue  # search-only hits must carry a license to count as open source
            cands[k] = {"repo": m["repo"], "name": m["repo"].split("/")[1], "desc": m["description"],
                        "links": {}, "origin": "GitHub search"}
    for k, p in fallback.items():
        cands.setdefault(k, {"repo": p.get("repo") or gh_repo(p["url"]), "name": p["name"], "desc": p.get("desc", ""),
                             "links": {}, "origin": "directory.json"})
    for k, f in curated.items():
        cands.setdefault(k, {"repo": f["source"]["repo"], "name": f["name"], "desc": f.get("tagline", ""),
                             "links": {}, "origin": "catalog"})

    ids = dict(disc.get("ids", {}))
    taken = {f["id"] for f in cat["firmware"]} | {v for k, v in ids.items() if k not in curated}
    ranked = []
    for k in sorted(cands):
        c = cands[k]
        if k in exclude or k in official or other.get(k) in ("closed", "other"):
            continue
        rec = repos.get(k, {})
        meta, rel, fb = rec.get("meta"), rec.get("rel"), fallback.get(k)
        if rel:
            if not rel["installable"]:
                continue
            stars = meta["stars"] if meta else (fb or {}).get("stars", 0)
            downloads, live = rel["downloads"], True
        elif fb:
            stars, downloads, live = fb.get("stars", 0), fb.get("downloads", 0), False
        elif k in curated:
            stars, downloads, live = (meta or {}).get("stars", 0), 0, False
        else:
            continue  # never checked and not in the snapshot: installability unknown
        if k in curated:
            fid = curated[k]["id"]
        elif k in ids:
            fid = ids[k]
        elif fb and fb.get("id") and fb["id"] not in taken and ID_RE.match(fb["id"]):
            fid = ids[k] = fb["id"]
            taken.add(fid)
        else:
            fid = _slug(c["name"])
            if fid in taken or not ID_RE.match(fid):
                fid = _slug(c["repo"].replace("/", "-"))
            n = 2
            while fid in taken:
                fid = f"{_slug(c['repo'].replace('/', '-'))[:29]}-{n}"
                n += 1
            taken.add(fid)
            ids[k] = fid
        latest = next((r for r in (rel or {}).get("releases", []) if not r["prerelease"]), None) \
            or ((rel or {}).get("releases") or [None])[0]
        ranked.append({
            "id": fid, "repo": c["repo"], "name": curated[k]["name"] if k in curated else c["name"],
            "url": (meta or {}).get("url") or f"https://github.com/{c['repo']}",
            "desc": c["desc"] or (meta or {}).get("description", ""),
            "license": (meta or {}).get("license") or (fb or {}).get("license"),
            "stars": stars, "downloads": downloads,
            "score": round(math.log1p(stars) + math.log1p(downloads), 3),
            "curated": k in curated, "origin": c["origin"], "live": live,
            "latest": latest and {"version": latest["version"], "date": latest["date"]},
        })
    ranked.sort(key=lambda p: (-p["score"], p["name"].lower()))
    ranked = ranked[:TOP_LIST]
    for i, p in enumerate(ranked, 1):
        p["rank"] = i

    entries = []
    for p in ranked:
        if p["curated"]:
            continue
        k = repo_key(p["repo"])
        meta = repos.get(k, {}).get("meta") or {}
        links = {"repo": p["url"], **cands[k]["links"]}
        home = meta.get("homepage", "")
        if "install" not in links and home.startswith("https://") and not home.startswith(p["url"]):
            links["install"] = home
        skip = {"fm-1", "fm1", "m-vave", "mvave", "firmware", "synthesizer", "synth", "fm1-firmware", "m-vave-fm-1"}
        entries.append({
            "id": p["id"], "name": p["name"], "author": meta.get("owner") or p["repo"].split("/")[0],
            "kind": "community", "curated": False,
            "tagline": meta.get("description") or p["desc"],
            "tags": [t for t in meta.get("topics", []) if t not in skip][:3],
            "art": {"hue": int(hashlib.sha1(k.encode()).hexdigest()[:4], 16) % 360},
            "links": links,
            "summary": p["desc"] or meta.get("description", ""),
            "install": "Use the project's own installer (see its page or README). "
                       "Not curated yet: this card is built from GitHub metadata.",
            "source": {"type": "github", "repo": p["repo"], "assetPatterns": [r"\.fwsc$"]},
        })
    return ranked, entries, ids


def _fetch_repo(gh, key, rec, need_meta):
    """Refresh one repo snapshot in place (conditional requests)."""
    repo = (rec.get("meta") or {}).get("repo") or rec.get("repo") or key
    got = False
    try:
        # releases first: they decide installability and downloads, the scarcer data
        st, data, etag = gh.get(f"https://api.github.com/repos/{repo}/releases?per_page=100",
                                rec.get("relEtag") if rec.get("rel") else None)
        if st == 200:
            rec["rel"], rec["relEtag"] = _trim_releases(data), etag
        got = True
        if need_meta == "always" or (need_meta and rec["rel"]["installable"]):
            st, data, etag = gh.get(f"https://api.github.com/repos/{repo}", rec.get("metaEtag") if rec.get("meta") else None)
            if st == 200:
                rec["meta"], rec["metaEtag"] = _trim_meta(data), etag
            rec["metaChecked"] = time.time()
        rec["checked"] = time.time()
        rec.pop("error", None)
        rec.pop("stale", None)
    except RateLimited:
        if got:
            rec["checked"] = time.time()
            rec.pop("error", None)
            rec.pop("stale", None)
        else:
            rec["stale"] = "rate limited, showing the last known data"
            rec["error"] = "rate limited (set GITHUB_TOKEN or FM1_USE_GH=1)"
    except urllib.error.HTTPError as e:
        rec["error"] = f"HTTP {e.code} ({e.reason})"
        if e.code == 404:
            rec["rel"] = {"count": 0, "downloads": 0, "installable": False, "releases": []}
            rec["checked"] = time.time()
    except Exception as e:  # network trouble: keep the old snapshot
        rec["error"] = str(e)[:200]


def discover(disc, gh, notes):
    """Refresh list + search + repo snapshots in disc (in place)."""
    cfg = discovery_config()
    now = time.time()
    # 1. the community list (raw.githubusercontent.com: no API quota)
    aw = disc.setdefault("awesome", {})
    try:
        st, body, etag = gh.get(cfg["awesome"], aw.get("etag") if aw.get("lists") else None, raw=True)
        if st == 200:
            aw.update(etag=etag, lists=parse_awesome(body.decode("utf-8", "replace")))
        aw["checked"] = now
    except Exception as e:
        notes.append(f"awesome-fm-1 list: {e}")
    # 2. GitHub repository search (its own quota: 10/min anonymous, 30/min with a token)
    search = disc.setdefault("search", {})
    for q in cfg["searches"]:
        prev = search.get(q, {})
        if now - prev.get("checked", 0) < 600:
            continue
        try:
            url = "https://api.github.com/search/repositories?" + urlencode(
                {"q": q, "sort": "stars", "order": "desc", "per_page": 100})
            st, data, etag = gh.get(url, prev.get("etag") if prev.get("items") is not None else None, resource="search")
            if st == 200:
                prev = {"etag": etag, "total": data.get("total_count", 0),
                        "items": [_trim_meta(i) for i in data.get("items", [])]}
            prev["checked"] = now
            search[q] = prev
        except RateLimited:
            notes.append("GitHub search rate limited; using the last results")
            break
        except Exception as e:
            notes.append(f"GitHub search: {e}")
    repos = disc.setdefault("repos", {})
    fresh_meta = set()
    for q in search.values():
        for m in q.get("items", []):
            k = repo_key(m["repo"])
            rec = repos.setdefault(k, {})
            if q.get("checked", 0) >= rec.get("metaChecked", 0):
                rec["meta"], rec["metaChecked"] = m, q.get("checked", 0)
            if now - q.get("checked", 0) < 3600:
                fresh_meta.add(k)

    # 3. which repos to (re)check, most important first
    cat = catalog()
    lists = aw.get("lists") or {"open": [], "other": {}}
    want = {}  # key -> priority (0 = always)
    for f in cat["firmware"]:
        if f.get("source", {}).get("type") == "github":
            want[repo_key(f["source"]["repo"])] = 0
    for p in disc.get("ranked", [])[:TOP_CARDS]:
        want.setdefault(repo_key(p["repo"]), 0)
    for p in disc.get("ranked", [])[TOP_CARDS:]:
        want.setdefault(repo_key(p["repo"]), 1)
    for e in lists["open"]:
        if e.get("repo"):
            want.setdefault(repo_key(e["repo"]), 2)
    for q in search.values():
        for m in q.get("items", []):
            k = repo_key(m["repo"])
            if k not in lists["other"] and not m["fork"] and not m["archived"] and m.get("license"):
                want.setdefault(k, 3)
    exclude = {repo_key(k) for k in cfg.get("exclude", {})}
    ttl = 900 if gh.auth else 24 * 3600
    jobs = []
    for k, prio in want.items():
        if k in exclude or lists["other"].get(k) in ("closed", "other"):
            continue
        rec = repos.setdefault(k, {"repo": k})
        if prio > 0 and rec.get("rel") is not None and now - rec.get("checked", 0) < ttl:
            continue
        jobs.append((prio, 0 if rec.get("rel") is None else 1, -(rec.get("meta") or {}).get("stars", 0),
                     rec.get("checked", 0), k))
    jobs.sort()
    with ThreadPoolExecutor(max_workers=6) as pool:
        for _, _, _, _, k in jobs:
            rec = repos[k]
            need_meta = k not in fresh_meta and (not rec.get("meta") or now - rec.get("metaChecked", 0) > (ttl if gh.auth else 6 * 3600))
            pool.submit(_fetch_repo, gh, k, rec, "always" if need_meta and want[k] == 0 else need_meta)
    skipped = sum(1 for *_, k in jobs if repos[k].get("stale"))
    if skipped:
        reset = (gh.rate.get("core") or {}).get("reset")
        when = time.strftime(" until %H:%M", time.localtime(reset)) if reset else ""
        notes.append(f"GitHub rate limit reached{when}: {skipped} of {len(jobs)} projects kept their last known numbers")
    return len(jobs), skipped


def refresh_releases():
    """Check for updates: rediscover and rank community firmware, refresh release info
    for every card, and cache the result (data/discovery-cache.json, releases-cache.json)."""
    with _refresh_lock:
        disc = read_json(DISCOVERY_CACHE, {})
        gh = GitHub(disc.setdefault("rate", {}))
        notes = []
        scanned, skipped = discover(disc, gh, notes)
        ranked, entries, ids = build_ranking(disc)
        disc.update(checked=time.strftime("%Y-%m-%dT%H:%M:%S"), ranked=ranked, ids=ids, notes=notes,
                    auth="token" if os.environ.get("GITHUB_TOKEN") else "gh" if gh.auth else "anonymous",
                    stats={"scanned": scanned, "skipped": skipped, "requests": gh.calls, "notModified": gh.not_modified,
                           "candidates": len(disc.get("repos", {}))})
        write_json(DISCOVERY_CACHE, disc)

        cache = {"checked": disc["checked"], "sources": {}}
        for fw in catalog()["firmware"] + entries:
            src = fw.get("source", {})
            if src.get("type") == "github":
                cache["sources"][fw["id"]] = release_entry(disc["repos"].get(repo_key(src["repo"]), {}),
                                                           src.get("assetPatterns"))
                if src.get("site"):
                    merge_site_releases(cache["sources"][fw["id"]], src["site"])
            elif src.get("type") == "official":
                cache["sources"][fw["id"]] = official_release(src)
            elif src.get("type") == "web":
                cache["sources"][fw["id"]] = web_release(src)
        write_json(RELEASE_CACHE, cache)
        return {"checked": disc["checked"], "notes": notes, "stats": disc["stats"],
                "top": [p["id"] for p in ranked[:TOP_CARDS]]}


def official_release(src):
    entry = {"releases": [], "error": None}
    version, date = "latest", ""
    try:
        notes = http_get(src["releaseNotes"]).decode("latin-1")
        m = re.search(r"FM-1_(\d{4})_(\d{2})\s*(\d{2})\s+(V\d+)", notes)
        if m:
            version, date = m.group(4), f"{m.group(1)}-{m.group(2)}-{m.group(3)}"
    except Exception as e:  # notes are informational only
        entry["error"] = f"release notes: {e}"
    entry["releases"].append({
        "version": version, "title": f"Official {version}", "date": date,
        "prerelease": False, "url": src.get("page"),
        "assets": src.get("assets", []), "sha256sums": None,
    })
    return entry


def web_release(src):
    """Releases of a firmware published on its own site (not GitHub), read from its install page:
    "manifest" names a JSON <script> listing every version with file and sha256 (FM-1+VA);
    "versionPattern" only finds the current version (the firmware is built into the page)."""
    entry = {"releases": [], "error": None}
    try:
        page = http_get(src["page"], limit=8 * 1024 * 1024).decode("utf-8", "replace")
    except Exception as e:
        entry["error"] = f"install page: {e}"
        return entry
    if src.get("manifest"):
        m = re.search(r'<script[^>]*id="%s"[^>]*>(.*?)</script>' % re.escape(src["manifest"]), page, re.S)
        try:
            rows = json.loads(m.group(1)) if m else []
        except json.JSONDecodeError:
            rows = []
        if not rows:
            entry["error"] = "release list not found on the install page"
        rows = [r for r in rows if not src.get("device") or r.get("device") == src["device"]]
        rows.sort(key=lambda r: (r.get("date", ""), r.get("n", 0)), reverse=True)
        for r in rows[:8]:
            url = urljoin(src["page"], r.get("file", ""))
            entry["releases"].append({
                "version": str(r.get("n") or r.get("version")), "title": r.get("version", ""), "date": r.get("date", ""),
                "prerelease": bool(r.get("beta")), "url": src["page"],
                "assets": [{"name": os.path.basename(urlparse(url).path), "url": url,
                            **({"sha256": r["sha256"].lower()} if re.fullmatch(r"[0-9a-fA-F]{64}", r.get("sha256", "")) else {})}],
                "sha256sums": None,
            })
    elif src.get("versionPattern"):
        m = re.search(src["versionPattern"], page)
        if m:
            entry["releases"].append({"version": m.group(1), "title": m.group(0), "date": "",
                                      "prerelease": bool(PRERELEASE_RE.search(m.group(1))), "url": src["page"],
                                      "assets": [], "sha256sums": None})
        else:
            entry["error"] = "version not found on the install page"
    return entry


def site_releases(site):
    """Releases published on a project's own site ahead of its GitHub mirror (FM-1 Open:
    open.m-vave.com links releases/<V>/<hash>/ and lists the files in SHA256SUMS-<V>)."""
    page = http_get(site["page"], limit=8 * 1024 * 1024).decode("utf-8", "replace")
    out, seen = [], set()
    pats = [re.compile(p, re.I) for p in site.get("assetPatterns") or [r"\.fwsc$"]]
    for m in re.finditer(site["releaseLink"], page):
        version, base = m.group(1), m.group(0)
        if version in seen:
            continue
        seen.add(version)
        sums_url = base + site["sums"].format(version=version)
        assets = []
        for line in http_get(sums_url, limit=64 * 1024).decode("utf-8", "replace").splitlines():
            parts = line.split()
            if len(parts) >= 2 and re.fullmatch(r"[0-9a-fA-F]{64}", parts[0]):
                name = os.path.basename(parts[-1].lstrip("*"))
                if any(p.search(name) for p in pats):
                    assets.append({"name": name, "url": base + name, "sha256": parts[0].lower()})
        out.append({"version": version, "title": f"{version} (project site)", "date": "",
                    "prerelease": bool(PRERELEASE_RE.search(version)), "url": site["page"],
                    "assets": assets, "sha256sums": sums_url})
    return out


def merge_site_releases(entry, site):
    """Put site releases the GitHub mirror doesn't have yet in front of its list."""
    try:
        known = {r["version"].lower() for r in entry.get("releases", [])}
        extra = [r for r in site_releases(site) if r["version"].lower() not in known]
        entry["releases"] = extra + entry.get("releases", [])
    except Exception as e:  # the GitHub data still stands
        entry["siteError"] = f"project site: {e}"[:200]


def firmware_entries():
    """Curated catalog plus card definitions for ranked projects not curated yet."""
    disc = read_json(DISCOVERY_CACHE, {})
    ranked, entries, _ = build_ranking(disc)
    return catalog()["firmware"] + entries, ranked, disc


def known_entry(fid):
    return catalog_entry(fid) or next((e for e in firmware_entries()[0] if e["id"] == fid), None)


def local_library():
    """Files downloaded/imported per firmware id, with their recorded hashes."""
    state = read_json(FW_STATE, {})
    files = state.get("files", {})
    out = {}
    for key, meta in list(files.items()):
        p = ROOT / meta["path"]
        if not p.exists():
            files.pop(key)
            continue
        out.setdefault(meta["id"], []).append({**meta, "key": key})
    for lst in out.values():
        lst.sort(key=lambda m: m.get("added", ""), reverse=True)
    return out


def record_file(fid, version, path, source_url, verified, sha):
    state = read_json(FW_STATE, {})
    key = f"{fid}/{version}/{path.name}"
    state.setdefault("files", {})[key] = {
        "id": fid, "version": version, "name": path.name,
        "path": str(path.relative_to(ROOT)).replace("\\", "/"),
        "size": path.stat().st_size, "sha256": sha, "verified": verified,
        "source": source_url, "added": time.strftime("%Y-%m-%dT%H:%M:%S"),
    }
    write_json(FW_STATE, state)
    return state["files"][key]


def download_asset(fid, version, asset_name):
    cache = read_json(RELEASE_CACHE, {}).get("sources", {})
    rel = next((r for r in cache.get(fid, {}).get("releases", []) if r["version"] == version), None)
    if not rel:
        raise ValueError("release not in cache, press Check for updates first")
    asset = next((a for a in rel["assets"] if a["name"] == asset_name), None)
    if not asset:
        raise ValueError("asset not found in release")
    if (urlparse(asset["url"]).hostname or "") not in ALLOWED_DL_HOSTS:
        raise ValueError("asset host not allowed")

    data = http_get(asset["url"])
    sha = hashlib.sha256(data).hexdigest()
    verified = None  # None = no checksum published
    expected = {}
    side = rel.get("sha256files", {}).get(asset_name)
    if asset.get("sha256"):  # published next to the file on the project's own install page
        expected[asset_name] = asset["sha256"]
    elif side:
        parts = http_get(side).decode("utf-8", "replace").split()
        if parts:
            expected[asset_name] = parts[0].lower()
    elif rel.get("sha256sums"):
        sums = http_get(rel["sha256sums"]).decode("utf-8", "replace")
        for line in sums.splitlines():
            parts = line.split()
            if len(parts) >= 2:
                expected[os.path.basename(parts[-1].lstrip("*"))] = parts[0].lower()
    if asset_name in expected:
        verified = expected[asset_name] == sha
        if not verified:
            raise ValueError(f"SHA256 mismatch for {asset_name}; file discarded")

    dest_dir = FW_LIB / fid / safe_version(version)
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / safe_filename(asset_name)
    dest.write_bytes(data)
    return record_file(fid, safe_version(version), dest, asset["url"], verified, sha)


def import_file(fid, version, name, data):
    dest_dir = FW_LIB / fid / safe_version(version)
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / safe_filename(name)
    dest.write_bytes(data)
    return record_file(fid, safe_version(version), dest, "manual import", None, sha256_file(dest))


def delete_file(key):
    state = read_json(FW_STATE, {})
    meta = state.get("files", {}).pop(key, None)
    if not meta:
        raise ValueError("unknown file")
    p = (ROOT / meta["path"]).resolve()
    if FW_LIB.resolve() in p.parents and p.exists():
        p.unlink()
        try:
            p.parent.rmdir()
        except OSError:
            pass
    write_json(FW_STATE, state)


def set_installed(body):
    state = read_json(FW_STATE, {})
    rec = {
        "id": str(body.get("id", ""))[:32],
        "version": str(body.get("version", ""))[:48],
        "note": str(body.get("note", ""))[:500],
        "date": time.strftime("%Y-%m-%dT%H:%M:%S"),
    }
    state["installed"] = rec
    state.setdefault("history", []).insert(0, rec)
    state["history"] = state["history"][:100]
    write_json(FW_STATE, state)
    return rec


def reveal(fid):
    folder = FW_LIB / fid if fid else FW_LIB
    folder.mkdir(parents=True, exist_ok=True)
    if sys.platform == "win32":
        os.startfile(folder)  # noqa: S606 - opens Explorer on a folder we own
    return str(folder)


# ---------------------------------------------------------------- HTTP

class Handler(SimpleHTTPRequestHandler):
    server_version = "FM1Dashboard/1.0"

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(WEB), **kw)

    def log_message(self, fmt, *args):
        if "/api/" in (args[0] if args else ""):
            sys.stderr.write("%s\n" % (fmt % args))

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    # Guard against DNS rebinding and cross-site requests from other web pages.
    def _host_ok(self):
        allowed = {f"127.0.0.1:{PORT}", f"localhost:{PORT}"}
        if self.headers.get("Host") not in allowed:
            return False
        if self.command != "GET":
            origin = self.headers.get("Origin")
            if origin not in {f"http://{h}" for h in allowed}:
                return False
        return True

    def _send_json(self, obj, status=200):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _error(self, msg, status=400):
        self._send_json({"error": msg}, status)

    def _body(self, limit=MAX_BODY):
        n = int(self.headers.get("Content-Length") or 0)
        if n > limit:
            raise ValueError("request too large")
        return self.rfile.read(n)

    def _json_body(self):
        raw = self._body()
        return json.loads(raw or b"{}")

    def _route(self):
        if not self._host_ok():
            return self._error("forbidden", 403)
        url = urlparse(self.path)
        if not url.path.startswith("/api/"):
            if self.command == "GET":
                return super().do_GET()
            return self._error("not found", 404)
        parts = [unquote(p) for p in url.path.split("/")[2:] if p]
        q = {k: v[0] for k, v in parse_qs(url.query).items()}
        try:
            return self._api(self.command, parts, q)
        except (ValueError, KeyError, json.JSONDecodeError) as e:
            return self._error(str(e))
        except urllib.error.URLError as e:
            return self._error(f"network error: {e.reason}", 502)
        except Exception as e:  # keep the server alive, report the problem
            return self._error(f"{type(e).__name__}: {e}", 500)

    do_GET = do_PUT = do_POST = do_DELETE = _route

    def _api(self, method, parts, q):
        head = parts[0] if parts else ""

        if head == "health":
            return self._send_json({"ok": True})

        if head == "settings":
            if method == "GET":
                return self._send_json(read_json(SETTINGS, {}))
            if method == "PUT":
                obj = self._json_body()
                if not isinstance(obj, dict):
                    raise ValueError("settings must be an object")
                write_json(SETTINGS, obj)
                return self._send_json(obj)

        if head == "patches":
            return patches_api(self, method, parts)

        if head == "formats" and method == "GET" and len(parts) == 1:
            return self._send_json(formats_response())

        if head == "firmware":
            sub = parts[1] if len(parts) > 1 else ""
            if sub == "" and method == "GET":
                state = read_json(FW_STATE, {})
                entries, ranked, disc = firmware_entries()
                return self._send_json({
                    "catalog": entries,  # curated catalog + cards for new, not yet curated entrants
                    "ranking": catalog().get("ranking"),
                    "ranked": ranked,  # live community ranking: #1-10 cards, #11-30 list
                    "discovery": {
                        "checked": disc.get("checked"), "auth": disc.get("auth"), "notes": disc.get("notes", []),
                        "stats": disc.get("stats"), "source": discovery_config()["awesomePage"],
                        "fallback": read_json(DIRECTORY, {}).get("updated") if not disc.get("ranked") else None,
                    },
                    "validated": read_json(VALIDATED, {"validations": []}).get("validations", []),
                    "releases": read_json(RELEASE_CACHE, {"checked": None, "sources": {}}),
                    "library": local_library(),
                    "installed": state.get("installed"),
                    "history": state.get("history", []),
                    "libraryPath": "firmware/library",
                })
            if sub == "refresh" and method == "POST":
                return self._send_json(refresh_releases())
            if sub == "download" and method == "POST":
                b = self._json_body()
                return self._send_json(download_asset(b["id"], b["version"], b["asset"]))
            if sub == "import" and method == "POST":
                fid = q.get("id", "")
                if not ID_RE.match(fid) or not known_entry(fid):
                    raise ValueError("unknown firmware id")
                data = self._body(MAX_IMPORT)
                if not data:
                    raise ValueError("empty file")
                return self._send_json(import_file(fid, q.get("version", "manual"), q.get("name", "firmware.fwsc"), data))
            if sub == "file" and method == "DELETE":
                delete_file(q.get("key", ""))
                return self._send_json({"ok": True})
            if sub == "installed" and method == "POST":
                return self._send_json(set_installed(self._json_body()))
            if sub == "reveal" and method == "POST":
                fid = self._json_body().get("id", "")
                if fid and (not ID_RE.match(fid) or not known_entry(fid)):
                    raise ValueError("unknown firmware id")
                # relative, so the local user name never reaches the browser
                return self._send_json({"path": Path(reveal(fid)).relative_to(ROOT).as_posix()})

        return self._error("not found", 404)


# ---------------------------------------------------------------- patches & formats
#
# Patch schema v2 (data/patches/<name>.json):
#   schemaVersion  2
#   firmware       {"id": catalog id, "version": optional}: the firmware the patch is for
#   format         "<file id>/<key>": a format defined in firmware/formats/<file id>.json
#   content        stock: voice (156 DX7 values), fx ({"<cc>": value}), program (1-128)
#                  other firmwares: params ({id: value}), cc ([{ch?, cc, value}]), sysex (["F0 .. F7"])
#   name, notes, tags, favorite, created, modified. Any other field is stored as it is.
# v1 files (no schemaVersion) are read as firmware {"id": "official"} in the stock format and
# are only rewritten, as v2, when they are saved.

FORMATS_DIR = ROOT / "firmware" / "formats"
PATCH_SCHEMA = 2
OFFICIAL_FORMAT = "official/dx7-voice+fx"
FORMAT_KEY_RE = re.compile(r"^[a-z0-9][a-z0-9.+\-]{0,47}$")
FORMAT_ID_RE = re.compile(r"^[a-z0-9][a-z0-9\-]{0,31}/[a-z0-9][a-z0-9.+\-]{0,47}$")
TRANSPORTS = {"program-change", "dx7-param-sysex", "cc-map", "cc-list", "params", "raw-sysex", "none"}
STATUSES = {"confirmed", "discovered", "unknown"}
_formats_cache = {"sig": None, "reg": None}


def load_formats():
    """Read the format registry, firmware/formats/*.json (files starting with _ are skipped).
    Broken files or formats are reported in "errors" instead of failing the whole registry."""
    paths = sorted(p for p in FORMATS_DIR.glob("*.json") if not p.name.startswith("_"))
    sig = tuple((p.name, p.stat().st_mtime_ns, p.stat().st_size) for p in paths)
    if _formats_cache["sig"] == sig:
        return _formats_cache["reg"]
    reg = {"files": [], "formats": {}, "errors": []}
    for p in paths:
        fid = p.stem
        try:
            if p.stat().st_size > MAX_BODY:
                raise ValueError("file too large")
            d = json.loads(p.read_text(encoding="utf-8"))
            if not isinstance(d, dict):
                raise ValueError("not a JSON object")
            if not ID_RE.match(fid) or d.get("id", fid) != fid:
                raise ValueError(f'"id" must equal the file name ({fid})')
            fws = d.get("firmware", [fid])
            fws = [fws] if isinstance(fws, str) else fws
            if not isinstance(fws, list) or not fws or not all(
                    isinstance(x, str) and (x == "*" or ID_RE.match(x)) for x in fws):
                raise ValueError('"firmware" must list catalog ids, or "*" for any firmware')
            fmts = d.get("formats")
            if not isinstance(fmts, dict) or not fmts:
                raise ValueError('no "formats"')
        except (OSError, ValueError, json.JSONDecodeError) as e:
            reg["errors"].append(f"{p.name}: {e}")
            continue
        ids = []
        for key, f in fmts.items():
            try:
                if not isinstance(key, str) or not FORMAT_KEY_RE.match(key) or not isinstance(f, dict):
                    raise ValueError("format keys: a-z 0-9 . + - (up to 48), each an object")
                send = f.get("send", [])
                if not isinstance(send, list) or not all(isinstance(s, dict) for s in send):
                    raise ValueError('"send" must be a list of steps')
                params = f.get("params", [])
                if not isinstance(params, list) or not all(
                        isinstance(x, dict) and isinstance(x.get("id"), str) for x in params):
                    raise ValueError('"params" must be a list of objects with an "id"')
                if len({x["id"] for x in params}) != len(params):
                    raise ValueError("duplicate parameter ids")
            except ValueError as e:
                reg["errors"].append(f"{p.name}: {key}: {e}")
                continue
            problems = [f'transport "{s.get("type")}" isn\'t supported by this dashboard'
                        for s in send if s.get("type") not in TRANSPORTS]
            blocked = next((s.get("reason") or "No way to send this format is known yet."
                            for s in send if s.get("type") == "none"), None)
            status = f.get("status", d.get("status", "unknown"))
            full = f"{fid}/{key}"
            reg["formats"][full] = {
                **f, "id": full, "file": fid, "firmware": fws,
                "status": status if status in STATUSES else "unknown",
                "sendable": bool(send) and not problems and not blocked,
                "notSendableReason": "; ".join(problems) or blocked or (None if send else "No send steps defined."),
            }
            ids.append(full)
        status = d.get("status", "unknown")
        reg["files"].append({
            "id": fid, "name": str(d.get("name", fid)), "firmware": fws,
            "status": status if status in STATUSES else "unknown",
            "description": str(d.get("description", "")), "formats": ids,
        })
    _formats_cache.update(sig=sig, reg=reg)
    return reg


def formats_response():
    """GET /api/formats: the registry plus what the Library needs to label it (catalog names
    and the logged device firmware), so the Library doesn't depend on the Firmware tab."""
    state = read_json(FW_STATE, {})
    return {
        **load_formats(),
        "catalog": [{"id": f.get("id"), "name": f.get("name"), "kind": f.get("kind")}
                    for f in catalog().get("firmware", [])],
        "installed": state.get("installed"),
    }


def normalize_patch(d):
    """Schema v2 view of a stored patch, without changing the file.
    Returns (view, stored schema version)."""
    stored = d.get("schemaVersion")
    out = dict(d)
    if stored is None:  # v1: stock DX7 voice + FX; "firmware" was a loose string
        legacy = d.get("firmware")
        out["firmware"] = {"id": "official"}
        if isinstance(legacy, str) and legacy and legacy != "official":
            out["legacyFirmware"] = legacy[:32]
        out["format"] = OFFICIAL_FORMAT
        out["schemaVersion"] = PATCH_SCHEMA
        return out, 1
    fw = d.get("firmware")
    if not isinstance(fw, dict) or not isinstance(fw.get("id"), str):
        out["firmware"] = {"id": fw if isinstance(fw, str) and ID_RE.match(fw) else "unknown"}
    if not isinstance(d.get("format"), str):
        out["format"] = "unknown/unknown"
    return out, stored


def _intv(v, lo, hi, what):
    if isinstance(v, bool) or not isinstance(v, int) or not lo <= v <= hi:
        raise ValueError(f"{what} must be an integer {lo}-{hi}")
    return v


def parse_sysex(msg):
    """One SysEx message as hex text ("F0 43 .. F7") or a byte list -> normalized hex text."""
    if isinstance(msg, str):
        tokens = msg.replace(",", " ").split()
        try:
            data = [int(t, 16) for t in tokens]
        except ValueError:
            raise ValueError(f"sysex: not hex: {msg[:40]}") from None
    elif isinstance(msg, list):
        data = [_intv(b, 0, 255, "sysex byte") for b in msg]
    else:
        raise ValueError("sysex: each message is a hex string or a byte list")
    if len(data) < 2 or data[0] != 0xF0 or data[-1] != 0xF7 or any(b > 0x7F for b in data[1:-1]):
        raise ValueError("sysex: each message must start with F0, end with F7 and hold 7-bit data")
    if len(data) > 65536:
        raise ValueError("sysex: message too long")
    return " ".join(f"{b:02X}" for b in data)


def validate_patch(obj):
    """Check a patch for PUT and return it as schema v2. Known fields are type-checked;
    unknown fields are kept untouched."""
    if not isinstance(obj, dict):
        raise ValueError("patch must be an object")
    sv = obj.get("schemaVersion")
    if sv is None:
        obj, _ = normalize_patch(obj)
    elif sv != PATCH_SCHEMA:
        raise ValueError(f"schemaVersion {sv} isn't supported (this dashboard writes {PATCH_SCHEMA})")
    obj = dict(obj)

    fw = obj.get("firmware")
    if not isinstance(fw, dict) or not isinstance(fw.get("id"), str) or not ID_RE.match(fw["id"]):
        raise ValueError('firmware must be {"id": "<catalog id>", "version": "..."}')
    fw = dict(fw)
    if fw.get("version") in (None, ""):
        fw.pop("version", None)
    elif not isinstance(fw["version"], str) or len(fw["version"]) > 48:
        raise ValueError("firmware.version: text up to 48 characters")
    obj["firmware"] = fw

    fmt_id = obj.get("format")
    if not isinstance(fmt_id, str) or not FORMAT_ID_RE.match(fmt_id):
        raise ValueError('format must be a format id such as "official/dx7-voice+fx"')
    fmt = load_formats()["formats"].get(fmt_id)
    if not fmt:
        raise ValueError(f'unknown format "{fmt_id}": add it to firmware/formats/ first')
    if "*" not in fmt["firmware"] and fw["id"] not in fmt["firmware"]:
        raise ValueError(f'format "{fmt_id}" is for {", ".join(fmt["firmware"])}, not {fw["id"]}')

    if obj.get("voice") is not None:
        v = obj["voice"]
        if not isinstance(v, list) or len(v) != 156:
            raise ValueError("voice must be a list of 156 DX7 values")
        for x in v:
            _intv(x, 0, 127, "voice values")
    if obj.get("fx") is not None:
        fx = obj["fx"]
        if not isinstance(fx, dict) or len(fx) > 128:
            raise ValueError('fx must be an object {"<cc>": value}')
        for k, x in fx.items():
            if not str(k).isdigit() or int(k) > 127:
                raise ValueError("fx keys are CC numbers 0-127")
            _intv(x, 0, 127, "fx values")
    if obj.get("program") is not None:
        _intv(obj["program"], 1, 128, "program")
    if obj.get("params") is not None:
        ps = obj["params"]
        if not isinstance(ps, dict) or len(ps) > 4096:
            raise ValueError("params must be an object {id: value} (up to 4096)")
        for k, x in ps.items():
            if len(k) > 64 or not (x is None or isinstance(x, (int, float, bool)) or (isinstance(x, str) and len(x) <= 256)):
                raise ValueError(f"params.{k[:64]}: a number, true/false or short text")
    if obj.get("cc") is not None:
        cl = obj["cc"]
        if not isinstance(cl, list) or len(cl) > 4096:
            raise ValueError("cc must be a list of {ch, cc, value} (up to 4096)")
        for e in cl:
            if not isinstance(e, dict):
                raise ValueError("cc entries are objects {ch, cc, value}")
            _intv(e.get("cc"), 0, 127, "cc.cc")
            _intv(e.get("value"), 0, 127, "cc.value")
            if e.get("ch") is not None:
                _intv(e["ch"], 1, 16, "cc.ch")
    if obj.get("sysex") is not None:
        sx = obj["sysex"]
        if not isinstance(sx, list) or len(sx) > 512:
            raise ValueError("sysex must be a list of messages (up to 512)")
        obj["sysex"] = [parse_sysex(m) for m in sx]
    tags = obj.get("tags", [])
    if not isinstance(tags, list) or len(tags) > 64 or not all(isinstance(t, str) and len(t) <= 64 for t in tags):
        raise ValueError("tags: a list of up to 64 short texts")
    if not isinstance(obj.get("notes", ""), str) or len(obj.get("notes", "")) > 20000:
        raise ValueError("notes: text up to 20000 characters")
    obj["favorite"] = bool(obj.get("favorite"))
    obj["schemaVersion"] = PATCH_SCHEMA
    return obj


def patch_summary(name, raw):
    """One row of GET /api/patches."""
    error = None
    if not isinstance(raw, dict):
        error, raw = "unreadable JSON", {}
    d, stored = normalize_patch(raw)
    tags = d.get("tags") if isinstance(d.get("tags"), list) else []
    return {
        "name": name, "favorite": bool(d.get("favorite")),
        "notes": d.get("notes", "") if isinstance(d.get("notes"), str) else "",
        "modified": d.get("modified", ""), "tags": [str(t) for t in tags],
        "program": d.get("program"),
        "hasVoice": bool(d.get("voice")), "hasFx": bool(d.get("fx")),
        "params": len(d["params"]) if isinstance(d.get("params"), dict) else 0,
        "cc": len(d["cc"]) if isinstance(d.get("cc"), list) else 0,
        "sysex": len(d["sysex"]) if isinstance(d.get("sysex"), list) else 0,
        "firmware": d["firmware"], "format": d["format"], "schemaVersion": stored,
        "legacyFirmware": d.get("legacyFirmware"), "error": error,
    }


def patches_api(h, method, parts):
    PATCHES.mkdir(parents=True, exist_ok=True)
    if len(parts) == 1 and method == "GET":
        return h._send_json([patch_summary(p.stem, read_json(p, None))
                             for p in sorted(PATCHES.glob("*.json")) if NAME_RE.match(p.stem)])
    if len(parts) == 2:
        name = parts[1]
        if not NAME_RE.match(name):
            raise ValueError("patch names: letters, digits, space _ . - ( ) up to 64 chars")
        path = PATCHES / f"{name}.json"
        if method == "GET":
            if not path.exists():
                return h._error("not found", 404)
            raw = read_json(path, None)
            if not isinstance(raw, dict):
                return h._error("patch file isn't valid JSON", 500)
            return h._send_json(normalize_patch(raw)[0])
        if method == "PUT":
            obj = validate_patch(h._json_body())
            obj["name"] = name
            obj["modified"] = time.strftime("%Y-%m-%dT%H:%M:%S")
            obj.setdefault("created", obj["modified"])
            write_json(path, obj)
            return h._send_json(obj)
        if method == "DELETE":
            path.unlink(missing_ok=True)
            return h._send_json({"deleted": name})
    if len(parts) == 3 and parts[2] == "rename" and method == "POST":
        return rename_patch(h, parts[1], str(h._json_body().get("to", "")).strip())
    return h._error("not found", 404)


def rename_patch(h, src, dst):
    """Rename a patch file, keeping its content as is (star, notes, schema); only name and
    modified change. Refuses to overwrite another patch."""
    for n in (src, dst):
        if not NAME_RE.match(n):
            raise ValueError("patch names: letters, digits, space _ . - ( ) up to 64 chars")
    sp, dp = PATCHES / f"{src}.json", PATCHES / f"{dst}.json"
    if not sp.exists():
        return h._error("not found", 404)
    # A case-only rename points at the same file on Windows/macOS; that's allowed.
    if dp.exists() and src.casefold() != dst.casefold():
        raise ValueError(f'a patch named "{dst}" already exists')
    raw = read_json(sp, None)
    if not isinstance(raw, dict):
        return h._error("patch file isn't valid JSON", 500)
    raw["name"] = dst
    raw["modified"] = time.strftime("%Y-%m-%dT%H:%M:%S")
    tmp = PATCHES / f"{dst}.json.renaming"
    write_json(tmp, raw)
    sp.unlink()
    tmp.replace(dp)
    return h._send_json({"renamed": src, "to": dst})


def main():
    for d in (DATA, PATCHES, FW_LIB):
        d.mkdir(parents=True, exist_ok=True)
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    url = f"http://{HOST}:{PORT}/"
    print(f"FM-1 Dashboard running at {url}  (Ctrl+C to stop)")
    if "--no-browser" not in sys.argv:
        webbrowser.open(url)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")


if __name__ == "__main__":
    main()
