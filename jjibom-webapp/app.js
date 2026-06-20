// app.js — orchestration layer. Owns the DOM, the analysis loop and the demo,
// and wires together the (testable, DOM-free) modules in ./src. The heavy
// computation lives in those modules; this file connects them to the page.

import { clamp, lerp, median, mad, ema } from './src/stats.js';
import { rgbToHsv, representativeColor, colorName, rgbToHex, luma } from './src/color.js';
import { mediaDisplayRect, displayToMedia, mediaToDisplay } from './src/geometry.js';
import { BlobTracker, computeConfidence } from './src/blobTracker.js';
import { estimateBackgroundMotion } from './src/motionCompensation.js';
import { analyzeBite, AlarmGate } from './src/biteDetector.js';
import { TrackingMachine, TrackState, alarmGateOpen } from './src/trackingState.js';
import { Diagnostics } from './src/diagnostics.js';
import { CameraController } from './src/camera.js';
import { AlarmController } from './src/alarm.js';
import { storage, loadJson, saveJson, downloadJson } from './src/storage.js';
import { DemoScene } from './src/demo.js';
import {
  ANALYSIS_MAX, PROCESS_INTERVAL_MS, CALIBRATION_FRAMES,
  ROI, BLOB, SHAKE, BITE, CALIB, CONFIDENCE, APP_VERSION
} from './src/config.js';

const HISTORY_KEY = 'jjibom-history-v1';
const SETTINGS_KEY = 'jjibom-settings-v1';
const ADAPTIVE_KEY = 'jjibom-adaptive-v1';

// App-level UI phases (chrome). The fine-grained tracking states (TRACKING /
// LOST / RECOVERING …) live in the TrackingMachine and run during MONITORING.
const PHASE = Object.freeze({
  IDLE: 'idle', CAMERA: 'camera', CALIBRATING: 'calibrating',
  READY: 'ready', MONITORING: 'monitoring', ALARM: 'alarm'
});

const $ = (id) => document.getElementById(id);
const els = {};
[
  'camera', 'cameraStage', 'overlay', 'analysisCanvas', 'demoCanvas', 'cameraEmpty',
  'tapGuide', 'calibrationPanel', 'calibrationText', 'cameraHud', 'startCameraBtn',
  'startDemoBtn', 'stopCameraBtn', 'flipCameraBtn', 'resetTargetBtn', 'monitorBtn',
  'statusPill', 'statusLabel', 'stateText', 'confidenceText', 'fpsText', 'wakeText',
  'targetSwatch', 'targetColorText', 'demoControls', 'alarmLayer', 'alarmTitle',
  'alarmReason', 'alarmScore', 'stopAlarmBtn', 'motionGauge', 'motionScore',
  'verticalMove', 'confidenceMetric', 'areaMetric', 'motionChart', 'sensitivity',
  'sensitivityOutput', 'detectMode', 'nightMode', 'soundEnabled', 'vibrationEnabled',
  'waveCorrection', 'colorTolerance', 'toleranceOutput', 'historyList', 'clearHistoryBtn',
  'installBtn', 'helpBtn', 'helpModal', 'closeHelpBtn', 'helpOkayBtn', 'feedbackModal',
  'feedbackTrueBtn', 'feedbackFalseBtn', 'feedbackSkipBtn', 'toast',
  // new optional elements (guarded with ?. everywhere)
  'cameraSelect', 'zoomControl', 'zoomRange', 'diagPanel', 'diagState', 'diagConfidence',
  'diagPos', 'diagCorrectedDy', 'diagBgDy', 'diagFloatHeight', 'diagCurHeight',
  'diagAreaRatio', 'diagBiteScore', 'diagFps', 'diagExportBtn', 'updateBanner', 'reloadBtn'
].forEach((id) => { els[id] = $(id); });

const analysisCtx = els.analysisCanvas.getContext('2d', { willReadFrequently: true });
const overlayCtx = els.overlay.getContext('2d');
const chartCtx = els.motionChart.getContext('2d');

// --- Controllers / modules ------------------------------------------------
const cameraCtl = new CameraController(els.camera);
const alarmCtl = new AlarmController();
const demo = new DemoScene();
const blobTracker = new BlobTracker();
const alarmGate = new AlarmGate();
const machine = new TrackingMachine();
const diagnostics = new Diagnostics();

// --- Mutable app state ----------------------------------------------------
let phase = PHASE.IDLE;
let isDemo = false;
let facingMode = 'environment';
let frameLoopToken = 0;
let lastProcessAt = 0;
let lastFrameAt = 0;
let fpsEma = 0;
let target = null;
let calibrationSamples = [];
let history = loadJson(HISTORY_KEY, []);
let adaptiveAdjustment = Number(storage.getItem(ADAPTIVE_KEY) || 0);
let currentEventId = null;
let feedbackEventId = null;
let lastExportableEvent = null;
let deferredInstallPrompt = null;
let toastTimer = null;
let alarmTimer = null;

// Per-frame analysis scratch (reused; no per-frame big allocations).
let frameImage = null;       // ImageData reused via getImageData
let prevLuma = null;         // Float32Array of previous processed frame luma
let currLuma = null;
let lumaSize = 0;
let bgOffsetX = 0;           // leaky-integrated background displacement (px)
let bgOffsetY = 0;
let shakingUntil = 0;

// Monitoring timers / trackers
let lastFoundAt = 0;
let lowConfSince = 0;
let stableFrames = 0;
let lastKnownX = 0;
let lastKnownY = 0;
let graph = [];

const settings = Object.assign({
  sensitivity: 6, detectMode: 'balanced', nightMode: false,
  soundEnabled: true, vibrationEnabled: true, waveCorrection: true, colorTolerance: 28
}, loadJson(SETTINGS_KEY, {}));

// ==========================================================================
// Settings + UI plumbing
// ==========================================================================
function saveSettings() { saveJson(SETTINGS_KEY, settings); }

function applySettingsToUi() {
  els.sensitivity.value = settings.sensitivity;
  els.detectMode.value = settings.detectMode;
  els.nightMode.checked = settings.nightMode;
  els.soundEnabled.checked = settings.soundEnabled;
  els.vibrationEnabled.checked = settings.vibrationEnabled;
  els.waveCorrection.checked = settings.waveCorrection;
  els.colorTolerance.value = settings.colorTolerance;
  updateSettingLabels();
}

function updateSettingLabels() {
  const value = Number(els.sensitivity.value);
  const label = value <= 3 ? '둔감' : value <= 7 ? '보통' : '민감';
  els.sensitivityOutput.textContent = `${label} ${value}`;
  els.toleranceOutput.textContent = els.colorTolerance.value;
}

const PHASE_LABELS = {
  [PHASE.IDLE]: ['대기', '카메라를 켜고 찌를 선택하세요.'],
  [PHASE.CAMERA]: ['찌 선택', '화면에서 찌 끝의 선명한 색을 터치하세요.'],
  [PHASE.CALIBRATING]: ['보정 중', '평소 물결 움직임을 잠깐 배우고 있어요.'],
  [PHASE.READY]: ['준비 완료', '감시 시작을 누르면 입질 알람이 켜집니다.'],
  [PHASE.MONITORING]: ['감시 중', '찌 움직임을 실시간으로 살펴보고 있어요.'],
  [PHASE.ALARM]: ['입질!', '큰 움직임이 감지됐어요.']
};

