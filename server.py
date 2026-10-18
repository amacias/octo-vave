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
import os
import re
import sys
import time
import urllib.error
import urllib.request
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

ROOT = Path(__file__).resolve().parent
WEB = ROOT / "web"
DATA = ROOT / "data"
PATCHES = DATA / "patches"
SETTINGS = DATA / "settings.json"
FW_STATE = DATA / "firmware-state.json"
RELEASE_CACHE = DATA / "releases-cache.json"
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

# Downloads are only ever made from URLs found in the catalog or GitHub release
# listings, and only from these hosts (GitHub redirects to its asset CDN).
ALLOWED_DL_HOSTS = {
    "github.com",
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",
    "yms-file-store.oss-cn-hongkong.aliyuncs.com",
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

def refresh_releases():
    """Query each catalog source for its latest releases and cache the result."""
    cache = {"checked": time.strftime("%Y-%m-%dT%H:%M:%S"), "sources": {}}
    for fw in catalog()["firmware"]:
        src = fw.get("source", {})
        entry = {"releases": [], "error": None}
        try:
            if src.get("type") == "github":
                gh = "application/vnd.github+json"
                repo = json.loads(http_get(f"https://api.github.com/repos/{src['repo']}", accept=gh))
                rels = [r for r in json.loads(http_get(
                    f"https://api.github.com/repos/{src['repo']}/releases?per_page=100", accept=gh))
                    if not r.get("draft")]
                pats = [re.compile(p, re.I) for p in src.get("assetPatterns", [r"\.fwsc$"])]
                entry["stats"] = {
                    "stars": repo.get("stargazers_count", 0),
                    "license": (repo.get("license") or {}).get("spdx_id"),
                    "pushed": (repo.get("pushed_at") or "")[:10],
                    "releases": len(rels),
                    # total downloads of firmware images across all releases
                    "downloads": sum(a.get("download_count", 0) for r in rels for a in r.get("assets", [])
                                     if a["name"].lower().endswith(".fwsc")),
                }
                for rel in rels[:6]:
                    all_assets = rel.get("assets", [])
                    assets = [
                        {"name": a["name"], "size": a["size"], "url": a["browser_download_url"],
                         "downloads": a.get("download_count", 0)}
                        for a in all_assets if any(p.search(a["name"]) for p in pats)
                    ]
                    entry["releases"].append({
                        "version": rel["tag_name"],
                        "title": rel.get("name") or rel["tag_name"],
                        "date": (rel.get("published_at") or "")[:10],
                        "prerelease": bool(rel.get("prerelease")) or bool(re.search(r"-(rc|beta|alpha|test|preview)", rel["tag_name"], re.I)),
                        "url": rel.get("html_url"),
                        "assets": assets,
                        "sha256sums": next(
                            (a["browser_download_url"] for a in all_assets
                             if re.fullmatch(r"SHA256SUMS(-.*)?(\.txt)?", a["name"], re.I)), None),
                        # per-file checksums such as foo.fwsc.sha256
                        "sha256files": {a["name"][:-7]: a["browser_download_url"]
                                        for a in all_assets if a["name"].lower().endswith(".sha256")},
                    })
            elif src.get("type") == "official":
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
        except urllib.error.HTTPError as e:
            entry["error"] = f"HTTP {e.code} ({'rate limited, set GITHUB_TOKEN' if e.code == 403 else e.reason})"
        except Exception as e:
            entry["error"] = str(e)
        if src.get("type") in ("github", "official"):
            cache["sources"][fw["id"]] = entry
    write_json(RELEASE_CACHE, cache)
    return cache


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
    if side:
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
            PATCHES.mkdir(parents=True, exist_ok=True)
            if len(parts) == 1 and method == "GET":
                items = []
                for p in sorted(PATCHES.glob("*.json")):
                    d = read_json(p, {})
                    items.append({
                        "name": p.stem, "favorite": bool(d.get("favorite")),
                        "notes": d.get("notes", ""), "modified": d.get("modified", ""),
                        "hasVoice": bool(d.get("voice")), "hasFx": bool(d.get("fx")),
                        "program": d.get("program"), "tags": d.get("tags", []),
                    })
                return self._send_json(items)
            if len(parts) == 2:
                name = parts[1]
                if not NAME_RE.match(name):
                    raise ValueError("patch names: letters, digits, space _ . - ( ) up to 64 chars")
                path = PATCHES / f"{name}.json"
                if method == "GET":
                    if not path.exists():
                        return self._error("not found", 404)
                    return self._send_json(read_json(path, {}))
                if method == "PUT":
                    obj = self._json_body()
                    if not isinstance(obj, dict):
                        raise ValueError("patch must be an object")
                    obj["name"] = name
                    obj["modified"] = time.strftime("%Y-%m-%dT%H:%M:%S")
                    obj.setdefault("created", obj["modified"])
                    write_json(path, obj)
                    return self._send_json(obj)
                if method == "DELETE":
                    path.unlink(missing_ok=True)
                    return self._send_json({"deleted": name})

        if head == "firmware":
            sub = parts[1] if len(parts) > 1 else ""
            if sub == "" and method == "GET":
                state = read_json(FW_STATE, {})
                return self._send_json({
                    "catalog": catalog()["firmware"],
                    "ranking": catalog().get("ranking"),
                    "directory": read_json(DIRECTORY, {"projects": []}),
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
                if not ID_RE.match(fid) or not catalog_entry(fid):
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
                if fid and (not ID_RE.match(fid) or not catalog_entry(fid)):
                    raise ValueError("unknown firmware id")
                # relative, so the local user name never reaches the browser
                return self._send_json({"path": Path(reveal(fid)).relative_to(ROOT).as_posix()})

        return self._error("not found", 404)


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
