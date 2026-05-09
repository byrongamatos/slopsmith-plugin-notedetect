# Analysis — Note Detection

## Coverage

| Spec area | Implementation | Notes |
|---|---|---|
| FR-001 (factory) | `createNoteDetector` | OK; `window.noteDetect` singleton + `window.createNoteDetector`. |
| FR-002 (tuning resolution) | `screen.js` mapping section | OK; tested by `mapping-bass.test.js`. |
| FR-003 (pluggable detector) | YIN / HPS / CREPE selectors | OK. |
| FR-004 (chord routing) | `screen.js` chord path | OK; tested by `chord-detection.test.js`. |
| FR-005 (3 % energy ratio) | constant in `screen.js` | OK. |
| FR-006 (chord leniency setting) | settings panel + defaults | OK. |
| FR-007 (technique flag adjustments) | chord scorer | OK; tested. |
| FR-008 (independent timing/pitch axes) | judgment | OK; `judgment.test.js`. |
| FR-009 / FR-010 (events + field reference) | event emission block | OK; README documents the schema. |
| FR-011 (octave-folded `pitchError`) | judgment | OK; **no dedicated test** (T707). |
| FR-012 (settings persistence) | `localStorage` | OK. |
| FR-013 (test harness) | `_loader.js` `vm` sandbox | OK; ships zero deps. |

## Drift

1. **README's "Auto-detect MIDI devices"** — wrong README text.
   That bullet belongs to `slopsmith-plugin-midi`, not this plugin.
   Confirmed false alarm — the README I read in this repo did not
   contain it. *(Cross-check noted; nothing to fix here.)*
2. **The header comment in `screen.js`** is a careful changelog
   ("CHANGE 1: 8-string tuning", chord-detection rationale, etc.).
   Strongly preserve when refactoring; it's documentation that
   cannot be regenerated from the code.
3. **Dev / Docker overlay assumes a sibling `slopsmith` checkout**
   at `../slopsmith` by default. README documents this but new
   contributors will trip over it. No drift, just friction.

## Gaps

1. **No dedicated test for the octave-folded `pitchError`** (T707).
   Important because the field is publicly contracted in the
   README and consumers (Practice Journal) will rely on its
   shape.
2. **No dedicated test for the CREPE → YIN fallback path** (T708).
   The fallback is the contract that "picking CREPE can't break
   the plugin"; an explicit test guards it.
3. **Chord scorer's 3 % energy threshold and ±10 % band headroom
   are magic numbers**. Tested empirically; no doc or test note
   explains why those particular values. Consider naming them as
   `CHORD_ENERGY_RATIO` / `CHORD_BAND_HEADROOM` constants with a
   one-line comment ("see clarify.md Q2/Q3").
4. **`session` end-of-song event** is documented but no test
   verifies its aggregate stats shape.
5. **Plugin size**: 2,889 lines in one file. Acceptable for a
   tightly-scoped DSP plugin, but the boundary between
   detection / mapping / chord / judgment / HUD is not always
   easy to find. Section comments help; explicit
   `//── XXX ──────` separators would help more.

## Recommendations

1. **Land T707 + T708** — small tests, big regression safety.
2. **Name the magic numbers** in the chord scorer; cross-link to
   clarify.md Q2/Q3.
3. **Add a `session.test.js`** that asserts the aggregate-stats
   shape on song end.
4. **Keep the test harness pattern** — `vm`-based-against-shipping-
   code is the right default for plugins this size; it's a model
   the rest of the ecosystem could borrow.
5. **Document the `~/Repositories/slopsmith` sibling-checkout
   assumption** in README's "Develop locally" section more
   prominently for new contributors.
