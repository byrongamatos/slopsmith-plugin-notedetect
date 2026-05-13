#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Regression-harness driver for note_detect.
 *
 * The headless harness scores ONE (audio, chart, settings) combo per
 * run. Tuning iterations want to know "did my code change improve
 * detection across all my fixtures, or did I just overfit one?" —
 * which is what this driver does. It reads a fixtures file, runs the
 * harness against each entry, optionally diffs against a stored
 * baseline JSON, and reports a pass/fail summary.
 *
 *   node tools/regression.js                         # run all fixtures, print summary
 *   node tools/regression.js --baseline baseline.json  # compare against baseline
 *   node tools/regression.js --update-baseline baseline.json  # write current results back as the new baseline
 *
 * Fixtures live at tools/regression-fixtures.json — a list of
 * { name, audio, chart, args } entries. `audio` paths may be absolute
 * or relative-to-the-plugin-repo, so contributors who keep their
 * reference recordings under `static/note_detect_recordings/` of a
 * sibling slopsmith checkout can point at them via `../../static/...`.
 * Missing audio files are reported but don't crash the run — useful
 * for fixtures lists that bundle local + collaborator-private
 * recordings, where each contributor sees only what they have.
 *
 * The driver exits with code 1 if --baseline was supplied and any
 * fixture's hit count regressed. Useful for pre-PR self-checks; not
 * wired into npm test (yet) because the audio is contributor-private.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parseArgs } = require('node:util');

const { values: args } = parseArgs({
    options: {
        fixtures: { type: 'string', default: 'tools/regression-fixtures.json' },
        baseline: { type: 'string' },
        'update-baseline': { type: 'string' },
        verbose: { type: 'boolean', default: false },
        help: { type: 'boolean', default: false, short: 'h' },
    },
});

if (args.help) {
    process.stdout.write(`Usage: node tools/regression.js [options]\n\n` +
        `  --fixtures <path>          (default: tools/regression-fixtures.json)\n` +
        `  --baseline <path>          compare results against the JSON at <path>; exit 1 on regression\n` +
        `  --update-baseline <path>   write current results to <path> as the new baseline\n` +
        `  --verbose                  forward --verbose to each harness invocation\n`);
    process.exit(0);
}

const repoRoot = path.resolve(__dirname, '..');
const fixturesPath = path.resolve(repoRoot, args.fixtures);
if (!fs.existsSync(fixturesPath)) {
    process.stderr.write(`[regression] fixtures file not found: ${fixturesPath}\n`);
    process.stderr.write(`             Create one — see tools/regression-fixtures.example.json for shape.\n`);
    process.exit(2);
}
const fixtures = JSON.parse(fs.readFileSync(fixturesPath, 'utf8'));
if (!Array.isArray(fixtures) || fixtures.length === 0) {
    process.stderr.write(`[regression] fixtures file has no entries\n`);
    process.exit(2);
}

const harnessJs = path.resolve(__dirname, 'harness.js');
const results = [];

for (const fx of fixtures) {
    const audio = path.resolve(repoRoot, fx.audio);
    const chart = path.resolve(repoRoot, fx.chart);
    if (!fs.existsSync(audio)) {
        process.stdout.write(`[skip] ${fx.name}  (audio missing: ${fx.audio})\n`);
        results.push({ name: fx.name, status: 'skipped', reason: 'audio-missing' });
        continue;
    }
    if (!fs.existsSync(chart)) {
        process.stdout.write(`[skip] ${fx.name}  (chart missing: ${fx.chart})\n`);
        results.push({ name: fx.name, status: 'skipped', reason: 'chart-missing' });
        continue;
    }
    const tmpOut = path.join(require('node:os').tmpdir(), `regression_${process.pid}_${results.length}.json`);
    const argv = [harnessJs, '--audio', audio, '--chart', chart, '--out', tmpOut, ...(fx.args || [])];
    if (args.verbose) argv.push('--verbose');
    const run = spawnSync(process.execPath, argv, { encoding: 'utf8' });
    if (run.status !== 0) {
        process.stdout.write(`[fail] ${fx.name}  (harness exit ${run.status})\n`);
        if (args.verbose) process.stderr.write(run.stderr || '');
        results.push({ name: fx.name, status: 'error', reason: run.stderr || 'unknown' });
        continue;
    }
    const diag = JSON.parse(fs.readFileSync(tmpOut, 'utf8'));
    fs.unlinkSync(tmpOut);
    const hits = diag.summary.hits;
    const total = diag.summary.total;
    const pure = (diag.miss_breakdown || {}).pure || 0;
    const chord = (diag.miss_breakdown || {}).chordPartial || 0;
    results.push({
        name: fx.name, status: 'ok',
        hits, total, accuracy: total > 0 ? hits / total : 0,
        pure, chord,
    });
}

// Build comparison table.
const baseline = (args.baseline && fs.existsSync(path.resolve(repoRoot, args.baseline)))
    ? JSON.parse(fs.readFileSync(path.resolve(repoRoot, args.baseline), 'utf8'))
    : null;
const baselineMap = new Map();
if (baseline && baseline.results) {
    for (const r of baseline.results) baselineMap.set(r.name, r);
}

const colW = { name: 36, hits: 12, pure: 8, chord: 8, delta: 10 };
function pad(s, w) {
    s = String(s);
    return s.length >= w ? s : s + ' '.repeat(w - s.length);
}
process.stdout.write('\n');
process.stdout.write(
    pad('fixture', colW.name) +
    pad('hits/total', colW.hits) +
    pad('pure', colW.pure) +
    pad('chordP', colW.chord) +
    (baseline ? pad('Δhits', colW.delta) : '') +
    '\n');
process.stdout.write('-'.repeat(colW.name + colW.hits + colW.pure + colW.chord + (baseline ? colW.delta : 0)) + '\n');

let regressed = 0;
let improved = 0;
for (const r of results) {
    if (r.status !== 'ok') {
        process.stdout.write(pad(r.name, colW.name) + '  ' + r.status + ' (' + r.reason + ')\n');
        continue;
    }
    let deltaCell = '';
    if (baseline) {
        const b = baselineMap.get(r.name);
        if (b && Number.isFinite(b.hits)) {
            const d = r.hits - b.hits;
            if (d > 0) improved++;
            if (d < 0) regressed++;
            deltaCell = pad((d > 0 ? '+' : '') + d + ' (' + b.hits + '→' + r.hits + ')', colW.delta);
        } else {
            deltaCell = pad('new', colW.delta);
        }
    }
    process.stdout.write(
        pad(r.name, colW.name) +
        pad(`${r.hits}/${r.total} (${Math.round(r.accuracy * 100)}%)`, colW.hits) +
        pad(String(r.pure), colW.pure) +
        pad(String(r.chord), colW.chord) +
        deltaCell + '\n');
}

if (args['update-baseline']) {
    const outPath = path.resolve(repoRoot, args['update-baseline']);
    const payload = {
        schema: 'note_detect.regression.v1',
        generated_at: new Date().toISOString(),
        results: results.filter(r => r.status === 'ok'),
    };
    fs.writeFileSync(outPath, JSON.stringify(payload, null, 2) + '\n');
    process.stdout.write(`\nWrote new baseline → ${outPath}\n`);
}

if (baseline) {
    process.stdout.write(`\nvs baseline: ${improved} improved, ${regressed} regressed\n`);
    if (regressed > 0) process.exit(1);
}
