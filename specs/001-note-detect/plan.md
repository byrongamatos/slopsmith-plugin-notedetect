# Implementation Plan — Note Detection

Single-file plugin (`screen.js`, 2,889 lines) with a non-trivial
test harness, a Makefile-driven dev workflow, and a Docker-compose
overlay for live mounting into Slopsmith.

## Files

- `plugin.json` — id `note_detect`, declares only `script`.
- `screen.js` — entire implementation: factory, detectors, chord
  scorer, scoring, HUD, event bus, draw hook, settings panel.
- `package.json` — `npm test` script.
- `Makefile` — dev workflow targets.
- `docker-compose.slopsmith.yml` — overlay that bind-mounts the
  plugin into a running Slopsmith container at
  `/opt/user-plugins/note_detect`.
- `test/` — Node `vm`-based test harness:
  - `_loader.js` — sandboxed loader for `screen.js`.
  - `_signals.js` — synthetic test signals.
  - `chord-detection.test.js` (245 lines)
  - `display-fingering.test.js` (112 lines)
  - `factory.test.js` (95 lines)
  - `hps.test.js` (71 lines)
  - `judgment.test.js` (81 lines)
  - `mapping-bass.test.js` (98 lines)
  - `yin-buffer-sizing.test.js` (59 lines)
  - `yin-noise-tolerance.test.js` (82 lines)
  - `README.md` — test rationale.

## Architecture

### Factory

```js
function createNoteDetector(options) {
  // closured state: pipeline, scoring, HUD, draw hook, DOM,
  // listeners. Returns a public surface with start / stop /
  // configure / dispose.
}
window.noteDetect = createNoteDetector();   // default singleton
window.createNoteDetector = createNoteDetector;
```

### Detection paths

```
chart notes within timing window:
  ├── 1 note → single-note path
  │     ├── method = YIN  → YIN detector (autocorrelation)
  │     ├── method = HPS  → FFT + HPS
  │     └── method = CREPE→ TF.js model (lazy-load); on failure fall
  │                          back to YIN
  └── ≥2 notes → constraint chord scorer
```

### Chord scorer

For each chart note in the chord:

1. Resolve string + fret + capo + tuning → expected frequency.
2. Compute frequency band: `freq * (1 ± 0.10)`.
3. FFT the audio frame; compute energy in the band /
   total-frame energy.
4. If ratio ≥ 0.03 → string is ringing.

Apply technique-flag adjustments (per FR-007). Final score:
`hits / total >= chordLeniency` → hit.

### Judgment

For each chart note:

- `timingError = (detectedAttempt.time - chart.time) * 1000`.
- `pitchError = octaveFolded(detected - expected, cents)`.
- `timingState`, `pitchState` mapped from outer + clean windows.
- `hit = (timingState === 'OK' && pitchState === 'OK')`.

### Event emission

- `window.dispatchEvent(new CustomEvent('notedetect:hit', { detail }))`
  + `notedetect:miss`, `notedetect:session`.
- If `window.slopsmith?.emit`: also `note:hit` / `note:miss`.

### HUD

- Top-right: accuracy %, current streak, best streak.
- Highway draw hook: green / red glow per note,
  EARLY/LATE/SHARP/FLAT labels for diagnostic misses.

## Dev workflow

`make dev` uses `slopsmith/docker-compose.yml` plus this repo's
`docker-compose.slopsmith.yml` overlay to:

- bind-mount this repo at `/opt/user-plugins/note_detect`,
- set `SLOPSMITH_PLUGINS_DIR=/opt/user-plugins`,
- expose Slopsmith on `${SLOPSMITH_PORT}`.

This plugin's `plugin.json.id` wins on the duplicate-id check, so
a previously-installed copy is shadowed cleanly.

`make test` runs `npm test` (Node `node:test` runner; no deps).
`make verify-mount` confirms the bind mount is visible inside the
container. `make logs` tails container output.

`.env.example` shows `SLOPSMITH_PORT` / `DLC_PATH`.

## Integration with Slopsmith Core

- **Single-script plugin loader**.
- **Highway hooks**: `getTime`, `getNotes`, `getSongInfo`
  (tuning), `addDrawHook`.
- **Event bus** (`window.slopsmith`): emits `note:hit` /
  `note:miss` when available.
- **Factory exported on `window.createNoteDetector`** for the
  `splitscreen` plugin and similar.

## Out of Scope

- Polyphonic transcription (would replace the constraint scorer).
- Tonal classification (e.g. "you're playing in Em").
- Per-string mic input.
- Server-side scoring / leaderboards.