function setPhase(next) {
  phase = next;
  els.statusPill.dataset.status = next;
  els.statusLabel.textContent = PHASE_LABELS[next][0];
  els.stateText.textContent = PHASE_LABELS[next][1];
  els.cameraEmpty.classList.toggle('hidden', next !== PHASE.IDLE);
  els.tapGuide.classList.toggle('hidden', next !== PHASE.CAMERA);
  els.calibrationPanel.classList.toggle('hidden', next !== PHASE.CALIBRATING);
  els.cameraHud.classList.toggle('hidden', next === PHASE.IDLE);
  els.stopCameraBtn.classList.toggle('hidden', next === PHASE.IDLE);
  els.flipCameraBtn.classList.toggle('hidden', next === PHASE.IDLE || isDemo);
  els.resetTargetBtn.classList.toggle('hidden', !target || next === PHASE.IDLE || next === PHASE.ALARM);
  els.demoControls?.classList.toggle('hidden', !isDemo || next === PHASE.IDLE);
  els.alarmLayer.classList.toggle('hidden', next !== PHASE.ALARM);

  const canMonitor = next === PHASE.READY || next === PHASE.MONITORING || next === PHASE.ALARM;
  els.monitorBtn.disabled = !canMonitor;
  els.monitorBtn.classList.toggle('monitoring', next === PHASE.MONITORING || next === PHASE.ALARM);
  if (next === PHASE.MONITORING) els.monitorBtn.innerHTML = '<span class="record-dot"></span>감시 멈춤';
  else if (next === PHASE.ALARM) els.monitorBtn.innerHTML = '<span class="record-dot"></span>알람 멈춤';
  else els.monitorBtn.innerHTML = '<span class="record-dot"></span>감시 시작';
}

function showToast(message, duration = 2500) {
  clearTimeout(toastTimer);
  els.toast.textContent = message;
  els.toast.classList.remove('hidden');
  toastTimer = setTimeout(() => els.toast.classList.add('hidden'), duration);
}

function showModal(modal) { modal.classList.remove('hidden'); document.body.style.overflow = 'hidden'; }
function hideModal(modal) {
  modal.classList.add('hidden');
  if (els.helpModal.classList.contains('hidden') && els.feedbackModal.classList.contains('hidden')) {
    document.body.style.overflow = '';
  }
}

// ==========================================================================
// Camera / demo lifecycle
// ==========================================================================
async function startCamera() {
  await stopEverything(true);
  await alarmCtl.ensureAudio();

  if (!navigator.mediaDevices?.getUserMedia) {
    showToast(window.isSecureContext
      ? '이 브라우저는 카메라 기능을 지원하지 않아요.'
      : '카메라는 HTTPS 주소 또는 localhost에서만 사용할 수 있어요.', 4500);
    return;
  }

  els.startCameraBtn.disabled = true;
  els.startCameraBtn.textContent = '카메라 여는 중…';
  try {
    await cameraCtl.start({ facingMode });
    isDemo = false;
    configureCanvases();
    resetTarget(false);
    setPhase(PHASE.CAMERA);
    startFrameLoop();
    await alarmCtl.requestWakeLock();
    await refreshCameraControls();
    showToast('카메라가 켜졌어요. 찌 끝을 터치하세요.');
  } catch (error) {
    console.error(error);
    let message = '카메라를 열지 못했어요.';
    if (error?.name === 'NotAllowedError') message = '카메라 권한이 거부됐어요. 브라우저 설정에서 허용해주세요.';
    else if (error?.name === 'NotFoundError') message = '사용할 수 있는 카메라를 찾지 못했어요.';
    else if (error?.name === 'NotReadableError') message = '다른 앱이 카메라를 사용 중일 수 있어요.';
    else if (error?.name === 'NotSupportedError') message = '이 브라우저는 카메라 기능을 지원하지 않아요.';
    showToast(message, 4500);
    setPhase(PHASE.IDLE);
  } finally {
    els.startCameraBtn.disabled = false;
    els.startCameraBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M14.5 6 13 4H7L5.5 6H3v13h18V6z"/><circle cx="12" cy="12.5" r="4"/></svg>카메라 켜기';
  }
}

async function startDemo() {
  await stopEverything(true);
  await alarmCtl.ensureAudio();
  if (!els.demoCanvas.captureStream) {
    showToast('이 브라우저에서는 데모 영상을 만들 수 없어요.');
    return;
  }
  isDemo = true;
  facingMode = 'environment';
  els.demoCanvas.width = 960;
  els.demoCanvas.height = 540;
  demo.start(els.demoCanvas);
  try {
    const stream = els.demoCanvas.captureStream(30);
    await cameraCtl.useStream(stream);
    configureCanvases();
    resetTarget(false);
    setPhase(PHASE.CAMERA);
    startFrameLoop();
    await alarmCtl.requestWakeLock();
    showToast('데모가 시작됐어요. 빨간 찌 끝을 터치하세요.', 3500);
  } catch (error) {
    console.error(error);
    showToast('데모 영상을 시작하지 못했어요.');
    await stopEverything(true);
  }
}

async function stopEverything(quiet = false) {
  cancelAlarm(false);
  frameLoopToken += 1;
  demo.stop();
  await cameraCtl.stop();
  isDemo = false;
  prevLuma = null;
  currLuma = null;
  resetTarget(false);
  clearOverlay();
  resetMetrics();
  await alarmCtl.releaseWakeLock();
  setPhase(PHASE.IDLE);
  if (!quiet) showToast('카메라를 껐어요.');
}

async function flipCamera() {
  if (isDemo) return;
  facingMode = facingMode === 'environment' ? 'user' : 'environment';
  await startCamera();
}

async function refreshCameraControls() {
  // Device picker (only when more than one rear camera is available).
  if (els.cameraSelect) {
    const inputs = await cameraCtl.listVideoInputs();
    if (inputs.length > 1 && !isDemo) {
      els.cameraSelect.innerHTML = '';
      inputs.forEach((device, index) => {
        const option = document.createElement('option');
        option.value = device.deviceId;
        option.textContent = device.label || `카메라 ${index + 1}`;
        if (device.deviceId === cameraCtl.deviceId) option.selected = true;
        els.cameraSelect.appendChild(option);
      });
      els.cameraSelect.classList.remove('hidden');
    } else {
      els.cameraSelect.classList.add('hidden');
    }
  }
  // Zoom slider (only when the track exposes a zoom capability).
  if (els.zoomControl && els.zoomRange) {
    const zoom = cameraCtl.getZoomCapability();
    if (zoom && !isDemo) {
      els.zoomRange.min = zoom.min;
      els.zoomRange.max = zoom.max;
      els.zoomRange.step = zoom.step;
      els.zoomRange.value = zoom.current;
      els.zoomControl.classList.remove('hidden');
    } else {
      els.zoomControl.classList.add('hidden');
    }
  }
}

