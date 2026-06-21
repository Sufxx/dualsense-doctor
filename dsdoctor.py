#!/usr/bin/env python3
"""
DualSense Doctor — AI-driven CLI that diagnoses PS5 stick drift and fixes it
by rewriting the stick center/range into the controller's NVS (USB only).

Talks to the controller directly via libhidapi (ctypes) — no pip build needed.
Calibration protocol verified against dualshock-tools (MIT).

Usage:
  python3 dsdoctor.py                 # diagnose (USB or Bluetooth)
  python3 dsdoctor.py --fix           # diagnose, then recalibrate (USB only)
  python3 dsdoctor.py --fix --center-only
  python3 dsdoctor.py --seconds 4     # longer rest sample
"""
import ctypes, ctypes.util, sys, time, math, argparse, statistics

VID = 0x054C
DUALSENSE = 0x0CE6
DUALSENSE_EDGE = 0x0DF2

LIB = "/opt/homebrew/lib/libhidapi.dylib"

# ---- thresholds (raw 0..255, center 128), matching the GUI ----
OFF_GOOD, OFF_BAD = 6, 19      # center offset magnitude
JIT_GOOD, JIT_BAD = 1.3, 2.5   # jitter (stddev)

C = dict(r="\033[31m", g="\033[32m", y="\033[33m", b="\033[34m", c="\033[36m",
         gray="\033[90m", bold="\033[1m", dim="\033[2m", x="\033[0m")
def col(s, k): return f"{C[k]}{s}{C['x']}"


# ---------------- libhidapi ctypes binding ----------------
class HID:
    def __init__(self):
        self.h = ctypes.CDLL(LIB)
        self.h.hid_open.restype = ctypes.c_void_p
        self.h.hid_open.argtypes = [ctypes.c_ushort, ctypes.c_ushort, ctypes.c_wchar_p]
        self.h.hid_read_timeout.restype = ctypes.c_int
        self.h.hid_read_timeout.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_size_t, ctypes.c_int]
        self.h.hid_get_feature_report.restype = ctypes.c_int
        self.h.hid_get_feature_report.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_size_t]
        self.h.hid_send_feature_report.restype = ctypes.c_int
        self.h.hid_send_feature_report.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_size_t]
        self.h.hid_error.restype = ctypes.c_wchar_p
        self.h.hid_error.argtypes = [ctypes.c_void_p]
        self.h.hid_close.argtypes = [ctypes.c_void_p]
        self.h.hid_init()
        self.dev = None
        self.pid = None

    def open(self):
        for pid in (DUALSENSE, DUALSENSE_EDGE):
            d = self.h.hid_open(VID, pid, None)
            if d:
                self.dev = d
                self.pid = pid
                return pid
        return None

    def read(self, n=78, ms=500):
        buf = ctypes.create_string_buffer(n)
        got = self.h.hid_read_timeout(self.dev, buf, n, ms)
        if got <= 0:
            return None
        return bytes(buf.raw[:got])

    def get_feature(self, report_id, n=64):
        buf = ctypes.create_string_buffer(n)
        buf[0] = report_id
        got = self.h.hid_get_feature_report(self.dev, buf, n)
        if got <= 0:
            raise IOError(f"get_feature 0x{report_id:02x} failed: {self.h.hid_error(self.dev)}")
        return bytes(buf.raw[:got])

    def send_feature(self, data):
        arr = bytes(data)
        got = self.h.hid_send_feature_report(self.dev, arr, len(arr))
        if got < 0:
            raise IOError(f"send_feature {data[0]:#x} failed: {self.h.hid_error(self.dev)}")
        return got

    def close(self):
        if self.dev:
            self.h.hid_close(self.dev)
            self.dev = None


# ---------------- input parsing ----------------
def parse_sticks(rep):
    """Return (lx, ly, rx, ry, mode) or None. rep includes report id at [0]."""
    if not rep:
        return None
    rid = rep[0]
    if rid == 0x31 and len(rep) >= 6:            # BT full
        return rep[2], rep[3], rep[4], rep[5], "bt"
    if rid == 0x01 and len(rep) >= 5:            # USB full or BT compat
        mode = "usb" if len(rep) >= 40 else "bt-compat"
        return rep[1], rep[2], rep[3], rep[4], mode
    return None


