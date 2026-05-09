# Feature Specification: Note Detection

**Feature Branch**: `001-note-detect`
**Created**: 2026-05-09 (retrospective)
**Status**: Implemented (v1.2.0)
**Input**: `README.md`, `screen.js`, `test/*`.

## User Scenarios & Testing

### User Story 1 — Score single notes in real time (P1)

As a player, I want my single notes scored against the chart in real
time, with hit / miss feedback on the highway and accuracy / streak
in the HUD.

**Why this priority**: Core function.

**Independent Test**: Click Detect during a single-note section, play
the chart note within the timing + pitch tolerances. The note glows
green; HUD accuracy increments.

**Acceptance Scenarios**:

1. **Given** Detect is on and the chart shows a single note,
   **When** the player produces a pitch matching the expected MIDI
   within `cleanPitch` (default ±50 cents) inside `cleanTiming`
   (default ±50 ms), **Then** the note is classified `OK/OK` and
   emitted as `notedetect:hit`.
2. **Given** the user plays the right pitch but late, **When** the
   timing falls between `cleanTiming` and the outer `timing` window,
   **Then** the note is classified with `timingState=LATE`,
   `pitchState=OK`, `hit=false`, emitted as `notedetect:miss` with a
   diagnostic label.
3. **Given** the timing window expires with no detected pitch,
   **When** the chart note passes the now-line, **Then** a pure
   miss event fires with `detectedMidi=null`, `confidence=0`,
   `timingState=null`, `pitchState=null`.

---

### User Story 2 — Score chords via per-string constraint check (P1)

As a player, I want chords to be scored per string — at least N% of
the chord's strings must ring for the chord to count as a hit.

**Acceptance Scenarios**:

1. **Given** a chord with 3 chart notes (e.g. on strings 0, 2, 4),
   **When** the player produces audio with energy in all three
   string bands (≥3 % of total each), **Then** the chord is scored
   as 3/3 → hit (with default 60 % leniency, anything ≥2/3
   passes).
2. **Given** a chord with hammer-on / pull-off technique flags,
   **When** evaluating the strings, **Then** the per-string energy
   threshold is lowered (no fresh pick attack expected).
3. **Given** a chord with bend / slide flags, **When** evaluating,
   **Then** the per-string pitch tolerance is widened.
4. **Given** a chord with harmonic flags, **When** evaluating,
   **Then** pitch refinement is skipped — energy check only.

---

### User Story 3 — Pick a detector for the rig (P2)

As a bass player whose rig rolls off the fundamental, I want to
switch from YIN to HPS so detection stops reading an octave high.
As a player with heavy distortion, I want CREPE.

**Acceptance Scenarios**:

1. **Given** the user picks HPS, **When** detection runs, **Then**
   pitch decisions use the harmonic-product-spectrum codepath.
2. **Given** the user picks CREPE, **When** the model fails to
   load (network / WebGL), **Then** the plugin transparently falls
   back to YIN with no user-facing error.

---

### User Story 4 — Configure tolerances + emit-only diagnostics (P2)

As a user, I want to tune the outer / clean timing and pitch
windows, and toggle visibility of diagnostic labels.

**Acceptance Scenarios**:

1. **Given** the user moves Timing Tolerance, **When** detection
   evaluates the next note, **Then** the new window is in effect.
2. **Given** Timing labels are toggled off, **When** a diagnostic
   miss fires, **Then** the label is suppressed visually but the
   event still emits.

---

### User Story 5 — Emit public events for other plugins (P2)

As another plugin author, I want stable events I can subscribe to.

**Acceptance Scenarios**:

1. **Given** detection is running, **When** a clean hit happens,
   **Then** `notedetect:hit` and (if `window.slopsmith` bus is
   available) `note:hit` are emitted with the full judgment object
   per the README's field reference.
2. **Given** the song ends, **When** detection wraps up, **Then**
   `notedetect:session` fires with aggregate stats.

---

### User Story 6 — Splitscreen-friendly multi-instance (P3)

As a splitscreen panel author, I can construct an independent
detector instance per panel.

**Acceptance Scenarios**:

1. **Given** `window.createNoteDetector(...)` is called, **When**
   the returned instance is started, **Then** it has its own audio
   pipeline, HUD, scoring, draw hook, and DOM subtree, independent
   of `window.noteDetect`.

## Functional Requirements

- **FR-001**: Factory: `window.createNoteDetector(options)` returns
  an instance with its own state. `window.noteDetect` is the default
  singleton.
- **FR-002**: Tuning resolution: read from
  `highway.getSongInfo().tuning` (or equivalent); supports guitar
  6/7/8-string and bass 4/5-string.
- **FR-003**: Single-note path: configurable detector
  (YIN / HPS / CREPE). YIN is default; CREPE falls back to YIN on
  load failure.
- **FR-004**: Chord path activates when ≥2 simultaneous chart
  notes share a timestamp. Per-string expected frequency band is
  open-pitch-of-string × {1.0..2¹²/¹² over 0..24 frets} × ±10 %
  headroom.
- **FR-005**: Per-string energy ratio threshold = 3 % of total
  audio-frame spectral energy.
- **FR-006**: Chord Leniency setting (default 0.6, range 0.25-1.0)
  defines `min hits / total strings` to count as a chord hit.
- **FR-007**: Technique flags adjust thresholds:
  hammer-on/pull-off lowers energy threshold; bend/slide widens
  pitch tolerance; harmonic skips pitch refinement.
- **FR-008**: Hit classification axes are independent: `timingState`
  ∈ {OK, EARLY, LATE}; `pitchState` ∈ {OK, SHARP, FLAT}. A clean
  hit requires both `OK`. Pure misses (window expired) have
  `timingState=null`, `pitchState=null`.
- **FR-009**: Events emitted on `window`:
  `notedetect:hit`, `notedetect:miss`, `notedetect:session`. When
  `window.slopsmith` bus is present: also `note:hit`, `note:miss`.
- **FR-010**: Event payloads MUST follow the README field reference
  (`note`, `time`, `noteTime`, `expectedMidi`, `detectedMidi`,
  `confidence`, `hit`, `timingState`, `pitchState`, `timingError`,
  `pitchError`). `pitchError` is octave-folded.
- **FR-011**: `pitchError` octave-folding: signed cents to nearest
  octave (so it is **not** necessarily
  `(detectedMidi - expectedMidi) * 100`).
- **FR-012**: Settings persisted in `localStorage`: detection
  method, timing tolerance, pitch tolerance, clean timing /
  clean pitch, label visibility, miss-marker duration, input gain,
  chord leniency.
- **FR-013**: Tests in `test/` MUST run via the `_loader.js` `vm`
  harness against the shipping `screen.js`.

## Out of Scope

- Polyphonic transcription.
- Per-string mic input (needs a hex pickup or DI box).
- Auto-arrangement creation from played audio.
- Syncing scores to a server / leaderboard (this plugin is
  display-only; consumers like Practice Journal handle persistence).
