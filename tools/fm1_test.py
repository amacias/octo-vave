#!/usr/bin/env python3
"""Interactive MIDI test tool for the M-VAVE FM-1 (Windows MME via ctypes, stdlib only).

Usage:
  python -I fm1_test.py                 interactive REPL
  python -I fm1_test.py --list          list ports and exit (opens nothing)
  python -I fm1_test.py --selftest      quick PASS/FAIL hardware test
  python -I fm1_test.py --monitor 10    monitor input for 10 s
  options: --out N / --in N to override port auto-selection, --fxch N (default 2)
"""
import argparse
import collections
import ctypes
import ctypes.wintypes as wt
import queue
import re
import sys
import time

try:
    import readline  # noqa: F401  (optional, not on Windows by default)
except ImportError:
    readline = None

# ----------------------------------------------------------------------------
# WinMM bindings
# ----------------------------------------------------------------------------
winmm = ctypes.WinDLL("winmm")
UINT, DWORD = wt.UINT, wt.DWORD
DWORD_PTR = ctypes.c_size_t
HANDLE = ctypes.c_void_p

CALLBACK_NULL = 0
CALLBACK_FUNCTION = 0x00030000
MMSYSERR_ALLOCATED = 4
MHDR_DONE = 0x1
MIM_OPEN, MIM_CLOSE, MIM_DATA, MIM_LONGDATA = 0x3C1, 0x3C2, 0x3C3, 0x3C4
MIM_ERROR, MIM_LONGERROR, MIM_MOREDATA = 0x3C5, 0x3C6, 0x3CC


class MIDIOUTCAPSW(ctypes.Structure):
    _fields_ = [("wMid", wt.WORD), ("wPid", wt.WORD), ("vDriverVersion", UINT),
                ("szPname", ctypes.c_wchar * 32), ("wTechnology", wt.WORD),
                ("wVoices", wt.WORD), ("wNotes", wt.WORD), ("wChannelMask", wt.WORD),
                ("dwSupport", DWORD)]


class MIDIINCAPSW(ctypes.Structure):
    _fields_ = [("wMid", wt.WORD), ("wPid", wt.WORD), ("vDriverVersion", UINT),
                ("szPname", ctypes.c_wchar * 32), ("dwSupport", DWORD)]


class MIDIHDR(ctypes.Structure):
    _fields_ = [("lpData", ctypes.c_void_p), ("dwBufferLength", DWORD),
                ("dwBytesRecorded", DWORD), ("dwUser", DWORD_PTR), ("dwFlags", DWORD),
                ("lpNext", ctypes.c_void_p), ("reserved", DWORD_PTR), ("dwOffset", DWORD),
                ("dwReserved", DWORD_PTR * 4)]


MIDIINPROC = ctypes.WINFUNCTYPE(None, HANDLE, UINT, DWORD_PTR, DWORD_PTR, DWORD_PTR)
PHDR = ctypes.POINTER(MIDIHDR)
PH = ctypes.POINTER(HANDLE)


def _sig(name, args, res=UINT):
    f = getattr(winmm, name)
    f.argtypes, f.restype = args, res


_sig("midiOutGetNumDevs", [], UINT)
_sig("midiOutGetDevCapsW", [DWORD_PTR, ctypes.POINTER(MIDIOUTCAPSW), UINT])
_sig("midiOutOpen", [PH, UINT, DWORD_PTR, DWORD_PTR, DWORD])
_sig("midiOutShortMsg", [HANDLE, DWORD])
_sig("midiOutPrepareHeader", [HANDLE, PHDR, UINT])
_sig("midiOutLongMsg", [HANDLE, PHDR, UINT])
_sig("midiOutUnprepareHeader", [HANDLE, PHDR, UINT])
_sig("midiOutReset", [HANDLE])
_sig("midiOutClose", [HANDLE])
_sig("midiOutGetErrorTextW", [UINT, ctypes.c_wchar_p, UINT])
_sig("midiInGetNumDevs", [], UINT)
_sig("midiInGetDevCapsW", [DWORD_PTR, ctypes.POINTER(MIDIINCAPSW), UINT])
_sig("midiInOpen", [PH, UINT, MIDIINPROC, DWORD_PTR, DWORD])
_sig("midiInPrepareHeader", [HANDLE, PHDR, UINT])
_sig("midiInUnprepareHeader", [HANDLE, PHDR, UINT])
_sig("midiInAddBuffer", [HANDLE, PHDR, UINT])
_sig("midiInStart", [HANDLE])
_sig("midiInStop", [HANDLE])
_sig("midiInReset", [HANDLE])
_sig("midiInClose", [HANDLE])
_sig("midiInGetErrorTextW", [UINT, ctypes.c_wchar_p, UINT])
_sig("timeBeginPeriod", [UINT])
_sig("timeEndPeriod", [UINT])


