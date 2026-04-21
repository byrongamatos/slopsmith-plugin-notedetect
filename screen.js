// Note Detection plugin
// Captures guitar audio, detects pitch via CREPE or YIN, scores against highway notes.

// ── State ──────────────────────────────────────────────────────────────────
let _ndEnabled = false;
let _ndAudioCtx = null;
let _ndStream = null;
let _ndAnalyser = null;
let _ndWorklet = null;
let _ndModel = null;       // CREPE TF model
let _ndModelLoading = false;
let _ndDetectionMethod = 'yin'; // 'crepe' or 'yin' — start with YIN (instant), user can switch

// Settings
let _ndTimingTolerance = 0.150;  // seconds (wider default for real-world play)
let _ndPitchTolerance = 50;      // cents
let _ndInputGain = 1.0;
let _ndSelectedDeviceId = '';
let _ndSelectedChannel = 'mono'; // 'mono' | 'left' | 'right'
let _ndLatencyOffset = 0.080;    // seconds — compensates for audio input latency

// Audio level metering
let _ndInputLevel = 0;       // current RMS level 0-1
let _ndInputPeak = 0;        // peak hold level
let _ndPeakDecay = 0;        // decay timer for peak hold
let _ndLevelAnalyser = null;  // AnalyserNode for VU meter

// Scoring
let _ndHits = 0;
let _ndMisses = 0;
let _ndStreak = 0;
let _ndBestStreak = 0;
let _ndSectionStats = [];    // [{name, hits, misses}]
let _ndCurrentSection = null;

// Note tracking
let _ndNoteResults = new Map(); // key -> 'hit'|'miss'
let _ndDetectedMidi = -1;
let _ndDetectedConfidence = 0;
let _ndDetectedString = -1;
let _ndDetectedFret = -1;

// Tuning — standard tuning MIDI base per string, adjusted by arrangement offsets.
// Guitar: 6 strings, low E2 to high E4. Bass: 4 strings, low E1 to high G2
// (one octave below guitar low-4 minus the top two). Arrangement type is
// derived from song_info.arrangement name; see _ndSetArrangement.
const _ndStandardMidiGuitar = [40, 45, 50, 55, 59, 64]; // E2 A2 D3 G3 B3 E4
const _ndStandardMidiBass = [28, 33, 38, 43];           // E1 A1 D2 G2
let _ndCurrentArrangement = 'guitar';                   // 'guitar' | 'bass'
let _ndTuningOffsets = [0, 0, 0, 0, 0, 0];
let _ndCapo = 0;
let _ndUnderBufferWarned = false;

function _ndArrangementKindFromName(name) {
    return /bass/i.test(String(name || '')) ? 'bass' : 'guitar';
}

function _ndSetArrangement(name) {
    _ndCurrentArrangement = _ndArrangementKindFromName(name);
}

function _ndStandardMidiFor(arrangement) {
    return arrangement === 'bass' ? _ndStandardMidiBass : _ndStandardMidiGuitar;
}

// Audio processing — use native sample rate, accumulate samples for YIN
let _ndAccumBuffer = new Float32Array(0);  // accumulates samples across frames
const _ndMinYinSamples = 4096;  // enough for low E at 48kHz (need tau=585, halfLen=2048)
const _ndFrameSize = 2048;  // ScriptProcessor buffer size

// ── localStorage Persistence ──────────────────────────────────────────────

const _ndStorageKey = 'slopsmith_notedetect';

function _ndSaveSettings() {
    try {
        localStorage.setItem(_ndStorageKey, JSON.stringify({
            deviceId: _ndSelectedDeviceId,
            channel: _ndSelectedChannel,
            method: _ndDetectionMethod,
            timingTolerance: _ndTimingTolerance,
            pitchTolerance: _ndPitchTolerance,
            inputGain: _ndInputGain,
            latencyOffset: _ndLatencyOffset,
        }));
    } catch (e) { /* localStorage unavailable */ }
}

function _ndLoadSettings() {
    try {
        const raw = localStorage.getItem(_ndStorageKey);
        if (!raw) return;
        const s = JSON.parse(raw);
        if (s.deviceId !== undefined) _ndSelectedDeviceId = s.deviceId;
        if (s.channel) _ndSelectedChannel = s.channel;
        if (s.method) _ndDetectionMethod = s.method;
        if (s.timingTolerance !== undefined) _ndTimingTolerance = s.timingTolerance;
        if (s.pitchTolerance !== undefined) _ndPitchTolerance = s.pitchTolerance;
        if (s.inputGain !== undefined) _ndInputGain = s.inputGain;
        if (s.latencyOffset !== undefined) _ndLatencyOffset = s.latencyOffset;
    } catch (e) { /* ignore */ }
}

_ndLoadSettings();

// ── Pitch Detection: YIN ───────────────────────────────────────────────────
// Lightweight monophonic pitch detector — works instantly, no model to load.

// Lowest frequency we claim to detect. Below this and YIN's autocorrelation
// window needs to be longer than the input — at 48 kHz a 30 Hz period is
// ~1600 samples, so halfLen must exceed that, i.e. buffer must exceed ~3200.
const _ND_MIN_DETECTABLE_HZ = 30;

function _ndYinDetect(buffer, sampleRate, minFreqHz = _ND_MIN_DETECTABLE_HZ) {
    const threshold = 0.15;
    const halfLen = Math.floor(buffer.length / 2);
    const yinBuffer = new Float32Array(halfLen);

    // Surface "too-small buffer" as a distinct state from "no note detected"
    // so callers (and tests) can tell the two apart. Without this, a broken
    // accumulation path silently drops every bass note.
    const minHalfLenForFreq = Math.ceil(sampleRate / minFreqHz);
    const underBuffered = halfLen < minHalfLenForFreq;

    // Difference function
    let runningSum = 0;
    yinBuffer[0] = 1;
    for (let tau = 1; tau < halfLen; tau++) {
        let sum = 0;
        for (let i = 0; i < halfLen; i++) {
            const delta = buffer[i] - buffer[i + tau];
            sum += delta * delta;
        }
        yinBuffer[tau] = sum;
        runningSum += sum;
        yinBuffer[tau] *= tau / runningSum; // cumulative mean normalized
    }

    // Absolute threshold
    let tau = 2;
    while (tau < halfLen) {
        if (yinBuffer[tau] < threshold) {
            while (tau + 1 < halfLen && yinBuffer[tau + 1] < yinBuffer[tau]) tau++;
            break;
        }
        tau++;
    }
    if (tau === halfLen) return { freq: -1, confidence: 0, underBuffered };

    // Parabolic interpolation
    const s0 = tau > 0 ? yinBuffer[tau - 1] : yinBuffer[tau];
    const s1 = yinBuffer[tau];
    const s2 = tau + 1 < halfLen ? yinBuffer[tau + 1] : yinBuffer[tau];
    const betterTau = tau + (s0 - s2) / (2 * (s0 - 2 * s1 + s2));

    const freq = sampleRate / betterTau;
    const confidence = 1 - yinBuffer[tau];
    return { freq, confidence: Math.max(0, confidence), underBuffered };
}

