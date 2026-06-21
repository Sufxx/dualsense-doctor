#!/usr/bin/env python3
"""
DualSense adaptive-trigger controller (USB, macOS via libhidapi/ctypes).

Sends HID OUTPUT report 0x02 with adaptive-trigger effects so L2/R2 push back
against your finger and present a firm "wall" early in the pull (a hair-trigger
feel). Effect recipes use the community-standard trigger generator encodings
(Feedback mode 0x21, Weapon mode 0x25).

IMPORTANT: trigger effects are EPHEMERAL output state — they persist on the
controller until something else sends an output report or it power-cycles. On a
PS5 the game overrides them, so this is a PC/Mac feel-demo, not a PS5 fix.

Usage:
  python3 triggers.py firm          # apply 'firm' wall to both triggers
  python3 triggers.py light|firm|max
  python3 triggers.py weapon        # clicky resist-then-break
  python3 triggers.py off           # clear effects
  python3 triggers.py firm --daemon # re-assert every 2s (keeps it on while no game touches it)
"""
import ctypes, sys, time, math

LIB = "/opt/homebrew/lib/libhidapi.dylib"
VID = 0x054C
PIDS = (0x0CE6, 0x0DF2)

C = dict(g="\033[32m", y="\033[33m", r="\033[31m", c="\033[36m", gray="\033[90m", b="\033[1m", x="\033[0m")
def col(s, k): return f"{C[k]}{s}{C['x']}"


class HID:
    def __init__(self):
        self.h = ctypes.CDLL(LIB)
        self.h.hid_open.restype = ctypes.c_void_p
        self.h.hid_open.argtypes = [ctypes.c_ushort, ctypes.c_ushort, ctypes.c_wchar_p]
        self.h.hid_write.restype = ctypes.c_int
        self.h.hid_write.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_size_t]
        self.h.hid_error.restype = ctypes.c_wchar_p
        self.h.hid_error.argtypes = [ctypes.c_void_p]
        self.h.hid_close.argtypes = [ctypes.c_void_p]
        self.h.hid_init()
        self.dev = None
        self.pid = None

    def open(self):
        for pid in PIDS:
            d = self.h.hid_open(VID, pid, None)
            if d:
                self.dev, self.pid = d, pid
                return pid
        return None

    def write(self, data):
        buf = bytes(data)
        n = self.h.hid_write(self.dev, buf, len(buf))
        if n < 0:
            raise IOError(f"hid_write failed: {self.h.hid_error(self.dev)}")
        return n

    def close(self):
        if self.dev:
            self.h.hid_close(self.dev)


# ---------------- trigger effect recipes (10-byte block: mode + 9 params) ----------------
def eff_off():
    return [0x05, 0, 0, 0, 0, 0, 0, 0, 0, 0]


def eff_feedback(position, strength):
    """Uniform resistance from `position`(0-9) to the end, intensity `strength`(1-8).
    Placing position early (1-3) gives a firm wall quickly = hair-trigger feel."""
    if strength <= 0:
        return eff_off()
    position = max(0, min(9, position))
    strength = max(1, min(8, strength))
    force = (strength - 1) & 0x07
    force_zones = 0
    active = 0
    for i in range(position, 10):
        force_zones |= force << (3 * i)
        active |= 1 << i
    return [0x21,
            active & 0xff, (active >> 8) & 0xff,
            force_zones & 0xff, (force_zones >> 8) & 0xff,
            (force_zones >> 16) & 0xff, (force_zones >> 24) & 0xff,
            0, 0, 0]


def eff_weapon(start, end, strength):
    """Resist from `start`(2-7) and 'break' at `end`(>start..8) with `strength`(1-8) —
    a gun-trigger click."""
    start = max(2, min(7, start))
    end = max(start + 1, min(8, end))
    strength = max(1, min(8, strength))
    zones = (1 << start) | (1 << end)
    return [0x25, zones & 0xff, (zones >> 8) & 0xff, (strength - 1) & 0xff, 0, 0, 0, 0, 0, 0]


PRESETS = {
    "off": eff_off(),
    "light": eff_feedback(3, 4),
    "firm": eff_feedback(2, 6),
    "max": eff_feedback(1, 8),
    "weapon": eff_weapon(3, 5, 8),
}


def build_report(r_eff, l_eff, flag0=0x0C, flag1=0x00):
    """USB output report 0x02. flag0 bit2(0x04)=R2 trigger, bit3(0x08)=L2 trigger.
    R2 effect at bytes 11-20, L2 at 22-31 (report id at byte 0)."""
    buf = [0] * 48
    buf[0] = 0x02
    buf[1] = flag0
    buf[2] = flag1
    buf[11:11 + len(r_eff)] = r_eff
    buf[22:22 + len(l_eff)] = l_eff
    return buf


def apply(hid, eff, flag0=0x0C):
    hid.write(build_report(eff, eff, flag0=flag0))


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    daemon = "--daemon" in sys.argv
    strong = "--strongflag" in sys.argv  # fallback flag combo if 0x0C doesn't engage
    preset = (args[0] if args else "firm").lower()
    if preset not in PRESETS:
        print(col(f"unknown preset '{preset}'. choose: {', '.join(PRESETS)}", "r"))
        return 1

    hid = HID()
    if not hid.open():
        print(col("No DualSense over USB. Plug in a USB-C DATA cable (BT can't be reached on macOS).", "r"))
        return 1
    print(col(f"Opened DualSense (PID {hid.pid:#06x})", "gray"))

    eff = PRESETS[preset]
    flag0 = 0xFF if strong else 0x0C
    apply(hid, eff, flag0=flag0)
    print(col(f"Applied '{preset}' to L2 + R2.", "g"), col(f"effect bytes: {['0x%02x'%b for b in eff]}", "gray"))
    if preset == "off":
        print(col("Triggers cleared.", "c"))

    if daemon:
        print(col("Daemon: re-asserting every 2s. Ctrl-C to stop (triggers keep last effect after).", "c"))
        try:
            while True:
                time.sleep(2)
                apply(hid, eff, flag0=flag0)
        except KeyboardInterrupt:
            print(col("\nstopped (effect remains until a game or 'off' changes it).", "gray"))
    hid.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
