// Proves: the plugin's MIDI -> (string, fret) mapping cannot represent bass notes.
//
// The plugin hardcodes a 6-string guitar tuning in screen.js:
//   const _ndStandardMidi = [40, 45, 50, 55, 59, 64]; // E2 A2 D3 G3 B3 E4
// and iterates only strings 0..5 looking for a fret 0..24 match. Bass
// fundamentals (E1=28, A1=33, D2=38, G2=43 with bass G2=43 the sole overlap)
// fall below MIDI 40 and always return {string: -1, fret: -1}, meaning
// detected bass notes are silently dropped by _ndMatchNotes() no matter how
// accurate YIN is.
//
// These tests describe the required behavior; they will fail until the plugin
// switches its tuning base on arrangement type.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadDetectionCore } = require('./_loader');

const core = loadDetectionCore();

// MIDI numbers for 4-string bass standard tuning (E1 A1 D2 G2)
const BASS_E1 = 28;
const BASS_A1 = 33;
const BASS_D2 = 38;
const BASS_G2 = 43;

// MIDI for 5-string bass low B (B0)
const BASS_B0 = 23;

test('guitar E2 (MIDI 40) maps to string 0, fret 0 — baseline', () => {
    const r = core.midiToStringFret(40);
    assert.equal(r.string, 0);
    assert.equal(r.fret, 0);
});

test('guitar A2 (MIDI 45) resolves to a valid guitar fingering — baseline', () => {
    // MIDI 45 can be string 0 fret 5 OR string 1 fret 0 (open A). Plugin's
    // first-match-wins tie-break picks string 0 fret 5. Document, don't judge.
    const r = core.midiToStringFret(45);
    assert.ok(r.string >= 0 && r.string <= 5, `got string=${r.string}`);
    assert.ok(r.fret >= 0 && r.fret <= 24, `got fret=${r.fret}`);
});

test('bass E1 (MIDI 28) should map to a valid string/fret — currently drops note', () => {
    const r = core.midiToStringFret(BASS_E1);
    assert.notEqual(r.string, -1, `bass E1 was dropped (got ${JSON.stringify(r)}); plugin never awards hit`);
    assert.notEqual(r.fret, -1);
});

test('bass A1 (MIDI 33) should map to a valid string/fret', () => {
    const r = core.midiToStringFret(BASS_A1);
    assert.notEqual(r.string, -1, `bass A1 was dropped (got ${JSON.stringify(r)})`);
    assert.notEqual(r.fret, -1);
});

test('bass D2 (MIDI 38) should map to a valid string/fret', () => {
    const r = core.midiToStringFret(BASS_D2);
    assert.notEqual(r.string, -1, `bass D2 was dropped (got ${JSON.stringify(r)})`);
    assert.notEqual(r.fret, -1);
});

test('bass G2 (MIDI 43) — ambiguous: overlaps guitar low-E fret 3; must prefer bass open-string in bass arrangement', () => {
    // In a guitar arrangement the open-G-bass frequency matches guitar E2 + 3 frets.
    // A bass-aware mapping should, for a Bass arrangement, report string=3 (G) fret=0,
    // not string=0 (E-guitar) fret=3.
    const r = core.midiToStringFret(BASS_G2);
    // Currently this returns {string: 0, fret: 3} (guitar interpretation).
    // Asserting the bass interpretation documents the expected fix.
    assert.equal(r.string, 3, `expected G string open (arrangement-aware); got ${JSON.stringify(r)}`);
    assert.equal(r.fret, 0);
});

test('5-string bass low B (MIDI 23) should map to a valid string/fret', () => {
    const r = core.midiToStringFret(BASS_B0);
    assert.notEqual(r.string, -1, `bass B0 was dropped (got ${JSON.stringify(r)})`);
    assert.notEqual(r.fret, -1);
});