// ── Pitch Detection: CREPE ─────────────────────────────────────────────────

async function _ndLoadCrepe() {
    if (_ndModel || _ndModelLoading) return;
    _ndModelLoading = true;

    const btn = document.getElementById('btn-notedetect');
    if (btn) btn.textContent = 'Detect (loading model...)';

    try {
        // Load TF.js if not present
        if (!window.tf) {
            await _ndLoadScript('https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.17.0/dist/tf.min.js');
        }
        // CREPE "tiny" model — monophonic pitch detection, ~4MB
        _ndModel = await tf.loadGraphModel(
            'https://tfhub.dev/google/tfjs-model/spice/2/default/1',
            { fromTFHub: true }
        );
        console.log('CREPE/SPICE model loaded');
    } catch (e1) {
        console.warn('SPICE TFHub load failed, trying CREPE backup:', e1);
        try {
            // Fallback: try loading CREPE from alternative CDN
            _ndModel = await tf.loadLayersModel(
                'https://cdn.jsdelivr.net/gh/nicksherron/crepe-js@master/model/model.json'
            );
            console.log('CREPE model loaded (fallback)');
        } catch (e2) {
            console.warn('All model loads failed, using YIN for this session:', e2);
            _ndModel = null;
            // Don't overwrite _ndDetectionMethod — keep the user's preference
            // so it retries next time. YIN is used as runtime fallback when _ndModel is null.
        }
    }
    _ndModelLoading = false;
    _ndUpdateButton();
}

function _ndLoadScript(src) {
    return new Promise((resolve, reject) => {
        if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
        const s = document.createElement('script');
        s.src = src;
        s.onload = resolve;
        s.onerror = reject;
        document.head.appendChild(s);
    });
}

async function _ndCrepeDetect(buffer) {
    if (!_ndModel) return { freq: -1, confidence: 0 };
    try {
        const input = tf.tensor(buffer, [1, buffer.length]);
        let outputs;
        // GraphModel (from loadGraphModel/TFHub) vs LayersModel (from loadLayersModel)
        if (_ndModel.execute) {
            outputs = _ndModel.execute(input);
        } else {
            outputs = _ndModel.predict(input);
        }

        // SPICE returns two tensors: [pitches, uncertainties]
        // Other CREPE models return a single tensor
        let freq = -1, confidence = 0;
        if (Array.isArray(outputs)) {
            const pitchData = await outputs[0].data();
            const uncData = outputs.length > 1 ? await outputs[1].data() : null;
            // SPICE pitch is in log scale: Hz = 2^(pitch * some_range) * base
            // The SPICE output is approximately: pitch_hz = 2^(5.661 * pitch_output + 4.0)
            // where pitch_output is in [0,1]
            const raw = pitchData[0];
            if (raw > 0 && raw < 1) {
                freq = Math.pow(2, 5.661 * raw + 4.0); // SPICE log-scale to Hz
            } else if (raw > 20) {
                freq = raw; // already Hz (some models output directly)
            }
            confidence = uncData ? Math.max(0, 1 - uncData[0]) : 0.8;
            outputs.forEach(t => t.dispose());
        } else {
            const pitchData = await outputs.data();
            const raw = pitchData[0];
            if (raw > 0 && raw < 1) {
                freq = Math.pow(2, 5.661 * raw + 4.0);
            } else if (raw > 20) {
                freq = raw;
            }
            confidence = pitchData.length > 1 ? Math.max(0, 1 - pitchData[1]) : 0.8;
            outputs.dispose();
        }
        input.dispose();

        if (freq < 20 || freq > 5000) return { freq: -1, confidence: 0 };
        return { freq, confidence };
    } catch (e) {
        return { freq: -1, confidence: 0 };
    }
}

// ── Audio Capture ──────────────────────────────────────────────────────────

