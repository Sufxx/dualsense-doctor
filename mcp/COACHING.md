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

`compare_sessions` compares up to ten saved complete rounds from one identified
controller, transport and recorded calibration history. It rechecks phase quality
and final-verification order. The repeated-round deadzone starting point is the
worst valid quiet rest/button/verification peak plus one percentage point, rounded
up. `session_report` uses the same rule for its complete current-epoch round, so a
clean final p99 cannot erase earlier valid movement. Per-capture p99 remains a
descriptive statistic; incomplete evidence withholds the report recommendation.
Large or incompatible evidence withholds a recommendation. Circularity and release
overshoot are reported separately. Repeated checks establish observed consistency;
they do not train a policy, tune firmware, or guarantee zero future drift. Begin a
new comparison after external calibration/input changes that the tool cannot detect.

Rest reports include offset, jitter, p99 and peak radial displacement. A per-capture
candidate describes that capture only; the complete-report recommendation retains
all valid quiet peaks. These are unapplied starting points, not minimum game settings.
Range reports distinguish axis limits, sector coverage and RMS circularity.
The circularity implementation follows the MIT DualShock Tools normalization,
48-bin angular maxima, and RMS radial error calculation. Its 7–9% guidance aims
to resemble stock behavior; symmetry matters more than a precise target.

Each coached circle must contain a continuous full turn. Rim exits, input gaps and
large unobservable angular jumps discard only unfinished arcs; completed turns remain.
An observed pause on the rim can resume, and reverse motion removes unfinished
forward credit. Pace is checked over each completed lap; short-window cues do not
erase a circle for one faster quadrant. Release direction is latched from the first outward excursion until
a sampled center return, so a rebound cannot relabel the original flick.

See [measurement math and limits](MEASUREMENT-MATH.md) for normalization, rounding,
quantization examples, geometry validation and what release peaks cannot establish.

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

## Directional tuning evidence

`session_report` also returns a read-only `tuning` assessment for one complete check.
It separates signed quiet X/Y means, variation between quiet windows, and observed
left/right/up/down axis reach. All valid quiet windows in the recorded calibration
epoch are retained; favorable returns do not replace earlier observations. This
single-check detail does not replace `compare_sessions` across compatible rounds.

Quiet percentages use `(raw - 128) / 127 * 100`: +X points right and +Y down.
The report retains the minimum/maximum window means, the full peak-to-peak axis
spread and the largest within-window standard deviation. Spread is not a radial
deadzone. Old captures lacking signed axes keep this detail unavailable.

Axis reach maps negative travel over 128 raw counts and positive travel over 127,
so both electrical endpoints are 100%. Opposing differences are percentage points.
A complete reach assessment needs all 48 measured angular sectors, valid raw axis
limits and compatible cardinal-sector bounds. These extrema come from rim circles;
they are not deliberate straight-direction holds or proof of physical travel,
unsaturated output, or ideal circularity. The existing circularity metric remains
separate. Raw quiet mean/extrema/deviation combinations are checked for consistency
while allowing the analyzer's rounding.

`nextStep` uses fixed evidence rules: finish an invalid check, collect missing axis
detail, repeat incomplete rim coverage, or check whether an observed directional
resting offset repeats after release. Mixed positions do not force repeated tests.
Even a one-count offset may be quantization; the report does not prescribe a firmware
adjustment or an automatic calibration. A normal completed assessment asks the user
to compare observations with in-game behavior. No hardware-health or zero-drift claim
is made, and no controller command is sent by this assessment.
