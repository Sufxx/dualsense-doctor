# Measurement math and limits

These measurements describe sampled controller output. They do not change calibration,
filter drift, choose a firmware trim or establish a universal game setting.

## Quiet input

Quiet radial displacement is `100 × hypot(X − 128, Y − 128) / 127`.
Signed axis percentages use the same center and divisor. Raw 128/128 is the reference;
one count on one axis is about 0.7874%, and one count on both axes is about 1.1136%.
These are input-resolution examples, not required game deadzones or calibration-word
increments. A native calibration-word step has no qualified raw-count conversion here.

Offset is the distance of the mean X/Y from center. Jitter is the larger of the two
population standard deviations. Peak is the largest sampled radial displacement.
The p99 statistic sorts the radii and selects index `min(N − 1, floor(0.99 × N))`.
It is not the peak: a rare nonzero sample can coexist with p99 = 0 and a rounded mean
of 128. Never infer that every sample was centered from either number.

The complete session report and repeated-round comparison use the worst valid quiet
peak from rest, buttons and final verification, add one percentage point, then round
up. They retain earlier valid quiet captures in the current calibration epoch rather
than selecting only the best final rest. Incomplete or incompatible evidence withholds
the recommendation. The existing review ceiling also withholds candidates above 20%.
This margin is an optional conservative starting point, not a requirement to raise
an already stable setting or abandon a zero-deadzone goal.

A constant center translation cannot remove underlying spread or standard deviation.
Consistent untouched returns in one direction can justify investigating an offset;
different offsets across phases or release directions require more evidence first.

## Range and circularity

Circularity follows the pinned DualShock Tools convention: normalize axes around
127.5 with divisor 128, round each normalized axis to two decimals, collect maximum
radii in 48 angular sectors, then compute `100 × sqrt(mean((radius − 1)²))`.
Full RMS requires 48 covered sectors; partial coverage is separately labeled.
Opposite-direction difference is the largest absolute radius difference among 24
opposite pairs, in percentage points. These metrics intentionally use a different
reference from quiet-center displacement and electrical endpoint reach.

Recorded radii are rounded to 0.01. When bins are present, comparison validates their
count, finite bounds, coverage and consistency with the summary. Radius rounding can
move RMS by at most 0.5 percentage points and the maximum opposite difference by 1;
the summary's own rounding adds 0.005. Contradictory geometry becomes unavailable
without hiding valid quiet evidence. Legacy records without bins keep their existing
summary-only interpretation; their geometry cannot be independently rechecked.

Maximum envelopes depend on movement and sampling opportunity. Compare similar
duration, pace, directions and rim contact; extra samples can increase a maximum
without any calibration change. Electrical endpoints at 0/255 do not prove angular
symmetry, unsaturated output, physical travel or ideal response near center.

The upstream 7–9% circularity guidance describes a stock-like response preference,
not an optimum for every stick module or game. Do not shrink useful range solely
to obtain a smaller RMS figure. Preserve symmetry and small-input response, then
validate the feel in game.

## Motion evidence

The coach requires complete observed turns, not a sum of disconnected arcs. It keeps
completed turns but discards the unfinished arc after rim loss, invalid/stale input
or a large unobservable angular jump. Pauses on the rim keep partial progress;
reverse motion subtracts from it. Pace cues and lap qualification are separate:
one faster quadrant does not erase an otherwise observable turn.

Reports can arrive in submillisecond bursts. Their arrival gaps are not individual
sensor intervals, so they must not become instantaneous physical-speed claims.
The coach qualifies a completed lap using observed angular travel and elapsed time,
with a fresh timing budget for each lap. Fully observed constant-angle holds of
at least 250 ms are excluded from that budget without erasing the partial circle.
Shorter or quantized pauses remain in the observed average; the tool does not recover
physical moving-only time. A lap uses absolute angular travel for pace and signed
travel for progress. Crossing overshoot is discarded rather than assigned an
invented sensor timestamp. These empirical thresholds do not establish true physical
stick speed or controller latency.

A release keeps the first observed outward direction until an input sample returns
inside 15%. The post-return metric observes the next 300 ms and flags excursions at 35%.
A fast rebound may cross center between reports: the app does not invent an unseen
center sample, and pre-return opposite motion is not included in that post-return
peak. Neither the peak nor the warning distinguishes thumb technique from mechanical
behavior. Direction-specific settled returns are useful further evidence before trim.

## Primary references

Pinned DualShock Tools sources:
[axis conversion](https://github.com/dualshock-tools/dualshock-tools.github.io/blob/b7cdcfaacfadfac5e80f4f40b16e85503a488e63/js/controller-manager.js),
[angular maxima](https://github.com/dualshock-tools/dualshock-tools.github.io/blob/b7cdcfaacfadfac5e80f4f40b16e85503a488e63/js/core.js),
[RMS calculation](https://github.com/dualshock-tools/dualshock-tools.github.io/blob/b7cdcfaacfadfac5e80f4f40b16e85503a488e63/js/stick-renderer.js), and
[fine-tuning guidance](https://github.com/dualshock-tools/dualshock-tools.github.io/blob/b7cdcfaacfadfac5e80f4f40b16e85503a488e63/templates/finetune-modal.html).
