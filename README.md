# Slopsmith Note Detection Plugin

Real-time pitch detection and scoring for [Slopsmith](https://github.com/byrongamatos/slopsmith) — works on both **guitar** (6-string) and **bass** (4-string) arrangements. The active tuning base is selected automatically from the loaded arrangement. Captures audio from your browser's audio input, detects the pitch being played, compares it against the notes on the highway, and shows hit/miss feedback with accuracy scoring.

## Install

```bash
cd plugins
git clone https://github.com/byrongamatos/slopsmith-plugin-notedetect.git note_detect
# restart Slopsmith
```

## How It Works

1. Click **Detect** in the player controls during a song
2. Browser requests microphone/line-in access
3. Audio input is analyzed in real-time for pitch (YIN or CREPE)
4. Detected pitch is compared against expected notes within a timing window
5. Notes glow green (hit) or red (miss) on the highway
6. Running accuracy and streak shown in the HUD

## Audio Input Channel Selection

Many guitar multi-effects pedals with USB audio (e.g. Valeton GP-5, Line 6 HX Stomp, Boss GT-1000) send two channels over USB:

| Channel | Signal | Best for |
|---------|--------|----------|
| **Left (Ch 1)** | Dry / DI | Pitch detection (recommended) |
| **Right (Ch 2)** | Wet / FX | Listening |
| **Mono (mix)** | Both mixed | Single-channel interfaces |

**For best pitch detection accuracy, select the dry/DI channel (usually Left / Ch 1).** The clean signal without amp simulation, distortion, or modulation effects gives the pitch detector a much cleaner fundamental frequency to track.

To configure: click the gear icon next to the Detect button, then choose your audio input device and channel.

## Settings

Click the gear icon when detection is active to access:

- **Audio Input Device** — select which interface to capture from
- **Input Channel** — Left (Ch 1), Right (Ch 2), or Mono (mix)
- **Input Level** — VU meter showing signal level on the selected channel
- **Detection Method** — YIN (lightweight, instant) or CREPE/SPICE (TensorFlow.js, ~20MB model download, better with effects)
- **Timing Tolerance** — how close to the beat a note must be played (default ±100ms)
- **Pitch Tolerance** — how close in pitch a note must be (default ±50 cents)
- **Input Gain** — amplify weak signals

All settings are persisted in localStorage across sessions.

## Scoring

- Accuracy percentage displayed in the highway HUD (top right)
- Streak counter (consecutive hits) and best streak
- Per-section accuracy breakdown shown when detection is stopped
- Fires a `notedetect:session` CustomEvent for Practice Journal integration

## Pitch Detection Methods

### YIN (default)
Lightweight autocorrelation-based algorithm. Works instantly with no model download. Best for clean or lightly distorted signals.

### CREPE / SPICE
TensorFlow.js neural network model (~20MB, loaded lazily on first use). More robust with heavily distorted or effected signals. Uses WebGL acceleration when available.

## Requirements

- Browser with `getUserMedia` support (all modern browsers)
- Audio input device (built-in mic, USB audio interface, or USB multi-effects pedal)
- Slopsmith core with `highway.getSongInfo()` tuning data (v1.x+)

## Develop locally

The repo ships a `Makefile` + compose overlay that mounts this plugin into a
running Slopsmith container via `SLOPSMITH_PLUGINS_DIR` (upstream
`slopsmith@b65a08c`). You edit `screen.js` here; the browser reload picks
it up.

Prereqs: a Slopsmith checkout with a working `docker-compose.yml` (`DLC_PATH`
already set, etc.), Docker Compose v2.

```bash
# From this repo root:
make help                        # list targets
make test                        # run the node:test suite (no deps)

# Assumes slopsmith is at ../slopsmith. Override if not:
SLOPSMITH_DIR=~/code/slopsmith make dev

# If host port 8000 is taken:
SLOPSMITH_PORT=8088 make dev

make logs                        # tail slopsmith container logs
make verify-mount                # confirm the plugin is visible in the container
make down                        # stop slopsmith
```

`make dev` launches Slopsmith at `http://localhost:$SLOPSMITH_PORT` with this
plugin mounted read-only at `/opt/user-plugins/note_detect`. The built-in
`plugins/` directory still loads as usual; this plugin's `plugin.json.id` wins
on the duplicate-id check so a previously-installed copy is safely shadowed.

### Why not clone into `slopsmith/plugins/` directly?

You can (the README's "Install" section describes that). The overlay approach
is better for development because:

- Your edits live in a git-tracked repo separate from the Slopsmith tree
- No manual sync or symlinks
- Swap branches without touching Slopsmith's working tree
- `make down` cleans up; no leftovers in `slopsmith/plugins/`

## Tests

    npm test

Runs a Node `vm`-based harness (Node 18+, no dependencies) that loads the shipped
`screen.js` against DOM stubs and exercises its real pitch-detection and mapping
functions with synthetic signals. Tests cover YIN detection at guitar/bass
frequencies, the arrangement-aware string/fret mapping, the chart-context-aware
display fingering resolver, and noise-tolerance regression guards.

See `test/README.md` for the full rationale. Adding tests when changing
detection or mapping logic is encouraged — the `vm` loader means tests
exercise the actual shipping code, not a parallel copy.

## License

MIT
