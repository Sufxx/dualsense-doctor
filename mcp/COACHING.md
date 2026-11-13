# Adaptive measurement and coaching

This optional MCP workflow measures controller input and saves evidence. It does
not write controller calibration or apply Windows/game settings.

Use `start_session` for targeted captures, then `capture_phase` after presenting
the physical instruction. `list_sessions` and `session_report` resume saved work.
For a continuous guided sequence, call `run_guided_session` once the user starts.
Clients should display MCP logging/progress notifications and allow cancellation.
Client delivery latency varies; this is not a promise of real-time chat rendering.
Progress notifications update progress and instruction text at up to 10 Hz.
Structured logs carry per-stick pace, direction and rim-contact cues at up to 1 Hz,
plus stage changes and bounded corrections, including for clients without a
progress token. A preparation countdown never substitutes for evidence.

The sequence checks stable rest, clockwise and counterclockwise rim coverage,
four-direction flick/release evidence, clean button presses, and a final rest.
Pace, direction, rim contact, settling, report loss and contamination affect the
instructions and progression. Interrupted or invalid captures cannot silently pass.
One contaminated button phase is retried; repeated contamination or a time limit
stops for clarification. Sufficient release evidence is not a diagnosis of health.

## Configuration and evidence

`DUALSENSE_SESSION_DIR` optionally sets a private local evidence directory. The
default is a `sessions` directory next to the application. Raw input, device
identity and session logs may be personal data: keep that directory out of commits.
Compare only the same controller and compatible transport/measurement conditions.
Use a new session after an external calibration change so old results are not
mistaken for post-change verification.

The speed, excursion and settling thresholds are empirical coaching defaults, not
manufacturer limits. They may need adjustment for different hardware or users.
The generic session does not invoke the repository's existing opt-in firmware
calibration tool; that protocol remains outside this feature's qualification.

## Metrics and credits

Rest reports include offset, jitter and radial displacement. Deadzone candidates
are observed p99 radial displacement plus a margin; they remain unapplied.
Range reports distinguish axis limits, sector coverage and RMS circularity.
The circularity implementation follows the MIT DualShock Tools normalization,
48-bin angular maxima, and RMS radial error calculation. Its 7–9% guidance aims
to resemble stock behavior; symmetry matters more than a precise target.

Primary references: https://dualshock-tools.github.io/ and its controller-manager.js,
core.js and stick-renderer.js sources. The existing Sony HID protocol credits in
this project remain intact. Hardware-free tests do not establish physical accuracy
or qualify permanent controller writes.

Run `npm test` and `npm run smoke` in `mcp`. The smoke test lists tools/resources,
reads the coaching prompt, and lists an isolated empty session directory. It does
not enumerate or open controllers and leaves calibration disabled.

## Portable agent workflow

The repository also includes the generic
[dualsense-tuneup skill](../.agents/skills/dualsense-tuneup/SKILL.md). Agents that
discover project skills can use it directly; others can copy it into their normal
skill directory. It contains no machine paths, owner profile, or thread arrangement.