def sample(hid, seconds):
    lx, ly, rx, ry = [], [], [], []
    mode = None
    t0 = time.time()
    misses = 0
    while time.time() - t0 < seconds:
        rep = hid.read()
        s = parse_sticks(rep)
        if not s:
            misses += 1
            if misses > 200:
                break
            continue
        lx.append(s[0]); ly.append(s[1]); rx.append(s[2]); ry.append(s[3]); mode = s[4]
    return dict(lx=lx, ly=ly, rx=rx, ry=ry, mode=mode, n=len(lx))


# ---------------- diagnosis ----------------
def axis_stats(vals):
    if not vals:
        return dict(mean=128, std=0, mn=128, mx=128)
    return dict(mean=statistics.fmean(vals),
                std=statistics.pstdev(vals) if len(vals) > 1 else 0,
                mn=min(vals), mx=max(vals))


def stick_diag(xs, ys):
    sx, sy = axis_stats(xs), axis_stats(ys)
    off_x, off_y = sx["mean"] - 128, sy["mean"] - 128
    mag = math.hypot(off_x, off_y)
    jit = max(sx["std"], sy["std"])
    rest_mag = (mag + 2.5 * jit) / 127
    dz = min(0.30, max(0.05, round(rest_mag * 1.8, 2)))
    ang = (math.degrees(math.atan2(off_y, off_x)) + 360) % 360
    direction = ["right", "down-right", "down", "down-left", "left", "up-left", "up", "up-right"][int(((ang + 22.5) % 360) / 45)]
    return dict(off_x=off_x, off_y=off_y, mag=mag, jit=jit, dz=dz, direction=direction,
                xrange=(sx["mn"], sx["mx"]), yrange=(sy["mn"], sy["mx"]))


def rate(mag, jit):
    pen = 0
    pen += max(0, (mag - 2) * 3)
    pen += max(0, (jit - 1) * 4)
    score = max(0, round(100 - min(pen, 100)))
    return score


def verdict(mag, jit):
    if mag < OFF_GOOD and jit < JIT_GOOD: return ("HEALTHY — no drift", "g")
    if mag < OFF_BAD and jit < JIT_BAD:   return ("MILD drift / wear", "y")
    if mag < OFF_BAD:                      return ("NOISY (jitter) drift", "y")
    return ("SEVERE drift", "r")


def tag(mag, jit):
    v, k = verdict(mag, jit)
    return col(v, k)


def print_diag(data, seconds):
    mode = data["mode"]
    print()
    print(col("  DualSense Doctor — AI diagnosis", "bold"))
    print(col(f"  link: {mode}   samples: {data['n']} over {seconds}s", "gray"))
    print(col("  " + "-" * 56, "gray"))
    worst = 0
    for name, xs, ys in (("LEFT", data["lx"], data["ly"]), ("RIGHT", data["rx"], data["ry"])):
        d = stick_diag(xs, ys)
        sc = rate(d["mag"], d["jit"])
        worst = max(worst, 100 - sc)
        print(f"  {col(name + ' STICK', 'bold')}   {tag(d['mag'], d['jit'])}   score {col(str(sc), 'c')}/100")
        print(f"    center offset : {col(f'{d['mag']:.1f}', 'b')}/255  toward {col(d['direction'], 'b')}  (x{d['off_x']:+.1f}, y{d['off_y']:+.1f})")
        print(f"    jitter (sigma): {d['jit']:.2f}    range x{d['xrange']}  y{d['yrange']}")
        print(f"    {col('→ recommend deadzone ' + str(round(d['dz']*100)) + '%', 'y')}")
        print()
        data[name] = d
    overall = 100 - worst
    print(col("  " + "-" * 56, "gray"))
    head = "g" if overall >= 90 else "y" if overall >= 55 else "r"
    print(f"  {col('OVERALL', 'bold')}  {col(str(overall) + '/100', head)}")
    return data


