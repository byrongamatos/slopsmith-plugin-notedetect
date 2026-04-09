# Slopsmith Note Detection Plugin

Real-time guitar pitch detection and scoring for [Slopsmith](https://github.com/byrongamatos/slopsmith). Captures audio from your browser's audio input, detects the pitch being played, compares it against the notes on the highway, and shows hit/miss feedback with accuracy scoring.

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

## License

MIT