async function _ndStartAudio() {
    try {
        const constraints = {
            audio: {
                echoCancellation: false,
                noiseSuppression: false,
                autoGainControl: false,
                channelCount: 2,  // request stereo for channel selection
            }
        };
        if (_ndSelectedDeviceId) {
            constraints.audio.deviceId = { exact: _ndSelectedDeviceId };
        }

        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            const isHttp = location.protocol === 'http:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1';
            const msg = isHttp
                ? 'Microphone access requires HTTPS. You are accessing Slopsmith over HTTP from a non-localhost address. Either:\n\n1. Use a reverse proxy with HTTPS (recommended)\n2. Access via localhost\n3. Add a self-signed certificate to the server'
                : 'Microphone access is not available in this browser. Use Chrome or Edge.';
            throw new Error(msg);
        }
        _ndStream = await navigator.mediaDevices.getUserMedia(constraints);
        // Use native sample rate — browsers often ignore non-standard rates,
        // and we need reliable timing for pitch detection
        _ndAudioCtx = new (window.AudioContext || window.webkitAudioContext)();

        const source = _ndAudioCtx.createMediaStreamSource(_ndStream);
        const streamChannels = source.channelCount;

        // Gain node for sensitivity control
        const gainNode = _ndAudioCtx.createGain();
        gainNode.gain.value = _ndInputGain;

        // Channel routing: split stereo into individual channels
        if (streamChannels >= 2 && _ndSelectedChannel !== 'mono') {
            const splitter = _ndAudioCtx.createChannelSplitter(2);
            source.connect(splitter);

            // Merge the selected channel back into mono for processing
            const merger = _ndAudioCtx.createChannelMerger(1);
            const chIdx = _ndSelectedChannel === 'left' ? 0 : 1;
            splitter.connect(merger, chIdx, 0);
            merger.connect(gainNode);
        } else {
            // Mono mix (default) — just connect directly
            source.connect(gainNode);
        }

        // AnalyserNode for VU meter (taps the signal after gain)
        _ndLevelAnalyser = _ndAudioCtx.createAnalyser();
        _ndLevelAnalyser.fftSize = 512;
        _ndLevelAnalyser.smoothingTimeConstant = 0.8;
        gainNode.connect(_ndLevelAnalyser);

        // ScriptProcessor only buffers audio — pitch detection runs off-thread
        // via setTimeout to avoid blocking the highway render loop.
        const processor = _ndAudioCtx.createScriptProcessor(_ndFrameSize, 1, 1);
        _ndWorklet = processor;
        _ndAccumBuffer = new Float32Array(0);
        _ndPendingBuffer = null; // latest ready buffer for detection

        processor.onaudioprocess = (e) => {
            if (!_ndEnabled) return;
            const input = e.inputBuffer.getChannelData(0);
            // Accumulate samples for low-frequency detection (need 4096 at 48kHz for low E)
            const prev = _ndAccumBuffer;
            const combined = new Float32Array(prev.length + input.length);
            combined.set(prev);
            combined.set(input, prev.length);
            if (combined.length >= _ndMinYinSamples) {
                // Store ready buffer — detection timer will pick it up
                const start = combined.length - _ndMinYinSamples;
                _ndPendingBuffer = combined.slice(start, start + _ndMinYinSamples);
                _ndAccumBuffer = new Float32Array(0);
            } else {
                _ndAccumBuffer = combined;
            }
        };

        // Detection runs on a timer, not in the audio callback
        _ndDetectInterval = setInterval(() => {
            if (_ndPendingBuffer) {
                const buf = _ndPendingBuffer;
                _ndPendingBuffer = null;
                _ndProcessFrame(buf);
            }
        }, 50); // ~20fps detection — plenty for note matching

        gainNode.connect(processor);
        processor.connect(_ndAudioCtx.destination); // must connect to keep processing alive

        // Start VU meter polling
        _ndStartLevelMeter();

        // Populate device selector
        _ndPopulateDevices();

        return true;
    } catch (e) {
        console.error('Note detect: mic access denied or failed:', e);
        alert('Note Detection: Could not access audio input.\n\n' + e.message);
        return false;
    }
}

let _ndDetectInterval = null;
let _ndPendingBuffer = null;

function _ndStopAudio() {
    _ndStopLevelMeter();
    if (_ndDetectInterval) { clearInterval(_ndDetectInterval); _ndDetectInterval = null; }
    _ndPendingBuffer = null;
    if (_ndWorklet) {
        _ndWorklet.disconnect();
        _ndWorklet = null;
    }
    _ndLevelAnalyser = null;
    if (_ndStream) {
        _ndStream.getTracks().forEach(t => t.stop());
        _ndStream = null;
    }
    if (_ndAudioCtx) {
        _ndAudioCtx.close();
        _ndAudioCtx = null;
    }
    _ndInputLevel = 0;
    _ndInputPeak = 0;
    _ndAccumBuffer = new Float32Array(0);
}

// ── Input Level Metering ──────────────────────────────────────────────────

let _ndLevelRaf = null;

function _ndStartLevelMeter() {
    _ndStopLevelMeter();
    const tick = () => {
        if (!_ndLevelAnalyser) return;
        const buf = new Float32Array(_ndLevelAnalyser.fftSize);
        _ndLevelAnalyser.getFloatTimeDomainData(buf);

        // RMS level
        let sum = 0;
        for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
        const rms = Math.sqrt(sum / buf.length);
        _ndInputLevel = Math.min(1, rms * 5); // scale up for visibility

        // Peak hold with decay
        if (_ndInputLevel > _ndInputPeak) {
            _ndInputPeak = _ndInputLevel;
            _ndPeakDecay = 30; // hold for ~30 frames
        } else if (_ndPeakDecay > 0) {
            _ndPeakDecay--;
        } else {
            _ndInputPeak *= 0.95;
        }

        // Update VU meter in settings panel if visible
        _ndDrawSettingsVU();

        _ndLevelRaf = requestAnimationFrame(tick);
    };
    _ndLevelRaf = requestAnimationFrame(tick);
}

function _ndStopLevelMeter() {
    if (_ndLevelRaf) {
        cancelAnimationFrame(_ndLevelRaf);
        _ndLevelRaf = null;
    }
}

function _ndDrawSettingsVU() {
    const bar = document.getElementById('nd-vu-bar');
    const peak = document.getElementById('nd-vu-peak');
    if (!bar) return;
    const pct = Math.round(_ndInputLevel * 100);
    bar.style.width = pct + '%';
    // Color: green < 60%, yellow 60-85%, red > 85%
    bar.className = pct > 85 ? 'h-full rounded transition-all duration-75 bg-red-500'
        : pct > 60 ? 'h-full rounded transition-all duration-75 bg-yellow-500'
        : 'h-full rounded transition-all duration-75 bg-green-500';
    if (peak) {
        const peakPct = Math.round(_ndInputPeak * 100);
        peak.style.left = Math.min(peakPct, 100) + '%';
    }
}

// ── Frame Processing ───────────────────────────────────────────────────────

async function _ndProcessFrame(buffer) {
    let result;
    const sr = _ndAudioCtx ? _ndAudioCtx.sampleRate : 48000;
    if (_ndDetectionMethod === 'crepe' && _ndModel) {
        result = await _ndCrepeDetect(buffer);
        // Fall back to YIN if CREPE returned nothing useful
        if (result.freq <= 0 || result.confidence < 0.3) {
            result = _ndYinDetect(buffer, sr);
        }
    } else {
        result = _ndYinDetect(buffer, sr);
    }

    if (result.freq <= 0 || result.confidence < 0.3) {
        if (result.underBuffered && !_ndUnderBufferWarned) {
            console.warn('[note_detect] YIN received an undersized buffer — low-frequency (bass) notes will drop silently. Check the frame accumulation path.');
            _ndUnderBufferWarned = true;
        }
        _ndDetectedMidi = -1;
        _ndDetectedConfidence = 0;
        _ndDetectedString = -1;
        _ndDetectedFret = -1;
        return;
    }

    _ndDetectedMidi = _ndFreqToMidi(result.freq);
    _ndDetectedConfidence = result.confidence;

    // _ndMatchNotes walks the chart candidates and assigns
    // _ndDetectedString/_ndDetectedFret via _ndResolveDisplayFingering
    // (chart-aware, with geometric fallback).
    _ndMatchNotes();
}

