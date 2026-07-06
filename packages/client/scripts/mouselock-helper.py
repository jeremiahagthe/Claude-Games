#!/usr/bin/env python3
"""fragwait mouselock helper (macOS only).

A tiny, dependency-free background process that gives a terminal FPS true
Counter-Strike-style mouse look: it hides the OS pointer system-wide and pins
it in place with silent warps (which generate NO terminal mouse event), while
the terminal's own mouse-motion deltas drive the view.

Line-based stdin protocol (one command per line):
  hide    apply the SetsCursorInBackground property (once) and hide the cursor
  show    show the cursor
  setpin  read the current global pointer position and store it as the pin
  warp    silently warp the pointer back to the stored pin (no-op if unset)
  <other> ignored

Prints nothing except the single readiness notification below. Exits on stdin
EOF, any exception, or SIGTERM — ALWAYS calling CGDisplayShowCursor on the way
out. This is belt-and-suspenders: the OS also restores the cursor automatically
when this process's WindowServer connection closes (the hide is per-connection),
so a crash can never leave the pointer hidden.
"""

import ctypes
import signal
import sys

CG_PATH = "/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics"
CF_PATH = "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation"

cg = ctypes.cdll.LoadLibrary(CG_PATH)
cf = ctypes.cdll.LoadLibrary(CF_PATH)


class CGPoint(ctypes.Structure):
    _fields_ = [("x", ctypes.c_double), ("y", ctypes.c_double)]


# --- CoreGraphics bindings (restype/argtypes set for every function) --------
cg.CGEventCreate.restype = ctypes.c_void_p
cg.CGEventCreate.argtypes = [ctypes.c_void_p]

cg.CGEventGetLocation.restype = CGPoint
cg.CGEventGetLocation.argtypes = [ctypes.c_void_p]

cg.CGWarpMouseCursorPosition.restype = ctypes.c_int
cg.CGWarpMouseCursorPosition.argtypes = [CGPoint]

cg.CGDisplayHideCursor.restype = ctypes.c_int
cg.CGDisplayHideCursor.argtypes = [ctypes.c_uint32]

cg.CGDisplayShowCursor.restype = ctypes.c_int
cg.CGDisplayShowCursor.argtypes = [ctypes.c_uint32]

# Private but stable: the main WindowServer connection id, and the per-connection
# property that lets a background process affect the cursor.
cg.CGSMainConnectionID.restype = ctypes.c_int
cg.CGSMainConnectionID.argtypes = []

cg.CGSSetConnectionProperty.restype = ctypes.c_int
cg.CGSSetConnectionProperty.argtypes = [
    ctypes.c_int, ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p,
]

# --- CoreFoundation bindings ------------------------------------------------
cf.CFStringCreateWithCString.restype = ctypes.c_void_p
cf.CFStringCreateWithCString.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_uint32]

# kCFBooleanTrue is a data symbol, resolved by address.
kCFBooleanTrue = ctypes.c_void_p.in_dll(cf, "kCFBooleanTrue")

kCFStringEncodingUTF8 = 0x08000100

_main_cid = cg.CGSMainConnectionID()
_prop_key = cf.CFStringCreateWithCString(None, b"SetsCursorInBackground", kCFStringEncodingUTF8)

_hidden = False        # balance hide/show so we never double-hide
_bg_prop_set = False   # apply SetsCursorInBackground at most once
_pin = None            # stored CGPoint, or None until first setpin


def _global_pointer():
    event = cg.CGEventCreate(None)
    return cg.CGEventGetLocation(event)


def do_hide():
    global _hidden, _bg_prop_set
    if not _bg_prop_set:
        cg.CGSSetConnectionProperty(_main_cid, _main_cid, _prop_key, kCFBooleanTrue)
        _bg_prop_set = True
    if not _hidden:
        cg.CGDisplayHideCursor(0)
        _hidden = True


def do_show():
    global _hidden
    if _hidden:
        cg.CGDisplayShowCursor(0)
        _hidden = False


def do_setpin():
    global _pin
    _pin = _global_pointer()


def do_warp():
    if _pin is not None:
        cg.CGWarpMouseCursorPosition(_pin)


def restore():
    # Force the cursor visible regardless of tracked state on the way out.
    cg.CGDisplayShowCursor(0)


def _on_sigterm(signum, frame):
    restore()
    sys.exit(0)


def main():
    signal.signal(signal.SIGTERM, _on_sigterm)
    try:
        for line in sys.stdin:
            cmd = line.strip()
            if cmd == "hide":
                do_hide()
            elif cmd == "show":
                do_show()
            elif cmd == "setpin":
                do_setpin()
            elif cmd == "warp":
                do_warp()
            # unknown lines: ignore
    finally:
        restore()


if __name__ == "__main__":
    main()
