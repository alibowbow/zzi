// alarm.js — sound, vibration and wake lock. Every browser capability is
// feature-detected and guarded so a missing API (notably on iOS/Safari) never
// throws or breaks the app.
//
// Tones are synthesised (no audio files) and pushed through a compressor so
// they stay loud outdoors without clipping. The same three presets exist in
// the Android service (AlarmPlayer.java).

export const ALARM_TONES = Object.freeze([
  { id: 'rise', label: '상승음' },
  { id: 'beep', label: '비프' },
  { id: 'siren', label: '사이렌' }
]);

const CYCLE_S = 1.05;
const VIBRATION = [420, 160, 420, 160, 760, 380];

// One cycle of a preset as [{ f0, f1, start, dur }] (Hz, seconds).
function toneCycle(tone) {
  if (tone === 'siren') return [{ f0: 650, f1: 1450, start: 0, dur: 0.5 }, { f0: 1450, f1: 650, start: 0.5, dur: 0.5 }];
  if (tone === 'beep') return [0, 0.24, 0.48].map((start) => ({ f0: 1320, f1: 1320, start, dur: 0.15 }));
  return [880, 1175, 1568].map((f, i) => ({ f0: f, f1: f, start: i * 0.23, dur: i === 2 ? 0.26 : 0.17 }));
}

export class AlarmController {
  constructor() {
    this.audioContext = null;
    this.master = null;
    this.repeatTimer = null;
    this.stopTimer = null;
    this.vibrateTimer = null;
    this.active = false;
    this.wakeLock = null;
    this.wantWakeLock = false;
    this.onWakeStateChange = null; // (state: 'on'|'off'|'unsupported') => void
    this.onAutoStop = null;        // () => void — the configured duration ran out
  }

  // Must run inside a user gesture the first time so the AudioContext may
  // start (Chrome/Safari autoplay rules). Safe to call repeatedly.
  async ensureAudio() {
    if (!this.audioContext) {
      const AudioCtor = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtor) return null;
      try { this.audioContext = new AudioCtor(); } catch { return null; }
      const ctx = this.audioContext;
      const compressor = ctx.createDynamicsCompressor();
      compressor.threshold.value = -20;
      compressor.knee.value = 6;
      compressor.ratio.value = 8;
      compressor.attack.value = 0.003;
      compressor.release.value = 0.15;
      this.master = ctx.createGain();
      this.master.gain.value = 0.9;
      this.master.connect(compressor).connect(ctx.destination);
    }
    if (this.audioContext.state === 'suspended') {
      try { await this.audioContext.resume(); } catch { /* ignore */ }
    }
    return this.audioContext;
  }

  // Unlock audio on the first touch anywhere, so an alarm that fires later
  // (without a gesture) can still play.
  installGestureUnlock(target = document) {
    const unlock = () => {
      this.ensureAudio().then((ctx) => {
        if (!ctx) return;
        const buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        src.connect(ctx.destination);
        try { src.start(0); } catch { /* ignore */ }
      });
    };
    ['pointerdown', 'keydown', 'touchend'].forEach((type) => target.addEventListener(type, unlock, { passive: true }));
  }

  get audioReady() {
    return Boolean(this.audioContext && this.audioContext.state === 'running');
  }

  vibrate(pattern) {
    if (typeof navigator.vibrate !== 'function') return false;
    try { return navigator.vibrate(pattern); } catch { return false; }
  }

  // Start the repeating alarm. durationSec > 0 stops it automatically.
  async start({ sound = true, vibration = true, tone = 'rise', volume = 1, durationSec = 20 } = {}) {
    this.stop();
    this.active = true;
    if (vibration) {
      this.vibrate(VIBRATION);
      const period = VIBRATION.reduce((a, b) => a + b, 0) + 200;
      this.vibrateTimer = setInterval(() => this.vibrate(VIBRATION), period);
    }
    if (sound) {
      const ctx = await this.ensureAudio();
      if (ctx && this.active) {
        this.master.gain.setValueAtTime(Math.max(0.05, Math.min(1, volume)) * 0.9, ctx.currentTime);
        this._scheduleCycle(tone);
        this.repeatTimer = setInterval(() => this._scheduleCycle(tone), CYCLE_S * 1000);
      }
    }
    if (durationSec > 0) {
      this.stopTimer = setTimeout(() => {
        this.stop();
        this.onAutoStop?.();
      }, durationSec * 1000);
    }
  }

  stop() {
    this.active = false;
    clearInterval(this.repeatTimer);
    clearInterval(this.vibrateTimer);
    clearTimeout(this.stopTimer);
    this.repeatTimer = null;
    this.vibrateTimer = null;
    this.stopTimer = null;
    this.vibrate(0);
  }

  // A short, clearly different chime for "monitoring has a problem".
  async warn({ sound = true, vibration = true, volume = 0.8 } = {}) {
    if (vibration) this.vibrate([180, 120, 180]);
    if (!sound) return;
    const ctx = await this.ensureAudio();
    if (!ctx) return;
    const t = ctx.currentTime + 0.02;
    [[660, 0], [440, 0.22], [660, 0.7], [440, 0.92]].forEach(([f, dt]) => this._note(f, f, t + dt, 0.18, volume * 0.8));
  }

  _scheduleCycle(tone) {
    const ctx = this.audioContext;
    if (!ctx || !this.active) return;
    const t = ctx.currentTime + 0.03;
    toneCycle(tone).forEach((n) => this._note(n.f0, n.f1, t + n.start, n.dur, 1));
  }

  _note(f0, f1, start, dur, level) {
    const ctx = this.audioContext;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(level, start + 0.012);
    gain.gain.setValueAtTime(level, start + dur - 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    gain.connect(this.master);
    // A sine body plus a quieter square edge carries further outdoors.
    [['sine', 0.75], ['square', 0.22]].forEach(([type, mix]) => {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(f0, start);
      if (f1 !== f0) osc.frequency.linearRampToValueAtTime(f1, start + dur);
      g.gain.value = mix;
      osc.connect(g).connect(gain);
      osc.start(start);
      osc.stop(start + dur + 0.02);
    });
  }

  // --- Wake lock ----------------------------------------------------------
  async requestWakeLock() {
    this.wantWakeLock = true;
    if (!('wakeLock' in navigator)) {
      this._emitWake('unsupported');
      return;
    }
    if (this.wakeLock || document.visibilityState !== 'visible') return;
    try {
      this.wakeLock = await navigator.wakeLock.request('screen');
      this._emitWake('on');
      this.wakeLock.addEventListener('release', () => {
        this.wakeLock = null;
        this._emitWake('off');
      }, { once: true });
    } catch {
      this.wakeLock = null;
      this._emitWake('off');
    }
  }

  async releaseWakeLock() {
    this.wantWakeLock = false;
    if (!this.wakeLock) return;
    try { await this.wakeLock.release(); } catch { /* ignore */ }
    this.wakeLock = null;
    this._emitWake('off');
  }

  // Re-acquire after the page returns to the foreground (the OS drops the lock
  // when the tab is hidden). A failure here is not fatal.
  reacquireIfNeeded() {
    if (this.wantWakeLock && !this.wakeLock && document.visibilityState === 'visible') {
      this.requestWakeLock();
    }
  }

  _emitWake(state) {
    if (typeof this.onWakeStateChange === 'function') this.onWakeStateChange(state);
  }
}
