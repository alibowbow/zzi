// motionController.js — orchestrates the vibration (motion-sensor) mode for the
// WEB path (in-page DeviceMotion -> filter -> calibration -> detector -> gate ->
// state machine -> alarm + UI callbacks). When the native Capacitor plugin is
// present it instead proxies to the native foreground service (the single owner
// of detection there) and relays its events. Browser-coupled glue; the heavy
// logic lives in the pure, tested modules.

import { MotionSensor } from './motionSensor.js';
import { summarizeCalibration } from './motionCalibration.js';
import { analyzeMotion, MotionAlarmGate, scoreToBand } from './vibrationDetector.js';
import { MotionMachine, MotionState } from './motionState.js';
import { Diagnostics } from './diagnostics.js';
import { MOTION, MOTION_VERSION } from './motionConfig.js';
import { isNativeAvailable, nativeMotion } from './nativeBridge.js';

const TICK_MS = 60;

export class MotionController {
  constructor({ alarm, callbacks } = {}) {
    this.alarm = alarm;
    this.cb = callbacks || {};
    this.sensor = new MotionSensor();
    this.gate = new MotionAlarmGate();
    this.machine = new MotionMachine();
    this.diag = new Diagnostics();
    this.buffer = [];
    this.calibBuffer = [];
    this.calibrating = false;
    this.calibStart = 0;
    this.baseline = null;
    this.tickTimer = null;
    this.calibTimer = null;
    this.monitorStart = 0;
    this.lastContactAt = -Infinity;
    this.lastAlarm = null;
    this.replay = null;
    this.nativeListeners = [];
    this.settings = { sensitivity: 5, detectMode: 'all', sound: true, vibration: true, keepAwake: true };
  }

  isNative() { return isNativeAvailable(); }
  isSupported() { return MotionSensor.isSupported() || isNativeAvailable(); }
  getState() { return this.machine.state; }

  setSettings(patch) {
    Object.assign(this.settings, patch);
    if (this.isNative()) nativeMotion.updateSettings(this.settings).catch(() => {});
  }

  // ---- web sample ingestion ----------------------------------------------
  _pushSample(sample) {
    this.buffer.push(sample);
    const cutoff = sample.t - MOTION.BUFFER_MS;
    while (this.buffer.length && this.buffer[0].t < cutoff) this.buffer.shift();
    if (this.calibrating) this.calibBuffer.push(sample);
  }

  async _ensurePermission() {
    this._setState(MotionState.REQUESTING_PERMISSION);
    const granted = await MotionSensor.requestPermission();
    if (!granted) { this._setState(MotionState.IDLE); this.cb.onError?.('permission'); }
    return granted;
  }

  _startSensor() {
    if (this.replay || this.sensor.running) return;
    this.sensor.start((s) => this._pushSample(s), (err) => this._onSensorError(err));
  }

  _onSensorError(err) {
    if (this.machine.isRunning() || this.calibrating) {
      this.machine.set(MotionState.ERROR, performance.now());
      this._setState(MotionState.ERROR);
      this.cb.onError?.(err);
    }
  }

  // ---- calibration --------------------------------------------------------
  async startCalibration() {
    if (this.isNative()) {
      // Native service performs permission + calibration + arming itself.
      await this._startNative();
      return;
    }
    if (!this.replay) {
      const ok = await this._ensurePermission();
      if (!ok) return;
      this._startSensor();
    }
    this.calibBuffer = [];
    this.calibrating = true;
    this.calibStart = performance.now();
    this.baseline = null;
    this.machine.set(MotionState.CALIBRATING, this.calibStart);
    this._setState(MotionState.CALIBRATING);
    this._startTick();
    clearTimeout(this.calibTimer);
    this.calibTimer = setTimeout(() => this._finishCalibration(), MOTION.CALIB_MS);
  }

  _finishCalibration() {
    this.calibrating = false;
    const result = summarizeCalibration(this.calibBuffer, { durationMs: MOTION.CALIB_MS, targetHz: MOTION.TARGET_HZ });
    if (!result.ok) {
      this.machine.set(MotionState.IDLE, performance.now());
      this._setState(MotionState.IDLE);
      this._stopTick();
      if (!this.replay) this.sensor.stop();
      this.cb.onCalibrationFail?.(result.reason, result.stats);
      return;
    }
    this.baseline = result.stats;
    this.cb.onCalibrationDone?.(result.stats);
    this._startMonitoringWeb();
  }

