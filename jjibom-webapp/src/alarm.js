// alarm.js — sound, vibration and wake lock. Every browser capability is
// feature-detected and guarded so a missing API (notably on iOS/Safari) never
// throws or breaks the app.

export class AlarmController {
  constructor() {
    this.audioContext = null;
    this.repeatTimer = null;
    this.wakeLock = null;
    this.wantWakeLock = false;
    this.onWakeStateChange = null; // (state: 'on'|'off'|'unsupported') => void
  }

  // Must be called from a user gesture the first time so the AudioContext is
  // allowed to start. Safe to call repeatedly.
  async ensureAudio() {
    if (!this.audioContext) {
      const AudioCtor = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtor) return null;
      try { this.audioContext = new AudioCtor(); } catch { return null; }
    }
    if (this.audioContext.state === 'suspended') {
      try { await this.audioContext.resume(); } catch { /* ignore */ }
    }
    return this.audioContext;
  }

  vibrate(pattern) {
    if (typeof navigator.vibrate !== 'function') return false;
    try { return navigator.vibrate(pattern); } catch { return false; }
  }

  // Start the repeating alarm (sound + vibration), respecting the toggles.
  async start({ sound = true, vibration = true } = {}) {
    if (vibration) this.vibrate([280, 120, 280, 120, 620, 180, 280]);
    if (!sound) return;
    await this.ensureAudio();
    this._beep();
    clearInterval(this.repeatTimer);
    this.repeatTimer = setInterval(() => this._beep(), 1900);
  }

  stop() {
    clearInterval(this.repeatTimer);
    this.repeatTimer = null;
    this.vibrate(0);
  }

  _beep() {
    const ctx = this.audioContext;
    if (!ctx) return;
    const start = ctx.currentTime + 0.02;
    [0, 0.34, 0.68].forEach((offset, index) => {
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(index === 2 ? 980 : 820, start + offset);
      oscillator.frequency.exponentialRampToValueAtTime(index === 2 ? 680 : 610, start + offset + 0.18);
      gain.gain.setValueAtTime(0.0001, start + offset);
      gain.gain.exponentialRampToValueAtTime(0.22, start + offset + 0.018);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + 0.22);
      oscillator.connect(gain).connect(ctx.destination);
      oscillator.start(start + offset);
      oscillator.stop(start + offset + 0.24);
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
