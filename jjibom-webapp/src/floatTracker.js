// floatTracker.js — all per-float state and per-frame logic for ONE float.
//
// The app keeps an array of these so it can track several floats at once
// (multi-select). Each unit owns its own blob tracker, alarm gate, tracking
// state machine and sample buffer, so floats are fully independent. Whole-frame
// concerns (the camera image, background/camera-shake motion) are computed once
// by the app and passed in.

import { clamp, lerp, median, mad, ema } from './stats.js';
import { BlobTracker, computeConfidence } from './blobTracker.js';
import { analyzeBite, AlarmGate } from './biteDetector.js';
import { TrackingMachine, TrackState, alarmGateOpen } from './trackingState.js';
import { Diagnostics } from './diagnostics.js';
import { ROI, BLOB, SHAKE, BITE, CONFIDENCE, CALIB, PROCESS_INTERVAL_MS } from './config.js';

let nextId = 0;

export class FloatUnit {
  constructor(selection) {
    this.id = ++nextId;
    this.applySelection(selection);
    this.area = 0; this.height = 0; this.width = 0; this.heightEst = 0;
    this.confidence = 1; this.lostFrames = 0;
    this.floatHeight = 0; this.floatArea = 0; this.waveMad = 0.6; this.bgShakeBaseline = 0;
    this.calibrated = false;
    this.prevTime = undefined; this._prevYN = undefined;
    this.tracker = new BlobTracker();
    this.gate = new AlarmGate();
    this.machine = new TrackingMachine();
    this.diag = new Diagnostics();
    this.calib = [];
    this.lastFoundAt = 0; this.lowConfSince = 0; this.stableFrames = 0;
    this.shakingUntil = 0;
    this.graph = [];
    this.lastResult = { found: false, x: this.x, y: this.y, area: 0, height: 0, confidence: 0, lostFrames: 0 };
    this.biteScore = 0; this.biteType = 'none'; this.yN = 0; this.correctedRel = 0;
  }

  // (Re)point this unit at a freshly tapped position/colour.
  applySelection(selection) {
    this.rgb = selection.rgb;
    this.hsv = selection.hsv;
    this.initialX = selection.x;
    this.initialY = selection.y;
    this.x = selection.x;
    this.y = selection.y;
    this.prevX = null; this.prevY = null;
    this.baselineY = selection.y;
    this.lastKnownX = selection.x;
    this.lastKnownY = selection.y;
  }

  reselect(selection) {
    this.applySelection(selection);
    this.area = 0; this.height = 0; this.heightEst = 0;
    this.lostFrames = 0; this.confidence = 1;
  }

  beginCalibration() {
    this.calib = [];
    this.calibrated = false;
  }