  _startMonitoringWeb() {
    if (!this.baseline) return;
    this.gate.reset();
    this.diag.clear();
    this.monitorStart = performance.now();
    this.lastContactAt = -Infinity;
    this.machine.set(MotionState.ARMED, this.monitorStart);
    this._setState(MotionState.ARMED);
    this._startTick();
    this.cb.onMonitorStart?.();
  }

  // Re-arm using an existing baseline (skip re-calibration).
  rearm() {
    if (this.isNative()) { this._startNative(); return; }
    if (this.baseline) this._startMonitoringWeb();
  }

  _startTick() {
    if (this.tickTimer) return;
    this.tickTimer = setInterval(() => this._tick(), TICK_MS);
  }
  _stopTick() { clearInterval(this.tickTimer); this.tickTimer = null; }

  _tick() {
    const now = performance.now();
    if (this.replay) this._feedReplay(now);

    if (this.calibrating) {
      this.cb.onCalibrationProgress?.(Math.min(1, (now - this.calibStart) / MOTION.CALIB_MS));
      return;
    }
    if (!this.machine.isRunning() && this.machine.state !== MotionState.PAUSED) return;

    // Stall = no fresh samples in the buffer (works for live sensor AND replay).
    const latestT = this.buffer.length ? this.buffer[this.buffer.length - 1].t : this.monitorStart;
    const stalled = this.machine.isRunning() && (now - latestT > MOTION.SENSOR_STALL_MS);
    const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';

    const analysis = this.baseline
      ? analyzeMotion(this.buffer, this.baseline, { now, sensitivity: this.settings.sensitivity, detectMode: this.settings.detectMode })
      : { score: 0, pattern: 'none', contact: false, features: {} };
    const latest = this.buffer[this.buffer.length - 1];

    this.diag.push({
      t: now, found: true, x: 0, y: analysis.score, yN: analysis.score / 100, correctedDy: 0, confidence: 1,
      amag: latest?.amag ?? 0, gmag: latest?.gmag ?? 0, jerk: latest?.jerk ?? 0, pattern: analysis.pattern
    });

    if (analysis.contact) this.lastContactAt = now;
    const event = this.gate.update(analysis.score, analysis.pattern, analysis.contact, now);
    const signals = {
      score: analysis.score, contact: analysis.contact, alarmEmitted: Boolean(event),
      hidden, sensorStalled: stalled, stableMs: now - this.lastContactAt, cooldownActive: this.gate.isMuted(now)
    };
    const before = this.machine.state;
    this.machine.update(signals, now);
    if (this.machine.state !== before) this._setState(this.machine.state);

    this.cb.onMetrics?.({
      score: analysis.score, band: scoreToBand(analysis.score), pattern: analysis.pattern,
      magnitude: latest?.amag ?? 0, state: this.machine.state, elapsedMs: now - this.monitorStart,
      features: analysis.features
    });

    if (event) this._fireAlarm(event, now);
  }

  _fireAlarm(event, now) {
    // Mute first so our own buzzer/sound is not re-detected as a bite.
    this.gate.muteForSelfVibration(now);
    this.machine.set(MotionState.ALARM, now);
    this._setState(MotionState.ALARM);
    this.lastAlarm = { ...event, timestamp: new Date().toISOString() };
    this.alarm?.start({ sound: this.settings.sound, vibration: this.settings.vibration });
    this.cb.onAlarm?.(this.lastAlarm, this._exportFor(event));
  }

  dismissAlarm() {
    const now = performance.now();
    this.alarm?.stop();
    this.gate.muteForSelfVibration(now, 400); // ignore trailing buzz
    if (this.isNative()) { nativeMotion.resumeMonitoring().catch(() => {}); return; }
    this.machine.dismissAlarm(now);
    this._setState(this.machine.state);
  }

  // A test alarm must never be recorded as a real bite.
  testAlarm() {
    const now = performance.now();
    this.gate.muteForSelfVibration(now);
    this.alarm?.start({ sound: this.settings.sound, vibration: this.settings.vibration });
    setTimeout(() => this.alarm?.stop(), 1500);
    this.cb.onTestAlarm?.();
  }

  pause() {
    if (this.isNative()) { nativeMotion.pauseMonitoring().catch(() => {}); return; }
    this.machine.set(MotionState.PAUSED, performance.now());
    this._setState(MotionState.PAUSED);
  }
  resume() {
    if (this.isNative()) { nativeMotion.resumeMonitoring().catch(() => {}); return; }
    this.machine.set(MotionState.ARMED, performance.now());
    this._setState(MotionState.ARMED);
  }

