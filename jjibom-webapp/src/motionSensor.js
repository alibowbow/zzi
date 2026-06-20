// motionSensor.js — browser DeviceMotionEvent wrapper. Normalises each event
// into a sample { t, amag, jerk, gmag, tilt, ... }, removing gravity when only
// accelerationIncludingGravity is available, and watches for sensor stalls.
// Browser-only.

import { GravityFilter, Ema, magnitude3, tiltFromGravity } from './motionFilter.js';
import { MOTION } from './motionConfig.js';

export class MotionSensor {
  constructor() {
    this.running = false;
    this.onSample = null;
    this.onError = null;
    this._handler = null;
    this._watch = null;
    this.lastEventAt = 0;
    this.capabilities = { accelerometer: false, linearAcceleration: false, gyroscope: false };
    this.gravity = new GravityFilter(MOTION.GRAVITY_LP_ALPHA);
    this.accelEma = new Ema(MOTION.ACCEL_EMA_ALPHA);
    this.prevAmag = null;
    this.prevT = null;
  }

  static isSupported() {
    return typeof window !== 'undefined' && typeof window.DeviceMotionEvent !== 'undefined';
  }

  // Must be called from a user gesture on iOS 13+. Returns true if granted.
  static async requestPermission() {
    const D = typeof window !== 'undefined' ? window.DeviceMotionEvent : undefined;
    if (D && typeof D.requestPermission === 'function') {
      try { return (await D.requestPermission()) === 'granted'; }
      catch { return false; }
    }
    return MotionSensor.isSupported();
  }

  start(onSample, onError) {
    if (this.running) return;
    this.running = true;
    this.onSample = onSample;
    this.onError = onError;
    this.gravity.reset();
    this.accelEma.reset();
    this.prevAmag = null;
    this.prevT = null;
    this.lastEventAt = performance.now();
    this._handler = (event) => this._onMotion(event);
    window.addEventListener('devicemotion', this._handler, { passive: true });
    this._watch = setInterval(() => {
      if (this.running && performance.now() - this.lastEventAt > MOTION.SENSOR_STALL_MS) {
        this.onError?.('stall');
      }
    }, 500);
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    if (this._handler) window.removeEventListener('devicemotion', this._handler);
    if (this._watch) clearInterval(this._watch);
    this._handler = null;
    this._watch = null;
    this.onSample = null;
    this.onError = null;
  }

  _onMotion(event) {
    const t = performance.now();
    this.lastEventAt = t;
    const a = event.acceleration;
    const ag = event.accelerationIncludingGravity;

    let lx; let ly; let lz;
    let gx = 0; let gy = 0; let gz = 9.81;
    if (a && a.x != null && a.y != null && a.z != null) {
      // Device exposes true linear acceleration.
      this.capabilities.linearAcceleration = true;
      this.capabilities.accelerometer = true;
      lx = a.x; ly = a.y; lz = a.z;
      if (ag && ag.x != null) { const grav = this.gravity.update(ag.x, ag.y, ag.z); gx = grav.gx; gy = grav.gy; gz = grav.gz; }
    } else if (ag && ag.x != null) {
      // Only gravity-included accel: low-pass to estimate and remove gravity.
      this.capabilities.accelerometer = true;
      const r = this.gravity.update(ag.x, ag.y, ag.z);
      lx = r.lx; ly = r.ly; lz = r.lz; gx = r.gx; gy = r.gy; gz = r.gz;
    } else {
      return; // no usable acceleration this event
    }

    const amag = this.accelEma.update(magnitude3(lx, ly, lz));
    const rr = event.rotationRate;
    let gmag = 0;
    if (rr && (rr.alpha != null || rr.beta != null || rr.gamma != null)) {
      this.capabilities.gyroscope = true;
      gmag = magnitude3(rr.alpha || 0, rr.beta || 0, rr.gamma || 0);
    }
    const tilt = tiltFromGravity(gx, gy, gz);
    let jerk = 0;
    if (this.prevAmag != null && this.prevT != null) {
      const dt = Math.max(0.001, (t - this.prevT) / 1000);
      jerk = Math.abs(amag - this.prevAmag) / dt;
    }
    this.prevAmag = amag;
    this.prevT = t;

    this.onSample?.({ t, amag, jerk, gmag, tilt, ax: lx, ay: ly, az: lz, interval: event.interval || 0 });
  }
}
