// Port Vela — synthesised sound and music, Web Audio API only.
// No audio files and no network requests: every sound is built from
// oscillators and filtered noise. Safe without an AudioContext
// (headless or unsupported browsers): every method simply does
// nothing instead of throwing, and the game still runs.
//
// Creating the context waits for a user gesture where the browser
// requires it: call unlock() (or resume()) from first input, and the
// game loop should call update(state) every frame so the engine
// pitch and the siren follow the game.

import { clamp } from './util.js';

// Original melody (MIDI notes) and bass line for the background loop:
// a light, sunny stroll in C major, written for this game.
const MELODY = [
  72, 76, 79, 76, 74, 76, 72, 0,
  74, 77, 81, 77, 76, 74, 72, 0,
  72, 76, 79, 84, 79, 76, 74, 76,
  77, 76, 74, 72, 74, 0, 67, 0,
];
const BASS = [
  48, 0, 55, 0, 53, 0, 55, 0,
  45, 0, 52, 0, 50, 0, 52, 0,
  48, 0, 55, 0, 53, 0, 55, 0,
  50, 0, 55, 0, 48, 0, 43, 0,
];
const MUSIC_BPM = 112;
const STEP_SECONDS = 60 / MUSIC_BPM / 2;

function midiToFreq(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

// The AudioContext constructor available here, or null.
function findAudioContextCtor(provided) {
  if (provided) return provided;
  if (typeof globalThis !== 'undefined') {
    return globalThis.AudioContext || globalThis.webkitAudioContext || null;
  }
  return null;
}

export function createAudio(providedContext) {
  const Ctor = findAudioContextCtor(providedContext);
  let ctx = null;
  let master = null;
  let muted = false;
  let engine = null;
  let siren = null;
  let musicTimer = null;
  let musicStep = 0;
  let musicNextTime = 0;
  let noiseBuffer = null;

  // True when a live context exists and is not muted away entirely.
  function live() {
    return ctx !== null && master !== null;
  }

  // Build the context lazily so construction never throws headlessly.
  function ensureContext() {
    if (ctx || !Ctor) return ctx;
    try {
      ctx = new Ctor();
      master = ctx.createGain();
      master.gain.value = muted ? 0 : 0.5;
      master.connect(ctx.destination);
    } catch (err) {
      ctx = null;
      master = null;
    }
    return ctx;
  }

  // A short burst of white noise through a low-pass filter.
  function noiseBufferFor() {
    if (noiseBuffer) return noiseBuffer;
    const length = Math.floor(ctx.sampleRate * 1);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    noiseBuffer = buffer;
    return buffer;
  }

  function playNoise(duration, filterFreq, gainValue, type = 'lowpass') {
    if (!live()) return;
    try {
      const src = ctx.createBufferSource();
      src.buffer = noiseBufferFor();
      src.loop = true;
      const filter = ctx.createBiquadFilter();
      filter.type = type;
      filter.frequency.value = filterFreq;
      const gain = ctx.createGain();
      const t = ctx.currentTime;
      gain.gain.setValueAtTime(gainValue, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + duration);
      src.connect(filter);
      filter.connect(gain);
      gain.connect(master);
      src.start(t);
      src.stop(t + duration + 0.02);
    } catch (err) { /* headless or stub context: stay silent */ }
  }

  // One oscillator note with an optional pitch slide and decay.
  function playTone(freq, duration, type = 'sine', gainValue = 0.2,
    slideTo = null, delay = 0) {
    if (!live()) return;
    try {
      const t = ctx.currentTime + delay;
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.setValueAtTime(Math.max(20, freq), t);
      if (slideTo != null) {
        osc.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo),
          t + duration);
      }
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(gainValue, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + duration);
      osc.connect(gain);
      gain.connect(master);
      osc.start(t);
      osc.stop(t + duration + 0.02);
    } catch (err) { /* stay silent */ }
  }

  // --- One-shot effects ------------------------------------------------

  function playSkid() {
    // Tyres on hot asphalt: high band-passed noise, short.
    playNoise(0.35, 900, 0.16, 'bandpass');
  }

  function playCrash() {
    // A low thud plus a burst of noise: metal and dust.
    playTone(70, 0.25, 'sine', 0.5, 35);
    playNoise(0.2, 300, 0.35);
  }

  function playGunshot() {
    // Crack first, body after: noise burst plus a fast low drop.
    playNoise(0.12, 2500, 0.4, 'highpass');
    playTone(160, 0.12, 'square', 0.22, 60);
  }

  function playPunch() {
    // A dull thump: a low sine dropping fast.
    playTone(120, 0.14, 'sine', 0.45, 55);
    playNoise(0.08, 400, 0.2);
  }

  function playPickup() {
    // A bright two-note chime for collecting cash or a package.
    playTone(880, 0.12, 'sine', 0.2);
    playTone(1318, 0.22, 'sine', 0.2, null, 0.09);
  }

  function playMissionComplete() {
    // A rising four-note jingle: C E G C, sunny and done.
    const notes = [523, 659, 784, 1047];
    notes.forEach((freq, i) => {
      playTone(freq, 0.28, 'triangle', 0.22, null, i * 0.12);
    });
  }

  function playClick() {
    playTone(660, 0.06, 'square', 0.12);
  }

  // --- Engine hum ------------------------------------------------------
  // Two detuned oscillators through a low-pass filter; the pitch
  // follows the player's speed (0 = idling, 1 = flat out).

  function startEngine(speed = 0) {
    if (!ensureContext() || engine) {
      if (engine) setEngineSpeed(speed);
      return;
    }
    try {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = 55;
      const sub = ctx.createOscillator();
      sub.type = 'sine';
      sub.frequency.value = 28;
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 500;
      const gain = ctx.createGain();
      gain.gain.value = 0.0;
      osc.connect(filter);
      sub.connect(filter);
      filter.connect(gain);
      gain.connect(master);
      osc.start();
      sub.start();
      engine = { osc, sub, filter, gain };
      setEngineSpeed(speed);
    } catch (err) {
      engine = null;
    }
  }

  function setEngineSpeed(speed = 0) {
    if (!engine || !live()) return;
    try {
      const frac = clamp(num(speed), 0, 1);
      const t = ctx.currentTime;
      engine.osc.frequency.setTargetAtTime(55 + frac * 165, t, 0.08);
      engine.sub.frequency.setTargetAtTime(28 + frac * 80, t, 0.08);
      engine.filter.frequency.setTargetAtTime(500 + frac * 1400, t, 0.1);
      engine.gain.gain.setTargetAtTime(0.05 + frac * 0.09, t, 0.1);
    } catch (err) { /* stay silent */ }
  }

  function stopEngine() {
    if (!engine) return;
    try {
      const t = ctx.currentTime;
      engine.gain.gain.setTargetAtTime(0, t, 0.05);
      const nodes = engine;
      engine = null;
      setTimeout(() => {
        try { nodes.osc.stop(); nodes.sub.stop(); } catch (err) { /* ok */ }
      }, 300);
    } catch (err) {
      engine = null;
    }
  }

  // --- Police siren ----------------------------------------------------
  // A single tone wobbling between two pitches via a square-wave LFO:
  // the classic two-tone wail, quiet enough to sit under the game.

  function startSiren() {
    if (!ensureContext() || siren) return;
    try {
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = 700;
      const lfo = ctx.createOscillator();
      lfo.type = 'square';
      lfo.frequency.value = 0.55;
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = 180;
      lfo.connect(lfoGain);
      lfoGain.connect(osc.frequency);
      const gain = ctx.createGain();
      gain.gain.value = 0.045;
      osc.connect(gain);
      gain.connect(master);
      osc.start();
      lfo.start();
      siren = { osc, lfo, gain };
    } catch (err) {
      siren = null;
    }
  }

  function stopSiren() {
    if (!siren) return;
    try {
      const nodes = siren;
      siren = null;
      nodes.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.05);
      setTimeout(() => {
        try { nodes.osc.stop(); nodes.lfo.stop(); } catch (err) { /* ok */ }
      }, 300);
    } catch (err) {
      siren = null;
    }
  }

  // --- Background music ------------------------------------------------
  // A light looping melody with a bass line, scheduled a little ahead
  // of time so it stays in tempo. Quiet by design (low gains).

  function scheduleMusicStep(step, when) {
    const delay = Math.max(0, when - ctx.currentTime);
    const melodyNote = MELODY[step % MELODY.length];
    const bassNote = BASS[step % BASS.length];
    if (melodyNote) {
      playTone(midiToFreq(melodyNote), STEP_SECONDS * 0.95, 'triangle',
        0.07, null, delay);
    }
    if (bassNote) {
      playTone(midiToFreq(bassNote), STEP_SECONDS * 1.8, 'sine',
        0.09, null, delay);
    }
  }

  function startMusic() {
    if (!ensureContext() || musicTimer) return;
    try {
      musicStep = 0;
      musicNextTime = ctx.currentTime + 0.05;
      const tick = () => {
        if (!ctx) return;
        while (musicNextTime < ctx.currentTime + 0.25) {
          scheduleMusicStep(musicStep, musicNextTime);
          musicStep += 1;
          musicNextTime += STEP_SECONDS;
        }
      };
      tick();
      musicTimer = setInterval(tick, 100);
    } catch (err) {
      musicTimer = null;
    }
  }

  function stopMusic() {
    if (musicTimer) {
      clearInterval(musicTimer);
      musicTimer = null;
    }
  }

  // --- Mute, unlock and the per-frame update ---------------------------

  function setMuted(value) {
    muted = !!value;
    if (master) {
      try {
        master.gain.setTargetAtTime(muted ? 0 : 0.5,
          ctx.currentTime, 0.02);
      } catch (err) { /* stay silent */ }
    }
    return muted;
  }

  function toggleMute() {
    return setMuted(!muted);
  }

  // Create (or resume) the context. Call from a user gesture: the
  // first key press or click. Safe to call any time; a no-op without
  // an AudioContext.
  function unlock() {
    if (!ensureContext()) return false;
    try {
      if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
        const result = ctx.resume();
        if (result && typeof result.catch === 'function') {
          result.catch(() => { /* autoplay policy: try again later */ });
        }
      }
    } catch (err) { /* stay silent */ }
    return true;
  }

  // Called every frame by the game loop: engine pitch follows the
  // player's speed while driving, the siren follows the chase, and
  // the music plays while the game is running.
  function update(state) {
    const safe = state && typeof state === 'object' ? state : {};
    const playing = safe.screen === 'playing';
    const player = safe.player || {};
    if (playing && !player.onFoot) {
      startEngine(clamp(Math.abs(num(player.speed, 0)) / 470, 0, 1));
    } else {
      stopEngine();
    }
    const chasing = playing && num(safe.wanted, 0) > 0 &&
      Array.isArray(safe.police) && safe.police.length > 0;
    if (chasing) startSiren();
    else stopSiren();
    if (playing) startMusic();
    else stopMusic();
  }

  function dispose() {
    stopMusic();
    stopEngine();
    stopSiren();
    if (ctx && typeof ctx.close === 'function') {
      try { ctx.close(); } catch (err) { /* ok */ }
    }
    ctx = null;
    master = null;
  }

  return {
    unlock,
    resume: unlock,
    update,
    startEngine,
    setEngineSpeed,
    stopEngine,
    startSiren,
    stopSiren,
    startMusic,
    stopMusic,
    playSkid,
    playCrash,
    playGunshot,
    playPunch,
    playPickup,
    playMissionComplete,
    playClick,
    toggleMute,
    setMuted,
    isMuted: () => muted,
    isEnginePlaying: () => engine !== null,
    isSirenPlaying: () => siren !== null,
    isMusicPlaying: () => musicTimer !== null,
    dispose,
  };
}

// Finite number or a fallback.
function num(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

export default createAudio;
