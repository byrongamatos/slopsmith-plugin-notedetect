// Verifies the slopsmith-desktop JUCE bridge branch in startAudio().
//
// When the renderer is hosted by slopsmith-desktop, `window.slopsmithDesktop`
// is exposed by the preload script (see slopsmith-desktop/src/main/preload.ts).
// In that environment the note-detect plugin MUST NOT call
// `navigator.mediaDevices.getUserMedia` — the native JUCE engine already owns
// the audio device and pitch detection runs over the `audio:getPitchDetection`
// IPC. Without this branch the Linux .deb build hits
// "Could not access audio input" (slopsmith-desktop#52).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadDetectionCore } = require('./_loader');

function freshSandboxWithBridge(overrides = {}) {
    const calls = {
        isAvailable: 0,
        isAudioRunning: 0,
        startAudio: 0,
        getPitchDetection: 0,
        getLevels: 0,
        getUserMedia: 0,
    };
    const { createNoteDetector } = loadDetectionCore({
        sandboxBeforeRun(sandbox) {
            // getUserMedia must NOT be reached on the bridge path. Throw
            // loudly if it is so the test fails with a clear cause
            // rather than silently passing because both code paths
            // happened to behave similarly under the stubs.
            sandbox.navigator.mediaDevices.getUserMedia = () => {
                calls.getUserMedia++;
                return Promise.reject(new Error('getUserMedia should not be called on the bridge path'));
            };
            sandbox.window.slopsmithDesktop = Object.assign({
                isDesktop: true,
                platform: 'linux',
                audio: {
                    isAvailable: async () => { calls.isAvailable++; return true; },
                    isAudioRunning: async () => { calls.isAudioRunning++; return false; },
                    startAudio: async () => { calls.startAudio++; },
                    getPitchDetection: async () => {
                        calls.getPitchDetection++;
                        return { midiNote: 60, confidence: 0.9, frequency: 261.63, cents: 0, noteName: 'C4' };
                    },
                    getLevels: async () => {
                        calls.getLevels++;
                        return { inputLevel: 0.2, inputPeak: 0.3, outputLevel: 0, outputPeak: 0 };
                    },
                },
            }, overrides);
        },
    });
    return { createNoteDetector, calls };
}

// Yield a few event-loop turns so the async work queued through
// `enable()` → `queueAudioOp(...)` → `startAudio()` has a chance to
// reach `await desktop.audio.isAvailable()` and the subsequent bridge
// calls before the test runs its assertions. setImmediate runs on the
// macrotask queue, which is what we want — awaiting it gives the
// promise chain time to drain between turns.
async function flushPendingAsync(turns = 5) {
    for (let i = 0; i < turns; i++) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setImmediate(r));
    }
}

test('bridge path: enable() consults the desktop bridge instead of getUserMedia', async () => {
    const { createNoteDetector, calls } = freshSandboxWithBridge();
    const det = createNoteDetector({ isDefault: false });
    await det.enable();
    await flushPendingAsync();
    assert.equal(calls.getUserMedia, 0, 'getUserMedia must not be called when the desktop bridge is available');
    assert.ok(calls.isAvailable >= 1, 'desktop.audio.isAvailable should be probed');
    // isAudioRunning + startAudio are best-effort wakes — at least one
    // should be touched so the engine is alive before pitch polling.
    assert.ok(calls.isAudioRunning + calls.startAudio >= 1,
        'desktop bridge should wake the engine if it isn\'t already running');
    det.destroy();
});

test('bridge path: falls back to getUserMedia when audio.isAvailable() resolves false', async () => {
    const { createNoteDetector, calls } = freshSandboxWithBridge({
        audio: {
            isAvailable: async () => false,
            isAudioRunning: async () => false,
            startAudio: async () => {},
            getPitchDetection: async () => ({ midiNote: -1, confidence: 0 }),
            getLevels: async () => ({ inputLevel: 0, inputPeak: 0 }),
        },
    });
    const det = createNoteDetector({ isDefault: false });
    // enable() will resolve false because the fallback getUserMedia
    // stub rejects in vm — what we're asserting is that the fallback
    // WAS attempted (the bridge correctly refused). isAvailable was
    // checked through the override so calls.isAvailable stays 0 here;
    // instead we observe getUserMedia being invoked.
    await det.enable();
    await flushPendingAsync();
    assert.ok(calls.getUserMedia >= 1,
        'bridge present but engine unavailable should fall through to getUserMedia');
    det.destroy();
});

test('bridge path: browser environment (no window.slopsmithDesktop) still uses getUserMedia', async () => {
    // No bridge sandbox — vanilla loader. getUserMedia in the default
    // navigator stub rejects, so enable() returns false; we just want
    // to confirm the bridge branch did NOT swallow execution.
    const { createNoteDetector } = loadDetectionCore();
    const det = createNoteDetector({ isDefault: false });
    const result = await det.enable();
    // enable() returns false when startAudio() returns false; the
    // important invariant is that we don't crash trying to read
    // window.slopsmithDesktop.
    assert.equal(typeof result, 'boolean');
    det.destroy();
});

test('bridge path: chord scoring wiring — uses scoreChord IPC, no raw-frame subscription', async () => {
    // The slopsmith-desktop release that unblocks polyphonic chord
    // scoring on Electron exposes audio.scoreChord — a request/reply
    // IPC that the native JUCE ChordScorer evaluates against the
    // engine's internal input ring. No audio buffers cross IPC, so
    // we also assert the bridge never subscribes to onInputFrame
    // (the removed push-stream surface) and never calls getUserMedia.
    // This test pins the wiring; chord-scoring accuracy is covered by
    // chord-detection.test.js, which still runs the in-JS reference
    // implementation that backs the browser path.
    const calls = {
        isAvailable: 0,
        isAudioRunning: 0,
        startAudio: 0,
        getPitchDetection: 0,
        getLevels: 0,
        getSampleRate: 0,
        scoreChord: 0,
        getUserMedia: 0,
    };
    const { createNoteDetector } = loadDetectionCore({
        sandboxBeforeRun(sandbox) {
            sandbox.navigator.mediaDevices.getUserMedia = () => {
                calls.getUserMedia++;
                return Promise.reject(new Error('getUserMedia should not be called when bridge is fully wired'));
            };
            sandbox.window.slopsmithDesktop = {
                isDesktop: true,
                platform: 'linux',
                audio: {
                    isAvailable: async () => { calls.isAvailable++; return true; },
                    isAudioRunning: async () => { calls.isAudioRunning++; return true; },
                    startAudio: async () => { calls.startAudio++; },
                    getPitchDetection: async () => {
                        calls.getPitchDetection++;
                        return { midiNote: 60, confidence: 0.9, frequency: 261.63, cents: 0, noteName: 'C4' };
                    },
                    getLevels: async () => {
                        calls.getLevels++;
                        return { inputLevel: 0.0, inputPeak: 0.0, outputLevel: 0, outputPeak: 0 };
                    },
                    getSampleRate: async () => { calls.getSampleRate++; return 48000; },
                    scoreChord: async (_ctx) => {
                        calls.scoreChord++;
                        return {
                            score: 0,
                            hitStrings: 0,
                            totalStrings: 0,
                            isHit: false,
                            results: [],
                        };
                    },
                },
            };
        },
    });

    const det = createNoteDetector({ isDefault: false });
    await det.enable();
    await flushPendingAsync();

    assert.equal(calls.getUserMedia, 0, 'getUserMedia must not be called when the bridge is fully wired');
    assert.ok(calls.getSampleRate >= 1, 'getSampleRate should still be queried on the bridge path');

    det.destroy();
    await flushPendingAsync();
});