  // Blob tracking for one frame. Returns the per-frame result and also stores it
  // on this.lastResult.
  track(frameImage, aw, ah, settings) {
    const lost = this.lostFrames || 0;
    const global = lost >= ROI.GLOBAL_AFTER_LOST;
    const floatHeight = this.floatHeight || this.heightEst || 12;
    const radius = global
      ? Math.max(aw, ah)
      : Math.max(clamp(ROI.BASE_RADIUS_PX + lost * ROI.GROW_PER_LOST_PX, ROI.BASE_RADIUS_PX, ROI.MAX_RADIUS_PX), floatHeight * 2.2);
    const rx = global ? 0 : clamp(Math.floor(this.x - radius), 0, aw - 1);
    const ry = global ? 0 : clamp(Math.floor(this.y - radius), 0, ah - 1);
    const rw = global ? aw : clamp(Math.ceil(this.x + radius), 1, aw) - rx;
    const rh = global ? ah : clamp(Math.ceil(this.y + radius), 1, ah) - ry;
    const roi = { x: rx, y: ry, w: rw, h: rh };

    const options = {
      tolerance: Number(settings.colorTolerance), nightMode: settings.nightMode,
      minArea: BLOB.MIN_AREA_PX, connectivity: BLOB.CONNECTIVITY, maxBlobs: BLOB.MAX_BLOBS
    };
    const ctx = {
      hasPrediction: !global,
      predictX: this.x - rx, predictY: this.y - ry,
      initialX: this.initialX - rx, initialY: this.initialY - ry,
      floatHeight, floatArea: this.floatArea || 0
    };

    const found = this.tracker.analyze(frameImage.data, aw, roi, this, options, ctx);
    const best = found.best;
    const accepted = best && found.bestScore >= 0.22 && best.qualityMean >= 0.18;
    if (!accepted) {
      this.lostFrames = lost + 1;
      this.confidence *= 0.7;
      this.lastResult = { found: false, x: this.x, y: this.y, area: 0, height: 0, width: 0, confidence: this.confidence, lostFrames: this.lostFrames };
      return this.lastResult;
    }

    const absX = roi.x + best.cx;
    const absY = roi.y + best.cy;
    const jumpPx = this.prevX != null ? Math.hypot(absX - this.prevX, absY - this.prevY) : 0;
    const areaRatio = this.floatArea ? best.area / this.floatArea : 1;
    const aspect = best.height / Math.max(1, best.width);
    const confidence = computeConfidence({ colorMean: best.qualityMean, jumpPx, floatHeight, areaRatio, aspect, margin: found.margin });
    const smoothing = confidence > 0.62 ? 0.55 : confidence > 0.35 ? 0.4 : 0.26;

    this.prevX = this.x; this.prevY = this.y;
    this.x = lerp(this.x, absX, smoothing);
    this.y = lerp(this.y, absY, smoothing);
    this.area = this.area ? lerp(this.area, best.area, 0.36) : best.area;
    this.height = this.height ? lerp(this.height, best.height, 0.4) : best.height;
    this.width = best.width;
    this.heightEst = this.heightEst ? ema(this.heightEst, best.height, 0.1) : best.height;
    this.confidence = confidence;
    this.lostFrames = 0;
    this.lastResult = { found: true, x: this.x, y: this.y, area: this.area, height: this.height, width: best.width, confidence, lostFrames: 0 };
    return this.lastResult;
  }

  calibrateStep(result, bgMag) {
    this.calib.push({ found: result.found, y: result.y, area: result.area, height: result.height, confidence: result.confidence, bgMag });
  }

  // Validate the collected calibration and lock in baselines. Returns
  // { ok, reason }. On success the unit is ready to monitor.
  finishCalibration() {
    const samples = this.calib;
    const found = samples.filter((s) => s.found && s.confidence >= 0.2);
    const foundRatio = samples.length ? found.length / samples.length : 0;
    const meanConf = found.length ? found.reduce((a, s) => a + s.confidence, 0) / found.length : 0;
    const ys = found.map((s) => s.y);
    const heights = found.map((s) => s.height).filter((h) => h > 0);
    const areas = found.map((s) => s.area).filter((a) => a > 0);
    const floatHeight = heights.length ? median(heights) : 0;
    const floatArea = areas.length ? median(areas) : 0;
    const waveMad = Math.max(0.4, mad(ys));
    const bgShake = floatHeight ? median(samples.map((s) => (s.bgMag || 0) / floatHeight)) : 0;

    if (foundRatio < CALIB.MIN_FOUND_RATIO) return { ok: false, reason: '찌를 자주 놓치고 있어요.' };
    if (meanConf < CALIB.MIN_MEAN_CONFIDENCE) return { ok: false, reason: '찌와 비슷한 색이 주변에 너무 많아요.' };
    if (floatHeight < CALIB.MIN_FLOAT_HEIGHT_PX) return { ok: false, reason: '찌가 너무 작게 보여요.' };
    if (bgShake > CALIB.MAX_BG_SHAKE_NORM) return { ok: false, reason: '카메라가 많이 흔들려요.' };

    this.baselineY = median(ys);
    this.floatHeight = floatHeight;
    this.floatArea = floatArea;
    this.waveMad = waveMad;
    this.bgShakeBaseline = bgShake;
    this.calibrated = true;
    return { ok: true };
  }

  beginMonitoring(now) {
    this.diag.clear();
    this.gate.reset();
    this.graph = [];
    this.machine.set(TrackState.TRACKING, now);
    this.lastFoundAt = now;
    this.lowConfSince = 0;
    this.stableFrames = 0;
    this.lastKnownX = this.x;
    this.lastKnownY = this.y;
    this.prevTime = undefined;
    this._prevYN = undefined;
  }