function configureCanvases() {
  const vw = els.camera.videoWidth || 1280;
  const vh = els.camera.videoHeight || 720;
  if (vw >= vh) {
    els.analysisCanvas.width = ANALYSIS_MAX;
    els.analysisCanvas.height = Math.max(120, Math.round(ANALYSIS_MAX * vh / vw));
  } else {
    els.analysisCanvas.height = ANALYSIS_MAX;
    els.analysisCanvas.width = Math.max(120, Math.round(ANALYSIS_MAX * vw / vh));
  }
  lumaSize = els.analysisCanvas.width * els.analysisCanvas.height;
  prevLuma = null;
  currLuma = new Float32Array(lumaSize);
  resizeOverlay();
  resizeChart();
}

// ==========================================================================
// Coordinate helpers (object-fit aware)
// ==========================================================================
function stageRect() { return els.cameraStage.getBoundingClientRect(); }

function videoRect() {
  const stage = stageRect();
  // CSS uses object-fit: contain for #camera.
  return mediaDisplayRect(stage.width, stage.height, els.camera.videoWidth, els.camera.videoHeight, 'contain');
}

// ==========================================================================
// Frame loop
// ==========================================================================
function startFrameLoop() {
  const token = ++frameLoopToken;
  lastProcessAt = 0;
  lastFrameAt = 0;
  fpsEma = 0;
  const useVfc = typeof els.camera.requestVideoFrameCallback === 'function';
  const step = (now) => {
    if (token !== frameLoopToken || !cameraCtl.isActive) return;
    if (!lastProcessAt || now - lastProcessAt >= PROCESS_INTERVAL_MS) {
      try { processFrame(now); } catch (error) { console.error('frame error', error); }
      lastProcessAt = now;
    }
    if (useVfc) els.camera.requestVideoFrameCallback(step);
    else requestAnimationFrame(step);
  };
  if (useVfc) els.camera.requestVideoFrameCallback(step);
  else requestAnimationFrame(step);
}

function processFrame(now) {
  const aw = els.analysisCanvas.width;
  const ah = els.analysisCanvas.height;
  if (!els.camera.videoWidth || !aw) return;
  try {
    analysisCtx.drawImage(els.camera, 0, 0, aw, ah);
  } catch { return; }

  // FPS estimate.
  if (lastFrameAt) {
    const instantFps = 1000 / Math.max(1, now - lastFrameAt);
    fpsEma = fpsEma ? lerp(fpsEma, instantFps, 0.12) : instantFps;
    els.fpsText.textContent = `${Math.round(fpsEma)}`;
  }
  lastFrameAt = now;

  // Single getImageData for the whole frame; luma + blob mask both read from it.
  frameImage = analysisCtx.getImageData(0, 0, aw, ah);
  fillLuma(frameImage.data, aw, ah);

  if (target) {
    const result = trackFrame(aw, ah, now);
    if (phase === PHASE.CALIBRATING) updateCalibration(result, now);
    else if (phase === PHASE.MONITORING) updateMonitoring(result, now);
    else updateIdleMetrics(result);
  }

  // Roll luma buffers for the next frame's background motion estimate.
  const swap = prevLuma;
  prevLuma = currLuma;
  currLuma = swap || new Float32Array(lumaSize);

  drawOverlay();
}

function fillLuma(data, aw, ah) {
  if (!currLuma || currLuma.length !== aw * ah) currLuma = new Float32Array(aw * ah);
  for (let p = 0, i = 0; p < currLuma.length; p += 1, i += 4) {
    currLuma[p] = luma(data[i], data[i + 1], data[i + 2]);
  }
}

// Run blob tracking + motion estimation for one frame. Returns a rich result.
function trackFrame(aw, ah, now) {
  const lost = target.lostFrames || 0;
  const global = lost >= ROI.GLOBAL_AFTER_LOST;
  const floatHeight = target.floatHeight || target.heightEst || 12;
  const radius = global
    ? Math.max(aw, ah)
    : Math.max(clamp(ROI.BASE_RADIUS_PX + lost * ROI.GROW_PER_LOST_PX, ROI.BASE_RADIUS_PX, ROI.MAX_RADIUS_PX), floatHeight * 2.2);
  const rx = global ? 0 : clamp(Math.floor(target.x - radius), 0, aw - 1);
  const ry = global ? 0 : clamp(Math.floor(target.y - radius), 0, ah - 1);
  const rw = global ? aw : clamp(Math.ceil(target.x + radius), 1, aw) - rx;
  const rh = global ? ah : clamp(Math.ceil(target.y + radius), 1, ah) - ry;
  const roi = { x: rx, y: ry, w: rw, h: rh };

  const options = {
    tolerance: Number(settings.colorTolerance),
    nightMode: settings.nightMode,
    minArea: BLOB.MIN_AREA_PX,
    connectivity: BLOB.CONNECTIVITY,
    maxBlobs: BLOB.MAX_BLOBS
  };
  const ctx = {
    hasPrediction: !global,
    predictX: target.x - rx,
    predictY: target.y - ry,
    initialX: target.initialX - rx,
    initialY: target.initialY - ry,
    floatHeight,
    floatArea: target.floatArea || 0
  };

  const found = blobTracker.analyze(frameImage.data, aw, roi, target, options, ctx);
  const best = found.best;

  // Background (camera/mount) motion for this frame. The exclude rect uses
  // width/height keys (the ROI uses w/h), so convert.
  const exclude = { x: roi.x, y: roi.y, width: roi.w, height: roi.h };
  const background = estimateBackgroundMotion(prevLuma, currLuma, aw, ah, exclude, SHAKE);
  const bgMag = Math.hypot(background.dx, background.dy);
  const bgMagNorm = bgMag / floatHeight;
  const shaking = background.confidence >= SHAKE.MIN_CONFIDENCE && bgMagNorm >= SHAKE.ALARM_SUPPRESS_NORM;
  if (shaking) shakingUntil = now + SHAKE.SUPPRESS_MS;

  // Leaky-integrate background displacement so we can subtract slow camera drift
  // / jitter from the float position without unbounded accumulation.
  if (background.confidence >= SHAKE.MIN_CONFIDENCE) {
    bgOffsetX = bgOffsetX * 0.88 + background.dx;
    bgOffsetY = bgOffsetY * 0.88 + background.dy;
  } else {
    bgOffsetX *= 0.85;
    bgOffsetY *= 0.85;
  }

  const accepted = best && found.bestScore >= 0.22 && best.qualityMean >= 0.18;
  if (!accepted) {
    target.lostFrames = lost + 1;
    target.confidence *= 0.7;
    return {
      found: false, x: target.x, y: target.y, area: 0, height: 0, width: 0,
      confidence: target.confidence, lostFrames: target.lostFrames,
      background, bgMagNorm, shaking
    };
  }

  const absX = roi.x + best.cx;
  const absY = roi.y + best.cy;
  const jumpPx = target.prevX != null ? Math.hypot(absX - target.prevX, absY - target.prevY) : 0;
  const areaRatio = target.floatArea ? best.area / target.floatArea : 1;
  const aspect = best.height / Math.max(1, best.width);
  const confidence = computeConfidence({
    colorMean: best.qualityMean, jumpPx, floatHeight,
    areaRatio, aspect, margin: found.margin
  });
  const smoothing = confidence > 0.62 ? 0.55 : confidence > 0.35 ? 0.4 : 0.26;

  target.prevX = target.x;
  target.prevY = target.y;
  target.x = lerp(target.x, absX, smoothing);
  target.y = lerp(target.y, absY, smoothing);
  target.area = target.area ? lerp(target.area, best.area, 0.36) : best.area;
  target.height = target.height ? lerp(target.height, best.height, 0.4) : best.height;
  target.width = best.width;
  target.heightEst = target.heightEst ? ema(target.heightEst, best.height, 0.1) : best.height;
  target.confidence = confidence;
  target.lostFrames = 0;

  return {
    found: true, x: target.x, y: target.y, area: target.area, height: target.height,
    width: best.width, confidence, lostFrames: 0,
    background, bgMagNorm, shaking, rawX: absX, rawY: absY
  };
}