def ai_recommendation(data):
    L, R = data.get("LEFT"), data.get("RIGHT")
    bad = [n for n, d in (("left", L), ("right", R)) if d and (d["mag"] >= OFF_BAD or d["jit"] >= JIT_BAD)]
    mild = [n for n, d in (("left", L), ("right", R)) if d and OFF_GOOD <= d["mag"] < OFF_BAD]
    print()
    print(col("  AI recommendation", "bold"))
    if not bad and not mild:
        print(col("  Both sticks rest dead-on center with a clean signal. No drift — nothing to fix.", "g"))
        return False
    if bad:
        print(col(f"  The {', '.join(bad)} stick(s) show real drift (off-center resting / noise).", "r"))
    if mild:
        print(col(f"  The {', '.join(mild)} stick(s) show mild wear.", "y"))
    if data["mode"] == "usb":
        print(col("  → I can recalibrate the center into the controller's memory now (USB connected).", "c"))
        print(col("    Re-run with:  python3 dsdoctor.py --fix", "c"))
    else:
        print(col("  → The permanent fix (NVS recalibration) needs USB. Plug the controller in with a", "c"))
        print(col("    USB-C DATA cable, then run:  python3 dsdoctor.py --fix", "c"))
        print(col("  → Interim (works now): apply the recommended deadzone above in Steam / per game.", "gray"))
    return True


# ---------------- deep active monitor (catches intermittent / return-to-center drift) ----------------
FINETUNE_LABELS = ['LL', 'LT', 'RL', 'RT', 'LR', 'LB', 'RR', 'RB', 'LX', 'LY', 'RX', 'RY']

def read_finetune(hid):
    """Read the 12 stored in-memory calibration values (centers + edges)."""
    try:
        hid.send_feature([0x80, 12, 2]); time.sleep(0.1)
        d = hid.get_feature(0x81, 64)
        if d[0] != 0x81 or d[1] != 12:
            return None
        return {FINETUNE_LABELS[i]: (d[4 + i * 2] | (d[5 + i * 2] << 8)) for i in range(12)}
    except Exception:
        return None


def monitor(hid, seconds):
    """Sample continuously while the user exercises the sticks; find drift episodes
    and post-release settle error (the stick failing to return to center)."""
    frames = []
    t0 = time.time()
    while time.time() - t0 < seconds:
        s = parse_sticks(hid.read())
        if s:
            frames.append((time.time() - t0, s[0], s[1], s[2], s[3]))
    if not frames:
        return None

    STABLE_FRAMES = 45      # ~0.18s of low-velocity frames => genuinely parked
    def analyze(name, ix, iy):
        rest_offs, settles, drift_frames = [], [], 0
        moving = False
        peak = 0
        max_up = 0
        up_events = 0
        # clean "parked at rest" detection (excludes snapback transients)
        prev = None
        low_run = 0
        stable_offs, stable_up = [], 0
        stable_max_up = 0
        for k, (t, *vals) in enumerate(frames):
            x, y = vals[ix] - 128, vals[iy] - 128
            mag = math.hypot(x, y)
            vel = 999 if prev is None else max(abs(x - prev[0]), abs(y - prev[1]))
            prev = (x, y)
            low_run = low_run + 1 if vel <= 3 else 0
            if low_run >= STABLE_FRAMES and mag < 30:   # parked & near rest = true rest
                stable_offs.append(mag)
                if -y > OFF_GOOD:
                    stable_up += 1
                stable_max_up = max(stable_max_up, -y)
            if mag >= 60:
                moving = True; peak = max(peak, mag)
            elif mag < 25:
                if moving and peak >= 60:
                    settles.append((mag, x, y)); moving = False; peak = 0
                rest_offs.append(mag)
                if -y > max_up: max_up = -y
                if -y > OFF_GOOD: up_events += 1
                if mag > OFF_BAD: drift_frames += 1
        settle_mags = [s[0] for s in settles]
        worst_settle = max(settles, key=lambda s: s[0]) if settles else (0, 0, 0)
        return dict(
            max_rest=max(rest_offs) if rest_offs else 0,
            p95_rest=sorted(rest_offs)[int(len(rest_offs) * 0.95)] if rest_offs else 0,
            rest_n=len(rest_offs),
            drift_frames=drift_frames,
            max_settle=max(settle_mags) if settle_mags else 0,
            mean_settle=statistics.fmean(settle_mags) if settle_mags else 0,
            releases=len(settles),
            max_up=max_up,
            up_events=up_events,
            worst_settle_vec=(worst_settle[1], worst_settle[2]),
            # the clean drift signal:
            stable_n=len(stable_offs),
            stable_max=max(stable_offs) if stable_offs else 0,
            stable_mean=statistics.fmean(stable_offs) if stable_offs else 0,
            stable_up=stable_up,
            stable_max_up=stable_max_up,
        )

    return dict(left=analyze("LEFT", 0, 1), right=analyze("RIGHT", 2, 3), n=len(frames),
                dur=frames[-1][0])


