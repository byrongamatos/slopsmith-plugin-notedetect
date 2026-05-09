# Clarifications — Note Detection

## Q1. Why a constraint scorer for chords instead of YIN/HPS/CREPE?

**A.** YIN, HPS, and CREPE are monophonic: they return one frequency
from the full mixed signal. A guitar chord produces 2-6 simultaneous
fundamentals plus their harmonics, all overlapping in the spectrum.
The detectors lock onto whichever string is loudest (usually the
lowest) and silently miss every other note. The constraint scorer
sidesteps this entirely by checking, per string, "is there energy
near the frequency I expect?" — which is a much simpler question
that the chart already provides the answer for.

## Q2. Why ±10 % band headroom?

**A.** Capo offsets, alt-tunings, bends, and string-bend tuning
slop all push the actual frequency a little off the nominal. ±10 %
is wide enough to absorb those without the bands leaking into each
other.

## Q3. Why ≥3 % energy ratio?

**A.** Empirical. Below 3 %, ambient noise / hum / cross-string
sympathy can register false positives. Above ~5 %, weak strings
(buried in the mix or quietly fingered) start scoring as silent.
3 % is the empirical floor that catches "user actually played this
string" without grabbing room noise.

## Q4. Why `pitchError` octave-folded?

**A.** A 1-octave-up detection (common YIN failure on bass) has a
"true" cents error of 1200; reporting that as the error makes the
plot histograms unreadable. Octave-folding clamps the error to
≤±600 cents from the nearest octave, which is what the user
actually wants to see ("you're 30 cents flat", not "you're 1170
cents sharp").

## Q5. Why is CREPE optional and gated behind a 20 MB download?

**A.** TensorFlow.js + the CREPE model is large, slow to start, and
benefits from WebGL acceleration that not every machine has. Making
it opt-in keeps the plugin's first-load cost zero for users on
clean signals (where YIN already wins). The fallback to YIN on
CREPE load failure means picking it can't break the plugin —
worst case you get the YIN behaviour you'd have had anyway.

## Q6. Why is `window.slopsmith` event bus emission optional?

**A.** It's a younger Slopsmith feature that not every host version
has. The plugin always emits `window.dispatchEvent(new
CustomEvent(...))` (works everywhere); the `window.slopsmith.emit`
path is additive when available. Backward-compatible.

## Q7. Why a factory pattern instead of a singleton?

**A.** Splitscreen needs N independent detectors (one per panel).
The original implementation was singleton-only; takeover PR
re-applied the factory design on top of accumulated changes
(5-string bass #14, per-note events #12, CI #13, HPS #15) per the
header comment in `screen.js`. The default singleton
(`window.noteDetect`) preserves the simple-case API.

## Q8. Why does the test harness use Node `vm` instead of jsdom or
a bundler?

**A.** The plugin ships zero dependencies; tests should ship the
same. `node:test` + `node:vm` runs the actual `screen.js` file
inside a sandbox with stub globals (`window`, `localStorage`,
synthetic `AudioContext`). Tests exercise the real shipping code,
not a parallel copy. See `test/_loader.js` and `test/README.md`.