// ==========================================================================
// Target selection
// ==========================================================================
function handleTargetPointer(event) {
  if (!cameraCtl.isActive || phase === PHASE.IDLE || phase === PHASE.ALARM) return;
  if (phase === PHASE.MONITORING) { showToast('감시를 먼저 멈춘 뒤 찌를 다시 선택해주세요.'); return; }
  if (phase === PHASE.CALIBRATING) return;

  const rect = stageRect();
  const vr = videoRect();
  const px = event.clientX - rect.left;
  const py = event.clientY - rect.top;
  const point = displayToMedia(px, py, vr, els.camera.videoWidth, els.camera.videoHeight);
  if (!point.inside) { showToast('영상 안쪽의 찌를 터치해주세요.'); return; }

  // Convert media coords -> analysis-canvas coords.
  const ax = point.x / els.camera.videoWidth * els.analysisCanvas.width;
  const ay = point.y / els.camera.videoHeight * els.analysisCanvas.height;
  selectTarget(ax, ay);
}

function selectTarget(x, y) {
  try {
    const aw = els.analysisCanvas.width;
    const ah = els.analysisCanvas.height;
    analysisCtx.drawImage(els.camera, 0, 0, aw, ah);
    const radius = 5;
    const x0 = clamp(Math.floor(x - radius), 0, aw - 1);
    const y0 = clamp(Math.floor(y - radius), 0, ah - 1);
    const x1 = clamp(Math.ceil(x + radius), 1, aw);
    const y1 = clamp(Math.ceil(y + radius), 1, ah);
    const patch = analysisCtx.getImageData(x0, y0, x1 - x0, y1 - y0);
    const sample = representativeColor(patch.data, (x1 - x0) * (y1 - y0));
    if (!sample) { showToast('색을 읽지 못했어요. 다시 터치해주세요.'); return; }

    target = {
      initialX: x, initialY: y, x, y, prevX: null, prevY: null,
      rgb: sample.rgb, hsv: sample.hsv,
      area: 0, height: 0, width: 0, heightEst: 0,
      baselineY: y, floatHeight: 0, floatArea: 0, waveMad: 0.6, bgShakeBaseline: 0,
      confidence: 1, lostFrames: 0
    };
    calibrationSamples = [];
    bgOffsetX = 0; bgOffsetY = 0;
    updateTargetColorUi();
    setPhase(PHASE.CALIBRATING);
    showToast('찌를 찾았어요. 잠깐만 그대로 두세요.');
  } catch (error) {
    console.error(error);
    showToast('찌 색을 읽는 중 문제가 생겼어요.');
  }
}

function updateTargetColorUi() {
  if (!target) return;
  els.targetSwatch.style.background = `rgb(${target.rgb.r}, ${target.rgb.g}, ${target.rgb.b})`;
  els.targetColorText.textContent = `${colorName(target.hsv)} · ${rgbToHex(target.rgb)}`;
}

// ==========================================================================
// Calibration (robust: median + MAD, validated before monitoring)
// ==========================================================================
function updateCalibration(result, now) {
  calibrationSamples.push({
    found: result.found, y: result.y, area: result.area,
    height: result.height, confidence: result.confidence, bgMagNorm: result.bgMagNorm
  });
  const progress = clamp(calibrationSamples.length / CALIBRATION_FRAMES, 0, 1);
  if (els.calibrationText) els.calibrationText.textContent = `폰을 움직이지 말아주세요 · ${Math.round(progress * 100)}%`;
  if (calibrationSamples.length < CALIBRATION_FRAMES) return;

  const found = calibrationSamples.filter((s) => s.found && s.confidence >= 0.2);
  const foundRatio = found.length / calibrationSamples.length;
  const meanConf = found.length ? found.reduce((a, s) => a + s.confidence, 0) / found.length : 0;
  const ys = found.map((s) => s.y);
  const heights = found.map((s) => s.height).filter((h) => h > 0);
  const areas = found.map((s) => s.area).filter((a) => a > 0);
  const floatHeight = heights.length ? median(heights) : 0;
  const floatArea = areas.length ? median(areas) : 0;
  const waveMad = Math.max(0.4, mad(ys));
  const bgShake = median(calibrationSamples.map((s) => s.bgMagNorm || 0));

  // --- Validate ----------------------------------------------------------
  const fail = (message) => { showToast(message, 4200); calibrationSamples = []; if (target) setPhase(PHASE.CAMERA); };
  if (foundRatio < CALIB.MIN_FOUND_RATIO) return fail('찌를 자주 놓치고 있어요. 더 선명한 부분을 다시 선택해주세요.');
  if (meanConf < CALIB.MIN_MEAN_CONFIDENCE) return fail('찌와 비슷한 색이 주변에 너무 많아요. 더 또렷한 색을 골라보세요.');
  if (floatHeight < CALIB.MIN_FLOAT_HEIGHT_PX) return fail('찌가 너무 작게 보여요. 줌을 키우거나 카메라를 가까이 해주세요.');
  if (bgShake > CALIB.MAX_BG_SHAKE_NORM) return fail('카메라가 많이 흔들려요. 거치대에 단단히 고정해주세요.');

  target.baselineY = median(ys);
  target.floatHeight = floatHeight;
  target.floatArea = floatArea;
  target.waveMad = waveMad;
  target.bgShakeBaseline = bgShake;
  setPhase(PHASE.READY);
  showToast('보정 완료! 이제 감시를 시작할 수 있어요.');
}

// ==========================================================================
// Monitoring (the heart): normalize, detect, gate, drive the state machine
// ==========================================================================
function startMonitoring() {
  if (!target || phase !== PHASE.READY) return;
  alarmCtl.ensureAudio();
  diagnostics.clear();
  alarmGate.reset();
  graph = [];
  const now = performance.now();
  machine.set(TrackState.TRACKING, now);
  lastFoundAt = now;
  lowConfSince = 0;
  stableFrames = 0;
  lastKnownX = target.x;
  lastKnownY = target.y;
  bgOffsetX = 0; bgOffsetY = 0;
  target._prevYN = undefined;
  target.prevTime = undefined;
  setPhase(PHASE.MONITORING);
  alarmCtl.requestWakeLock();
  showToast('입질 감시를 시작했어요.');
}

function stopMonitoring() {
  if (phase === PHASE.ALARM) { cancelAlarm(true); return; }
  if (phase !== PHASE.MONITORING) return;
  machine.set(TrackState.IDLE, performance.now());
  setPhase(PHASE.READY);
  showToast('감시를 잠시 멈췄어요.');
}