class MMError(Exception):
    def __init__(self, rc, what, inp=False):
        buf = ctypes.create_unicode_buffer(256)
        (winmm.midiInGetErrorTextW if inp else winmm.midiOutGetErrorTextW)(rc, buf, 256)
        self.rc = rc
        super().__init__("%s failed: MMSYSERR %d (%s)" % (what, rc, buf.value))


class PortBusy(Exception):
    pass


def busy_msg(kind, name):
    return ("MIDI %s port '%s' is already in use (MMSYSERR_ALLOCATED). Windows MIDI ports are "
            "exclusive: another program (a Chrome dashboard tab, M-UPGRADE, a DAW, another "
            "copy of this tool) holds it. Close/release it there and try again." % (kind, name))


def list_out():
    r = []
    for i in range(winmm.midiOutGetNumDevs()):
        c = MIDIOUTCAPSW()
        winmm.midiOutGetDevCapsW(i, ctypes.byref(c), ctypes.sizeof(c))
        r.append(c.szPname)
    return r


def list_in():
    r = []
    for i in range(winmm.midiInGetNumDevs()):
        c = MIDIINCAPSW()
        winmm.midiInGetDevCapsW(i, ctypes.byref(c), ctypes.sizeof(c))
        r.append(c.szPname)
    return r


def find_fm1(names):
    for i, n in enumerate(names):
        if "FM-1" in n.upper():
            return i
    return None


# ----------------------------------------------------------------------------
# Output port
# ----------------------------------------------------------------------------
class MidiOut:
    def __init__(self, idx, name=""):
        self.h = HANDLE()
        self.name = name
        rc = winmm.midiOutOpen(ctypes.byref(self.h), idx, 0, 0, CALLBACK_NULL)
        if rc == MMSYSERR_ALLOCATED:
            raise PortBusy(busy_msg("output", name))
        if rc:
            raise MMError(rc, "midiOutOpen")
        self.log = False
        self.held = set()

    def send(self, data):
        data = bytes(data)
        if not data:
            return
        if self.log:
            print("  > " + " ".join("%02X" % b for b in data))
        if data[0] != 0xF0 and len(data) <= 3:
            msg = data[0] | (data[1] << 8 if len(data) > 1 else 0) | (data[2] << 16 if len(data) > 2 else 0)
            rc = winmm.midiOutShortMsg(self.h, msg)
            if rc:
                raise MMError(rc, "midiOutShortMsg")
            st = data[0] & 0xF0
            if st == 0x90 and len(data) > 2 and data[2] > 0:
                self.held.add((data[0] & 15, data[1]))
            elif st in (0x80, 0x90) and len(data) > 1:
                self.held.discard((data[0] & 15, data[1]))
            return
        buf = ctypes.create_string_buffer(data, len(data))
        hdr = MIDIHDR()
        hdr.lpData = ctypes.addressof(buf)
        hdr.dwBufferLength = len(data)
        hdr.dwBytesRecorded = len(data)
        sz = ctypes.sizeof(hdr)
        rc = winmm.midiOutPrepareHeader(self.h, ctypes.byref(hdr), sz)
        if rc:
            raise MMError(rc, "midiOutPrepareHeader")
        try:
            rc = winmm.midiOutLongMsg(self.h, ctypes.byref(hdr), sz)
            if rc:
                raise MMError(rc, "midiOutLongMsg")
            t0 = time.perf_counter()
            while not (hdr.dwFlags & MHDR_DONE):
                if time.perf_counter() - t0 > 2.0:
                    raise RuntimeError("timeout waiting for SysEx send to complete")
                time.sleep(0.001)
        finally:
            if hdr.dwFlags & MHDR_DONE or not (hdr.dwFlags & 0x10):  # not INQUEUE
                winmm.midiOutUnprepareHeader(self.h, ctypes.byref(hdr), sz)
            del buf  # keep buf referenced until here

    def all_off(self):
        lg, self.log = self.log, False
        try:
            self._all_off()
        finally:
            self.log = lg

    def _all_off(self):
        for ch, n in list(self.held):
            try:
                self.send([0x80 | ch, n, 0])
            except Exception:
                pass
        self.held.clear()
        for ch in range(16):
            for cc, v in ((64, 0), (123, 0), (120, 0)):
                try:
                    self.send([0xB0 | ch, cc, v])
                except Exception:
                    pass

    def close(self):
        if not self.h:
            return
        try:
            self.all_off()
        finally:
            winmm.midiOutReset(self.h)
            winmm.midiOutClose(self.h)
            self.h = HANDLE()


