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

test('destroying one instance does not break a sibling', () => {
    // Can't drive hits through the real audio pipeline from the vm
    // harness (no AudioContext, no getUserMedia), so we can't directly
    // observe per-instance counter divergence — a fuller isolation
    // test lives in the browser smoke-test step. What we CAN assert
    // from here: each instance gets its own API surface and destroy()
    // on one leaves the other's methods callable without throwing.
    // That's the minimum guarantee the factory needs to keep so
    // splitscreen can mount and unmount panels independently.
    const a = createNoteDetector();
    const b = createNoteDetector();

    // Sanity: each call returns a fresh API object (distinct closures).
    assert.notStrictEqual(a, b, 'each factory call should return a distinct API object');

    a.destroy();

    // Sibling instance should still be fully callable after destroy().
    assert.equal(b.isEnabled(), false);
    assert.doesNotThrow(() => b.getStats());
    assert.doesNotThrow(() => b.setChannel(0));
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
