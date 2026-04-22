// Structural tests for the createNoteDetector factory.
//
// The factory is designed so that splitscreen and other multi-panel
// plugins can instantiate independent detectors. These tests don't
// exercise the audio pipeline (the vm sandbox lacks AudioContext /
// getUserMedia) — instead they lock in the public API shape, the
// independence of per-instance state, and the destroy() contract.
// Audio / DOM behavior is validated manually in a real browser; see
// the PR body's test plan.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadDetectionCore } = require('./_loader');

const { createNoteDetector } = loadDetectionCore();

test('createNoteDetector returns the documented API surface', () => {
    const det = createNoteDetector();
    const expected = ['enable', 'disable', 'destroy', 'isEnabled', 'getStats', 'setChannel', 'injectButton', 'showSummary'];
    for (const name of expected) {
        assert.equal(typeof det[name], 'function', `missing method: ${name}`);
    }
    det.destroy();
});

test('isEnabled() returns false on a freshly-created instance', () => {
    const det = createNoteDetector();
    assert.equal(det.isEnabled(), false);
    det.destroy();
});

test('getStats() returns the documented shape before any detection', () => {
    const det = createNoteDetector();
    const s = det.getStats();
    assert.equal(typeof s.hits, 'number');
    assert.equal(typeof s.misses, 'number');
    assert.equal(typeof s.streak, 'number');
    assert.equal(typeof s.bestStreak, 'number');
    assert.equal(typeof s.accuracy, 'number');
    assert.ok(Array.isArray(s.sectionStats), 'sectionStats should be an array');
    // Fresh instance has zero counters.
    assert.equal(s.hits, 0);
    assert.equal(s.misses, 0);
    assert.equal(s.accuracy, 0);
    det.destroy();
});

test('destroy() is idempotent — calling twice does not throw', () => {
    const det = createNoteDetector();
    det.destroy();
    // Second call must not throw; instance should accept it silently.
    assert.doesNotThrow(() => det.destroy());
});

test('destroy() after disable() is safe even though disable was a no-op', () => {
    const det = createNoteDetector();
    // disable() with the instance never enabled is a no-op — destroy()
    // still has to clean up draw hooks and the registry.
    det.disable();
    assert.doesNotThrow(() => det.destroy());
});

test('multiple instances have independent state (getStats)', () => {
    // Two detectors created simultaneously — verify their stats objects
    // are distinct closures. We can't drive hits through the real audio
    // pipeline from this harness, but we can confirm the stats-object
    // identity is per-instance and that destroying one doesn't leak
    // into the other.
    const a = createNoteDetector();
    const b = createNoteDetector();

    const statsA = a.getStats();
    const statsB = b.getStats();
    assert.notStrictEqual(statsA, statsB, 'stats objects should be distinct per instance');
    assert.notStrictEqual(statsA.sectionStats, statsB.sectionStats,
        'sectionStats arrays should be distinct per instance');

    a.destroy();
    // b should still be usable after a.destroy()
    assert.equal(b.isEnabled(), false);
    assert.doesNotThrow(() => b.getStats());
    b.destroy();
});

test('setChannel() does not throw on a disabled instance', () => {
    const det = createNoteDetector();
    // Instance is disabled — setChannel should update the setting but
    // not try to restart audio that was never started. Must not throw.
    assert.doesNotThrow(() => det.setChannel(0));
    assert.doesNotThrow(() => det.setChannel(1));
    assert.doesNotThrow(() => det.setChannel(-1));
    det.destroy();
});