  stopMonitoring(now) {
    this.machine.set(TrackState.IDLE, now);
  }

  // One monitoring frame. `background`/`bgOffsetY` are shared whole-frame values.
  // Returns { alarmEvent|null, state, message, changed, biteScore, yN }.
  monitor(result, now, settings, adaptiveAdjustment, background, bgOffsetY) {
    const floatHeight = this.floatHeight || 12;
    const dt = clamp((now - (this.prevTime || now - PROCESS_INTERVAL_MS)) / 1000, 0.03, 0.25);
    this.prevTime = now;

    const correctedY = (result.found ? result.y : this.y) - bgOffsetY;
    const yN = (correctedY - this.baselineY) / floatHeight;
    const prevYN = this._prevYN ?? yN;
    const correctedDyFrame = yN - prevYN;
    const vN = correctedDyFrame / dt;
    this._prevYN = yN;

    const areaRatio = this.floatArea ? result.area / this.floatArea : 1;
    const heightRatio = floatHeight ? result.height / floatHeight : 1;
    const bgMagNorm = Math.hypot(background.dx, background.dy) / floatHeight;
    if (background.confidence >= SHAKE.MIN_CONFIDENCE && bgMagNorm >= SHAKE.ALARM_SUPPRESS_NORM) {
      this.shakingUntil = now + SHAKE.SUPPRESS_MS;
    }
    const shaking = now < this.shakingUntil;

    this.diag.push({
      t: now, found: result.found, x: this.x, y: this.y,
      yN, vN, correctedDy: correctedDyFrame, areaRatio, heightRatio,
      confidence: result.confidence, shaking
    });

    const sensitivity = (Number(settings.sensitivity) - 1) / 9;
    const adaptive = clamp(1 + adaptiveAdjustment, 0.78, 1.34);
    const bite = analyzeBite(this.diag.samples, {
      now, windowMs: BITE.WINDOW_MS,
      waveMadN: (this.waveMad / floatHeight) * adaptive,
      detectMode: settings.detectMode, sensitivity
    });

    if (result.found) {
      this.lastFoundAt = now;
      this.lastKnownX = this.x; this.lastKnownY = this.y;
      if (result.confidence >= CONFIDENCE.LOW) { this.stableFrames += 1; this.lowConfSince = 0; }
      else { this.stableFrames = 0; if (!this.lowConfSince) this.lowConfSince = now; }
    } else {
      this.stableFrames = 0;
    }
    const lostMs = result.found ? 0 : now - this.lastFoundAt;
    const lowConfMs = this.lowConfSince ? now - this.lowConfSince : 0;
    const sinkTrajectory = bite.type === 'sink' && bite.features.sinkScore > 0.5;
    const reacquireOk = result.found && result.confidence >= CONFIDENCE.LOW;
    const signals = {
      found: result.found, confidence: result.confidence, shaking, lostMs, lowConfMs,
      biteScore: bite.score, sinkTrajectory, reacquireOk, stableFrames: this.stableFrames, alarmEmitted: false
    };

    const gateOpen = alarmGateOpen(this.machine.state, signals);
    const event = this.gate.update(bite.score, bite.type, now, gateOpen);
    signals.alarmEmitted = Boolean(event);
    const transition = this.machine.update(signals, now);

    if (settings.waveCorrection && result.found && result.confidence > 0.4 && bite.score < 0.4 && !shaking) {
      this.baselineY = lerp(this.baselineY, correctedY, 0.006);
    }

    this.graph.push(clamp(yN, -1.6, 1.6));
    if (this.graph.length > 150) this.graph.shift();
    this.biteScore = bite.score;
    this.biteType = bite.type;
    this.yN = yN;
    this.correctedRel = correctedY - this.baselineY;

    return { alarmEvent: event, state: this.machine.state, message: transition.message, changed: transition.changed, biteScore: bite.score, bite, yN };
  }

  resumeAfterAlarm(now) {
    this.machine.resume(true, now);
  }
}