function updateMonitoring(result, now) {
  const floatHeight = target.floatHeight || 12;
  const dt = clamp((now - (target.prevTime || now - PROCESS_INTERVAL_MS)) / 1000, 0.03, 0.25);
  target.prevTime = now;

  // Shake-corrected position relative to the calibrated baseline, normalized to
  // float-height units. Subtracting the leaky background offset removes camera
  // jitter; the normalization keeps sensitivity stable across zoom/resolution.
  const correctedY = (result.found ? result.y : target.y) - bgOffsetY;
  const yN = (correctedY - target.baselineY) / floatHeight;
  const prevYN = target._prevYN ?? yN;
  const correctedDyFrame = yN - prevYN;            // normalized per-frame delta
  const vN = correctedDyFrame / dt;                // float-heights per second
  target._prevYN = yN;

  const areaRatio = target.floatArea ? result.area / target.floatArea : 1;
  const heightRatio = floatHeight ? result.height / floatHeight : 1;
  const shaking = now < shakingUntil;

  // One unified sample feeds both the bite detector and the diagnostics export.
  diagnostics.push({
    t: now, found: result.found,
    x: target.x / els.analysisCanvas.width,
    y: target.y / els.analysisCanvas.height,
    yN, vN, correctedDy: correctedDyFrame,
    areaRatio, heightRatio,
    confidence: result.confidence, shaking
  });

  const sensitivity = (Number(settings.sensitivity) - 1) / 9;
  const adaptive = clamp(1 + adaptiveAdjustment, 0.78, 1.34);
  const bite = analyzeBite(diagnostics.samples, {
    now, windowMs: BITE.WINDOW_MS,
    waveMadN: (target.waveMad / floatHeight) * adaptive,
    detectMode: settings.detectMode, sensitivity
  });

  // Timers used by the state machine.
  if (result.found) {
    lastFoundAt = now;
    lastKnownX = target.x; lastKnownY = target.y;
    if (result.confidence >= CONFIDENCE.LOW) {
      stableFrames += 1;
      if (!lowConfSince) lowConfSince = 0;
    } else {
      stableFrames = 0;
      if (!lowConfSince) lowConfSince = now;
    }
    if (result.confidence >= CONFIDENCE.LOW) lowConfSince = 0;
  } else {
    stableFrames = 0;
  }
  const lostMs = result.found ? 0 : now - lastFoundAt;
  const lowConfMs = lowConfSince ? now - lowConfSince : 0;
  const sinkTrajectory = bite.type === 'sink' && bite.features.sinkScore > 0.5;
  const reacquireDist = Math.hypot(target.x - lastKnownX, target.y - lastKnownY);
  const reacquireOk = result.found && result.confidence >= CONFIDENCE.LOW;

  const signals = {
    found: result.found, confidence: result.confidence, shaking,
    lostMs, lowConfMs, biteScore: bite.score, sinkTrajectory,
    reacquireOk, stableFrames, alarmEmitted: false
  };

  // Alarm gate: only feed it when the machine says alarms are allowed.
  const gateOpen = alarmGateOpen(machine.state, signals);
  const event = alarmGate.update(bite.score, bite.type, now, gateOpen);
  signals.alarmEmitted = Boolean(event);

  const transition = machine.update(signals, now);
  if (transition.changed && transition.message) showToast(transition.message, 2600);
  reflectTrackingState(machine.state);

  if (event) triggerAlarm(event, now);

  // Slowly fold the *normal* float position into the baseline so gradual wind /
  // current drift does not look like a sustained bite. Only while calm + found.
  if (settings.waveCorrection && result.found && result.confidence > 0.4 && bite.score < 0.4 && !shaking) {
    target.baselineY = lerp(target.baselineY, correctedY, 0.006);
  }

  // --- UI ---------------------------------------------------------------
  graph.push(clamp(yN, -1.6, 1.6));
  if (graph.length > 150) graph.shift();
  els.motionGauge.style.setProperty('--value', Math.round(bite.score * 100));
  els.motionScore.textContent = Math.round(bite.score * 100);
  els.verticalMove.textContent = ((correctedY - target.baselineY)).toFixed(1);
  updateTrackingUi(result);
  updateDiagPanel(result, bite, yN);
  drawMotionChart();
}

// Surface LOST / RECOVERING to the status pill during monitoring.
function reflectTrackingState(state) {
  if (phase !== PHASE.MONITORING) return;
  if (state === TrackState.LOST) {
    els.statusLabel.textContent = '찌 놓침';
    els.stateText.textContent = '찌를 놓쳤어요. 화면과 조명을 확인해 주세요.';
  } else if (state === TrackState.RECOVERING) {
    els.statusLabel.textContent = '재탐색';
    els.stateText.textContent = '찌를 다시 찾고 있어요…';
  } else {
    els.statusLabel.textContent = '감시 중';
    els.stateText.textContent = PHASE_LABELS[PHASE.MONITORING][1];
  }
}

function updateIdleMetrics(result) {
  updateTrackingUi(result);
  if (els.diagPanel) updateDiagPanel(result, { score: 0, type: 'none' }, 0);
}

function updateTrackingUi(result) {
  const confidence = Math.round(clamp(result.confidence * 100, 0, 100));
  els.confidenceText.textContent = result.found ? `${confidence}%` : '놓침';
  els.confidenceMetric.textContent = confidence;
  const areaBase = target?.floatArea || result.area || 1;
  const areaPercent = Math.round(clamp(result.area / areaBase * 100, 0, 160));
  els.areaMetric.textContent = result.found ? areaPercent : 0;
}

// ==========================================================================
// Diagnostics panel
// ==========================================================================
function updateDiagPanel(result, bite, yN) {
  if (!els.diagPanel || els.diagPanel.open === false) {
    // Still keep the export target fresh, but skip DOM writes when collapsed.
  }
  if (!els.diagState) return;
  els.diagState.textContent = stateLabel(machine.state);
  els.diagConfidence.textContent = `${Math.round((result.confidence || 0) * 100)}%`;
  els.diagPos.textContent = `${Math.round(target?.x || 0)}, ${Math.round(target?.y || 0)}`;
  els.diagCorrectedDy.textContent = yN.toFixed(3);
  els.diagBgDy.textContent = `${bgOffsetY.toFixed(2)}px`;
  els.diagFloatHeight.textContent = `${(target?.floatHeight || 0).toFixed(1)}px`;
  els.diagCurHeight.textContent = `${(result.height || 0).toFixed(1)}px`;
  els.diagAreaRatio.textContent = `${Math.round((target?.floatArea ? (result.area / target.floatArea) : 0) * 100)}%`;
  els.diagBiteScore.textContent = (bite.score || 0).toFixed(2);
  els.diagFps.textContent = `${Math.round(fpsEma)}`;
}

function stateLabel(state) {
  return {
    [TrackState.IDLE]: '대기', [TrackState.TRACKING]: '추적', [TrackState.POSSIBLE_BITE]: '입질 의심',
    [TrackState.LOST]: '놓침', [TrackState.RECOVERING]: '재탐색', [TrackState.ALARM]: '알람'
  }[state] || state;
}

