# DualSense Doctor — MCP server

Connect your **PS5 DualSense to Claude Code** (or any MCP client). Your Claude session can then read the controller and ask things like *"is my controller drifting?"* or *"set my triggers to a firm hair-trigger."* Runs locally over stdio — **no network, no telemetry.**

## Install

```bash
cd mcp
npm install          # pulls node-hid (prebuilt binaries) + the MCP SDK
```

> **macOS:** the controller must be on **USB** (a Bluetooth DualSense isn't reachable by node-hid on macOS). You may also need to grant **Input Monitoring** to your terminal/Claude Code for live stick reads.
> **Linux:** add a udev rule for non-root HID access:
> `SUBSYSTEM=="hidraw", ATTRS{idVendor}=="054c", MODE="0660", TAG+="uaccess"` then replug.
> **Windows:** USB and Bluetooth both work.

## Add to Claude Code

```bash
claude mcp add dualsense -- node /absolute/path/to/dualsense-doctor/mcp/server.js
```

Or add to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "dualsense": {
      "command": "node",
      "args": ["/absolute/path/to/dualsense-doctor/mcp/server.js"]
    }
  }
}
```

Then just ask Claude:
- *"List my controllers and check the battery."*
- *"Diagnose my right stick for drift."*
- *"Set both triggers to the weapon preset."*
- *"Make the lightbar purple."*

## Tools

| Tool | What it does | Risk |
|------|--------------|------|
| `list_controllers` | List connected DualSense(s) | read-only |
| `get_status` | Mode, live sticks, battery, firmware | read-only |
| `diagnose_drift` | Sample at rest → offset/jitter/score/verdict per stick | read-only |
| `read_sticks` | One stick reading | read-only |
| `get_battery` | Battery % + charging | read-only |
| `set_trigger_effect` | Adaptive-trigger feel (presets or custom) | reversible* |
| `set_lightbar` | Light bar color | reversible* |
| `recalibrate_center` | Rewrite stick center to NVS flash | **gated, brick-risk** |

\* Trigger/lightbar effects are ephemeral — they reset on power-cycle, and a PS5 game overrides them.

## Safety

- **`recalibrate_center` is not registered at all** unless you set `DUALSENSE_MCP_ALLOW_CALIBRATION=1`. Even then it is **USB-only**, requires `confirm="RECALIBRATE"`, and waits for the sticks to be untouched and still before sampling — so the AI can't casually trigger an NVS write or calibrate to a touched stick. A bad result is recoverable by re-running.
- Every other tool is read-only or ephemeral. All inputs are validated and clamped.
- Zero network calls. Two pinned dependencies (`node-hid`, `@modelcontextprotocol/sdk`) + `zod`.

The calibration protocol is reverse-engineered work by [dualshock-tools](https://github.com/dualshock-tools/dualshock-tools.github.io) (Paolo "the_al"). See the repo root for full credits and the bricking disclaimer.