// ── Frequency / MIDI Conversion ────────────────────────────────────────────

function _ndFreqToMidi(freq) {
    return 12 * Math.log2(freq / 440) + 69;
}

function _ndMidiFromStringFret(string, fret, arrangement = _ndCurrentArrangement) {
    const base = _ndStandardMidiFor(arrangement);
    return base[string] + _ndTuningOffsets[string] + _ndCapo + fret;
}

function _ndMidiToStringFret(midiNote, arrangement = _ndCurrentArrangement) {
    // Pure geometric fallback: walk strings 0..N and return the first position
    // that matches the pitch. Used when there is no chart context available
    // (player noodling between chart notes). When a chart note is in play,
    // _ndResolveDisplayFingering picks the chart's (s, f) instead — see the
    // research notes in mapping-bass.test.js.
    const base = _ndStandardMidiFor(arrangement);
    let bestDist = Infinity;
    let bestString = -1;
    let bestFret = -1;
    for (let s = 0; s < base.length; s++) {
        const openMidi = base[s] + _ndTuningOffsets[s] + _ndCapo;
        const fret = Math.round(midiNote - openMidi);
        if (fret < 0 || fret > 24) continue;
        const dist = Math.abs(midiNote - (openMidi + fret));
        if (dist < bestDist) {
            bestDist = dist;
            bestString = s;
            bestFret = fret;
        }
    }
    return { string: bestString, fret: bestFret };
}

// Chart-context-aware fingering resolver. If any candidate chart note's
// expected pitch is within the pitch tolerance of the detected MIDI, return
// that note's (string, fret) — the player is hitting the charted fingering.
// Otherwise fall back to the geometric first-match on the arrangement's
// tuning. This mirrors what score-follower apps (e.g. Rocksmith) do: trust
// the chart for display when the player is on-pitch, only guess when they
// aren't.
function _ndResolveDisplayFingering(detectedMidi, candidateNotes, arrangement = _ndCurrentArrangement, pitchToleranceCents = _ndPitchTolerance) {
    if (candidateNotes && candidateNotes.length > 0) {
        for (const cn of candidateNotes) {
            const expected = _ndMidiFromStringFret(cn.s, cn.f, arrangement);
            if (Math.abs(detectedMidi - expected) * 100 <= pitchToleranceCents) {
                return { string: cn.s, fret: cn.f };
            }
        }
    }
    return _ndMidiToStringFret(detectedMidi, arrangement);
}

// ── Note Matching ──────────────────────────────────────────────────────────

function _ndNoteKey(note, time) {
    // Unique key for a note event
    return `${time.toFixed(3)}_${note.s}_${note.f}`;
}

