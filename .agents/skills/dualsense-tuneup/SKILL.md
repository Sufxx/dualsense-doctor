---
name: dualsense-tuneup
description: Run repeatable DualSense stick checks and tune-ups through the DualSense Doctor MCP, with adaptive coaching, recorded measurements, and an optional interactive client card.
---

## Begin a session

Use the installed MCP tools. Identify the intended controller with
`list_controllers`; resume known session evidence with `list_sessions` and
`session_report` when appropriate. Present the first physical instruction and
begin one `run_guided_session` when the user starts. Relay meaningful progress
and corrections rather than asking for readiness at every stage.

The local coach checks pace, direction, rim contact, settling, release evidence,
and accidental stick movement. Advance from its evidence, not a guessed timer.
Respect cancellation and incomplete results. A client may delay progress/logging
notifications; describe that limit honestly rather than promising instant feedback.
Use `start_session` and `capture_phase` for targeted repeats after explaining that
phase's instruction. Record the adjustment being tested so comparisons have context.

## Interpret the result

Keep circularity, resting displacement, jitter, snapback, and a game deadzone
separate. The DualShock Tools guidance of roughly 7–9% RMS circularity resembles
stock range; symmetry matters more than an exact target or a perfect zero. That
guidance is not a universal optimum for every module or game. Preserve good range
and small-input response while checking center consistency and repeated returns.

Report what was observed, what is proposed, what was actually changed, and what
was saved. Measurement completion does not mean the controller was calibrated or
a game setting was applied. Keep software-deadzone candidates unapplied until a
specific supported setting is changed and rechecked. After an external calibration
change, start a new session or clearly separate before/after evidence.

Controller-memory calibration is a separate opt-in operation. This skill does not
enable it or grant permission to save permanently. Use only available, validated
calibration tools with a deliberate decision on the reviewed result; retain the
server's NVS gates and do not turn a general tune-up request into an automatic
firmware write. Never describe synthetic tests as hardware qualification.

## Optional interactive client

If the T3 adapter tools and HTML rendering are available, `show_live_coach` returns
an HTML path for that client's preview and render tools. Otherwise keep the generic
MCP coaching workflow. The actual desktop card and its preview renderer may have
different network access; test the target client rather than assuming either works.
Use the card's single Start and Pause/Resume/Stop controls when supported. Display
preferences affect the view, not the underlying measurement or controller settings.

Session logs, device identities, generated capability-bearing HTML, and runtime
files stay private. Share only selected generic code or synthetic examples when
reporting a bug. Repository users can consult `mcp/COACHING.md`; the optional adapter
has additional notes in `mcp/T3-INTEGRATION.md` when that layer is installed.