# ----------------------------------------------------------------------------
# Input port
# ----------------------------------------------------------------------------
class MidiIn:
    NBUF, BUFSZ = 4, 4096

    def __init__(self, idx, name=""):
        self.q = queue.Queue()
        self.h = HANDLE()
        self.closing = False
        self.name = name
        self._cb = MIDIINPROC(self._callback)  # keep alive
        self.bufs = {}  # addr -> (buf, hdr)
        self.pending = bytearray()
        rc = winmm.midiInOpen(ctypes.byref(self.h), idx, self._cb, 0, CALLBACK_FUNCTION)
        if rc == MMSYSERR_ALLOCATED:
            raise PortBusy(busy_msg("input", name))
        if rc:
            raise MMError(rc, "midiInOpen", True)
        try:
            for _ in range(self.NBUF):
                buf = ctypes.create_string_buffer(self.BUFSZ)
                hdr = MIDIHDR()
                hdr.lpData = ctypes.addressof(buf)
                hdr.dwBufferLength = self.BUFSZ
                self.bufs[ctypes.addressof(hdr)] = (buf, hdr)
                sz = ctypes.sizeof(hdr)
                rc = winmm.midiInPrepareHeader(self.h, ctypes.byref(hdr), sz)
                if rc:
                    raise MMError(rc, "midiInPrepareHeader", True)
                rc = winmm.midiInAddBuffer(self.h, ctypes.byref(hdr), sz)
                if rc:
                    raise MMError(rc, "midiInAddBuffer", True)
            rc = winmm.midiInStart(self.h)
            if rc:
                raise MMError(rc, "midiInStart", True)
        except Exception:
            self.close()
            raise

    # Runs on a Windows thread: only copy data and enqueue. No midiIn* calls here.
    def _callback(self, hnd, msg, inst, p1, p2):
        try:
            if msg in (MIM_DATA, MIM_MOREDATA):
                self.q.put(("short", time.perf_counter(), p1 & 0xFFFFFFFF))
            elif msg == MIM_LONGDATA:
                hdr = ctypes.cast(p1, PHDR).contents
                n = hdr.dwBytesRecorded
                data = ctypes.string_at(hdr.lpData, n) if n else b""
                self.q.put(("long", time.perf_counter(), p1, data))
            elif msg in (MIM_ERROR, MIM_LONGERROR):
                self.q.put(("error", time.perf_counter(), p1))
        except Exception:
            pass

    def poll(self, timeout=0.05):
        """Return list of decoded events: ('short', t, status, d1, d2) / ('sysex', t, bytes)."""
        out = []
        try:
            item = self.q.get(timeout=timeout)
        except queue.Empty:
            return out
        while item is not None:
            kind = item[0]
            if kind == "short":
                p = item[2]
                out.append(("short", item[1], p & 0xFF, (p >> 8) & 0xFF, (p >> 16) & 0xFF))
            elif kind == "long":
                addr, data = item[2], item[3]
                if data and not self.closing:
                    self.pending += data
                    if self.pending[-1] == 0xF7:
                        out.append(("sysex", item[1], bytes(self.pending)))
                        self.pending = bytearray()
                if not self.closing and addr in self.bufs:
                    hdr = self.bufs[addr][1]
                    winmm.midiInAddBuffer(self.h, ctypes.byref(hdr), ctypes.sizeof(hdr))
            elif kind == "error":
                out.append(("error", item[1], item[2]))
            try:
                item = self.q.get_nowait()
            except queue.Empty:
                item = None
        return out

    def close(self):
        if not self.h:
            return
        self.closing = True
        winmm.midiInStop(self.h)
        winmm.midiInReset(self.h)  # returns all buffers (callback enqueues only)
        time.sleep(0.05)
        for buf, hdr in self.bufs.values():
            winmm.midiInUnprepareHeader(self.h, ctypes.byref(hdr), ctypes.sizeof(hdr))
        winmm.midiInClose(self.h)
        self.h = HANDLE()
        self.bufs.clear()