def print_monitor(hid, m):
    print()
    print(col("  Deep active monitor", "bold"))
    print(col(f"  {m['n']} samples over {m['dur']:.1f}s", "gray"))
    print(col("  " + "-" * 56, "gray"))
    ft = read_finetune(hid)
    drift_found = False
    for name, d in (("LEFT", m["left"]), ("RIGHT", m["right"])):
        # CLEAN drift verdict from parked-rest samples only (snapback excluded)
        sk = "g" if d["stable_max"] < OFF_GOOD else "y" if d["stable_max"] < OFF_BAD else "r"
        if d["stable_max"] >= OFF_BAD or d["stable_up"] > 3:
            drift_found = True
        print(f"  {col(name + ' STICK', 'bold')}")
        print(f"    {col('TRUE-REST drift (clean)', 'bold')}: max {col(f'{d['stable_max']:.1f}/255', sk)}, "
              f"mean {d['stable_mean']:.1f}, up-max {col(f'{d['stable_max_up']:.1f}', sk)}, "
              f"up-episodes {col(str(d['stable_up']), sk)}  [{d['stable_n']} parked samples]")
        print(col(f"    (raw incl. snapback: p95 {d['p95_rest']:.1f}, {d['releases']} releases — not a drift measure)", "gray"))
        print()
    if ft:
        print(col("  stored calibration centers (LX,LY,RX,RY): "
                  f"{ft['LX']},{ft['LY']} / {ft['RX']},{ft['RY']}", "gray"))
    return drift_found


# ---------------- the fix: NVS recalibration (USB only) ----------------
def expect(hid, report_id, data, want, label):
    hid.send_feature(data)
    time.sleep(0.05)
    resp = hid.get_feature(0x83, 64)
    got = (resp[0] << 24) | (resp[1] << 16) | (resp[2] << 8) | resp[3]
    if got != want:
        raise RuntimeError(f"{label} rejected (got {got:#010x}, want {want:#010x}). Nothing saved — safe to retry.")


def firmware_check(hid):
    try:
        v = hid.get_feature(0x20, 64)
        build = bytes(v[1:12]).split(b"\x00")[0].decode(errors="ignore").strip()
        old = ("2020" in build) or ("2021" in build)
        return build, old
    except Exception:
        return None, False


def nvs_status(hid):
    hid.send_feature([0x80, 3, 3]); time.sleep(0.05)
    d = hid.get_feature(0x81, 64)
    ret = (d[1] << 24) | (d[2] << 16) | (d[3] << 8) | d[4]
    return {0x03030200: "unlocked(permanent)", 0x03030201: "locked(temporary)",
            0x15010100: "pending_reboot"}.get(ret, f"unknown({ret:#x})")


def wait_for_rest(hid, need_stable=1.5, timeout=25, rest_tol=25, vel_tol=3):
    """Block until BOTH sticks are untouched (near rest zone) and not moving for
    `need_stable` seconds. This guarantees center sampling captures a true resting
    position and never calibrates to a touched/off position. Returns True/False."""
    last, stable_since, t0 = None, None, time.time()
    while time.time() - t0 < timeout:
        s = parse_sticks(hid.read())
        if not s:
            continue
        lx, ly, rx, ry = s[0], s[1], s[2], s[3]
        near = math.hypot(lx - 128, ly - 128) < rest_tol and math.hypot(rx - 128, ry - 128) < rest_tol
        vel = 999 if last is None else max(abs(lx - last[0]), abs(ly - last[1]), abs(rx - last[2]), abs(ry - last[3]))
        last = (lx, ly, rx, ry)
        if near and vel <= vel_tol:
            stable_since = stable_since or time.time()
            if time.time() - stable_since >= need_stable:
                return True
        else:
            stable_since = None
    return False


