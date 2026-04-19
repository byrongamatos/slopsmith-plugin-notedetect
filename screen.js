// Note Detection plugin
// Captures guitar audio, detects pitch via CREPE or YIN, scores against highway notes.
// Factory pattern: createNoteDetector(options) returns an independent instance.

// ── Shared Constants ──────────────────────────────────────────────────────
const ND_STANDARD_MIDI = [40, 45, 50, 55, 59, 64]; // E2 A2 D3 G3 B3 E4
const ND_MIN_YIN_SAMPLES = 4096;
const ND_FRAME_SIZE = 2048;
const ND_STORAGE_KEY = 'slopsmith_notedetect';

// ── Shared State (expensive resources, load once) ─────────────────────────
let _sharedModel = null;
let _sharedModelLoading = false;

// ── Instance Registry ─────────────────────────────────────────────────────
const _ndInstances = new Set();

// ── Shared Settings Persistence ───────────────────────────────────────────

function _ndSaveSettings(s) {
    try {
        localStorage.setItem(ND_STORAGE_KEY, JSON.stringify(s));
    } catch (e) { /* localStorage unavailable */ }
}

function _ndLoadSettings() {
    try {
        const raw = localStorage.getItem(ND_STORAGE_KEY);
        if (!raw) return {};
        return JSON.parse(raw);
    } catch (e) { return {}; }
}

// ── Pitch Detection: YIN (pure function) ──────────────────────────────────

function _ndYinDetect(buffer, sampleRate) {
    const threshold = 0.15;
    const halfLen = Math.floor(buffer.length / 2);
    const yinBuffer = new Float32Array(halfLen);

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
        yinBuffer[tau] *= tau / runningSum;
    }

    let tau = 2;
    while (tau < halfLen) {
        if (yinBuffer[tau] < threshold) {
            while (tau + 1 < halfLen && yinBuffer[tau + 1] < yinBuffer[tau]) tau++;
            break;
        }
        tau++;
    }
    if (tau === halfLen) return { freq: -1, confidence: 0 };

    const s0 = tau > 0 ? yinBuffer[tau - 1] : yinBuffer[tau];
    const s1 = yinBuffer[tau];
    const s2 = tau + 1 < halfLen ? yinBuffer[tau + 1] : yinBuffer[tau];
    const betterTau = tau + (s0 - s2) / (2 * (s0 - 2 * s1 + s2));

    const freq = sampleRate / betterTau;
    const confidence = 1 - yinBuffer[tau];
    return { freq, confidence: Math.max(0, confidence) };
}

// ── Pitch Detection: CREPE/SPICE (shared model) ──────────────────────────

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

async function _ndLoadCrepe(updateBtnFn) {
    if (_sharedModel || _sharedModelLoading) return;
    _sharedModelLoading = true;

    if (updateBtnFn) updateBtnFn('Detect (loading model...)');

    try {
        if (!window.tf) {
            await _ndLoadScript('https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.17.0/dist/tf.min.js');
        }
        _sharedModel = await tf.loadGraphModel(
            'https://tfhub.dev/google/tfjs-model/spice/2/default/1',
            { fromTFHub: true }
        );
        console.log('CREPE/SPICE model loaded');
    } catch (e1) {
        console.warn('SPICE TFHub load failed, trying CREPE backup:', e1);
        try {
            _sharedModel = await tf.loadLayersModel(
                'https://cdn.jsdelivr.net/gh/nicksherron/crepe-js@master/model/model.json'
            );
            console.log('CREPE model loaded (fallback)');
        } catch (e2) {
            console.warn('All model loads failed, using YIN for this session:', e2);
            _sharedModel = null;
        }
    }
    _sharedModelLoading = false;
}