// Binary search: find index of first element with .t >= target
function _ndBsearch(arr, target) {
    let lo = 0, hi = arr.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (arr[mid].t < target) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

function _ndMatchNotes() {
    // Compensate for audio input latency: the detected pitch corresponds to
    // what the player played ~latencyOffset ago, so shift the comparison window back.
    // Also add the core's A/V render offset so we match against the chart time
    // the user was visually aiming at (the highway's rendered time = getTime() +
    // avOffset). Without this, a non-zero A/V offset makes every detection miss
    // by exactly that offset, since getTime() returns the audio-aligned chart
    // time while the player is playing to the visually-shifted strum bar.
    const avOffsetSec = (highway.getAvOffset ? highway.getAvOffset() : 0) / 1000;
    const t = highway.getTime() + avOffsetSec - _ndLatencyOffset;
    if (_ndDetectedMidi < 0) return;

    const notes = highway.getNotes();
    const chords = highway.getChords();
    const tolerance = _ndTimingTolerance;
    const centsTolerance = _ndPitchTolerance;

    const candidateNotes = [];

    // Use binary search to jump to the relevant time region
    if (notes && notes.length > 0) {
        const start = _ndBsearch(notes, t - tolerance);
        for (let i = start; i < notes.length; i++) {
            const n = notes[i];
            if (n.t > t + tolerance) break;
            if (n.mt) continue; // skip muted notes
            candidateNotes.push({ s: n.s, f: n.f, t: n.t });
        }
    }
    if (chords && chords.length > 0) {
        const start = _ndBsearch(chords, t - tolerance);
        for (let i = start; i < chords.length; i++) {
            const c = chords[i];
            if (c.t > t + tolerance) break;
            for (const cn of (c.notes || [])) {
                if (cn.mt) continue;
                candidateNotes.push({ s: cn.s, f: cn.f, t: c.t });
            }
        }
    }

    // Resolve HUD/overlay fingering — prefer the chart's (s, f) when the
    // player is hitting a candidate pitch, otherwise fall back to the
    // geometric first-match on the arrangement's tuning.
    const disp = _ndResolveDisplayFingering(_ndDetectedMidi, candidateNotes, _ndCurrentArrangement, centsTolerance);
    _ndDetectedString = disp.string;
    _ndDetectedFret = disp.fret;

    // Check each candidate
    for (const cn of candidateNotes) {
        const key = _ndNoteKey(cn, cn.t);
        if (_ndNoteResults.has(key)) continue; // already judged

        const expectedMidi = _ndMidiFromStringFret(cn.s, cn.f);
        const detectedCents = (_ndDetectedMidi - expectedMidi) * 100;

        if (Math.abs(detectedCents) <= centsTolerance) {
            _ndNoteResults.set(key, 'hit');
            _ndHits++;
            _ndStreak++;
            if (_ndStreak > _ndBestStreak) _ndBestStreak = _ndStreak;
            _ndUpdateSectionStat('hit');
        }
    }
}

// Mark missed notes that have passed the timing window
function _ndCheckMisses() {
    if (!_ndEnabled) return;
    // Mirror _ndMatchNotes's time derivation so hit/miss are measured on the
    // same clock (visual-target time the player is actually aiming at).
    const avOffsetSec = (highway.getAvOffset ? highway.getAvOffset() : 0) / 1000;
    const t = highway.getTime() + avOffsetSec - _ndLatencyOffset;
    const tolerance = _ndTimingTolerance;
    const missDeadline = t - tolerance * 2; // notes older than this are missed
    const notes = highway.getNotes();
    const chords = highway.getChords();

    const checkNote = (s, f, noteTime) => {
        if (noteTime > missDeadline) return; // not yet past window
        const key = _ndNoteKey({ s, f }, noteTime);
        if (!_ndNoteResults.has(key)) {
            _ndNoteResults.set(key, 'miss');
            _ndMisses++;
            _ndStreak = 0;
            _ndUpdateSectionStat('miss');
        }
    };

    // Use binary search — only check notes in the region that could be newly missed
    // (between last check and current missDeadline)
    if (notes && notes.length > 0) {
        const start = _ndBsearch(notes, missDeadline - 1); // look back 1s
        for (let i = start; i < notes.length; i++) {
            const n = notes[i];
            if (n.t > missDeadline) break;
            if (n.mt) continue;
            checkNote(n.s, n.f, n.t);
        }
    }
    if (chords && chords.length > 0) {
        const start = _ndBsearch(chords, missDeadline - 1);
        for (let i = start; i < chords.length; i++) {
            const c = chords[i];
            if (c.t > missDeadline) break;
            for (const cn of (c.notes || [])) {
                if (cn.mt) continue;
                checkNote(cn.s, cn.f, c.t);
            }
        }
    }

    // Track current section
    const sections = highway.getSections();
    if (sections) {
        let current = null;
        for (const sec of sections) {
            if (sec.time <= t) current = sec.name;
            else break;
        }
        if (current && current !== _ndCurrentSection) {
            _ndCurrentSection = current;
            // Ensure section stats entry exists
            if (!_ndSectionStats.find(s => s.name === current)) {
                _ndSectionStats.push({ name: current, hits: 0, misses: 0 });
            }
        }
    }
}

function _ndUpdateSectionStat(type) {
    if (!_ndCurrentSection) return;
    let sec = _ndSectionStats.find(s => s.name === _ndCurrentSection);
    if (!sec) {
        sec = { name: _ndCurrentSection, hits: 0, misses: 0 };
        _ndSectionStats.push(sec);
    }
    if (type === 'hit') sec.hits++;
    else sec.misses++;
}

// ── Settings Panel ─────────────────────────────────────────────────────────

function _ndShowSettings() {
    let panel = document.getElementById('nd-settings-panel');
    if (panel) { panel.remove(); return; }

    const channelLabels = { mono: 'Mono (mix)', left: 'Left (Ch 1 — dry/DI)', right: 'Right (Ch 2 — wet)' };

    panel = document.createElement('div');
    panel.id = 'nd-settings-panel';
    panel.className = 'fixed top-16 right-4 z-[150] bg-dark-700 border border-gray-600 rounded-xl p-4 w-80 shadow-2xl text-sm';
    panel.innerHTML = `
        <div class="flex justify-between items-center mb-3">
            <span class="text-gray-200 font-semibold">Note Detection Settings</span>
            <button onclick="document.getElementById('nd-settings-panel').remove()" class="text-gray-500 hover:text-white">&times;</button>
        </div>

        <label class="block text-gray-400 text-xs mb-1">Audio Input Device</label>
        <select id="nd-device-select" class="w-full bg-dark-600 border border-gray-600 rounded px-2 py-1 text-xs text-gray-200 mb-2"
                onchange="_ndOnDeviceChange(this.value)">
            <option value="">Default</option>
        </select>

        <label class="block text-gray-400 text-xs mb-1">Input Channel</label>
        <select id="nd-channel-select" class="w-full bg-dark-600 border border-gray-600 rounded px-2 py-1 text-xs text-gray-200 mb-2"
                onchange="_ndOnChannelChange(this.value)">
            <option value="mono" ${_ndSelectedChannel === 'mono' ? 'selected' : ''}>Mono (mix both channels)</option>
            <option value="left" ${_ndSelectedChannel === 'left' ? 'selected' : ''}>Left (Ch 1) — typically dry/DI</option>
            <option value="right" ${_ndSelectedChannel === 'right' ? 'selected' : ''}>Right (Ch 2) — typically wet/FX</option>
        </select>

        <label class="block text-gray-400 text-xs mb-1">Input Level</label>
        <div class="relative h-3 bg-dark-600 rounded overflow-hidden mb-1">
            <div id="nd-vu-bar" class="h-full rounded transition-all duration-75 bg-green-500" style="width:0%"></div>
            <div id="nd-vu-peak" class="absolute top-0 w-0.5 h-full bg-white/70" style="left:0%"></div>
        </div>
        <div class="flex justify-between text-[9px] text-gray-600 mb-3">
            <span>-inf</span><span>-18dB</span><span>-6dB</span><span>0dB</span>
        </div>

        <label class="block text-gray-400 text-xs mb-1">Detection Method</label>
        <select id="nd-method-select" class="w-full bg-dark-600 border border-gray-600 rounded px-2 py-1 text-xs text-gray-200 mb-3"
                onchange="_ndSetMethod(this.value)">
            <option value="yin" ${_ndDetectionMethod === 'yin' ? 'selected' : ''}>YIN (lightweight, clean signals)</option>
            <option value="crepe" ${_ndDetectionMethod === 'crepe' ? 'selected' : ''}>CREPE/SPICE (robust, ~20MB model)</option>
        </select>

        <label class="block text-gray-400 text-xs mb-1">Audio Latency Offset: <span id="nd-latency-val">${Math.round(_ndLatencyOffset * 1000)}</span>ms</label>
        <input type="range" min="0" max="250" value="${Math.round(_ndLatencyOffset * 1000)}"
               class="w-full accent-green-400 mb-2"
               oninput="_ndLatencyOffset=this.value/1000;document.getElementById('nd-latency-val').textContent=this.value;_ndSaveSettings()">
        <div class="text-[10px] text-gray-600 mb-3 leading-tight">
            Compensates for USB/audio interface delay. Increase if notes register late.
        </div>

        <label class="block text-gray-400 text-xs mb-1">Timing Tolerance: <span id="nd-timing-val">${Math.round(_ndTimingTolerance * 1000)}</span>ms</label>
        <input type="range" min="30" max="300" value="${Math.round(_ndTimingTolerance * 1000)}"
               class="w-full accent-green-400 mb-3"
               oninput="_ndTimingTolerance=this.value/1000;document.getElementById('nd-timing-val').textContent=this.value;_ndSaveSettings()">

        <label class="block text-gray-400 text-xs mb-1">Pitch Tolerance: <span id="nd-pitch-val">${_ndPitchTolerance}</span> cents</label>
        <input type="range" min="10" max="100" value="${_ndPitchTolerance}"
               class="w-full accent-green-400 mb-3"
               oninput="_ndPitchTolerance=+this.value;document.getElementById('nd-pitch-val').textContent=this.value;_ndSaveSettings()">

        <label class="block text-gray-400 text-xs mb-1">Input Gain: <span id="nd-gain-val">${_ndInputGain.toFixed(1)}</span>x</label>
        <input type="range" min="1" max="50" value="${Math.round(_ndInputGain * 10)}"
               class="w-full accent-green-400 mb-3"
               oninput="_ndInputGain=this.value/10;document.getElementById('nd-gain-val').textContent=_ndInputGain.toFixed(1);_ndSaveSettings()">

        <div class="text-[10px] text-gray-600 mt-1 leading-tight">
            Tip: For multi-effects pedals with USB audio (e.g. Valeton GP-5), select <b>Left (Ch 1)</b> for the dry/DI signal — it gives the most accurate pitch detection.
        </div>
    `;

    document.body.appendChild(panel);
    _ndPopulateDevices();
}

function _ndOnDeviceChange(deviceId) {
    _ndSelectedDeviceId = deviceId;
    _ndSaveSettings();
    _ndRestartAudio();
}

function _ndOnChannelChange(channel) {
    _ndSelectedChannel = channel;
    _ndSaveSettings();
    _ndRestartAudio();
}

async function _ndPopulateDevices() {
    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const sel = document.getElementById('nd-device-select');
        if (!sel) return;
        sel.innerHTML = '<option value="">Default</option>';
        for (const d of devices) {
            if (d.kind !== 'audioinput') continue;
            const opt = document.createElement('option');
            opt.value = d.deviceId;
            opt.textContent = d.label || `Input ${d.deviceId.slice(0, 8)}`;
            if (d.deviceId === _ndSelectedDeviceId) opt.selected = true;
            sel.appendChild(opt);
        }
    } catch (e) { /* permission not yet granted */ }
}