def run_fix(hid, center_only=False):
    if hid.pid == DUALSENSE_EDGE:
        print(col("  ⚠ DualSense Edge: calibration applies but won't persist without the hardware write-protect mod.", "y"))
    build, old = firmware_check(hid)
    if build:
        print(col(f"  firmware build: {build}", "gray"))
    if old:
        print(col("  ⚠ Old firmware (2020/2021) may block calibration. Update via PS5 / Sony updater if it fails.", "y"))

    print(col("\n  Recalibrating CENTER — waiting for both sticks to be untouched & still…", "bold"))
    if not wait_for_rest(hid):
        raise RuntimeError("Sticks never settled (still being touched?). Aborted — nothing was written.")
    print(col("    ✓ sticks at rest — sampling true center now (keep hands off)", "g"))
    expect(hid, 0x82, [0x82, 1, 1, 1], 0x83010101, "center begin")
    for i in range(6):
        expect(hid, 0x82, [0x82, 3, 1, 1], 0x83010101, "center sample")
        time.sleep(0.45)
    expect(hid, 0x82, [0x82, 2, 1, 1], 0x83010102, "center end")
    print(col("    ✓ center captured", "g"))

    if not center_only:
        print(col("\n  Recalibrating RANGE — slowly roll BOTH sticks fully around the edge, 3-4 times.", "bold"))
        expect(hid, 0x82, [0x82, 1, 1, 2], 0x83010201, "range begin")
        t0 = time.time()
        while time.time() - t0 < 9:
            left = 9 - int(time.time() - t0)
            print(f"    keep rotating… {left}s ", end="\r"); time.sleep(0.3)
        expect(hid, 0x82, [0x82, 2, 1, 2], 0x83010202, "range end")
        print(col("    ✓ range captured                 ", "g"))

    print(col("\n  Saving to controller memory — do NOT unplug…", "bold"))
    hid.send_feature([0x80, 3, 2, 101, 50, 64, 12]); time.sleep(0.1)
    if not hid.get_feature(0x81, 64):                                    # NVS unlock — must answer
        raise RuntimeError("NVS unlock got no response — aborted, nothing committed.")
    time.sleep(0.15)
    hid.send_feature([0x80, 3, 1]); time.sleep(0.1); hid.get_feature(0x81, 64)                    # NVS lock
    time.sleep(0.2)
    st = nvs_status(hid)
    if st.startswith("unknown"):                                        # don't claim a save we can't confirm
        raise RuntimeError(f"NVS save left an unexpected state ({st}). Re-run calibration to be safe.")
    print(col(f"  ✓ Saved. NVS status: {st}", "g"))
    print(col("  Done. Re-run a diagnosis to confirm the drift is gone:", "c"))
    print(col("    python3 dsdoctor.py", "c"))


# ---------------- main ----------------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fix", action="store_true", help="apply NVS recalibration (USB only)")
    ap.add_argument("--center-only", action="store_true", help="skip range step during fix")
    ap.add_argument("--seconds", type=float, default=3.0, help="rest-sample duration")
    ap.add_argument("--monitor", type=float, default=0, help="active drift monitor for N seconds")
    args = ap.parse_args()

    hid = HID()
    if not hid.open():
        print(col("No DualSense found. Connect it (USB or Bluetooth) and try again.", "r"))
        return 1
    print(col(f"Opened DualSense (PID {hid.pid:#06x})", "gray"))

    if args.monitor:
        m = monitor(hid, args.monitor)
        if not m:
            print(col("No input received during monitor.", "r"))
            return 2
        print_monitor(hid, m)
        hid.close()
        return 0

    data = sample(hid, args.seconds)
    if data["n"] == 0:
        print(col("Connected, but no input reports were received.", "r"))
        print(col("On macOS this usually means Input Monitoring permission is needed, or the", "gray"))
        print(col("controller is asleep — press the PS button, or grant Terminal Input Monitoring.", "gray"))
        # feature reports may still work (e.g. for --fix over USB)
        if not args.fix:
            return 2
    else:
        data = print_diag(data, args.seconds)
        ai_recommendation(data)

    if args.fix:
        if data.get("mode") not in ("usb", None):
            print(col("\n  ✗ --fix needs USB. Your controller is on Bluetooth — plug in a USB-C data cable.", "r"))
            return 3
        try:
            run_fix(hid, center_only=args.center_only)
        except Exception as e:
            print(col(f"\n  ✗ {e}", "r"))
            return 4
    hid.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
