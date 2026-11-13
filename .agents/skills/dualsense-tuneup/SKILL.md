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

For repeated checks, compare complete saved rounds with `compare_sessions`.
The repeated-round starting deadzone covers the worst valid quiet peak plus one
percentage point, rounded up; it differs from a single report's p99 estimate.
Never select only the best run or interpret repetition as firmware improvement.
Use the same controller, connection type and unchanged setup. Begin a new
comparison after any external calibration or game/input-layer change. Report
circularity and release overshoot separately; do not promise zero future drift.

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
During a check, use the per-stick cue and actual outer-edge coverage to explain
what to adjust. Preparation countdowns are separate from evidence progress: a timer
reaching zero never proves a movement passed. Progress notifications carry fresh
corrections; relay meaningful cue changes without narrating every sample. Report
render FPS and received input Hz separately, without promising measured latency.
The optional card offers 1/3/5-round targets; Repeat starts a round only when
pressed. A new comparison or disconnect clears the live comparison, while saved
session logs remain available for later `compare_sessions` calls. Lightbar Apply
works before a test when connected; its effect is not saved in controller memory.

Session logs, device identities, generated capability-bearing HTML, and runtime
files stay private. Share only selected generic code or synthetic examples when
reporting a bug. Repository users can consult `mcp/COACHING.md`; the optional adapter
has additional notes in `mcp/T3-INTEGRATION.md` when that layer is installed.