  stop() {
    if (this.isNative()) nativeMotion.stopMonitoring().catch(() => {});
    this._stopTick();
    clearTimeout(this.calibTimer);
    this.sensor.stop();
    this.alarm?.stop();
    this.replay = null;
    this.calibrating = false;
    this.nativeListeners.forEach((l) => l.remove?.());
    this.nativeListeners = [];
    this.machine.set(MotionState.IDLE, performance.now());
    this._setState(MotionState.IDLE);
  }

  onVisibilityChange() {
    if (this.isNative()) return; // native foreground service keeps running
    const now = performance.now();
    if (document.visibilityState === 'hidden' && this.machine.isRunning()) {
      this.machine.set(MotionState.PAUSED, now);
      this._setState(MotionState.PAUSED);
      this.cb.onBackgroundPause?.();
    } else if (document.visibilityState === 'visible' && this.machine.state === MotionState.PAUSED) {
      this.cb.onResumePrompt?.();
    }
  }

  // ---- native path --------------------------------------------------------
  async _startNative() {
    this.nativeListeners.forEach((l) => l.remove?.());
    this.nativeListeners = [
      nativeMotion.addListener('stateChanged', (d) => { this.machine.state = d.state; this._setState(d.state); }),
      nativeMotion.addListener('biteDetected', (d) => { this.lastAlarm = d; this.cb.onAlarm?.(d, d.export || null); }),
      nativeMotion.addListener('metrics', (d) => this.cb.onMetrics?.(d)),
      nativeMotion.addListener('sensorError', (d) => this.cb.onError?.(d.reason))
    ];
    const perm = await nativeMotion.requestPermissions();
    if (!perm?.granted) { this.cb.onError?.('permission'); return; }
    await nativeMotion.startMonitoring(this.settings);
    this.cb.onMonitorStart?.();
  }

  async refreshNativeState() {
    if (!this.isNative()) return null;
    const state = await nativeMotion.getMonitoringState();
    if (state?.state) { this.machine.state = state.state; this._setState(state.state); }
    return state;
  }

  // ---- replay (demo / recorded JSON) --------------------------------------
  loadReplay(samples, loop = false) {
    this.replay = { samples: samples.slice(), idx: 0, startWall: null, startT: samples.length ? samples[0].t : 0, loop };
  }
  _feedReplay(now) {
    const r = this.replay;
    if (r.startWall == null) r.startWall = now;
    const elapsed = now - r.startWall;
    while (r.idx < r.samples.length && (r.samples[r.idx].t - r.startT) <= elapsed) {
      const s = r.samples[r.idx];
      r.idx += 1;
      // Preserve each sample's original spacing (anchored to wall time), do NOT
      // collapse them all to `now`.
      this._pushSample({ ...s, t: r.startWall + (s.t - r.startT) });
    }
    if (r.idx >= r.samples.length) {
      if (r.loop) { r.idx = 0; r.startWall = now; r.startT = r.samples.length ? r.samples[0].t : 0; }
      else this.replay = null; // ended -> stall watchdog will fire (dropout demo)
    }
  }

  // Demo entry point: arm with a fixed baseline and replay a recorded scenario,
  // running the SAME detector/gate/state machine as live monitoring.
  playScenario(samples, loop, baseline) {
    this.stop();
    this.baseline = baseline;
    this.loadReplay(samples, loop);
    this._startMonitoringWeb();
  }

  _exportFor(event) {
    const samples = this.diag.recentWindow(MOTION.LONG_WINDOW_MS * 2, performance.now());
    const peak = (key) => samples.reduce((m, s) => Math.max(m, s[key] || 0), 0);
    return {
      timestamp: new Date().toISOString(), appVersion: MOTION_VERSION, mode: 'motion',
      sensitivity: this.settings.sensitivity, predictedPattern: event.pattern, biteScore: event.score,
      baselineMad: this.baseline?.accelMad ?? 0, peakAcceleration: peak('amag'), peakJerk: peak('jerk'),
      gyroPeak: peak('gmag'), userLabel: null, background: this.isNative(),
      screenOn: typeof document !== 'undefined' ? document.visibilityState === 'visible' : true,
      samples: samples.map((s) => ({ t: Math.round(s.t), amag: s.amag, gmag: s.gmag, jerk: s.jerk }))
    };
  }

  _setState(state) { this.cb.onState?.(state); }
}
