# DualSense Doctor

Diagnose and **actually fix** PS5 DualSense stick drift, tune the adaptive triggers, and control the light bar — all locally, in your browser or from the command line. Plus an **MCP server** so your Claude Code session can read and control the controller directly.

No installs to try it, no account, no telemetry. Your controller data never leaves your machine — **zero network calls.**

```bash
./serve.sh          # serves DualSense Studio on http://localhost:8777 and opens Chrome
```

Requires **Chrome / Edge / Opera** for the web apps (WebHID). Works over USB *or* Bluetooth.

---

## What's in here

| Part | What it does | How |
|------|--------------|-----|
| **Studio** (`studio.html`) | Triggers + lightbar + live sticks + drift recalibration, one page | WebHID (USB/BT) |
| **Diagnostic** (`index.html`) | Deep drift diagnostic: rest / range / snapback tests, drift score, deadzone export, full recalibration | WebHID (USB/BT) |
| **CLI** (`dsdoctor.py`, `triggers.py`) | AI-driven diagnose + recalibrate + trigger control from the terminal | Python + libhidapi |
| **MCP server** (`mcp/`) | Lets a **Claude Code** session read/control your controller | node-hid + MCP SDK |

---

## Why DualSense sticks drift

Each stick uses two **ALPS Alpine carbon-film potentiometers** — a metal wiper scrubbing a printed carbon track. After ~2 million cycles the wiper wears the track, the resting voltage no longer lands at electrical center, and the firmware reports phantom input even when you're not touching the stick. That's drift. It's **mechanical wear, not a software bug** — and jitter is worst near center because the electrical tap is most sensitive there.

## What "fix" is actually possible (honest)

1. **On-controller recalibration** *(USB only — the real fix).* Rewrites the stick **center + range** into the controller's NVS flash, exactly like the PS5 does at the factory. Persists across reboots and travels back to the PS5. Fixes *electrical / center* drift at the root.
2. **Software deadzone profile** *(any connection).* Computes the smallest deadzone that hides the measured drift; paste it into Steam / per-game. A mask, not a cure — and on macOS it can't apply system-wide on its own.
3. **Hardware.** If the carbon track is physically worn, no calibration restores it. Contact cleaner under the cap buys time; the permanent cure is a contactless **Hall-effect / TMR replacement module** (e.g. Gulikit), which can't drift.

Metric thresholds (raw 0–255, center 128): center offset **PASS < 6 / FAIL > 19**; jitter (σ) **PASS < 1.3 / FAIL > 2.5**.

## Adaptive triggers

The Studio's Triggers tab (and `triggers.py`) drives the L2/R2 motors to create a firm **resistance wall early in the pull** — a "hair-trigger" feel that pushes back against your finger. Presets (off/light/firm/max/weapon) or custom wall position + strength.

> Trigger effects are **ephemeral** — they hold until a game changes them or the controller power-cycles. On a **PS5** the game overrides them, and software can't shorten physical travel; for a permanent short pull on PS5 you need a hardware trigger-stop or a DualSense Edge.

## Connect it to Claude Code (MCP)

The `mcp/` server lets your Claude session read and control the controller:

```bash
cd mcp && npm install
claude mcp add dualsense -- node "$(pwd)/server.js"
```

Then ask Claude: *"Is my controller drifting?"*, *"Set my triggers to firm,"* *"Make the lightbar purple."* See **[mcp/README.md](mcp/README.md)** for tools, `.mcp.json` config, and platform notes.

## Safety

- **USB-only recalibration**, and it self-gates: it waits until the sticks are untouched and still before sampling, verifies every step's controller echo, and **aborts without writing** on any mismatch. The single NVS-commit step is confirmed against a known-good status before reporting success.
- Writing to the controller's memory is inherently a **brick-risk** operation. A *soft* mis-calibration is recoverable by re-running. **Use at your own risk.** Keep battery > ~30% and don't unplug mid-save.
- **DualSense Edge** (PID `0x0df2`) won't *persist* calibration without a hardware write-protect mod — the tools detect and warn.
- In the MCP server, the recalibration tool is **disabled unless you explicitly opt in** (`DUALSENSE_MCP_ALLOW_CALIBRATION=1`) — an AI can't casually trigger an NVS write.

## Privacy

Everything runs locally. The web apps load no fonts, scripts, or assets from any CDN and make **no network requests**. The MCP server is stdio-only with no network access.

## Layout

```
index.html / studio.html   WebHID apps          css/ js/   styles + modules
dsdoctor.py                diagnose + recalibrate (USB)
triggers.py                adaptive trigger control (USB)
mcp/                       Claude Code MCP server (node-hid)
serve.sh                   local server launcher
```

## Credits

The on-controller stick recalibration protocol (NVS unlock / calibrate / flash over HID) was reverse-engineered by **Paolo "the_al"** and the **[dualshock-tools](https://github.com/dualshock-tools/dualshock-tools.github.io)** project (MIT). This project re-implements that protocol independently with its own diagnostics, trigger, and MCP layers. Huge thanks to that work.

## License

[MIT](LICENSE) — free for anyone to use, modify, and build on.
