// Proves: YIN silently fails for low bass frequencies when given an
// undersized buffer.
//
// The plugin's Web Audio ScriptProcessor delivers 2048-sample frames
// (_ndFrameSize = 2048). screen.js accumulates frames until at least
// _ndMinYinSamples = 4096 before calling _ndYinDetect — but any bug in the
// accumulation path, a timing edge case at song start, or a shorter frame
// from a different input device would route an undersized buffer to YIN
// and it returns {freq: -1} for low frequencies without any diagnostic.
//
// YIN's halfLen = buffer.length / 2 caps the maximum detectable period to
// halfLen samples; at 48 kHz a 41.2 Hz period needs ~1165 samples, so a
// buffer of 2048 (halfLen 1024) cannot detect it. The plugin should either
// reject undersized buffers explicitly, signal a diagnostic, or detect
// adaptively. These tests document the current silent-fail behavior.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadDetectionCore } = require('./_loader');
const { sine } = require('./_signals');

const core = loadDetectionCore();
const SR = 48000;

test('YIN detects guitar E2 (82 Hz) with a single 2048-sample frame — baseline', () => {
    const buf = sine(82.4, SR, 2048 / SR);
    const r = core.yinDetect(buf, SR);
    assert.ok(r.freq > 0, 'expected detection, got nothing');
    assert.ok(Math.abs(r.freq - 82.4) < 2, `expected ~82.4, got ${r.freq}`);
});

test('YIN detects bass E1 (41 Hz) with a single 2048-sample frame — CURRENTLY FAILS SILENTLY', () => {
    const buf = sine(41.2, SR, 2048 / SR);
    const r = core.yinDetect(buf, SR);
    assert.ok(
        r.freq > 0,
        `bass E1 with 2048-sample buffer returned ${r.freq} (silent miss). ` +
        `Plugin should either adaptively enlarge the buffer or surface a "buffer too small" state.`
    );
});

test('YIN detects 5-string bass low B (31 Hz) with a single 2048-sample frame — CURRENTLY FAILS SILENTLY', () => {
    const buf = sine(30.87, SR, 2048 / SR);
    const r = core.yinDetect(buf, SR);
    assert.ok(r.freq > 0, `low-B returned ${r.freq} (silent miss)`);
});

test('YIN detects bass E1 (41 Hz) with 4096-sample buffer — the accumulated path works', () => {
    const buf = sine(41.2, SR, 4096 / SR);
    const r = core.yinDetect(buf, SR);
    assert.ok(r.freq > 0);
    assert.ok(Math.abs(r.freq - 41.2) < 0.5, `expected ~41.2, got ${r.freq}`);
});