async function _ndRestartAudio() {
    _ndStopAudio();
    if (_ndEnabled) await _ndStartAudio();
}

function _ndSetMethod(method) {
    _ndDetectionMethod = method;
    _ndSaveSettings();
    if (method === 'crepe') _ndLoadCrepe();
}

// ── Visual Feedback ────────────────────────────────────────────────────────
// Uses a DOM overlay HUD (works with both 2D and 3D highway) plus
// draw hook indicators on the 2D highway when project()/fretX() are available.

let _ndHitFlash = 0;   // green flash alpha
let _ndMissFlash = 0;  // red flash alpha
let _ndLastHitCount = 0;
let _ndLastMissCount = 0;

// DOM HUD overlay — positioned over the player, works with any renderer
function _ndCreateHUD() {
    if (document.getElementById('nd-hud')) return;
    const hud = document.createElement('div');
    hud.id = 'nd-hud';
    hud.className = 'absolute top-3 right-16 z-[20] pointer-events-none text-right';
    // Append inside the player so it layers correctly (player is z-index:100 fixed)
    const player = document.getElementById('player');
    if (!player) return;
    hud.innerHTML = `
        <div id="nd-hud-accuracy" class="text-xl font-bold" style="text-shadow:0 0 8px currentColor"></div>
        <div id="nd-hud-streak" class="text-xs text-gray-400 mt-0.5"></div>
        <div id="nd-hud-counts" class="text-[10px] text-gray-600 mt-0.5"></div>
        <div id="nd-hud-detected" class="text-[10px] text-cyan-400 mt-1 font-mono"></div>
    `;
    player.appendChild(hud);
}

function _ndRemoveHUD() {
    const hud = document.getElementById('nd-hud');
    if (hud) hud.remove();
    const flash = document.getElementById('nd-flash-overlay');
    if (flash) flash.remove();
}

function _ndCreateFlashOverlay() {
    if (document.getElementById('nd-flash-overlay')) return;
    const player = document.getElementById('player');
    if (!player) return;
    const flash = document.createElement('div');
    flash.id = 'nd-flash-overlay';
    flash.style.cssText = 'position:absolute;inset:0;z-index:20;pointer-events:none;border:4px solid transparent;transition:border-color 0.05s;';
    player.appendChild(flash);
}

// Update DOM HUD at 30fps (lighter than rAF)
let _ndHudInterval = null;

function _ndStartHUD() {
    _ndCreateHUD();
    _ndCreateFlashOverlay();
    _ndLastHitCount = 0;
    _ndLastMissCount = 0;
    if (_ndHudInterval) clearInterval(_ndHudInterval);
    _ndHudInterval = setInterval(_ndUpdateHUD, 33);
}

function _ndStopHUD() {
    if (_ndHudInterval) { clearInterval(_ndHudInterval); _ndHudInterval = null; }
    _ndRemoveHUD();
}

function _ndUpdateHUD() {
    if (!_ndEnabled) return;

    const total = _ndHits + _ndMisses;
    const accEl = document.getElementById('nd-hud-accuracy');
    const streakEl = document.getElementById('nd-hud-streak');
    const countsEl = document.getElementById('nd-hud-counts');
    const detectedEl = document.getElementById('nd-hud-detected');
    const flashEl = document.getElementById('nd-flash-overlay');

    if (accEl && total > 0) {
        const accuracy = Math.round((_ndHits / total) * 100);
        const color = accuracy >= 90 ? '#00ff88' : accuracy >= 70 ? '#ffcc00' : '#ff4444';
        accEl.textContent = accuracy + '%';
        accEl.style.color = color;
    } else if (accEl) {
        accEl.textContent = '';
    }

    if (streakEl) {
        let text = _ndStreak > 0 ? `${_ndStreak} streak` : '';
        if (_ndBestStreak > 0) text += `  best: ${_ndBestStreak}`;
        streakEl.textContent = text;
    }

    if (countsEl && total > 0) {
        countsEl.textContent = `${_ndHits} / ${total}`;
    }

    if (detectedEl) {
        if (_ndDetectedString >= 0 && _ndDetectedConfidence > 0.3) {
            const names = ['E2','A2','D3','G3','B3','E4'];
            detectedEl.textContent = `${names[_ndDetectedString] || '?'} fret ${_ndDetectedFret}`;
        } else {
            detectedEl.textContent = '';
        }
    }

    // Edge flash on hit/miss
    if (flashEl) {
        if (_ndHits > _ndLastHitCount) {
            flashEl.style.borderColor = 'rgba(0, 255, 136, 0.6)';
            setTimeout(() => { if (flashEl) flashEl.style.borderColor = 'transparent'; }, 80);
        } else if (_ndMisses > _ndLastMissCount) {
            flashEl.style.borderColor = 'rgba(255, 50, 68, 0.4)';
            setTimeout(() => { if (flashEl) flashEl.style.borderColor = 'transparent'; }, 80);
        }
        _ndLastHitCount = _ndHits;
        _ndLastMissCount = _ndMisses;
    }
}