// ==========================================================================
// Alarm + history
// ==========================================================================
function triggerAlarm(event, now) {
  if (phase !== PHASE.MONITORING) return;
  const typeLabel = { sink: '찌가 잠겼어요!', lift: '찌가 솟았어요!', twitch: '토독 입질!' }[event.type] || '입질 감지!';
  const reasonLabel = {
    sink: '찌가 아래로 가라앉았어요.', lift: '찌가 빠르게 올라왔어요.',
    twitch: '짧고 빠른 떨림이 이어졌어요.'
  }[event.type] || '평소 물결보다 큰 움직임이에요.';
  const score = Math.round(clamp(event.score * 100, 0, 100));

  const record = {
    id: Date.now(), timestamp: new Date().toISOString(),
    reason: typeLabel, type: event.type, score, feedback: null
  };
  history.unshift(record);
  history = history.slice(0, 30);
  saveJson(HISTORY_KEY, history);
  renderHistory();
  currentEventId = record.id;

  // Snapshot for local JSON export.
  lastExportableEvent = diagnostics.exportEvent(
    { at: event.at, timestamp: record.timestamp, type: event.type, score: event.score },
    { floatHeight: target.floatHeight, floatArea: target.floatArea, waveMad: target.waveMad },
    { deviceInfo: navigator.userAgent, analysisFps: Math.round(fpsEma) }
  );
  lastExportableEvent.eventId = record.id; // lets feedback back-fill userLabel

  els.alarmTitle.textContent = typeLabel;
  els.alarmReason.textContent = reasonLabel;
  els.alarmScore.textContent = score;
  machine.set(TrackState.ALARM, now);
  setPhase(PHASE.ALARM);
  alarmCtl.start({ sound: settings.soundEnabled, vibration: settings.vibrationEnabled });
  clearTimeout(alarmTimer);
  alarmTimer = setTimeout(() => cancelAlarm(true), 12000);
}

function cancelAlarm(showFeedback = true) {
  clearTimeout(alarmTimer);
  alarmTimer = null;
  alarmCtl.stop();
  if (phase === PHASE.ALARM) {
    const resume = target && cameraCtl.isActive;
    machine.resume(Boolean(target), performance.now());
    setPhase(resume ? PHASE.MONITORING : cameraCtl.isActive ? PHASE.CAMERA : PHASE.IDLE);
    if (showFeedback && currentEventId) {
      feedbackEventId = currentEventId;
      setTimeout(() => showModal(els.feedbackModal), 120);
    }
  }
  currentEventId = null;
}

function renderHistory() {
  els.historyList.textContent = '';
  if (!history.length) {
    const empty = document.createElement('div');
    empty.className = 'history-empty';
    empty.innerHTML = '<svg viewBox="0 0 24 24"><path d="M4 4v16h16V8l-4-4z"/><path d="M8 13h8M8 17h5M15 4v5h5"/></svg><strong>아직 감지 기록이 없어요</strong><span>입질을 찾으면 시간과 움직임 종류를 남겨드려요.</span>';
    els.historyList.appendChild(empty);
    return;
  }
  history.slice(0, 10).forEach((event) => {
    const item = document.createElement('article');
    item.className = 'history-item';
    const icon = document.createElement('div');
    icon.className = 'history-icon';
    icon.innerHTML = (event.type === 'twitch')
      ? '<svg viewBox="0 0 24 24"><path d="M5 12h2l2-6 3 12 3-9 2 6h2"/></svg>'
      : '<svg viewBox="0 0 24 24"><path d="M12 3v13m-4-4 4 4 4-4M5 20h14"/></svg>';
    const main = document.createElement('div');
    main.className = 'history-main';
    const title = document.createElement('strong');
    title.textContent = event.reason;
    const time = document.createElement('span');
    time.textContent = formatEventTime(event.timestamp);
    main.append(title, time);
    const side = document.createElement('div');
    side.className = 'history-side';
    const score = document.createElement('span');
    score.className = 'history-score';
    score.textContent = `강도 ${event.score}`;
    side.appendChild(score);
    if (event.feedback === true || event.feedback === false) {
      const label = document.createElement('span');
      label.className = `feedback-label ${event.feedback ? 'true' : 'false'}`;
      label.textContent = event.feedback ? '✓ 입질 맞음' : '오탐 표시';
      side.appendChild(label);
    } else {
      const pills = document.createElement('div');
      pills.className = 'feedback-pills';
      const yes = document.createElement('button');
      yes.type = 'button'; yes.dataset.feedbackId = event.id; yes.dataset.feedbackValue = 'true'; yes.textContent = '입질';
      const no = document.createElement('button');
      no.type = 'button'; no.dataset.feedbackId = event.id; no.dataset.feedbackValue = 'false'; no.textContent = '오탐';
      pills.append(yes, no);
      side.appendChild(pills);
    }
    item.append(icon, main, side);
    els.historyList.appendChild(item);
  });
}

function formatEventTime(timestamp) {
  try {
    return new Intl.DateTimeFormat('ko-KR', {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit'
    }).format(new Date(timestamp));
  } catch { return timestamp; }
}

function setFeedback(id, value) {
  const event = history.find((item) => Number(item.id) === Number(id));
  if (!event) return;
  event.feedback = value;
  // Light, local-only sensitivity nudge from false positives.
  adaptiveAdjustment = clamp(adaptiveAdjustment + (value ? -0.018 : 0.055), -0.18, 0.32);
  storage.setItem(ADAPTIVE_KEY, String(adaptiveAdjustment));
  if (lastExportableEvent && Number(lastExportableEvent.eventId) === Number(id)) {
    lastExportableEvent.event.userLabel = value ? 'true_positive' : 'false_positive';
  }
  saveJson(HISTORY_KEY, history);
  renderHistory();
  showToast(value ? '입질로 기록했어요.' : '오탐으로 기록했어요. 민감도를 조금 낮춰 반영합니다.');
}

