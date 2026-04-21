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

test('bass E1 (MIDI 28) in bass arrangement maps to open E (string 0, fret 0)', () => {
    const r = core.midiToStringFret(BASS_E1, 'bass');
    assert.equal(r.string, 0, `got ${JSON.stringify(r)}`);
    assert.equal(r.fret, 0);
});

test('bass A1 (MIDI 33) in bass arrangement maps to open A (string 1, fret 0)', () => {
    const r = core.midiToStringFret(BASS_A1, 'bass');
    assert.equal(r.string, 1, `got ${JSON.stringify(r)}`);
    assert.equal(r.fret, 0);
});

test('bass D2 (MIDI 38) in bass arrangement maps to open D (string 2, fret 0)', () => {
    const r = core.midiToStringFret(BASS_D2, 'bass');
    assert.equal(r.string, 2, `got ${JSON.stringify(r)}`);
    assert.equal(r.fret, 0);
});

test('bass G2 (MIDI 43) in bass arrangement prefers open G-string over fretted A-string', () => {
    // In a guitar arrangement the same MIDI note looks like fret 3 on the
    // low-E string. In a bass arrangement it should be the open G string —
    // the mapping must look up bass tuning base AND prefer lower frets.
    const r = core.midiToStringFret(BASS_G2, 'bass');
    assert.equal(r.string, 3, `expected G string open; got ${JSON.stringify(r)}`);
    assert.equal(r.fret, 0);
});

test('5-string bass low B (MIDI 23) in bass arrangement maps below the 4-string range', () => {
    // 4-string bass can't play B0; plugin should still not silently drop the
    // detection — either return string 0 fret negative (invalid) or surface
    // it via a distinct marker. The current 4-string bass tuning table makes
    // this "out of range"; 5-string support is a later phase.
    const r = core.midiToStringFret(BASS_B0, 'bass');
    assert.equal(r.string, -1, `expected out-of-range for 4-string bass; got ${JSON.stringify(r)}`);
});
