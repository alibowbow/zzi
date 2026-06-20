// app.js — orchestration layer. Owns the DOM, the analysis loop and the demo,
// and drives one or more FloatUnit trackers (multi-select). Heavy computation
// lives in the testable modules under ./src.

import { clamp, lerp } from './src/stats.js';
import { representativeColor, colorName, rgbToHex, luma } from './src/color.js';
import { mediaDisplayRect, displayToMedia, mediaToDisplay } from './src/geometry.js';
import { estimateBackgroundMotion } from './src/motionCompensation.js';
import { TrackState } from './src/trackingState.js';
import { FloatUnit } from './src/floatTracker.js';
import { CameraController } from './src/camera.js';
import { AlarmController } from './src/alarm.js';
import { storage, loadJson, saveJson, downloadJson } from './src/storage.js';
import { DemoScene } from './src/demo.js';
import { ANALYSIS_MAX, PROCESS_INTERVAL_MS, CALIBRATION_FRAMES, SHAKE } from './src/config.js';

const HISTORY_KEY = 'jjibom-history-v1';
const SETTINGS_KEY = 'jjibom-settings-v1';
const ADAPTIVE_KEY = 'jjibom-adaptive-v1';

const MAX_FLOATS = 4;
const FLOAT_PALETTE = ['#42edc4', '#62c9ff', '#ffdb75', '#ff9bd2'];

// App-level UI phases (chrome). Fine-grained tracking states live per-float.
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
  'waveCorrection', 'multiSelect', 'colorTolerance', 'toleranceOutput', 'historyList',
  'clearHistoryBtn', 'helpBtn', 'helpModal', 'closeHelpBtn', 'helpOkayBtn', 'feedbackModal',
  'feedbackTrueBtn', 'feedbackFalseBtn', 'feedbackSkipBtn', 'toast',
  'cameraSelect', 'zoomControl', 'zoomRange', 'diagPanel', 'diagState', 'diagConfidence',
  'diagPos', 'diagCorrectedDy', 'diagBgDy', 'diagFloatHeight', 'diagCurHeight',
  'diagAreaRatio', 'diagBiteScore', 'diagFps', 'diagExportBtn', 'updateBanner', 'reloadBtn'
].forEach((id) => { els[id] = $(id); });

const analysisCtx = els.analysisCanvas.getContext('2d', { willReadFrequently: true });
const overlayCtx = els.overlay.getContext('2d');
const chartCtx = els.motionChart.getContext('2d');

const cameraCtl = new CameraController(els.camera);
const alarmCtl = new AlarmController();
const demo = new DemoScene();

// --- Mutable app state ----------------------------------------------------
let phase = PHASE.IDLE;
let isDemo = false;
let facingMode = 'environment';
let frameLoopToken = 0;
let lastProcessAt = 0;
let lastFrameAt = 0;
let fpsEma = 0;
let floats = [];               // FloatUnit[] — one per selected float
let calibFrames = 0;
let history = loadJson(HISTORY_KEY, []);
let adaptiveAdjustment = Number(storage.getItem(ADAPTIVE_KEY) || 0);
let currentEventId = null;
let feedbackEventId = null;
let lastExportableEvent = null;
let toastTimer = null;
let alarmTimer = null;

// Per-frame analysis scratch (reused; no per-frame big allocations).
let frameImage = null;
let prevLuma = null;
let currLuma = null;
let lumaSize = 0;
let bgOffsetX = 0;             // shared, leaky-integrated background displacement
let bgOffsetY = 0;

const settings = Object.assign({
  sensitivity: 6, detectMode: 'balanced', nightMode: false,
  soundEnabled: true, vibrationEnabled: true, waveCorrection: true,
  multiSelect: false, colorTolerance: 28
}, loadJson(SETTINGS_KEY, {}));

const primaryFloat = () => floats[0] || null;

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
  if (els.multiSelect) els.multiSelect.checked = settings.multiSelect;
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
  els.resetTargetBtn.classList.toggle('hidden', !floats.length || next === PHASE.IDLE || next === PHASE.ALARM);
  els.demoControls?.classList.toggle('hidden', !isDemo || next === PHASE.IDLE);
  els.alarmLayer.classList.toggle('hidden', next !== PHASE.ALARM);
  if (els.tapGuide && next === PHASE.CAMERA) updateTapGuide();

  const canMonitor = next === PHASE.READY || next === PHASE.MONITORING || next === PHASE.ALARM;
  els.monitorBtn.disabled = !canMonitor;
  els.monitorBtn.classList.toggle('monitoring', next === PHASE.MONITORING || next === PHASE.ALARM);
  if (next === PHASE.MONITORING) els.monitorBtn.innerHTML = '<span class="record-dot"></span>감시 멈춤';
  else if (next === PHASE.ALARM) els.monitorBtn.innerHTML = '<span class="record-dot"></span>알람 멈춤';
  else els.monitorBtn.innerHTML = '<span class="record-dot"></span>감시 시작';
}

