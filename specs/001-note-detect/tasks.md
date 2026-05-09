# Tasks — Note Detection

## US1 — Single-note scoring (P1)

- [DONE] T101 YIN detector (autocorrelation, CMNDF).
- [DONE] T102 HPS detector (FFT + harmonic-product-spectrum).
- [DONE] T103 CREPE detector via TF.js (lazy-load, YIN fallback).
- [DONE] T104 Outer + clean timing/pitch windows; `timingState` /
  `pitchState` axes; pure-miss handling on window expiry.
- [DONE] T105 HUD: accuracy %, streak, best streak.
- [DONE] T106 Diagnostic miss labels (EARLY / LATE / SHARP / FLAT)
  with toggleable visibility.

## US2 — Chord scoring (P1)

- [DONE] T201 Detect ≥2 simultaneous chart notes → route to chord
  path.
- [DONE] T202 Per-string expected frequency band with capo +
  tuning + ±10 % headroom.
- [DONE] T203 Spectral-energy ratio threshold (3 %).
- [DONE] T204 Technique flag adjustments (HO/PO, bend/slide,
  harmonic).
- [DONE] T205 Chord leniency setting (0.25-1.0, default 0.6).

## US3 — Detector pickability (P2)

- [DONE] T301 Settings panel selector.
- [DONE] T302 Lazy CREPE load + YIN fallback.

## US4 — Tunable thresholds (P2)

- [DONE] T401 Outer timing / pitch tolerance sliders.
- [DONE] T402 Clean timing / pitch sliders.
- [DONE] T403 Miss-marker duration setting.
- [DONE] T404 `localStorage` persistence.

## US5 — Public events (P2)

- [DONE] T501 `notedetect:hit` / `notedetect:miss` /
  `notedetect:session`.
- [DONE] T502 `note:hit` / `note:miss` on `window.slopsmith`
  bus when available.
- [DONE] T503 Field reference in README.

## US6 — Splitscreen factory (P3)

- [DONE] T601 `createNoteDetector(options)` factory.
- [DONE] T602 Per-instance closured state (HUD, scoring, draw
  hook, DOM, listeners).
- [DONE] T603 `window.noteDetect` default singleton.

## Cross-cutting

- [DONE] T701 Tunings: 6/7/8 string guitar + 4/5 string bass.
- [DONE] T702 8-string tuning support landed (per `screen.js`
  CHANGE 1 notes).
- [DONE] T703 Test harness: Node `vm` loader runs against
  shipping `screen.js`.
- [DONE] T704 Tests for chord detection, display fingering,
  factory, HPS, judgment, bass mapping, YIN buffer sizing, YIN
  noise tolerance.
- [DONE] T705 Makefile dev workflow + Docker compose overlay.
- [DONE] T706 CI (per #13 in `screen.js` header note).
- [OPEN] T707 [P] Test for octave-folded `pitchError` (referenced
  in README's field reference; no dedicated test file visible).
- [OPEN] T708 [P] Test the CREPE → YIN fallback path (mock TF.js
  failure mode).
- [OPEN] T709 [P] Per-string DI input via Web MIDI/Web USB
  (out-of-scope for v1; would obviate the chord-energy heuristic).
- [OPEN] T710 [P] Polyphonic transcription experiment (e.g. via
  Onsets and Frames / TF.js).