async function _ndCrepeDetect(buffer) {
    if (!_sharedModel) return { freq: -1, confidence: 0 };
    try {
        const input = tf.tensor(buffer, [1, buffer.length]);
        let outputs;
        if (_sharedModel.execute) {
            outputs = _sharedModel.execute(input);
        } else {
            outputs = _sharedModel.predict(input);
        }

        let freq = -1, confidence = 0;
        if (Array.isArray(outputs)) {
            const pitchData = await outputs[0].data();
            const uncData = outputs.length > 1 ? await outputs[1].data() : null;
            const raw = pitchData[0];
            if (raw > 0 && raw < 1) {
                freq = Math.pow(2, 5.661 * raw + 4.0);
            } else if (raw > 20) {
                freq = raw;
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

// ── Frequency / MIDI Conversion (pure functions) ──────────────────────────

function _ndFreqToMidi(freq) {
    return 12 * Math.log2(freq / 440) + 69;
}

function _ndNoteKey(note, time) {
    return `${time.toFixed(3)}_${note.s}_${note.f}`;
}

function _ndBsearch(arr, target) {
    let lo = 0, hi = arr.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (arr[mid].t < target) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

// ── Factory ───────────────────────────────────────────────────────────────

function createNoteDetector(options) {
    options = options || {};
    const hw = options.highway || window.highway;
    const container = options.container || null;
    const channelIndex = options.channel != null ? options.channel : -1;
    const externalStream = options.audioStream || null;
    const externalAudioCtx = options.audioCtx || null;

    // ── Instance State ────────────────────────────────────────────────────
    let enabled = false;
    let audioCtx = null;
    let stream = null;
    let worklet = null;
    let levelAnalyser = null;
    let gainNode = null;

    // Settings (loaded from shared localStorage)
    const saved = _ndLoadSettings();
    let detectionMethod = saved.method || 'yin';
    let timingTolerance = saved.timingTolerance != null ? saved.timingTolerance : 0.150;
    let pitchTolerance = saved.pitchTolerance != null ? saved.pitchTolerance : 50;
    let inputGain = saved.inputGain != null ? saved.inputGain : 1.0;
    let selectedDeviceId = saved.deviceId || '';
    let selectedChannel = saved.channel || 'mono';
    let latencyOffset = saved.latencyOffset != null ? saved.latencyOffset : 0.080;

    // Audio level metering
    let inputLevel = 0;
    let inputPeak = 0;
    let peakDecay = 0;

    // Scoring
    let hits = 0;
    let misses = 0;
    let streak = 0;
    let bestStreak = 0;
    let sectionStats = [];
    let currentSection = null;

    // Note tracking
    let noteResults = new Map();
    let detectedMidi = -1;
    let detectedConfidence = 0;
    let detectedString = -1;
    let detectedFret = -1;

    // Tuning
    let tuningOffsets = [0, 0, 0, 0, 0, 0];
    let capo = 0;

    // Audio processing
    let accumBuffer = new Float32Array(0);
    let pendingBuffer = null;

    // Timers
    let detectInterval = null;
    let levelRaf = null;
    let hudInterval = null;
    let missCheckInterval = null;
    let gcInterval = null;
    const flashTimeouts = [];

    // Visual state
    let hitFlash = 0;
    let missFlash = 0;
    let lastHitCount = 0;
    let lastMissCount = 0;

    // DOM
    let instanceRoot = null;
    let detectBtn = null;
    let gearBtn = null;

    // Draw hook reference (for cleanup)
    let drawHookFn = null;

    // ── Helpers ───────────────────────────────────────────────────────────

    function saveSettings() {
        _ndSaveSettings({
            deviceId: selectedDeviceId,
            channel: selectedChannel,
            method: detectionMethod,
            timingTolerance: timingTolerance,
            pitchTolerance: pitchTolerance,
            inputGain: inputGain,
            latencyOffset: latencyOffset,
        });
    }

    function midiFromStringFret(string, fret) {
        return ND_STANDARD_MIDI[string] + tuningOffsets[string] + capo + fret;
    }

    function midiToStringFret(midiNote) {
        let bestDist = Infinity;
        let bestString = -1;
        let bestFret = -1;
        for (let s = 0; s < 6; s++) {
            const openMidi = ND_STANDARD_MIDI[s] + tuningOffsets[s] + capo;
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

    // ── Audio Capture ─────────────────────────────────────────────────────

    async function startAudio() {
        try {
            if (externalStream) {
                // Shared stream mode — splitscreen passes a MediaStream + AudioContext
                audioCtx = externalAudioCtx || new (window.AudioContext || window.webkitAudioContext)();
                stream = externalStream;
            } else {
                // Standalone mode — call getUserMedia ourselves
                const constraints = {
                    audio: {
                        echoCancellation: false,
                        noiseSuppression: false,
                        autoGainControl: false,
                        channelCount: 2,
                    }
                };
                if (selectedDeviceId) {
                    constraints.audio.deviceId = { exact: selectedDeviceId };
                }

                if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
                    const isHttp = location.protocol === 'http:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1';
                    const msg = isHttp
                        ? 'Microphone access requires HTTPS. You are accessing Slopsmith over HTTP from a non-localhost address. Either:\n\n1. Use a reverse proxy with HTTPS (recommended)\n2. Access via localhost\n3. Add a self-signed certificate to the server'
                        : 'Microphone access is not available in this browser. Use Chrome or Edge.';
                    throw new Error(msg);
                }
                stream = await navigator.mediaDevices.getUserMedia(constraints);
                audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            }

            const source = audioCtx.createMediaStreamSource(stream);
            const streamChannels = source.channelCount;

            gainNode = audioCtx.createGain();
            gainNode.gain.value = inputGain;

            // Channel routing
            if (channelIndex >= 0 && streamChannels > channelIndex) {
                // Explicit channel index (for multi-channel interfaces)
                const splitter = audioCtx.createChannelSplitter(streamChannels);
                source.connect(splitter);
                const merger = audioCtx.createChannelMerger(1);
                splitter.connect(merger, channelIndex, 0);
                merger.connect(gainNode);
            } else if (streamChannels >= 2 && selectedChannel !== 'mono') {
                // Legacy left/right selection
                const splitter = audioCtx.createChannelSplitter(2);
                source.connect(splitter);
                const merger = audioCtx.createChannelMerger(1);
                const chIdx = selectedChannel === 'left' ? 0 : 1;
                splitter.connect(merger, chIdx, 0);
                merger.connect(gainNode);
            } else {
                source.connect(gainNode);
            }

            // AnalyserNode for VU meter
            levelAnalyser = audioCtx.createAnalyser();
            levelAnalyser.fftSize = 512;
            levelAnalyser.smoothingTimeConstant = 0.8;
            gainNode.connect(levelAnalyser);

            // ScriptProcessor for sample accumulation
            const processor = audioCtx.createScriptProcessor(ND_FRAME_SIZE, 1, 1);
            worklet = processor;
            accumBuffer = new Float32Array(0);
            pendingBuffer = null;

            processor.onaudioprocess = (e) => {
                if (!enabled) return;
                const input = e.inputBuffer.getChannelData(0);
                const prev = accumBuffer;
                const combined = new Float32Array(prev.length + input.length);
                combined.set(prev);
                combined.set(input, prev.length);
                if (combined.length >= ND_MIN_YIN_SAMPLES) {
                    const start = combined.length - ND_MIN_YIN_SAMPLES;
                    pendingBuffer = combined.slice(start, start + ND_MIN_YIN_SAMPLES);
                    accumBuffer = new Float32Array(0);
                } else {
                    accumBuffer = combined;
                }
            };

            detectInterval = setInterval(() => {
                if (pendingBuffer) {
                    const buf = pendingBuffer;
                    pendingBuffer = null;
                    processFrame(buf);
                }
            }, 50);

            gainNode.connect(processor);
            processor.connect(audioCtx.destination);

            startLevelMeter();
            populateDevices();

            return true;
        } catch (e) {
            console.error('Note detect: mic access denied or failed:', e);
            alert('Note Detection: Could not access audio input.\n\n' + e.message);
            return false;
        }
    }

    function stopAudio() {
        stopLevelMeter();
        if (detectInterval) { clearInterval(detectInterval); detectInterval = null; }
        pendingBuffer = null;
        if (worklet) {
            worklet.disconnect();
            worklet.onaudioprocess = null;
            worklet = null;
        }
        if (gainNode) { gainNode.disconnect(); gainNode = null; }
        levelAnalyser = null;
        if (!externalStream && stream) {
            stream.getTracks().forEach(t => t.stop());
        }
        stream = null;
        if (!externalAudioCtx && audioCtx) {
            audioCtx.close();
        }
        audioCtx = null;
        inputLevel = 0;
        inputPeak = 0;
        accumBuffer = new Float32Array(0);
    }

    // ── Level Metering ────────────────────────────────────────────────────

    function startLevelMeter() {
        stopLevelMeter();
        const tick = () => {
            if (!levelAnalyser) return;
            const buf = new Float32Array(levelAnalyser.fftSize);
            levelAnalyser.getFloatTimeDomainData(buf);
            let sum = 0;
            for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
            const rms = Math.sqrt(sum / buf.length);
            inputLevel = Math.min(1, rms * 5);

            if (inputLevel > inputPeak) {
                inputPeak = inputLevel;
                peakDecay = 30;
            } else if (peakDecay > 0) {
                peakDecay--;
            } else {
                inputPeak *= 0.95;
            }

            drawSettingsVU();
            levelRaf = requestAnimationFrame(tick);
        };
        levelRaf = requestAnimationFrame(tick);
    }

    function stopLevelMeter() {
        if (levelRaf) { cancelAnimationFrame(levelRaf); levelRaf = null; }
    }

    function drawSettingsVU() {
        if (!instanceRoot) return;
        const bar = instanceRoot.querySelector('.nd-vu-bar');
        const peak = instanceRoot.querySelector('.nd-vu-peak');
        if (!bar) return;
        const pct = Math.round(inputLevel * 100);
        bar.style.width = pct + '%';
        bar.className = 'nd-vu-bar h-full rounded transition-all duration-75 ' +
            (pct > 85 ? 'bg-red-500' : pct > 60 ? 'bg-yellow-500' : 'bg-green-500');
        if (peak) {
            peak.style.left = Math.min(Math.round(inputPeak * 100), 100) + '%';
        }
    }

    // ── Frame Processing ──────────────────────────────────────────────────

    async function processFrame(buffer) {
        let result;
        const sr = audioCtx ? audioCtx.sampleRate : 48000;
        if (detectionMethod === 'crepe' && _sharedModel) {
            result = await _ndCrepeDetect(buffer);
            if (result.freq <= 0 || result.confidence < 0.3) {
                result = _ndYinDetect(buffer, sr);
            }
        } else {
            result = _ndYinDetect(buffer, sr);
        }

        if (result.freq <= 0 || result.confidence < 0.3) {
            detectedMidi = -1;
            detectedConfidence = 0;
            detectedString = -1;
            detectedFret = -1;
            return;
        }

        detectedMidi = _ndFreqToMidi(result.freq);
        detectedConfidence = result.confidence;

        const sf = midiToStringFret(detectedMidi);
        detectedString = sf.string;
        detectedFret = sf.fret;

        matchNotes();
    }

    // ── Note Matching ─────────────────────────────────────────────────────

    function matchNotes() {
        const t = hw.getTime() - latencyOffset;
        if (detectedMidi < 0) return;

        const notes = hw.getNotes();
        const chords = hw.getChords();
        const tolerance = timingTolerance;
        const centsTol = pitchTolerance;

        const candidates = [];

        if (notes && notes.length > 0) {
            const start = _ndBsearch(notes, t - tolerance);
            for (let i = start; i < notes.length; i++) {
                const n = notes[i];
                if (n.t > t + tolerance) break;
                if (n.mt) continue;
                candidates.push({ s: n.s, f: n.f, t: n.t });
            }
        }
        if (chords && chords.length > 0) {
            const start = _ndBsearch(chords, t - tolerance);
            for (let i = start; i < chords.length; i++) {
                const c = chords[i];
                if (c.t > t + tolerance) break;
                for (const cn of (c.notes || [])) {
                    if (cn.mt) continue;
                    candidates.push({ s: cn.s, f: cn.f, t: c.t });
                }
            }
        }

        for (const cn of candidates) {
            const key = _ndNoteKey(cn, cn.t);
            if (noteResults.has(key)) continue;

            const expectedMidi = midiFromStringFret(cn.s, cn.f);
            const detectedCents = (detectedMidi - expectedMidi) * 100;

            if (Math.abs(detectedCents) <= centsTol) {
                noteResults.set(key, 'hit');
                hits++;
                streak++;
                if (streak > bestStreak) bestStreak = streak;
                updateSectionStat('hit');
            }
        }
    }

    function checkMisses() {
        if (!enabled) return;
        const t = hw.getTime() - latencyOffset;
        const tolerance = timingTolerance;
        const missDeadline = t - tolerance * 2;
        const notes = hw.getNotes();
        const chords = hw.getChords();

        const checkNote = (s, f, noteTime) => {
            if (noteTime > missDeadline) return;
            const key = _ndNoteKey({ s, f }, noteTime);
            if (!noteResults.has(key)) {
                noteResults.set(key, 'miss');
                misses++;
                streak = 0;
                updateSectionStat('miss');
            }
        };

        if (notes && notes.length > 0) {
            const start = _ndBsearch(notes, missDeadline - 1);
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

        const sections = hw.getSections();
        if (sections) {
            let current = null;
            for (const sec of sections) {
                if (sec.time <= t) current = sec.name;
                else break;
            }
            if (current && current !== currentSection) {
                currentSection = current;
                if (!sectionStats.find(s => s.name === current)) {
                    sectionStats.push({ name: current, hits: 0, misses: 0 });
                }
            }
        }
    }

    function updateSectionStat(type) {
        if (!currentSection) return;
        let sec = sectionStats.find(s => s.name === currentSection);
        if (!sec) {
            sec = { name: currentSection, hits: 0, misses: 0 };
            sectionStats.push(sec);
        }
        if (type === 'hit') sec.hits++;
        else sec.misses++;
    }

    function resetScoring() {
        hits = 0;
        misses = 0;
        streak = 0;
        bestStreak = 0;
        noteResults.clear();
        sectionStats = [];
        currentSection = null;
        detectedMidi = -1;
        detectedConfidence = 0;
        detectedString = -1;
        detectedFret = -1;
    }

    // ── Settings Panel ────────────────────────────────────────────────────

    function showSettings() {
        if (!instanceRoot) return;
        let panel = instanceRoot.querySelector('.nd-settings-panel');
        if (panel) { panel.remove(); return; }

        panel = document.createElement('div');
        panel.className = 'nd-settings-panel fixed top-16 right-4 z-[150] bg-dark-700 border border-gray-600 rounded-xl p-4 w-80 shadow-2xl text-sm';
        panel.innerHTML = `
            <div class="flex justify-between items-center mb-3">
                <span class="text-gray-200 font-semibold">Note Detection Settings</span>
                <button class="nd-close-settings text-gray-500 hover:text-white">&times;</button>
            </div>

            <label class="block text-gray-400 text-xs mb-1">Audio Input Device</label>
            <select class="nd-device-select w-full bg-dark-600 border border-gray-600 rounded px-2 py-1 text-xs text-gray-200 mb-2">
                <option value="">Default</option>
            </select>

            <label class="block text-gray-400 text-xs mb-1">Input Channel</label>
            <select class="nd-channel-select w-full bg-dark-600 border border-gray-600 rounded px-2 py-1 text-xs text-gray-200 mb-2">
                <option value="mono" ${selectedChannel === 'mono' ? 'selected' : ''}>Mono (mix both channels)</option>
                <option value="left" ${selectedChannel === 'left' ? 'selected' : ''}>Left (Ch 1) — typically dry/DI</option>
                <option value="right" ${selectedChannel === 'right' ? 'selected' : ''}>Right (Ch 2) — typically wet/FX</option>
            </select>

            <label class="block text-gray-400 text-xs mb-1">Input Level</label>
            <div class="relative h-3 bg-dark-600 rounded overflow-hidden mb-1">
                <div class="nd-vu-bar h-full rounded transition-all duration-75 bg-green-500" style="width:0%"></div>
                <div class="nd-vu-peak absolute top-0 w-0.5 h-full bg-white/70" style="left:0%"></div>
            </div>
            <div class="flex justify-between text-[9px] text-gray-600 mb-3">
                <span>-inf</span><span>-18dB</span><span>-6dB</span><span>0dB</span>
            </div>

            <label class="block text-gray-400 text-xs mb-1">Detection Method</label>
            <select class="nd-method-select w-full bg-dark-600 border border-gray-600 rounded px-2 py-1 text-xs text-gray-200 mb-3">
                <option value="yin" ${detectionMethod === 'yin' ? 'selected' : ''}>YIN (lightweight, clean signals)</option>
                <option value="crepe" ${detectionMethod === 'crepe' ? 'selected' : ''}>CREPE/SPICE (robust, ~20MB model)</option>
            </select>

            <label class="block text-gray-400 text-xs mb-1">Audio Latency Offset: <span class="nd-latency-val">${Math.round(latencyOffset * 1000)}</span>ms</label>
            <input type="range" min="0" max="250" value="${Math.round(latencyOffset * 1000)}"
                   class="nd-latency-slider w-full accent-green-400 mb-2">
            <div class="text-[10px] text-gray-600 mb-3 leading-tight">
                Compensates for USB/audio interface delay. Increase if notes register late.
            </div>

            <label class="block text-gray-400 text-xs mb-1">Timing Tolerance: <span class="nd-timing-val">${Math.round(timingTolerance * 1000)}</span>ms</label>
            <input type="range" min="30" max="300" value="${Math.round(timingTolerance * 1000)}"
                   class="nd-timing-slider w-full accent-green-400 mb-3">

            <label class="block text-gray-400 text-xs mb-1">Pitch Tolerance: <span class="nd-pitch-val">${pitchTolerance}</span> cents</label>
            <input type="range" min="10" max="100" value="${pitchTolerance}"
                   class="nd-pitch-slider w-full accent-green-400 mb-3">

            <label class="block text-gray-400 text-xs mb-1">Input Gain: <span class="nd-gain-val">${inputGain.toFixed(1)}</span>x</label>
            <input type="range" min="1" max="50" value="${Math.round(inputGain * 10)}"
                   class="nd-gain-slider w-full accent-green-400 mb-3">

            <div class="text-[10px] text-gray-600 mt-1 leading-tight">
                Tip: For multi-effects pedals with USB audio (e.g. Valeton GP-5), select <b>Left (Ch 1)</b> for the dry/DI signal — it gives the most accurate pitch detection.
            </div>
        `;

        // Wire up event handlers
        panel.querySelector('.nd-close-settings').onclick = () => panel.remove();
        panel.querySelector('.nd-device-select').onchange = function() { onDeviceChange(this.value); };
        panel.querySelector('.nd-channel-select').onchange = function() { onChannelChange(this.value); };
        panel.querySelector('.nd-method-select').onchange = function() { setMethod(this.value); };
        panel.querySelector('.nd-latency-slider').oninput = function() {
            latencyOffset = this.value / 1000;
            panel.querySelector('.nd-latency-val').textContent = this.value;
            saveSettings();
        };
        panel.querySelector('.nd-timing-slider').oninput = function() {
            timingTolerance = this.value / 1000;
            panel.querySelector('.nd-timing-val').textContent = this.value;
            saveSettings();
        };
        panel.querySelector('.nd-pitch-slider').oninput = function() {
            pitchTolerance = +this.value;
            panel.querySelector('.nd-pitch-val').textContent = this.value;
            saveSettings();
        };
        panel.querySelector('.nd-gain-slider').oninput = function() {
            inputGain = this.value / 10;
            panel.querySelector('.nd-gain-val').textContent = inputGain.toFixed(1);
            if (gainNode) gainNode.gain.value = inputGain;
            saveSettings();
        };

        instanceRoot.appendChild(panel);
        populateDevices();
    }

    function onDeviceChange(deviceId) {
        selectedDeviceId = deviceId;
        saveSettings();
        restartAudio();
    }

    function onChannelChange(channel) {
        selectedChannel = channel;
        saveSettings();
        restartAudio();
    }

    async function populateDevices() {
        try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            if (!instanceRoot) return;
            const sel = instanceRoot.querySelector('.nd-device-select');
            if (!sel) return;
            sel.innerHTML = '<option value="">Default</option>';
            for (const d of devices) {
                if (d.kind !== 'audioinput') continue;
                const opt = document.createElement('option');
                opt.value = d.deviceId;
                opt.textContent = d.label || `Input ${d.deviceId.slice(0, 8)}`;
                if (d.deviceId === selectedDeviceId) opt.selected = true;
                sel.appendChild(opt);
            }
        } catch (e) { /* permission not yet granted */ }
    }

    async function restartAudio() {
        stopAudio();
        if (enabled) await startAudio();
    }

    function setMethod(method) {
        detectionMethod = method;
        saveSettings();
        if (method === 'crepe') _ndLoadCrepe(updateButtonText);
    }

    // ── Visual Feedback ───────────────────────────────────────────────────

    function createHUD() {
        if (!instanceRoot) return;
        if (instanceRoot.querySelector('.nd-hud')) return;
        const hud = document.createElement('div');
        hud.className = 'nd-hud absolute top-3 right-16 z-[20] pointer-events-none text-right';
        const target = container || document.getElementById('player');
        if (!target) return;
        hud.innerHTML = `
            <div class="nd-hud-accuracy text-xl font-bold" style="text-shadow:0 0 8px currentColor"></div>
            <div class="nd-hud-streak text-xs text-gray-400 mt-0.5"></div>
            <div class="nd-hud-counts text-[10px] text-gray-600 mt-0.5"></div>
            <div class="nd-hud-detected text-[10px] text-cyan-400 mt-1 font-mono"></div>
        `;
        target.appendChild(hud);
    }

    function removeHUD() {
        if (!instanceRoot) return;
        const hud = instanceRoot.querySelector('.nd-hud');
        if (hud) hud.remove();
        const flash = instanceRoot.querySelector('.nd-flash-overlay');
        if (flash) flash.remove();
    }

    function createFlashOverlay() {
        if (!instanceRoot) return;
        if (instanceRoot.querySelector('.nd-flash-overlay')) return;
        const target = container || document.getElementById('player');
        if (!target) return;
        const flash = document.createElement('div');
        flash.className = 'nd-flash-overlay';
        flash.style.cssText = 'position:absolute;inset:0;z-index:20;pointer-events:none;border:4px solid transparent;transition:border-color 0.05s;';
        target.appendChild(flash);
    }

    function startHUD() {
        createHUD();
        createFlashOverlay();
        lastHitCount = 0;
        lastMissCount = 0;
        if (hudInterval) clearInterval(hudInterval);
        hudInterval = setInterval(updateHUD, 33);
    }

    function stopHUD() {
        if (hudInterval) { clearInterval(hudInterval); hudInterval = null; }
        removeHUD();
    }

    function updateHUD() {
        if (!enabled || !instanceRoot) return;

        const total = hits + misses;
        const accEl = instanceRoot.querySelector('.nd-hud-accuracy');
        const streakEl = instanceRoot.querySelector('.nd-hud-streak');
        const countsEl = instanceRoot.querySelector('.nd-hud-counts');
        const detectedEl = instanceRoot.querySelector('.nd-hud-detected');
        const flashEl = instanceRoot.querySelector('.nd-flash-overlay');

        if (accEl && total > 0) {
            const accuracy = Math.round((hits / total) * 100);
            const color = accuracy >= 90 ? '#00ff88' : accuracy >= 70 ? '#ffcc00' : '#ff4444';
            accEl.textContent = accuracy + '%';
            accEl.style.color = color;
        } else if (accEl) {
            accEl.textContent = '';
        }

        if (streakEl) {
            let text = streak > 0 ? `${streak} streak` : '';
            if (bestStreak > 0) text += `  best: ${bestStreak}`;
            streakEl.textContent = text;
        }

        if (countsEl && total > 0) {
            countsEl.textContent = `${hits} / ${total}`;
        }

        if (detectedEl) {
            if (detectedString >= 0 && detectedConfidence > 0.3) {
                const names = ['E2','A2','D3','G3','B3','E4'];
                detectedEl.textContent = `${names[detectedString] || '?'} fret ${detectedFret}`;
            } else {
                detectedEl.textContent = '';
            }
        }

        if (flashEl) {
            if (hits > lastHitCount) {
                flashEl.style.borderColor = 'rgba(0, 255, 136, 0.6)';
                const t = setTimeout(() => { if (flashEl) flashEl.style.borderColor = 'transparent'; }, 80);
                flashTimeouts.push(t);
            } else if (misses > lastMissCount) {
                flashEl.style.borderColor = 'rgba(255, 50, 68, 0.4)';
                const t = setTimeout(() => { if (flashEl) flashEl.style.borderColor = 'transparent'; }, 80);
                flashTimeouts.push(t);
            }
            lastHitCount = hits;
            lastMissCount = misses;
        }
    }

    // ── 2D Draw Hook ──────────────────────────────────────────────────────

    function registerDrawHook() {
        if (drawHookFn) return;
        drawHookFn = function(ctx, W, H) {
            if (!enabled) return;
            if (!hw.project || !hw.fretX) return;

            const t = hw.getTime();
            const notes = hw.getNotes();
            const chords = hw.getChords();

            const drawIndicator = (s, f, noteTime, result) => {
                const tOff = noteTime - t;
                const p = hw.project(tOff);
                if (!p) return;
                const x = hw.fretX(f, p.scale, W);
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

            if (notes) {
                for (const n of notes) {
                    if (n.t < t - 0.5) continue;
                    if (n.t > t + 3) break;
                    if (n.mt) continue;
                    const key = _ndNoteKey(n, n.t);
                    const result = noteResults.get(key);
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
                        const result = noteResults.get(key);
                        if (result) drawIndicator(cn.s, cn.f, c.t, result);
                    }
                }
            }

            // Detected note indicator at now line
            if (detectedString >= 0 && detectedConfidence > 0.3) {
                const p = hw.project(0);
                if (p) {
                    const x = hw.fretX(detectedFret, p.scale, W);
                    const y = p.y * H;
                    ctx.save();
                    ctx.globalAlpha = Math.min(1, detectedConfidence);
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
                    ctx.fillText(detectedFret, x, y);
                    ctx.restore();
                }
            }
        };
        hw.addDrawHook(drawHookFn);
    }

    // ── Button Injection ──────────────────────────────────────────────────

    function updateButtonText(text) {
        if (detectBtn) detectBtn.textContent = text;
    }

    function updateButton() {
        if (!detectBtn) return;
        if (enabled) {
            detectBtn.className = 'px-3 py-1.5 bg-green-900/50 rounded-lg text-xs text-green-300 transition';
            detectBtn.textContent = 'Detect \u2713';
        } else {
            detectBtn.className = 'px-3 py-1.5 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-500 transition';
            detectBtn.textContent = 'Detect';
        }
        if (gearBtn) gearBtn.classList.toggle('hidden', !enabled);
    }

    // ── Summary ───────────────────────────────────────────────────────────

    function showSummary() {
        const total = hits + misses;
        if (total < 5) return;

        const existing = instanceRoot ? instanceRoot.querySelector('.nd-summary-overlay') : null;
        if (existing) existing.remove();

        const accuracy = Math.round((hits / total) * 100);

        let sectionHtml = '';
        if (sectionStats.length > 0) {
            sectionHtml = '<div class="mt-3 text-xs"><div class="text-gray-400 mb-1">Per Section:</div>';
            for (const sec of sectionStats) {
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

        const overlay = document.createElement('div');
        overlay.className = 'nd-summary-overlay fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm';
        overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
        overlay.innerHTML = `
            <div class="bg-dark-700 border border-gray-600 rounded-2xl p-6 w-80 shadow-2xl">
                <div class="text-center mb-4">
                    <div class="text-3xl font-bold ${accuracy >= 90 ? 'text-green-400' : accuracy >= 70 ? 'text-yellow-400' : 'text-red-400'}">${accuracy}%</div>
                    <div class="text-gray-400 text-sm">Accuracy</div>
                </div>
                <div class="grid grid-cols-3 gap-3 text-center text-sm mb-3">
                    <div>
                        <div class="text-green-400 font-bold">${hits}</div>
                        <div class="text-gray-500 text-xs">Hits</div>
                    </div>
                    <div>
                        <div class="text-red-400 font-bold">${misses}</div>
                        <div class="text-gray-500 text-xs">Misses</div>
                    </div>
                    <div>
                        <div class="text-blue-400 font-bold">${bestStreak}</div>
                        <div class="text-gray-500 text-xs">Best Streak</div>
                    </div>
                </div>
                ${sectionHtml}
                <button class="nd-close-summary mt-4 w-full py-2 bg-dark-600 hover:bg-dark-500 rounded-lg text-sm text-gray-300 transition">
                    Close
                </button>
            </div>
        `;
        overlay.querySelector('.nd-close-summary').onclick = () => overlay.remove();
        document.body.appendChild(overlay);

        publishToJournal(accuracy);
    }

    function publishToJournal(accuracy) {
        const info = hw.getSongInfo();
        if (!info) return;
        try {
            window.dispatchEvent(new CustomEvent('notedetect:session', {
                detail: {
                    title: info.title,
                    artist: info.artist,
                    arrangement: info.arrangement,
                    accuracy: accuracy,
                    hits: hits,
                    misses: misses,
                    bestStreak: bestStreak,
                    sections: sectionStats.map(s => ({
                        name: s.name,
                        accuracy: (s.hits + s.misses) > 0 ? Math.round(s.hits / (s.hits + s.misses) * 100) : 0,
                    })),
                    timestamp: new Date().toISOString(),
                }
            }));
        } catch (e) { /* journal not installed */ }
    }

    // ── Enable / Disable ──────────────────────────────────────────────────

    async function enable() {
        if (enabled) return;
        enabled = true;
        updateButton();

        const info = hw.getSongInfo();
        if (info && info.tuning) tuningOffsets = info.tuning;
        if (info && info.capo !== undefined) capo = info.capo;

        resetScoring();

        const ok = await startAudio();
        if (!ok) {
            enabled = false;
            updateButton();
            return;
        }

        missCheckInterval = setInterval(checkMisses, 100);
        startHUD();
        registerDrawHook();

        // GC interval
        gcInterval = setInterval(() => {
            if (!enabled || noteResults.size < 500) return;
            const t = hw.getTime();
            for (const [key] of noteResults) {
                const noteTime = parseFloat(key.split('_')[0]);
                if (noteTime < t - 5) noteResults.delete(key);
            }
        }, 5000);

        if (detectionMethod === 'crepe') _ndLoadCrepe(updateButtonText);
    }

    function disable() {
        if (!enabled) return;
        enabled = false;
        updateButton();
        stopAudio();
        stopHUD();
        if (missCheckInterval) { clearInterval(missCheckInterval); missCheckInterval = null; }
        if (gcInterval) { clearInterval(gcInterval); gcInterval = null; }
        flashTimeouts.forEach(clearTimeout);
        flashTimeouts.length = 0;

        showSummary();

        if (instanceRoot) {
            const panel = instanceRoot.querySelector('.nd-settings-panel');
            if (panel) panel.remove();
        }
    }

    // ── Public API ────────────────────────────────────────────────────────

    // Instance root container
    instanceRoot = document.createElement('div');
    instanceRoot.className = 'nd-instance';

    const api = {
        enable: enable,
        disable: disable,

        destroy() {
            if (enabled) {
                enabled = false;
                stopAudio();
                stopHUD();
            }
            if (missCheckInterval) { clearInterval(missCheckInterval); missCheckInterval = null; }
            if (gcInterval) { clearInterval(gcInterval); gcInterval = null; }
            flashTimeouts.forEach(clearTimeout);
            flashTimeouts.length = 0;
            if (drawHookFn && hw.removeDrawHook) {
                hw.removeDrawHook(drawHookFn);
                drawHookFn = null;
            }
            if (instanceRoot) { instanceRoot.remove(); instanceRoot = null; }
            if (detectBtn) { detectBtn.remove(); detectBtn = null; }
            if (gearBtn) { gearBtn.remove(); gearBtn = null; }
            _ndInstances.delete(api);
        },

        isEnabled() { return enabled; },

        getStats() {
            const total = hits + misses;
            return {
                hits, misses, streak, bestStreak,
                accuracy: total > 0 ? Math.round((hits / total) * 100) : 0,
                sectionStats: sectionStats.slice(),
            };
        },

        setChannel(idx) {
            selectedChannel = idx === 0 ? 'left' : idx === 1 ? 'right' : 'mono';
            saveSettings();
            restartAudio();
        },

        injectButton(bar) {
            const controls = bar || document.getElementById('player-controls');
            if (!controls) return;
            if (detectBtn && controls.contains(detectBtn)) return;

            const closeBtn = controls.querySelector('button:last-child');

            detectBtn = document.createElement('button');
            detectBtn.className = 'px-3 py-1.5 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-500 transition';
            detectBtn.textContent = 'Detect';
            detectBtn.title = 'Toggle real-time note detection & scoring';
            detectBtn.onclick = async () => {
                if (enabled) disable();
                else await enable();
            };
            controls.insertBefore(detectBtn, closeBtn);

            gearBtn = document.createElement('button');
            gearBtn.className = 'px-2 py-1.5 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-500 transition hidden';
            gearBtn.textContent = '\u2699';
            gearBtn.title = 'Note detection settings';
            gearBtn.onclick = showSettings;
            controls.insertBefore(gearBtn, closeBtn);

            // Attach instance root near the controls for scoped DOM queries
            const target = container || document.getElementById('player');
            if (target && !target.contains(instanceRoot)) {
                target.appendChild(instanceRoot);
            }
        },

        showSummary: showSummary,
    };

    _ndInstances.add(api);
    return api;
}

// ── Default Singleton ─────────────────────────────────────────────────────
const noteDetect = createNoteDetector();
window.noteDetect = noteDetect;
window.createNoteDetector = createNoteDetector;

// ── Hook into playSong ────────────────────────────────────────────────────
(function() {
    const origPlaySong = window.playSong;
    window.playSong = async function(filename, arrangement) {
        // Disable all active instances
        for (const inst of _ndInstances) {
            if (inst.isEnabled()) {
                inst.disable();
            }
        }
        // Reset default singleton scoring
        await origPlaySong(filename, arrangement);
        noteDetect.injectButton();
    };
})();