// ==========================================================================
// Overlay + chart drawing
// ==========================================================================
function resizeOverlay() {
  const rect = stageRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(1, Math.round(rect.width * dpr));
  const height = Math.max(1, Math.round(rect.height * dpr));
  if (els.overlay.width !== width || els.overlay.height !== height) {
    els.overlay.width = width;
    els.overlay.height = height;
    overlayCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
}

function resizeChart() {
  const rect = els.motionChart.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(1, Math.round(rect.width * dpr));
  const height = Math.max(1, Math.round(rect.height * dpr));
  if (els.motionChart.width !== width || els.motionChart.height !== height) {
    els.motionChart.width = width;
    els.motionChart.height = height;
    chartCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  drawMotionChart();
}

function clearOverlay() {
  const rect = stageRect();
  overlayCtx.clearRect(0, 0, rect.width, rect.height);
}

function drawOverlay() {
  const rect = stageRect();
  overlayCtx.clearRect(0, 0, rect.width, rect.height);
  if (!cameraCtl.isActive || !target) return;
  const vr = videoRect();
  const aw = els.analysisCanvas.width;
  const ah = els.analysisCanvas.height;
  const p = mediaToDisplay(target.x / aw * els.camera.videoWidth, target.y / ah * els.camera.videoHeight, vr);
  const confidence = clamp(target.confidence, 0, 1);
  const isLost = target.lostFrames > 2 || machine.state === TrackState.LOST;
  const color = isLost ? '#ff5f70' : confidence > 0.45 ? '#42edc4' : '#ffdb75';
  const radius = 20;

  overlayCtx.save();
  overlayCtx.strokeStyle = color;
  overlayCtx.fillStyle = color;
  overlayCtx.lineWidth = 1.6;
  overlayCtx.shadowColor = color;
  overlayCtx.shadowBlur = 9;
  overlayCtx.beginPath();
  overlayCtx.arc(p.x, p.y, radius, 0, Math.PI * 2);
  overlayCtx.stroke();
  overlayCtx.shadowBlur = 0;
  overlayCtx.beginPath();
  overlayCtx.moveTo(p.x - radius - 9, p.y); overlayCtx.lineTo(p.x - radius + 3, p.y);
  overlayCtx.moveTo(p.x + radius - 3, p.y); overlayCtx.lineTo(p.x + radius + 9, p.y);
  overlayCtx.moveTo(p.x, p.y - radius - 9); overlayCtx.lineTo(p.x, p.y - radius + 3);
  overlayCtx.moveTo(p.x, p.y + radius - 3); overlayCtx.lineTo(p.x, p.y + radius + 9);
  overlayCtx.stroke();
  overlayCtx.beginPath();
  overlayCtx.arc(p.x, p.y, 2.5, 0, Math.PI * 2);
  overlayCtx.fill();

  if ((phase === PHASE.READY || phase === PHASE.MONITORING || phase === PHASE.ALARM) && target.baselineY) {
    const baseY = mediaToDisplay(0, target.baselineY / ah * els.camera.videoHeight, vr).y;
    overlayCtx.setLineDash([5, 5]);
    overlayCtx.strokeStyle = 'rgba(255,255,255,.35)';
    overlayCtx.beginPath();
    overlayCtx.moveTo(Math.max(vr.x, p.x - 64), baseY);
    overlayCtx.lineTo(Math.min(vr.x + vr.width, p.x + 64), baseY);
    overlayCtx.stroke();
    overlayCtx.setLineDash([]);
  }

  const label = isLost ? '찌 놓침' : phase === PHASE.MONITORING ? `감시 ${Math.round(confidence * 100)}%` : `찌 ${Math.round(confidence * 100)}%`;
  overlayCtx.font = '700 11px system-ui, sans-serif';
  const textWidth = overlayCtx.measureText(label).width;
  overlayCtx.fillStyle = 'rgba(3,15,21,.78)';
  overlayCtx.beginPath();
  roundedRectPath(overlayCtx, p.x - textWidth / 2 - 8, p.y + 29, textWidth + 16, 23, 7);
  overlayCtx.fill();
  overlayCtx.fillStyle = color;
  overlayCtx.textAlign = 'center';
  overlayCtx.textBaseline = 'middle';
  overlayCtx.fillText(label, p.x, p.y + 40.5);
  overlayCtx.restore();
}

function roundedRectPath(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

function drawMotionChart() {
  const rect = els.motionChart.getBoundingClientRect();
  const width = rect.width;
  const height = rect.height;
  if (!width || !height) return;
  chartCtx.clearRect(0, 0, width, height);
  chartCtx.strokeStyle = 'rgba(166, 220, 229, 0.09)';
  chartCtx.lineWidth = 1;
  for (let i = 1; i < 4; i += 1) {
    const y = height * i / 4;
    chartCtx.beginPath(); chartCtx.moveTo(0, y); chartCtx.lineTo(width, y); chartCtx.stroke();
  }
  chartCtx.setLineDash([5, 6]);
  chartCtx.strokeStyle = 'rgba(255, 135, 94, 0.28)';
  chartCtx.beginPath();
  chartCtx.moveTo(0, height * 0.18); chartCtx.lineTo(width, height * 0.18);
  chartCtx.moveTo(0, height * 0.82); chartCtx.lineTo(width, height * 0.82);
  chartCtx.stroke();
  chartCtx.setLineDash([]);
  const values = graph.length ? graph : Array.from({ length: 80 }, (_, i) => Math.sin(i * 0.2) * 0.018);
  const visible = values.slice(-150);
  chartCtx.beginPath();
  visible.forEach((value, index) => {
    const x = visible.length <= 1 ? 0 : index / (visible.length - 1) * width;
    const y = height / 2 + clamp(value, -1.6, 1.6) / 1.6 * height * 0.42;
    if (index === 0) chartCtx.moveTo(x, y); else chartCtx.lineTo(x, y);
  });
  const hot = Number(els.motionScore.textContent) >= 70;
  chartCtx.strokeStyle = hot ? '#ff6b7c' : '#42edc4';
  chartCtx.lineWidth = 2;
  chartCtx.shadowColor = hot ? 'rgba(255,107,124,.35)' : 'rgba(66,237,196,.28)';
  chartCtx.shadowBlur = 8;
  chartCtx.stroke();
  chartCtx.shadowBlur = 0;
  chartCtx.strokeStyle = 'rgba(255,255,255,.15)';
  chartCtx.lineWidth = 1;
  chartCtx.beginPath(); chartCtx.moveTo(0, height / 2); chartCtx.lineTo(width, height / 2); chartCtx.stroke();
}

function resetMetrics() {
  graph = [];
  els.motionGauge.style.setProperty('--value', 0);
  els.motionScore.textContent = '0';
  els.verticalMove.textContent = '0.0';
  els.confidenceMetric.textContent = '0';
  els.areaMetric.textContent = '0';
  els.confidenceText.textContent = '—';
  els.fpsText.textContent = '—';
  drawMotionChart();
}

function resetTarget(showMessage = true) {
  if (phase === PHASE.ALARM) cancelAlarm(false);
  target = null;
  calibrationSamples = [];
  machine.set(TrackState.IDLE, performance.now());
  els.targetSwatch.style.background = '';
  els.targetColorText.textContent = '아직 없음';
  resetMetrics();
  clearOverlay();
  if (cameraCtl.isActive) setPhase(PHASE.CAMERA);
  if (showMessage) showToast('화면에서 찌 끝을 다시 터치하세요.');
}

// ==========================================================================
// Diagnostics export
// ==========================================================================
function exportDiagnostics() {
  if (!lastExportableEvent) { showToast('내보낼 입질 이벤트가 아직 없어요.'); return; }
  const name = `jjibom-event-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  if (downloadJson(name, lastExportableEvent)) showToast('이벤트 데이터를 내보냈어요.');
  else showToast('내보내기를 지원하지 않는 환경이에요.');
}

// ==========================================================================
// Events
// ==========================================================================
function bindEvents() {
  els.startCameraBtn.addEventListener('click', startCamera);
  els.startDemoBtn.addEventListener('click', startDemo);
  els.stopCameraBtn.addEventListener('click', () => stopEverything());
  els.flipCameraBtn.addEventListener('click', flipCamera);
  els.resetTargetBtn.addEventListener('click', () => resetTarget(true));
  els.overlay.addEventListener('pointerdown', handleTargetPointer);
  els.monitorBtn.addEventListener('click', () => {
    if (phase === PHASE.READY) startMonitoring();
    else if (phase === PHASE.MONITORING || phase === PHASE.ALARM) stopMonitoring();
  });
  els.stopAlarmBtn.addEventListener('click', () => cancelAlarm(true));

  els.cameraSelect?.addEventListener('change', async () => {
    if (isDemo) return;
    try { await cameraCtl.start({ deviceId: els.cameraSelect.value }); configureCanvases(); resetTarget(false); setPhase(PHASE.CAMERA); startFrameLoop(); await refreshCameraControls(); }
    catch (error) { console.error(error); showToast('카메라를 전환하지 못했어요.'); }
  });
  els.zoomRange?.addEventListener('input', () => { cameraCtl.setZoom(Number(els.zoomRange.value)); });

  els.sensitivity.addEventListener('input', () => { settings.sensitivity = Number(els.sensitivity.value); updateSettingLabels(); saveSettings(); });
  els.detectMode.addEventListener('change', () => { settings.detectMode = els.detectMode.value; saveSettings(); });
  els.nightMode.addEventListener('change', () => { settings.nightMode = els.nightMode.checked; saveSettings(); showToast(settings.nightMode ? '야간 LED 모드를 켰어요.' : '일반 색상 모드로 바꿨어요.'); });
  els.soundEnabled.addEventListener('change', () => { settings.soundEnabled = els.soundEnabled.checked; saveSettings(); if (!settings.soundEnabled) alarmCtl.stop(); else alarmCtl.ensureAudio(); });
  els.vibrationEnabled.addEventListener('change', () => { settings.vibrationEnabled = els.vibrationEnabled.checked; saveSettings(); });
  els.waveCorrection.addEventListener('change', () => { settings.waveCorrection = els.waveCorrection.checked; saveSettings(); });
  els.colorTolerance.addEventListener('input', () => { settings.colorTolerance = Number(els.colorTolerance.value); updateSettingLabels(); saveSettings(); });

  els.demoControls?.addEventListener('click', (event) => {
    const sceneBtn = event.target.closest('[data-demo-scene]');
    if (sceneBtn) { demo.setScenario(sceneBtn.dataset.demoScene); flashDemoButton(sceneBtn); if (phase !== PHASE.MONITORING && (sceneBtn.dataset.demoScene === 'sink' || sceneBtn.dataset.demoScene === 'lift' || sceneBtn.dataset.demoScene === 'twitch')) showToast('움직임을 만들었어요. 알람을 보려면 감시 시작을 눌러주세요.'); return; }
    const biteBtn = event.target.closest('[data-demo-bite]');
    if (biteBtn) { demo.triggerBite(biteBtn.dataset.demoBite); if (phase !== PHASE.MONITORING) showToast('움직임을 만들었어요. 알람을 보려면 감시 시작을 눌러주세요.'); }
  });

  els.diagExportBtn?.addEventListener('click', exportDiagnostics);

  els.historyList.addEventListener('click', (event) => {
    const button = event.target.closest('[data-feedback-id]');
    if (!button) return;
    setFeedback(button.dataset.feedbackId, button.dataset.feedbackValue === 'true');
  });
  els.clearHistoryBtn.addEventListener('click', () => {
    if (!history.length) return;
    if (window.confirm('입질 기록을 모두 지울까요?')) { history = []; saveJson(HISTORY_KEY, history); renderHistory(); showToast('기록을 모두 지웠어요.'); }
  });

  els.helpBtn.addEventListener('click', () => showModal(els.helpModal));
  els.closeHelpBtn.addEventListener('click', () => hideModal(els.helpModal));
  els.helpOkayBtn.addEventListener('click', () => hideModal(els.helpModal));
  els.helpModal.addEventListener('click', (event) => { if (event.target === els.helpModal) hideModal(els.helpModal); });

  els.feedbackTrueBtn.addEventListener('click', () => { if (feedbackEventId) setFeedback(feedbackEventId, true); feedbackEventId = null; hideModal(els.feedbackModal); });
  els.feedbackFalseBtn.addEventListener('click', () => { if (feedbackEventId) setFeedback(feedbackEventId, false); feedbackEventId = null; hideModal(els.feedbackModal); });
  els.feedbackSkipBtn.addEventListener('click', () => { feedbackEventId = null; hideModal(els.feedbackModal); });

  window.addEventListener('beforeinstallprompt', (event) => { event.preventDefault(); deferredInstallPrompt = event; els.installBtn.classList.remove('hidden'); });
  els.installBtn.addEventListener('click', async () => {
    if (!deferredInstallPrompt) { showToast('브라우저 메뉴에서 “홈 화면에 추가”를 선택해주세요.'); return; }
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    els.installBtn.classList.add('hidden');
  });
  window.addEventListener('appinstalled', () => { deferredInstallPrompt = null; els.installBtn.classList.add('hidden'); showToast('찌봄을 홈 화면에 설치했어요.'); });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      alarmCtl.reacquireIfNeeded();
    } else if (phase === PHASE.MONITORING) {
      // The OS can throttle/stop a backgrounded tab's camera analysis.
      showToast('화면이 꺼지거나 다른 앱으로 가면 감시가 멈출 수 있어요.', 3500);
    }
  });
  window.addEventListener('resize', () => { resizeOverlay(); resizeChart(); drawOverlay(); });
  window.addEventListener('orientationchange', () => setTimeout(() => { configureCanvases(); drawOverlay(); }, 250));
  window.addEventListener('beforeunload', () => { cameraCtl.stop(); });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { hideModal(els.helpModal); hideModal(els.feedbackModal); if (phase === PHASE.ALARM) cancelAlarm(true); }
  });
}

function flashDemoButton(button) {
  button.classList.add('active');
  setTimeout(() => button.classList.remove('active'), 600);
}

// ==========================================================================
// Service worker + update banner
// ==========================================================================
async function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || !(window.isSecureContext || location.hostname === 'localhost')) return;
  try {
    const registration = await navigator.serviceWorker.register('./sw.js');
    registration.addEventListener('updatefound', () => {
      const installing = registration.installing;
      if (!installing) return;
      installing.addEventListener('statechange', () => {
        if (installing.state === 'installed' && navigator.serviceWorker.controller) showUpdateBanner(registration);
      });
    });
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloading) return;
      reloading = true;
      window.location.reload();
    });
  } catch (error) {
    console.warn('Service worker registration failed:', error);
  }
}

function showUpdateBanner(registration) {
  if (!els.updateBanner) return;
  els.updateBanner.classList.remove('hidden');
  els.reloadBtn?.addEventListener('click', () => {
    registration.waiting?.postMessage('SKIP_WAITING');
  }, { once: true });
}

// ==========================================================================
// Init
// ==========================================================================
function init() {
  alarmCtl.onWakeStateChange = (state) => {
    els.wakeText.textContent = { on: '켜짐', off: '풀림', unsupported: '미지원' }[state] || '—';
  };
  applySettingsToUi();
  renderHistory();
  setPhase(PHASE.IDLE);
  bindEvents();
  registerServiceWorker();
  resizeChart();
  drawMotionChart();
  if (!window.isSecureContext && location.hostname !== 'localhost' && location.protocol !== 'file:') {
    showToast('실제 카메라 사용에는 HTTPS 연결이 필요해요.', 4200);
  }
}

init();