// 2D highway draw hook — uses project()/fretX() for accurate positioning.
// Only draws when the 2D highway is active (these APIs exist on the highway object).
highway.addDrawHook(function(ctx, W, H) {
    if (!_ndEnabled) return;
    // Only draw note indicators if highway exposes projection (2D mode)
    if (!highway.project || !highway.fretX) return;

    const t = highway.getTime();
    const notes = highway.getNotes();
    const chords = highway.getChords();

    const drawIndicator = (s, f, noteTime, result) => {
        const tOff = noteTime - t;
        const p = highway.project(tOff);
        if (!p) return;
        const x = highway.fretX(f, p.scale, W);
        const y = p.y * H;

        const age = Math.abs(t - noteTime);
        const fade = Math.max(0, 1 - age / 0.6) * p.scale;
        if (fade <= 0) return;

        if (result === 'hit') {
            ctx.save();
            ctx.globalAlpha = fade * 0.7;
            ctx.shadowColor = '#00ff88';
            ctx.shadowBlur = 20 * p.scale;
            ctx.strokeStyle = '#00ff88';
            ctx.lineWidth = 3 * p.scale;
            ctx.beginPath();
            ctx.arc(x, y, 14 * p.scale, 0, Math.PI * 2);
            ctx.stroke();
            ctx.restore();
        } else if (result === 'miss') {
            ctx.save();
            ctx.globalAlpha = fade * 0.5;
            ctx.shadowColor = '#ff3344';
            ctx.shadowBlur = 12 * p.scale;
            ctx.strokeStyle = '#ff3344';
            ctx.lineWidth = 2 * p.scale;
            const sz = 8 * p.scale;
            ctx.beginPath();
            ctx.moveTo(x - sz, y - sz);
            ctx.lineTo(x + sz, y + sz);
            ctx.moveTo(x + sz, y - sz);
            ctx.lineTo(x - sz, y + sz);
            ctx.stroke();
            ctx.restore();
        }
    };

    // Draw results for recent notes
    if (notes) {
        for (const n of notes) {
            if (n.t < t - 0.5) continue;
            if (n.t > t + 3) break;
            if (n.mt) continue;
            const key = _ndNoteKey(n, n.t);
            const result = _ndNoteResults.get(key);
            if (result) drawIndicator(n.s, n.f, n.t, result);
        }
    }
    if (chords) {
        for (const c of chords) {
            if (c.t < t - 0.5) continue;
            if (c.t > t + 3) break;
            for (const cn of (c.notes || [])) {
                if (cn.mt) continue;
                const key = _ndNoteKey(cn, c.t);
                const result = _ndNoteResults.get(key);
                if (result) drawIndicator(cn.s, cn.f, c.t, result);
            }
        }
    }

    // Detected note indicator at the now line
    if (_ndDetectedString >= 0 && _ndDetectedConfidence > 0.3) {
        const p = highway.project(0); // now line
        if (p) {
            const x = highway.fretX(_ndDetectedFret, p.scale, W);
            const y = p.y * H;
            ctx.save();
            ctx.globalAlpha = Math.min(1, _ndDetectedConfidence);
            ctx.fillStyle = '#44ddff';
            ctx.shadowColor = '#44ddff';
            ctx.shadowBlur = 12;
            ctx.beginPath();
            ctx.arc(x, y, 6, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = '#000';
            ctx.font = 'bold 7px sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(_ndDetectedFret, x, y);
            ctx.restore();
        }
    }
});

// ── Toggle Button ──────────────────────────────────────────────────────────

function _ndInjectButton() {
    const controls = document.getElementById('player-controls');
    if (!controls || document.getElementById('btn-notedetect')) return;

    const closeBtn = controls.querySelector('button:last-child');

    const btn = document.createElement('button');
    btn.id = 'btn-notedetect';
    btn.className = 'px-3 py-1.5 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-500 transition';
    btn.textContent = 'Detect';
    btn.title = 'Toggle real-time note detection & scoring';
    btn.onclick = _ndToggle;
    controls.insertBefore(btn, closeBtn);

    // Settings gear button
    const gear = document.createElement('button');
    gear.id = 'btn-notedetect-settings';
    gear.className = 'px-2 py-1.5 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-500 transition hidden';
    gear.textContent = '\u2699';
    gear.title = 'Note detection settings';
    gear.onclick = _ndShowSettings;
    controls.insertBefore(gear, closeBtn);
}

function _ndUpdateButton() {
    const btn = document.getElementById('btn-notedetect');
    if (!btn) return;
    if (_ndEnabled) {
        btn.className = 'px-3 py-1.5 bg-green-900/50 rounded-lg text-xs text-green-300 transition';
        btn.textContent = 'Detect \u2713';
    } else {
        btn.className = 'px-3 py-1.5 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-500 transition';
        btn.textContent = 'Detect';
    }
    const gear = document.getElementById('btn-notedetect-settings');
    if (gear) gear.classList.toggle('hidden', !_ndEnabled);
}

async function _ndToggle() {
    _ndEnabled = !_ndEnabled;
    _ndUpdateButton();

    if (_ndEnabled) {
        // Read tuning from song info
        const info = highway.getSongInfo();
        if (info && info.tuning) {
            _ndTuningOffsets = info.tuning;
        }
        if (info && info.capo !== undefined) {
            _ndCapo = info.capo;
        }
        if (info && info.arrangement) {
            _ndSetArrangement(info.arrangement);
        }

        // Reset scoring
        _ndResetScoring();

        const ok = await _ndStartAudio();
        if (!ok) {
            _ndEnabled = false;
            _ndUpdateButton();
            return;
        }

        // Start miss-check polling and HUD
        _ndMissCheckInterval = setInterval(_ndCheckMisses, 100);
        _ndStartHUD();

        if (_ndDetectionMethod === 'crepe') _ndLoadCrepe();
    } else {
        _ndStopAudio();
        _ndStopHUD();
        if (_ndMissCheckInterval) { clearInterval(_ndMissCheckInterval); _ndMissCheckInterval = null; }

        // Show summary if we had results
        _ndShowSummary();

        // Close settings panel
        const panel = document.getElementById('nd-settings-panel');
        if (panel) panel.remove();
    }
}

let _ndMissCheckInterval = null;

function _ndResetScoring() {
    _ndHits = 0;
    _ndMisses = 0;
    _ndStreak = 0;
    _ndBestStreak = 0;
    _ndNoteResults.clear();
    _ndSectionStats = [];
    _ndCurrentSection = null;
    _ndDetectedMidi = -1;
    _ndDetectedConfidence = 0;
    _ndDetectedString = -1;
    _ndDetectedFret = -1;
}

// ── End-of-song Summary ────────────────────────────────────────────────────

function _ndShowSummary() {
    const total = _ndHits + _ndMisses;
    if (total < 5) return; // not enough data

    let overlay = document.getElementById('nd-summary-overlay');
    if (overlay) overlay.remove();

    const accuracy = Math.round((_ndHits / total) * 100);

    let sectionHtml = '';
    if (_ndSectionStats.length > 0) {
        sectionHtml = '<div class="mt-3 text-xs"><div class="text-gray-400 mb-1">Per Section:</div>';
        for (const sec of _ndSectionStats) {
            const secTotal = sec.hits + sec.misses;
            const secAcc = secTotal > 0 ? Math.round((sec.hits / secTotal) * 100) : 0;
            const barColor = secAcc >= 90 ? 'bg-green-500' : secAcc >= 70 ? 'bg-yellow-500' : 'bg-red-500';
            sectionHtml += `
                <div class="flex items-center gap-2 mb-1">
                    <span class="w-24 truncate text-gray-300">${sec.name}</span>
                    <div class="flex-1 h-2 bg-dark-600 rounded overflow-hidden">
                        <div class="${barColor} h-full rounded" style="width:${secAcc}%"></div>
                    </div>
                    <span class="w-10 text-right text-gray-400">${secAcc}%</span>
                </div>
            `;
        }
        sectionHtml += '</div>';
    }

    overlay = document.createElement('div');
    overlay.id = 'nd-summary-overlay';
    overlay.className = 'fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm';
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
    overlay.innerHTML = `
        <div class="bg-dark-700 border border-gray-600 rounded-2xl p-6 w-80 shadow-2xl">
            <div class="text-center mb-4">
                <div class="text-3xl font-bold ${accuracy >= 90 ? 'text-green-400' : accuracy >= 70 ? 'text-yellow-400' : 'text-red-400'}">${accuracy}%</div>
                <div class="text-gray-400 text-sm">Accuracy</div>
            </div>
            <div class="grid grid-cols-3 gap-3 text-center text-sm mb-3">
                <div>
                    <div class="text-green-400 font-bold">${_ndHits}</div>
                    <div class="text-gray-500 text-xs">Hits</div>
                </div>
                <div>
                    <div class="text-red-400 font-bold">${_ndMisses}</div>
                    <div class="text-gray-500 text-xs">Misses</div>
                </div>
                <div>
                    <div class="text-blue-400 font-bold">${_ndBestStreak}</div>
                    <div class="text-gray-500 text-xs">Best Streak</div>
                </div>
            </div>
            ${sectionHtml}
            <button onclick="this.parentElement.parentElement.remove()"
                    class="mt-4 w-full py-2 bg-dark-600 hover:bg-dark-500 rounded-lg text-sm text-gray-300 transition">
                Close
            </button>
        </div>
    `;
    document.body.appendChild(overlay);

    // Publish to Practice Journal if installed
    _ndPublishToJournal(accuracy);
}

// ── Practice Journal Integration ───────────────────────────────────────────

function _ndPublishToJournal(accuracy) {
    // Check if practice_journal plugin exists by looking for its API
    const info = highway.getSongInfo();
    if (!info) return;

    try {
        // Fire a custom event that the practice journal plugin can listen for
        window.dispatchEvent(new CustomEvent('notedetect:session', {
            detail: {
                title: info.title,
                artist: info.artist,
                arrangement: info.arrangement,
                accuracy: accuracy,
                hits: _ndHits,
                misses: _ndMisses,
                bestStreak: _ndBestStreak,
                sections: _ndSectionStats.map(s => ({
                    name: s.name,
                    accuracy: (s.hits + s.misses) > 0 ? Math.round(s.hits / (s.hits + s.misses) * 100) : 0,
                })),
                timestamp: new Date().toISOString(),
            }
        }));
    } catch (e) { /* journal not installed, ignore */ }
}

// ── Garbage Collection ─────────────────────────────────────────────────────
// Prune old note results to prevent unbounded memory growth

setInterval(() => {
    if (!_ndEnabled || _ndNoteResults.size < 500) return;
    const t = highway.getTime();
    for (const [key, _] of _ndNoteResults) {
        const noteTime = parseFloat(key.split('_')[0]);
        if (noteTime < t - 5) _ndNoteResults.delete(key);
    }
}, 5000);

// ── Hook into playSong ─────────────────────────────────────────────────────

(function() {
    const origPlaySong = window.playSong;
    window.playSong = async function(filename, arrangement) {
        // Reset state on new song
        if (_ndEnabled) {
            _ndStopAudio();
            _ndStopHUD();
            if (_ndMissCheckInterval) { clearInterval(_ndMissCheckInterval); _ndMissCheckInterval = null; }
            _ndEnabled = false;
        }
        _ndResetScoring();
        await origPlaySong(filename, arrangement);
        _ndInjectButton();

        // Read tuning from newly loaded song
        const info = highway.getSongInfo();
        if (info && info.tuning) {
            _ndTuningOffsets = info.tuning;
        }
        if (info && info.capo !== undefined) {
            _ndCapo = info.capo;
        }
        if (info && info.arrangement) {
            _ndSetArrangement(info.arrangement);
        }
    };
})();
