const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadDetectionCore } = require('./_loader');

const core = loadDetectionCore();

test('classifyTiming uses signed millisecond errors', () => {
    assert.equal(core.classifyTiming(0, 100), 'OK');
    assert.equal(core.classifyTiming(100, 100), 'OK');
    assert.equal(core.classifyTiming(-101, 100), 'EARLY');
    assert.equal(core.classifyTiming(101, 100), 'LATE');
    assert.equal(core.classifyTiming(null, 100), null);
});

test('classifyPitch uses signed cent errors', () => {
    assert.equal(core.classifyPitch(0, 20), 'OK');
    assert.equal(core.classifyPitch(-20, 20), 'OK');
    assert.equal(core.classifyPitch(21, 20), 'SHARP');
    assert.equal(core.classifyPitch(-21, 20), 'FLAT');
    assert.equal(core.classifyPitch(null, 20), null);
});

test('makeJudgment marks a clean matched note as hit', () => {
    const j = core.makeJudgment({
        matched: true,
        note: { s: 1, f: 3 },
        noteTime: 10,
        judgedAt: 10.04,
        expectedMidi: 48,
        detectedMidi: 48.1,
        pitchError: 10,
        timingThresholdMs: 100,
        pitchThresholdCents: 20,
        confidence: 0.9,
    });
    assert.equal(j.hit, true);
    assert.equal(j.timingState, 'OK');
    assert.equal(j.timingError, 40);
    assert.equal(j.pitchState, 'OK');
    assert.equal(j.pitchError, 10);
    assert.deepEqual(j.note, { s: 1, f: 3 });
});

test('makeJudgment preserves independent timing and pitch failures', () => {
    const j = core.makeJudgment({
        matched: true,
        noteTime: 10,
        judgedAt: 10.14,
        pitchError: -35,
        timingThresholdMs: 100,
        pitchThresholdCents: 20,
    });
    assert.equal(j.hit, false);
    assert.equal(j.timingState, 'LATE');
    assert.equal(j.timingError, 140);
    assert.equal(j.pitchState, 'FLAT');
    assert.equal(j.pitchError, -35);
});

test('makeJudgment represents an unmatched pure miss without pitch labels', () => {
    const j = core.makeJudgment({
        matched: false,
        note: { s: 2, f: 5 },
        noteTime: 12,
        judgedAt: 12.4,
        expectedMidi: 55,
    });
    assert.equal(j.hit, false);
    assert.equal(j.timingState, null);
    assert.equal(j.timingError, null);
    assert.equal(j.pitchState, null);
    assert.equal(j.pitchError, null);
    assert.equal(j.detectedAt, null);
    assert.equal(j.expectedMidi, 55);
});