# ----------------------------------------------------------------------------
# Helpers / tables
# ----------------------------------------------------------------------------
NOTE_BASE = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}
NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def note_name(n):
    return "%s%d" % (NAMES[n % 12], n // 12 - 1)


def parse_note(s):
    if re.fullmatch(r"[A-Ga-g][#bB]?", s):
        s += "4"  # default octave 4
    m = re.fullmatch(r"([A-Ga-g])([#bB]?)(-?\d)", s)
    if m:
        n = NOTE_BASE[m.group(1).upper()]
        if m.group(2) == "#":
            n += 1
        elif m.group(2):
            n -= 1
        n += (int(m.group(3)) + 1) * 12
    else:
        n = int(s, 0)
    if not 0 <= n <= 127:
        raise ValueError("note out of range 0-127: %s" % s)
    return n


def num(s, lo, hi, what="value"):
    v = int(s, 0)
    if not lo <= v <= hi:
        raise ValueError("%s must be %d..%d (got %d)" % (what, lo, hi, v))
    return v


def parse_hex(args):
    s = " ".join(args).replace(",", " ")
    out = []
    for tok in s.split():
        tok = tok[2:] if tok.lower().startswith("0x") else tok
        if len(tok) > 2 and len(tok) % 2 == 0:  # allow packed "F04310"
            out.extend(int(tok[i:i + 2], 16) for i in range(0, len(tok), 2))
        else:
            out.append(int(tok, 16))
    if any(not 0 <= b <= 255 for b in out):
        raise ValueError("bytes must be 00..FF")
    return bytes(out)


FX = {
    "filter": {"sw": 0, "type": 1, "cutoff": 2, "q": 3},
    "reverb": {"sw": 4, "type": 5, "decay": 6, "mix": 7},
    "delay": {"sw": 8, "decay": 9, "rate": 10, "mix": 11},
    "dist": {"sw": 12, "gain": 13, "tone": 14, "level": 15},
    "chorus": {"sw": 16, "freq": 17, "depth": 18, "mix": 19},
    "phaser": {"sw": 20, "freq": 21, "depth": 22, "mix": 23},
}
FX_ALIAS = {"distortion": "dist", "distort": "dist", "dis": "dist", "flt": "filter"}
PARAM_ALIAS = {"switch": "sw", "resonance": "q", "res": "q"}
TYPE_NAMES = {"filter": {"lpf": 0, "bpf": 1, "hpf": 2}, "reverb": {"room": 0, "hall": 1, "plate": 2}}
CC_MAX = {0: 1, 1: 2, 2: 107, 3: 10, 4: 1, 5: 2, 6: 100, 8: 1, 12: 1, 16: 1, 20: 1}
CC_NAME = {cc: "%s.%s" % (g, p) for g, d in FX.items() for p, cc in d.items()}
SPECIAL_CC = {1: "modwheel", 7: "volume", 10: "pan", 11: "expression", 64: "sustain",
              120: "allsoundoff", 121: "resetctrl", 123: "allnotesoff"}

HELP = """Commands (ASCII only; <> required, [] optional):
  ports                          list MIDI in/out, mark selected
  note <note> [vel] [ms]         play one note (C4, F#3, 60); default vel 100, 500 ms
  scale [root]                   major scale up (default C4)
  chord <root> [maj|min|7]       play a chord (default maj)
  arp-test                       up/down arpeggio test
  pc <1-128>                     program change (voice select)
  voices <from> <to> [ms]        step through voices playing a note on each (default 600 ms)
  cc <ch 1-16> <cc> <val>        raw control change
  fx <name> on|off               FX switch on FX channel (filter reverb delay dist chorus phaser)
  fx <name> <param> <val>        e.g. fx filter cutoff 60, fx reverb type hall
  fx                             list FX names/CCs
  fxch <n>                       set FX channel (default 2)
  fxsweep <cc> [ms]              sweep CC over full range up/down holding a note (ms per step, default 30)
  bend <-8192..8191>   at <0-127>   mod <0-127>   sustain on|off
  sysex <hex...>                 send SysEx (F0/F7 added if missing)
  param <0-155> <val>            DX7 VCED single-param write (F0 43 10 pp qq vv F7)
  alg <1-32> [demo]              set algorithm (param 134)
  oplevel <op 1-6> <0-99> [demo] operator output level
  ratio <op> <coarse> [fine] [demo]  operator freq ratio (sets osc mode 0)
  clock <bpm> [beats]            FA, F8 x24/beat (default 8 beats), FC
  monitor [seconds] [all]        decode incoming MIDI, CC summary at end (Ctrl+C to stop)
  raw <hex...>                   send short or long message
  panic                          all notes off on all channels
  log on|off                     echo sent messages as hex
  help | quit
Note: on the FX channel CC1 is Filter Type, not mod wheel."""


def decode(st, d1, d2, fxch):
    if st >= 0xF0:
        names = {0xF8: "CLOCK", 0xFA: "START", 0xFB: "CONTINUE", 0xFC: "STOP", 0xFE: "ACTIVE-SENSE",
                 0xFF: "RESET", 0xF1: "MTC", 0xF2: "SONGPOS", 0xF3: "SONGSEL", 0xF6: "TUNE"}
        return names.get(st, "SYS %02X" % st)
    ch, k = (st & 15) + 1, st & 0xF0
    if k == 0x90 and d2:
        return "ch%-2d NOTE ON  %-4s (%3d) vel %d" % (ch, note_name(d1), d1, d2)
    if k in (0x80, 0x90):
        return "ch%-2d NOTE OFF %-4s (%3d) vel %d" % (ch, note_name(d1), d1, d2)
    if k == 0xB0:
        nm = CC_NAME.get(d1) if ch == fxch else SPECIAL_CC.get(d1)
        return "ch%-2d CC %3d = %3d  %s" % (ch, d1, d2, ("[" + nm + "]") if nm else "")
    if k == 0xC0:
        return "ch%-2d PROGRAM %d (voice %03d)" % (ch, d1, d1 + 1)
    if k == 0xD0:
        return "ch%-2d AFTERTOUCH %d" % (ch, d1)
    if k == 0xA0:
        return "ch%-2d POLY-AT %s %d" % (ch, note_name(d1), d2)
    if k == 0xE0:
        return "ch%-2d PITCHBEND %d" % (ch, ((d2 << 7) | d1) - 8192)
    return "?? %02X %02X %02X" % (st, d1, d2)


def do_monitor(in_idx, in_name, secs, show_all, fxch):
    if in_idx is None:
        print("No FM-1 MIDI input found (use --in N).")
        return
    try:
        mi = MidiIn(in_idx, in_name)
    except PortBusy as e:
        print(str(e))
        return
    print("Monitoring '%s'%s. Ctrl+C to stop." % (in_name, (" for %.1f s" % secs) if secs else ""))
    ccs = {}
    other = collections.Counter()
    t0 = time.perf_counter()
    try:
        while secs is None or time.perf_counter() - t0 < secs:
            for ev in mi.poll(0.05):
                t = ev[1] - t0
                if ev[0] == "sysex":
                    other["sysex"] += 1
                    print("%8.3f SYSEX (%d bytes) %s" % (t, len(ev[2]), " ".join("%02X" % b for b in ev[2])))
                    continue
                if ev[0] == "error":
                    print("%8.3f input error %08X" % (t, ev[2]))
                    continue
                _, _, st, d1, d2 = ev
                if st in (0xF8, 0xFE):
                    other[decode(st, 0, 0, fxch)] += 1
                    if not show_all:
                        continue
                if st & 0xF0 == 0xB0 and st < 0xF0:
                    key = ((st & 15) + 1, d1)
                    r = ccs.setdefault(key, [0, d2, d2, d2])
                    r[0] += 1
                    r[1], r[2], r[3] = min(r[1], d2), max(r[2], d2), d2
                elif st not in (0xF8, 0xFE):
                    other[decode(st, d1, d2, fxch).split()[1] if st < 0xF0 else decode(st, 0, 0, fxch)] += 1
                print("%8.3f %s" % (t, decode(st, d1, d2, fxch)))
    except KeyboardInterrupt:
        print("\n(monitor stopped)")
    finally:
        mi.close()
    print("\nSummary: %d unique CC(s) seen" % len(ccs))
    if ccs:
        print("  ch  cc  count  min  max  last  name")
        for (ch, cc), (n, lo, hi, last) in sorted(ccs.items()):
            nm = (CC_NAME.get(cc) if ch == fxch else SPECIAL_CC.get(cc)) or ""
            print("  %2d %3d %6d %4d %4d %5d  %s" % (ch, cc, n, lo, hi, last, nm))
    if other:
        print("Other messages: " + ", ".join("%s=%d" % kv for kv in sorted(other.items())))


# ----------------------------------------------------------------------------
# REPL
# ----------------------------------------------------------------------------
class Tool:
    def __init__(self, out, in_idx, in_name, fxch):
        self.out, self.in_idx, self.in_name, self.fxch = out, in_idx, in_name, fxch
        self.nch = 0  # note channel 1 (0-based)
        self.out_sel, self.in_sel = None, in_idx

    # -- low level
    def sleep(self, ms):
        time.sleep(max(0.0, ms) / 1000.0)

    def non(self, n, v=100):
        self.out.send([0x90 | self.nch, n, v])

    def noff(self, n):
        self.out.send([0x80 | self.nch, n, 0])

    def play(self, notes, vel=100, ms=400):
        if isinstance(notes, int):
            notes = [notes]
        try:
            for n in notes:
                self.non(n, vel)
            self.sleep(ms)
        finally:
            for n in notes:
                self.noff(n)

    def cc(self, ch, cc, v):
        self.out.send([0xB0 | (ch - 1), cc, v])

    def param(self, p, v):
        self.out.send([0xF0, 0x43, 0x10, p >> 7, p & 127, v & 127, 0xF7])

    def demo(self, a):
        if a and a[-1].lower() == "demo":
            self.play(60, 100, 700)
            return a[:-1]
        return a

    # -- commands
    def c_help(self, a):
        print(HELP)

    def c_ports(self, a):
        print_ports(self.out_sel, self.in_sel)

    def c_note(self, a):
        n = parse_note(a[0])
        vel = num(a[1], 1, 127, "velocity") if len(a) > 1 else 100
        ms = float(a[2]) if len(a) > 2 else 500
        print("note %s (%d) vel %d %g ms" % (note_name(n), n, vel, ms))
        self.play(n, vel, ms)

    def c_scale(self, a):
        r = parse_note(a[0]) if a else 60
        for iv in (0, 2, 4, 5, 7, 9, 11, 12):
            print(note_name(r + iv), end=" ", flush=True)
            self.play(r + iv, 90, 220)
            self.sleep(30)
        print()

    def c_chord(self, a):
        r = parse_note(a[0])
        kind = a[1].lower() if len(a) > 1 else "maj"
        iv = {"maj": (0, 4, 7), "min": (0, 3, 7), "7": (0, 4, 7, 10)}.get(kind)
        if iv is None:
            raise ValueError("chord type must be maj, min or 7")
        ns = [r + i for i in iv]
        print("chord " + " ".join(note_name(n) for n in ns))
        self.play(ns, 85, 1200)

    def c_arp_test(self, a):
        seq = [60, 64, 67, 71, 72, 71, 67, 64]
        for _ in range(3):
            for n in seq:
                self.play(n, 90, 110)
        self.play(60, 90, 100)

    def c_pc(self, a):
        v = num(a[0], 1, 128, "voice")
        self.out.send([0xC0 | self.nch, v - 1])
        print("program change -> voice %03d" % v)

    def c_voices(self, a):
        lo, hi = num(a[0], 1, 128, "from"), num(a[1], 1, 128, "to")
        ms = float(a[2]) if len(a) > 2 else 600
        step = 1 if hi >= lo else -1
        for v in range(lo, hi + step, step):
            self.out.send([0xC0 | self.nch, v - 1])
            print("voice %03d" % v, flush=True)
            self.sleep(20)
            self.play(60, 100, ms * 0.8)
            self.sleep(ms * 0.2)

    def c_cc(self, a):
        ch, cc, v = num(a[0], 1, 16, "channel"), num(a[1], 0, 127, "cc"), num(a[2], 0, 127, "value")
        self.cc(ch, cc, v)

    def c_fxch(self, a):
        if a:
            self.fxch = num(a[0], 1, 16, "channel")
        print("FX channel = %d" % self.fxch)

    def c_fx(self, a):
        if not a:
            for g, d in FX.items():
                print("  %-7s %s" % (g, "  ".join("%s=%d" % kv for kv in d.items())))
            print("  FX channel = %d" % self.fxch)
            return
        g = FX_ALIAS.get(a[0].lower(), a[0].lower())
        if g not in FX:
            raise ValueError("unknown fx '%s' (filter reverb delay dist chorus phaser)" % a[0])
        if len(a) < 2:
            raise ValueError("usage: fx <name> on|off  |  fx <name> <param> <val>")
        w = a[1].lower()
        if w in ("on", "off"):
            cc, v = FX[g]["sw"], 127 if w == "on" else 0
        else:
            p = PARAM_ALIAS.get(w, w)
            if p not in FX[g]:
                raise ValueError("%s params: %s" % (g, ", ".join(FX[g])))
            cc = FX[g][p]
            if len(a) < 3:
                raise ValueError("missing value")
            sv = a[2].lower()
            if p == "sw" and sv in ("on", "off"):
                v = 127 if sv == "on" else 0
            elif p == "type" and sv in TYPE_NAMES.get(g, {}):
                v = TYPE_NAMES[g][sv]
            else:
                v = num(a[2], 0, 127, "value")
        print("fx %s -> ch%d CC%d = %d" % (g, self.fxch, cc, v))
        self.cc(self.fxch, cc, v)

    def c_fxsweep(self, a):
        cc = num(a[0], 0, 23, "cc")
        ms = float(a[1]) if len(a) > 1 else 30
        hi = CC_MAX.get(cc, 127)
        print("sweep CC%d (%s) 0..%d..0 on ch%d, %g ms/step" % (cc, CC_NAME.get(cc, "?"), hi, self.fxch, ms))
        self.non(60, 100)
        try:
            for v in list(range(0, hi + 1)) + list(range(hi - 1, -1, -1)):
                self.cc(self.fxch, cc, v)
                self.sleep(ms)
        finally:
            self.noff(60)

    def c_bend(self, a):
        v = num(a[0], -8192, 8191, "bend") + 8192
        self.out.send([0xE0 | self.nch, v & 127, v >> 7])

    def c_at(self, a):
        self.out.send([0xD0 | self.nch, num(a[0], 0, 127, "pressure")])

    def c_mod(self, a):
        self.cc(self.nch + 1, 1, num(a[0], 0, 127, "mod"))

    def c_sustain(self, a):
        if not a or a[0].lower() not in ("on", "off"):
            raise ValueError("usage: sustain on|off")
        self.cc(self.nch + 1, 64, 127 if a[0].lower() == "on" else 0)

    def c_sysex(self, a):
        d = bytearray(parse_hex(a))
        if not d or d[0] != 0xF0:
            d.insert(0, 0xF0)
        if d[-1] != 0xF7:
            d.append(0xF7)
        if any(b > 0x7F for b in d[1:-1]):
            raise ValueError("SysEx data bytes must be <= 7F")
        self.out.send(d)
        print("sent %d bytes" % len(d))

    def c_param(self, a):
        p, v = num(a[0], 0, 155, "param"), num(a[1], 0, 127, "value")
        self.param(p, v)
        print("param %d = %d" % (p, v))

    def c_alg(self, a):
        a = self.demo_split(a)
        n = num(a[0], 1, 32, "algorithm")
        self.param(134, n - 1)
        print("algorithm %d (param 134 = %d)" % (n, n - 1))
        self.run_demo()

    def c_oplevel(self, a):
        a = self.demo_split(a)
        op, lv = num(a[0], 1, 6, "op"), num(a[1], 0, 99, "level")
        p = (6 - op) * 21 + 16
        self.param(p, lv)
        print("OP%d output level = %d (param %d)" % (op, lv, p))
        self.run_demo()

    def c_ratio(self, a):
        a = self.demo_split(a)
        op, co = num(a[0], 1, 6, "op"), num(a[1], 0, 31, "coarse")
        fi = num(a[2], 0, 99, "fine") if len(a) > 2 else 0
        base = (6 - op) * 21
        self.param(base + 17, 0)
        self.param(base + 18, co)
        self.param(base + 19, fi)
        print("OP%d ratio coarse %d fine %d (params %d-%d)" % (op, co, fi, base + 17, base + 19))
        self.run_demo()

    def demo_split(self, a):
        self._demo = bool(a) and a[-1].lower() == "demo"
        return a[:-1] if self._demo else a

    def run_demo(self):
        if self._demo:
            self.play(60, 100, 800)

    def c_clock(self, a):
        bpm = float(a[0])
        beats = int(a[1]) if len(a) > 1 else 8
        if bpm <= 0:
            raise ValueError("bpm must be > 0")
        iv = 60.0 / (bpm * 24)
        print("clock %g bpm, %d beats (%d ticks)" % (bpm, beats, beats * 24))
        self.out.send([0xFA])
        try:
            start = time.perf_counter()
            for i in range(beats * 24):
                tgt = start + i * iv
                while True:
                    rem = tgt - time.perf_counter()
                    if rem <= 0:
                        break
                    if rem > 0.002:
                        time.sleep(rem - 0.002)
                self.out.send([0xF8])
        finally:
            self.out.send([0xFC])
        print("stop (FC)")

    def c_monitor(self, a):
        secs, show_all = None, False
        for x in a:
            if x.lower() == "all":
                show_all = True
            else:
                secs = float(x)
        do_monitor(self.in_sel, self.in_name, secs, show_all, self.fxch)

    def c_raw(self, a):
        d = parse_hex(a)
        self.out.send(d)
        print("sent %d byte(s)" % len(d))

    def c_panic(self, a):
        self.out.all_off()
        lg, self.out.log = self.out.log, False
        for n in range(128):
            self.out.send([0x80 | self.nch, n, 0])
        self.out.log = lg
        winmm.midiOutReset(self.out.h)
        print("panic sent")

    def c_log(self, a):
        if not a or a[0].lower() not in ("on", "off"):
            raise ValueError("usage: log on|off")
        self.out.log = a[0].lower() == "on"

    def dispatch(self, line):
        parts = line.split()
        if not parts:
            return True
        cmd, a = parts[0].lower(), parts[1:]
        if cmd in ("quit", "exit", "q"):
            return False
        fn = getattr(self, "c_" + cmd.replace("-", "_"), None)
        if fn is None:
            print("unknown command '%s' (try 'help')" % cmd)
            return True
        try:
            fn(a)
        except (IndexError, ValueError) as e:
            print("error: %s%s" % (e if isinstance(e, ValueError) else "missing argument", "  (see 'help')"))
        except MMError as e:
            print("MIDI error: %s" % e)
        return True

    def repl(self):
        print("FM-1 test tool. Output: %s. Type 'help'." % self.out.name)
        while True:
            try:
                line = input("fm1> ")
            except EOFError:
                break
            except KeyboardInterrupt:
                print("\n(interrupted; panic)")
                self.out.all_off()
                continue
            if not sys.stdin.isatty():
                print(line)
            try:
                if not self.dispatch(line):
                    break
            except KeyboardInterrupt:
                print("\n(interrupted; panic)")
                self.out.all_off()


def print_ports(out_sel, in_sel):
    outs, ins = list_out(), list_in()
    print("MIDI outputs:")
    for i, n in enumerate(outs):
        print("  %s [%d] %s" % ("*" if i == out_sel else " ", i, n))
    if not outs:
        print("  (none)")
    print("MIDI inputs:")
    for i, n in enumerate(ins):
        print("  %s [%d] %s" % ("*" if i == in_sel else " ", i, n))
    if not ins:
        print("  (none)")
    print("(* = selected)")


def selftest(out_idx, name, fxch):
    ok = True

    def step(label, fn):
        nonlocal ok
        try:
            fn()
            print("PASS  %s" % label)
        except Exception as e:
            ok = False
            print("FAIL  %s: %s" % (label, e))

    out = None
    try:
        out = MidiOut(out_idx, name)
        print("PASS  open output '%s'" % name)
    except PortBusy as e:
        print("FAIL  open output: " + str(e))
        return False
    except Exception as e:
        print("FAIL  open output: %s" % e)
        return False
    try:
        def arp():
            for n in (60, 64, 67, 72):
                out.send([0x90, n, 55])
                time.sleep(0.18)
                out.send([0x80, n, 0])
                time.sleep(0.03)

        step("C-major arpeggio (ch1, vel 55)", arp)
        step("program change 1", lambda: out.send([0xC0, 0]))

        def rev():
            out.send([0xB0 | (fxch - 1), 4, 127])
            time.sleep(0.15)
            out.send([0x90, 60, 55])
            time.sleep(0.4)
            out.send([0x80, 60, 0])
            out.send([0xB0 | (fxch - 1), 4, 0])
            time.sleep(0.1)

        step("reverb on / off (ch%d CC4)" % fxch, rev)
        step("SysEx param write (alg param 134)", lambda: out.send([0xF0, 0x43, 0x10, 1, 6, 0, 0xF7]))
    finally:
        try:
            out.close()
            print("PASS  close output")
        except Exception as e:
            ok = False
            print("FAIL  close output: %s" % e)
    print("SELFTEST " + ("PASS" if ok else "FAIL"))
    return ok


def main():
    for s in (sys.stdout, sys.stderr):
        try:
            s.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
    ap = argparse.ArgumentParser(description="FM-1 MIDI test tool")
    ap.add_argument("--out", type=int, help="output port index")
    ap.add_argument("--in", dest="inp", type=int, help="input port index")
    ap.add_argument("--fxch", type=int, default=2, help="FX channel 1-16 (default 2)")
    ap.add_argument("--list", action="store_true", help="list ports and exit")
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("--monitor", type=float, metavar="SECONDS")
    args = ap.parse_args()

    outs, ins = list_out(), list_in()
    out_idx = args.out if args.out is not None else find_fm1(outs)
    in_idx = args.inp if args.inp is not None else find_fm1(ins)
    if args.list:
        print_ports(out_idx, in_idx)
        return 0

    winmm.timeBeginPeriod(1)
    try:
        if args.selftest:
            if out_idx is None or out_idx >= len(outs):
                print("FAIL  no FM-1 output port found (use --out N; see --list)")
                return 1
            return 0 if selftest(out_idx, outs[out_idx], args.fxch) else 1
        in_name = ins[in_idx] if in_idx is not None and in_idx < len(ins) else ""
        if args.monitor is not None:
            do_monitor(in_idx, in_name, args.monitor, False, args.fxch)
            return 0
        if out_idx is None or out_idx >= len(outs):
            print("No FM-1 output port found (use --out N; see --list).")
            return 1
        try:
            out = MidiOut(out_idx, outs[out_idx])
        except PortBusy as e:
            print(str(e))
            return 1
        tool = Tool(out, in_idx, in_name, args.fxch)
        tool.out_sel, tool.in_sel = out_idx, in_idx
        try:
            tool.repl()
        finally:
            out.close()
    finally:
        winmm.timeEndPeriod(1)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
