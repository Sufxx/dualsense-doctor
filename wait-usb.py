#!/usr/bin/env python3
"""Poll until a DualSense appears over USB (hidapi bus_type==USB), then exit 0.
Exits 1 on timeout. Used to trigger AI-driven diagnose+fix when the user plugs in."""
import ctypes, time, sys

LIB = "/opt/homebrew/lib/libhidapi.dylib"
VID = 0x054C
USB_BUS = 1  # hidapi: 0 unknown, 1 usb, 2 bluetooth

class DI(ctypes.Structure): pass
DI._fields_ = [("path", ctypes.c_char_p), ("vendor_id", ctypes.c_ushort),
    ("product_id", ctypes.c_ushort), ("serial_number", ctypes.c_wchar_p),
    ("release_number", ctypes.c_ushort), ("manufacturer_string", ctypes.c_wchar_p),
    ("product_string", ctypes.c_wchar_p), ("usage_page", ctypes.c_ushort),
    ("usage", ctypes.c_ushort), ("interface_number", ctypes.c_int),
    ("next", ctypes.POINTER(DI)), ("bus_type", ctypes.c_int)]

h = ctypes.CDLL(LIB)
h.hid_enumerate.restype = ctypes.POINTER(DI)
h.hid_enumerate.argtypes = [ctypes.c_ushort, ctypes.c_ushort]
h.hid_free_enumeration.argtypes = [ctypes.POINTER(DI)]
h.hid_init()

def found_usb():
    p = h.hid_enumerate(VID, 0)
    cur, hit = p, False
    while cur:
        d = cur.contents
        if d.bus_type == USB_BUS:
            hit = True
        cur = d.next
    if p:
        h.hid_free_enumeration(p)
    return hit

timeout = float(sys.argv[1]) if len(sys.argv) > 1 else 900
t0 = time.time()
while time.time() - t0 < timeout:
    if found_usb():
        print("USB_DUALSENSE_CONNECTED")
        sys.exit(0)
    time.sleep(2)
print("timeout: no USB DualSense detected")
sys.exit(1)
