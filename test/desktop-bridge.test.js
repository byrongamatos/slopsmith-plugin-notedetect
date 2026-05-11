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

test('bridge path: chord scoring wiring — calls scoreChord IPC, never subscribes to onInputFrame', async () => {
    // The slopsmith-desktop release that unblocks polyphonic chord
    // scoring on Electron exposes audio.scoreChord — a request/reply
    // IPC that the native JUCE ChordScorer evaluates against the
    // engine's internal input ring. No audio buffers cross IPC.
    // We pin three things here:
    //  1. The bridge wins (no getUserMedia / Web-Audio fallback).
    //  2. scoreChord is actually invoked when a chord falls inside
    //     the timing tolerance window, with a request shape that
    //     mirrors the chart-note metadata.
    //  3. The removed onInputFrame push-stream surface is never
    //     subscribed — the stub throws if called so a regression
    //     resurfacing the streaming path would trip immediately.
    // Chord-scoring accuracy itself is covered by chord-detection.
    // test.js against the JS reference implementation that backs the
    // browser path.
    const calls = {
        isAvailable: 0,
        isAudioRunning: 0,
        startAudio: 0,
        getPitchDetection: 0,
        getLevels: 0,
        getSampleRate: 0,
        scoreChord: 0,
        onInputFrame: 0,
        getUserMedia: 0,
    };
    const scoreChordRequests = [];
    let capturedDetectTick = null;
    const { createNoteDetector } = loadDetectionCore({
        sandboxBeforeRun(sandbox) {
            sandbox.navigator.mediaDevices.getUserMedia = () => {
                calls.getUserMedia++;
                return Promise.reject(new Error('getUserMedia should not be called when bridge is fully wired'));
            };
            // Capture the bridge's detect interval callback so the
            // test can drive a single tick synchronously. The default
            // sandbox stub returns 0 without storing the callback,
            // which is fine for tests that only care about enable/
            // disable lifecycle but blocks this one from observing
            // scoreChord being called. startAudio() also schedules
            // a separate level-meter interval after the detect one,
            // so we capture only the first callback (the detect tick).
            let intervalSeq = 0;
            sandbox.setInterval = (cb) => {
                intervalSeq += 1;
                if (intervalSeq === 1 && typeof cb === 'function') {
                    capturedDetectTick = cb;
                }
                return intervalSeq;
            };
            // Highway returns a single three-note chord at t=0 inside
            // the default 100 ms timing-tolerance window, so the
            // bridge's detect tick routes it through matchNotes()'s
            // chord branch (group.length >= 2).
            sandbox.highway.getChords = () => ([
                { t: 0, notes: [
                    { s: 0, f: 0 },
                    { s: 1, f: 0 },
                    { s: 2, f: 0 },
                ]},
            ]);
            sandbox.window.slopsmithDesktop = {
                isDesktop: true,
                platform: 'linux',
                audio: {
                    isAvailable: async () => { calls.isAvailable++; return true; },
                    isAudioRunning: async () => { calls.isAudioRunning++; return true; },
                    startAudio: async () => { calls.startAudio++; },
                    getPitchDetection: async () => {
                        calls.getPitchDetection++;
                        return { midiNote: -1, confidence: 0, frequency: -1, cents: 0, noteName: '' };
                    },
                    getLevels: async () => {
                        calls.getLevels++;
                        return { inputLevel: 0.0, inputPeak: 0.0, outputLevel: 0, outputPeak: 0 };
                    },
                    getSampleRate: async () => { calls.getSampleRate++; return 48000; },
                    scoreChord: async (ctx) => {
                        calls.scoreChord++;
                        scoreChordRequests.push(ctx);
                        return {
                            score: 0,
                            hitStrings: 0,
                            totalStrings: ctx.notes.length,
                            isHit: false,
                            results: ctx.notes.map(n => ({
                                s: n.s, f: n.f, hit: false,
                                bandEnergy: 0, centsDiff: null, centsError: null,
                            })),
                        };
                    },
                    // Regression guard: the previous implementation
                    // subscribed to this push stream. The new path
                    // dispatches scoreChord on demand instead, so any
                    // call here is a bug — throw loudly.
                    onInputFrame: () => {
                        calls.onInputFrame++;
                        throw new Error('bridge should not subscribe to onInputFrame on the scoreChord path');
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
    assert.equal(calls.onInputFrame, 0, 'onInputFrame must not be invoked on the scoreChord path');
    assert.equal(typeof capturedDetectTick, 'function',
        'bridge detect interval should register a callback we can drive');

    // Drive one detect cycle and let the awaited IPC chain settle.
    await capturedDetectTick();
    await flushPendingAsync();

    assert.equal(calls.scoreChord, 1, 'scoreChord should be invoked exactly once for the single chord tick');
    assert.equal(calls.onInputFrame, 0, 'onInputFrame still not called after a chord tick');
    const req = scoreChordRequests[0];
    assert.ok(req && Array.isArray(req.notes), 'scoreChord request should carry a notes array');
    assert.equal(req.notes.length, 3, 'request should mirror the 3-note chord');
    // JSON round-trip neutralises the sandbox/test realm split that
    // makes structural deepEqual flaky on objects constructed inside
    // the vm context (different Object.prototype). The shape and
    // values are what matter.
    assert.equal(
        JSON.stringify(req.notes.map(n => ({ s: n.s, f: n.f }))),
        JSON.stringify([{ s: 0, f: 0 }, { s: 1, f: 0 }, { s: 2, f: 0 }]),
        'request notes should preserve chord shape',
    );
    assert.ok(Array.isArray(req.offsets), 'request should include tuning offsets');

    det.destroy();
    await flushPendingAsync();
});

test('bridge path: downlevel desktop without scoreChord — chord branch silently skips, monophonic still works', async () => {
    // Compatibility guard: an older slopsmith-desktop build can
    // expose getPitchDetection (monophonic path) without yet shipping
    // audio.scoreChord. The plugin should still take the bridge path
    // for monophonic detection (no getUserMedia fallback) and just
    // skip the chord branch silently — no throws, no crashes,
    // chord-group ticks return without recording judgments.
    const calls = {
        isAvailable: 0,
        getPitchDetection: 0,
        getSampleRate: 0,
        getUserMedia: 0,
    };
    let capturedDetectTick = null;
    const { createNoteDetector } = loadDetectionCore({
        sandboxBeforeRun(sandbox) {
            sandbox.navigator.mediaDevices.getUserMedia = () => {
                calls.getUserMedia++;
                return Promise.reject(new Error('getUserMedia should not be called on the downlevel bridge path'));
            };
            let intervalSeq = 0;
            sandbox.setInterval = (cb) => {
                intervalSeq += 1;
                if (intervalSeq === 1 && typeof cb === 'function') {
                    capturedDetectTick = cb;
                }
                return intervalSeq;
            };
            // Same 3-note chord at t=0 as the happy-path test.
            sandbox.highway.getChords = () => ([
                { t: 0, notes: [
                    { s: 0, f: 0 },
                    { s: 1, f: 0 },
                    { s: 2, f: 0 },
                ]},
            ]);
            sandbox.window.slopsmithDesktop = {
                isDesktop: true,
                platform: 'linux',
                audio: {
                    // Deliberately omit scoreChord (and onInputFrame —
                    // any older build that lacked scoreChord would
                    // also lack the streaming surface in this
                    // configuration).
                    isAvailable: async () => { calls.isAvailable++; return true; },
                    isAudioRunning: async () => true,
                    startAudio: async () => {},
                    getPitchDetection: async () => {
                        calls.getPitchDetection++;
                        return { midiNote: -1, confidence: 0, frequency: -1, cents: 0, noteName: '' };
                    },
                    getLevels: async () => ({ inputLevel: 0, inputPeak: 0, outputLevel: 0, outputPeak: 0 }),
                    getSampleRate: async () => { calls.getSampleRate++; return 48000; },
                },
            };
        },
    });

    const det = createNoteDetector({ isDefault: false });
    await det.enable();
    await flushPendingAsync();

    assert.equal(calls.getUserMedia, 0, 'downlevel bridge should still take the bridge path, not fall back to getUserMedia');
    assert.equal(typeof capturedDetectTick, 'function', 'bridge detect interval should still register');

    // Drive a chord tick. The chord branch must short-circuit (no
    // scoreChord to call) without throwing. The single-note path is
    // also a no-op (getPitchDetection returns midi=-1), so the tick
    // completes cleanly and the test simply asserts no exception
    // propagated out of the async call.
    await assert.doesNotReject(async () => {
        await capturedDetectTick();
        await flushPendingAsync();
    }, 'downlevel chord tick must not throw');

    det.destroy();
    await flushPendingAsync();
});