function updateTapGuide() {
  const strong = els.tapGuide.querySelector('strong');
  if (!strong) return;
  if (settings.multiSelect && floats.length) strong.textContent = `찌 ${floats.length}개 선택됨 · 더 터치하거나 감시 준비`;
  else if (settings.multiSelect) strong.textContent = '여러 찌를 터치할 수 있어요';
  else strong.textContent = '화면의 찌 끝을 터치하세요';
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
  return mediaDisplayRect(stage.width, stage.height, els.camera.videoWidth, els.camera.videoHeight, 'contain');
}

// ==========================================================================
// Frame loop — plain requestAnimationFrame for reliability across real cameras
// AND the canvas-captureStream demo (rVFC can stall on canvas streams).
// ==========================================================================
function startFrameLoop() {
  const token = ++frameLoopToken;
  lastProcessAt = 0;
  lastFrameAt = 0;
  fpsEma = 0;
  const step = (now) => {
    if (token !== frameLoopToken || !cameraCtl.isActive) return;
    if (!lastProcessAt || now - lastProcessAt >= PROCESS_INTERVAL_MS) {
      try { processFrame(now); } catch (error) { console.error('frame error', error); }
      lastProcessAt = now;
    }
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function processFrame(now) {
  const aw = els.analysisCanvas.width;
  const ah = els.analysisCanvas.height;
  if (!els.camera.videoWidth || !aw) return;
  try { analysisCtx.drawImage(els.camera, 0, 0, aw, ah); } catch { return; }

  if (lastFrameAt) {
    const instantFps = 1000 / Math.max(1, now - lastFrameAt);
    fpsEma = fpsEma ? lerp(fpsEma, instantFps, 0.12) : instantFps;
    els.fpsText.textContent = `${Math.round(fpsEma)}`;
  }
  lastFrameAt = now;

  frameImage = analysisCtx.getImageData(0, 0, aw, ah);
  fillLuma(frameImage.data, aw, ah);

  if (floats.length) {
    // Whole-frame background (camera/mount) motion — computed once, shared.
    const background = estimateBackgroundMotion(prevLuma, currLuma, aw, ah, null, SHAKE);
    if (background.confidence >= SHAKE.MIN_CONFIDENCE) {
      bgOffsetX = bgOffsetX * 0.88 + background.dx;
      bgOffsetY = bgOffsetY * 0.88 + background.dy;
    } else {
      bgOffsetX *= 0.85;
      bgOffsetY *= 0.85;
    }
    floats.forEach((f) => f.track(frameImage, aw, ah, settings));

    if (phase === PHASE.CALIBRATING) handleCalibrationFrame(background);
    else if (phase === PHASE.MONITORING) handleMonitoringFrame(now, background);
    else updateIdleMetrics();
  }

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

// ==========================================================================
// Target selection (single or multi)
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
    const selection = { x, y, rgb: sample.rgb, hsv: sample.hsv };

    if (settings.multiSelect) {
      // Tapping near an existing float re-points it instead of duplicating.
      const near = floats.find((f) => Math.hypot(f.x - x, f.y - y) <= Math.max(14, f.floatHeight || 12));
      if (near) {
        near.reselect(selection);
      } else if (floats.length < MAX_FLOATS) {
        floats.push(new FloatUnit(selection));
      } else {
        showToast(`찌는 최대 ${MAX_FLOATS}개까지 선택할 수 있어요.`);
        return;
      }
    } else {
      floats = [new FloatUnit(selection)];
    }

    calibFrames = 0;
    floats.forEach((f) => f.beginCalibration());
    bgOffsetX = 0; bgOffsetY = 0;
    updateSelectionUi();
    setPhase(PHASE.CALIBRATING);
    showToast(settings.multiSelect && floats.length > 1
      ? `찌 ${floats.length}개 · 잠깐 그대로 두세요.`
      : '찌를 찾았어요. 잠깐만 그대로 두세요.');
  } catch (error) {
    console.error(error);
    showToast('찌 색을 읽는 중 문제가 생겼어요.');
  }
}

function updateSelectionUi() {
  const primary = primaryFloat();
  if (!primary) { els.targetSwatch.style.background = ''; els.targetColorText.textContent = '아직 없음'; return; }
  els.targetSwatch.style.background = `rgb(${primary.rgb.r}, ${primary.rgb.g}, ${primary.rgb.b})`;
  els.targetColorText.textContent = floats.length > 1
    ? `찌 ${floats.length}개 선택됨`
    : `${colorName(primary.hsv)} · ${rgbToHex(primary.rgb)}`;
}

// ==========================================================================
// Calibration (per-float, validated; multi-float calibrates together)
// ==========================================================================
function handleCalibrationFrame(background) {
  calibFrames += 1;
  const bgMag = Math.hypot(background.dx, background.dy);
  floats.forEach((f) => f.calibrateStep(f.lastResult, bgMag));
  const progress = clamp(calibFrames / CALIBRATION_FRAMES, 0, 1);
  if (els.calibrationText) els.calibrationText.textContent = `폰을 움직이지 말아주세요 · ${Math.round(progress * 100)}%`;
  updateTrackingUi(primaryFloat()?.lastResult);
  if (calibFrames >= CALIBRATION_FRAMES) finalizeCalibration();
}

function finalizeCalibration() {
  const results = floats.map((f) => ({ f, r: f.finishCalibration() }));
  const ok = results.filter((x) => x.r.ok).map((x) => x.f);
  const failed = results.filter((x) => !x.r.ok);

  if (!ok.length) {
    const reason = failed[0]?.r.reason || '보정에 실패했어요.';
    showToast(`${reason} 다시 선택해주세요.`, 4200);
    floats = [];
    updateSelectionUi();
    resetMetrics();
    clearOverlay();
    setPhase(PHASE.CAMERA);
    return;
  }
  floats = ok;
  updateSelectionUi();
  if (failed.length) showToast(`찌 ${failed.length}개는 보정에 실패해 제외했어요.`, 3500);
  else showToast(floats.length > 1 ? `보정 완료! 찌 ${floats.length}개를 감시할 수 있어요.` : '보정 완료! 이제 감시를 시작할 수 있어요.');
  setPhase(PHASE.READY);
}

// ==========================================================================
// Monitoring
// ==========================================================================
function startMonitoring() {
  const ready = floats.filter((f) => f.calibrated);
  if (!ready.length || phase !== PHASE.READY) return;
  alarmCtl.ensureAudio();
  floats = ready;
  const now = performance.now();
  floats.forEach((f) => f.beginMonitoring(now));
  bgOffsetX = 0; bgOffsetY = 0;
  setPhase(PHASE.MONITORING);
  alarmCtl.requestWakeLock();
  showToast(floats.length > 1 ? `찌 ${floats.length}개 감시를 시작했어요.` : '입질 감시를 시작했어요.');
}

function stopMonitoring() {
  if (phase === PHASE.ALARM) { cancelAlarm(true); return; }
  if (phase !== PHASE.MONITORING) return;
  const now = performance.now();
  floats.forEach((f) => f.stopMonitoring(now));
  setPhase(PHASE.READY);
  showToast('감시를 잠시 멈췄어요.');
}

function handleMonitoringFrame(now, background) {
  let alarm = null;
  let alarmUnit = null;
  let message = null;
  floats.forEach((f) => {
    const mon = f.monitor(f.lastResult, now, settings, adaptiveAdjustment, background, bgOffsetY);
    if (mon.changed && mon.message && !message) message = mon.message;
    if (mon.alarmEvent && !alarm) { alarm = mon.alarmEvent; alarmUnit = f; }
  });
  if (message) showToast(message, 2600);
  reflectTrackingState();
  updateMonitorUi();
  if (alarm && alarmUnit) triggerAlarm(alarmUnit, alarm, now);
}

function reflectTrackingState() {
  if (phase !== PHASE.MONITORING) return;
  const states = floats.map((f) => f.machine.state);
  if (states.includes(TrackState.LOST)) {
    els.statusLabel.textContent = '찌 놓침';
    els.stateText.textContent = '찌를 놓쳤어요. 화면과 조명을 확인해 주세요.';
  } else if (states.includes(TrackState.RECOVERING)) {
    els.statusLabel.textContent = '재탐색';
    els.stateText.textContent = '찌를 다시 찾고 있어요…';
  } else {
    els.statusLabel.textContent = '감시 중';
    els.stateText.textContent = PHASE_LABELS[PHASE.MONITORING][1];
  }
}

function updateIdleMetrics() {
  updateTrackingUi(primaryFloat()?.lastResult);
  updateDiagPanel();
}

function updateMonitorUi() {
  const primary = primaryFloat();
  const maxBite = floats.reduce((m, f) => Math.max(m, f.biteScore), 0);
  els.motionGauge.style.setProperty('--value', Math.round(maxBite * 100));
  els.motionScore.textContent = Math.round(maxBite * 100);
  els.verticalMove.textContent = (primary?.correctedRel ?? 0).toFixed(1);
  updateTrackingUi(primary?.lastResult);
  updateDiagPanel();
  drawMotionChart();
}

function updateTrackingUi(result) {
  const r = result || { found: false, confidence: 0, area: 0 };
  const primary = primaryFloat();
  const confidence = Math.round(clamp((r.confidence || 0) * 100, 0, 100));
  els.confidenceText.textContent = r.found ? `${confidence}%` : '놓침';
  els.confidenceMetric.textContent = confidence;
  const areaBase = primary?.floatArea || r.area || 1;
  const areaPercent = Math.round(clamp((r.area || 0) / areaBase * 100, 0, 160));
  els.areaMetric.textContent = r.found ? areaPercent : 0;
}

// ==========================================================================
// Diagnostics panel (reflects the primary float)
// ==========================================================================
function updateDiagPanel() {
  if (!els.diagState) return;
  const primary = primaryFloat();
  const r = primary?.lastResult || { confidence: 0, height: 0, area: 0 };
  els.diagState.textContent = primary ? stateLabel(primary.machine.state) : '—';
  els.diagConfidence.textContent = `${Math.round((r.confidence || 0) * 100)}%`;
  els.diagPos.textContent = primary ? `${Math.round(primary.x)}, ${Math.round(primary.y)}` : '—';
  els.diagCorrectedDy.textContent = (primary?.yN ?? 0).toFixed(3);
  els.diagBgDy.textContent = `${bgOffsetY.toFixed(2)}px`;
  els.diagFloatHeight.textContent = `${(primary?.floatHeight || 0).toFixed(1)}px`;
  els.diagCurHeight.textContent = `${(r.height || 0).toFixed(1)}px`;
  els.diagAreaRatio.textContent = `${Math.round((primary?.floatArea ? (r.area / primary.floatArea) : 0) * 100)}%`;
  els.diagBiteScore.textContent = (primary?.biteScore || 0).toFixed(2);
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
function triggerAlarm(unit, event, now) {
  if (phase !== PHASE.MONITORING) return;
  const idx = floats.indexOf(unit);
  const floatLabel = floats.length > 1 ? `${idx + 1}번 찌` : null;
  const typeLabel = { sink: '찌가 잠겼어요!', lift: '찌가 솟았어요!', twitch: '토독 입질!' }[event.type] || '입질 감지!';
  const reasonLabel = {
    sink: '찌가 아래로 가라앉았어요.', lift: '찌가 빠르게 올라왔어요.', twitch: '짧고 빠른 떨림이 이어졌어요.'
  }[event.type] || '평소 물결보다 큰 움직임이에요.';
  const score = Math.round(clamp(event.score * 100, 0, 100));

  const record = {
    id: Date.now(), timestamp: new Date().toISOString(),
    reason: floatLabel ? `${floatLabel} ${typeLabel}` : typeLabel,
    type: event.type, score, feedback: null
  };
  history.unshift(record);
  history = history.slice(0, 30);
  saveJson(HISTORY_KEY, history);
  renderHistory();
  currentEventId = record.id;

  lastExportableEvent = unit.diag.exportEvent(
    { at: event.at, timestamp: record.timestamp, type: event.type, score: event.score },
    { floatHeight: unit.floatHeight, floatArea: unit.floatArea, waveMad: unit.waveMad },
    { deviceInfo: navigator.userAgent, analysisFps: Math.round(fpsEma) }
  );
  lastExportableEvent.eventId = record.id;

  els.alarmTitle.textContent = floatLabel ? `${floatLabel} · ${typeLabel}` : typeLabel;
  els.alarmReason.textContent = reasonLabel;
  els.alarmScore.textContent = score;
  unit.machine.set(TrackState.ALARM, now);
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
    const now = performance.now();
    floats.forEach((f) => f.resumeAfterAlarm(now));
    setPhase(floats.length && cameraCtl.isActive ? PHASE.MONITORING : cameraCtl.isActive ? PHASE.CAMERA : PHASE.IDLE);
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
// Overlay + chart
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
  if (!cameraCtl.isActive || !floats.length) return;
  const vr = videoRect();
  const aw = els.analysisCanvas.width;
  const ah = els.analysisCanvas.height;
  const multi = floats.length > 1;
  const showBaseline = phase === PHASE.READY || phase === PHASE.MONITORING || phase === PHASE.ALARM;

  floats.forEach((unit, index) => {
    const p = mediaToDisplay(unit.x / aw * els.camera.videoWidth, unit.y / ah * els.camera.videoHeight, vr);
    const confidence = clamp(unit.confidence, 0, 1);
    const isLost = unit.lostFrames > 2 || unit.machine.state === TrackState.LOST;
    const base = FLOAT_PALETTE[index % FLOAT_PALETTE.length];
    const color = isLost ? '#ff5f70' : confidence > 0.45 ? base : '#ffdb75';
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

    if (showBaseline && unit.baselineY) {
      const baseY = mediaToDisplay(0, unit.baselineY / ah * els.camera.videoHeight, vr).y;
      overlayCtx.setLineDash([5, 5]);
      overlayCtx.strokeStyle = 'rgba(255,255,255,.32)';
      overlayCtx.beginPath();
      overlayCtx.moveTo(Math.max(vr.x, p.x - 64), baseY);
      overlayCtx.lineTo(Math.min(vr.x + vr.width, p.x + 64), baseY);
      overlayCtx.stroke();
      overlayCtx.setLineDash([]);
    }

    // Label: a number badge when multiple floats, else a confidence chip.
    const label = multi
      ? (isLost ? `${index + 1} 놓침` : `${index + 1}번 ${Math.round(confidence * 100)}%`)
      : (isLost ? '찌 놓침' : phase === PHASE.MONITORING ? `감시 ${Math.round(confidence * 100)}%` : `찌 ${Math.round(confidence * 100)}%`);
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
  });
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
  const graph = primaryFloat()?.graph || [];
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
  floats = [];
  calibFrames = 0;
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
    try {
      await cameraCtl.start({ deviceId: els.cameraSelect.value });
      configureCanvases(); resetTarget(false); setPhase(PHASE.CAMERA); startFrameLoop(); await refreshCameraControls();
    } catch (error) { console.error(error); showToast('카메라를 전환하지 못했어요.'); }
  });
  els.zoomRange?.addEventListener('input', () => { cameraCtl.setZoom(Number(els.zoomRange.value)); });

  els.sensitivity.addEventListener('input', () => { settings.sensitivity = Number(els.sensitivity.value); updateSettingLabels(); saveSettings(); });
  els.detectMode.addEventListener('change', () => { settings.detectMode = els.detectMode.value; saveSettings(); });
  els.nightMode.addEventListener('change', () => { settings.nightMode = els.nightMode.checked; saveSettings(); showToast(settings.nightMode ? '야간 LED 모드를 켰어요.' : '일반 색상 모드로 바꿨어요.'); });
  els.soundEnabled.addEventListener('change', () => { settings.soundEnabled = els.soundEnabled.checked; saveSettings(); if (!settings.soundEnabled) alarmCtl.stop(); else alarmCtl.ensureAudio(); });
  els.vibrationEnabled.addEventListener('change', () => { settings.vibrationEnabled = els.vibrationEnabled.checked; saveSettings(); });
  els.waveCorrection.addEventListener('change', () => { settings.waveCorrection = els.waveCorrection.checked; saveSettings(); });
  els.multiSelect?.addEventListener('change', () => {
    settings.multiSelect = els.multiSelect.checked;
    saveSettings();
    updateTapGuide();
    showToast(settings.multiSelect ? `여러 찌를 선택할 수 있어요. (최대 ${MAX_FLOATS}개)` : '단일 찌 모드로 바꿨어요.');
  });
  els.colorTolerance.addEventListener('input', () => { settings.colorTolerance = Number(els.colorTolerance.value); updateSettingLabels(); saveSettings(); });

  els.demoControls?.addEventListener('click', (event) => {
    const sceneBtn = event.target.closest('[data-demo-scene]');
    if (!sceneBtn) return;
    const scene = sceneBtn.dataset.demoScene;
    demo.setScenario(scene);
    flashDemoButton(sceneBtn);
    if (phase !== PHASE.MONITORING && (scene === 'sink' || scene === 'lift' || scene === 'twitch')) {
      showToast('움직임을 만들었어요. 알람을 보려면 감시 시작을 눌러주세요.');
    }
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

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      alarmCtl.reacquireIfNeeded();
    } else if (phase === PHASE.MONITORING) {
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
