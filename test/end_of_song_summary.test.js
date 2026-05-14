// End-of-song summary tests — exercise the song:ended listener that
// pops the post-song summary modal when audio finishes naturally with
// detection still on.
//
// The full audio + DOM pipeline isn't available in the vm sandbox, so
// these tests drive the subscription/handler directly via the same
// `_bind*` / `_unbind*` test hooks the drill tests use. Each test gets
// a fresh loader load so the slopsmith listener registry doesn't leak.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadDetectionCore } = require('./_loader');

test('_bindEndOfSongEvents() adds a song:ended listener on top of drill\'s', () => {
    // Contract: drill alone registers exactly one song:ended listener
    // (covered by drill_mode.test.js). Adding the end-of-song summary
    // subscription brings the count to two; the test pins that so a
    // future refactor doesn't silently collapse them onto a single
    // handler (the drill handler clears iteration state and is wrong
    // to use for surfacing the modal).
    const core = loadDetectionCore();
    const det = core.createNoteDetector();
    det._bindDrillEvents();
    assert.equal(core.slopsmith._listenerCount('song:ended'), 1, 'drill alone');
    det._bindEndOfSongEvents();
    assert.equal(core.slopsmith._listenerCount('song:ended'), 2, 'drill + end-of-song');
    // Idempotent — calling again must not double-bind.
    det._bindEndOfSongEvents();
    assert.equal(core.slopsmith._listenerCount('song:ended'), 2, 'second bind is a no-op');
    det.destroy();
});

test('_unbindEndOfSongEvents() removes only the end-of-song listener', () => {
    const core = loadDetectionCore();
    const det = core.createNoteDetector();
    det._bindDrillEvents();
    det._bindEndOfSongEvents();
    assert.equal(core.slopsmith._listenerCount('song:ended'), 2);
    det._unbindEndOfSongEvents();
    // Drill listener survives — destroy() is the only thing that
    // tears that down.
    assert.equal(core.slopsmith._listenerCount('song:ended'), 1, 'drill listener survives');
    // Idempotent.
    det._unbindEndOfSongEvents();
    assert.equal(core.slopsmith._listenerCount('song:ended'), 1, 'second unbind is a no-op');
    det.destroy();
});

test('destroy() unbinds both drill and end-of-song listeners', () => {
    const core = loadDetectionCore();
    const det = core.createNoteDetector();
    det._bindDrillEvents();
    det._bindEndOfSongEvents();
    assert.equal(core.slopsmith._listenerCount('song:ended'), 2);
    det.destroy();
    assert.equal(core.slopsmith._listenerCount('song:ended'), 0);
});

test('song:ended on a disabled instance does not throw', () => {
    // Detection disabled = no in-flight session. The handler is
    // expected to bail early on `if (!enabled) return;` rather than
    // try to render a summary against zeroed counters. Tests against
    // a regression where the guard was removed and showSummary tried
    // to DOM-write into the (stubbed) sandbox elements, which throws.
    const core = loadDetectionCore();
    const det = core.createNoteDetector();
    det._bindEndOfSongEvents();
    // isEnabled() defaults to false in the vm — confirms the
    // precondition rather than depending on it implicitly.
    assert.equal(det.isEnabled(), false);
    assert.doesNotThrow(() => {
        core.slopsmith._fire('song:ended', {});
    });
    det.destroy();
});
