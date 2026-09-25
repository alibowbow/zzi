// app.js — orchestration layer. Owns the DOM, the camera analysis loop, the
// demo, the shared alarm screen and the app shell (tabs, settings, history).
// Detection itself lives in the tested modules under ./src.

import { clamp, lerp, median } from './src/stats.js';
import { representativeColor, colorName, rgbToHex, luma } from './src/color.js';
import { mediaDisplayRect, displayToMedia, mediaToDisplay } from './src/geometry.js';
import { estimateBackgroundMotion, frameDifference, isFrameUnstable } from './src/motionCompensation.js';
import { TrackState } from './src/trackingState.js';
import { FloatUnit } from './src/floatTracker.js';
import { CameraController } from './src/camera.js';
import { AlarmController, ALARM_TONES } from './src/alarm.js';
import { storage, loadJson, saveJson, downloadJson } from './src/storage.js';
import { DemoScene } from './src/demo.js';
import { ANALYSIS_MAX, PROCESS_INTERVAL_MS, CALIBRATION_FRAMES, SHAKE, BITE } from './src/config.js';
import { MotionController } from './src/motionController.js';
import { MotionState, MotionStateLabel } from './src/motionState.js';
import { MOTION_SCENARIOS, generateScenario, DEMO_BASELINE } from './src/motionScenarios.js';
import { isNativeAvailable, isNativeApp, platform, nativeMotion } from './src/nativeBridge.js';
import { APP_VERSION } from './src/version.js';
import { LakeScene } from './src/ui/scene.js';
import { Seismograph } from './src/ui/seismograph.js';
import { MOTION } from './src/motionConfig.js';

const KEYS = Object.freeze({
  history: 'jjibom-history-v1',
  camera: 'jjibom-settings-v1',
  adaptive: 'jjibom-adaptive-v1',
  motion: 'jjibom-motion-v1',
  motionEvents: 'jjibom-motion-events-v1',
  mode: 'jjibom-mode-v1',
  alarm: 'jjibom-alarm-v1',
  ui: 'jjibom-ui-v1'
});

const MAX_FLOATS = 4;
const MAX_HISTORY = 200;
const FLOAT_PALETTE = ['#8df5c8', '#8fc9ff', '#ffc46b', '#ff9bd2'];
const LOST_WARN_MS = 20000;
const FROZEN_WARN_MS = 4000;
const SENSOR_WARN_MS = 3000;

// App-level camera phases (chrome). Fine-grained tracking states live per float.
const PHASE = Object.freeze({
  IDLE: 'idle', CAMERA: 'camera', CALIBRATING: 'calibrating',
  READY: 'ready', MONITORING: 'monitoring', ALARM: 'alarm'
});

const PHASE_TEXT = {
  [PHASE.IDLE]: ['대기', '카메라를 켜고 찌를 선택하세요.'],
  [PHASE.CAMERA]: ['찌 선택', '화면에서 찌 끝의 또렷한 색을 눌러 주세요.'],
  [PHASE.CALIBRATING]: ['보정 중', '평소 물결을 익히고 있어요. 폰을 건드리지 마세요.'],
  [PHASE.READY]: ['준비 완료', '감시 시작을 누르면 입질 알람이 켜져요.'],
  [PHASE.MONITORING]: ['감시 중', '찌 움직임을 지켜보고 있어요.'],
  [PHASE.ALARM]: ['입질!', '큰 움직임이 감지됐어요.']
};

const MOTION_RUNNING = new Set([
  MotionState.REQUESTING_PERMISSION, MotionState.CALIBRATING, MotionState.ARMED, MotionState.POSSIBLE_BITE,
  MotionState.ALARM, MotionState.COOLDOWN, MotionState.STABILIZING, MotionState.PAUSED, MotionState.ERROR
]);
const MOTION_WATCHING = new Set([
  MotionState.ARMED, MotionState.POSSIBLE_BITE, MotionState.ALARM, MotionState.COOLDOWN, MotionState.STABILIZING
]);

const CAMERA_TYPE = {
  sink: { title: '찌가 잠겼어요!', reason: '찌가 아래로 끌려 들어갔어요.' },
  lift: { title: '찌가 솟았어요!', reason: '찌가 빠르게 올라왔어요.' },
  twitch: { title: '토독 입질!', reason: '짧고 빠른 떨림이 이어졌어요.' }
};
const MOTION_PATTERN = { strong_pull: '강한 당김', tap: '토독 입질', repeated: '반복 입질' };

// ==========================================================================
// DOM
// ==========================================================================
const $ = (id) => document.getElementById(id);
const els = {};
[
  'app', 'liveChip', 'liveChipText', 'nightBtn', 'focusBtn', 'warnBanner', 'warnTitle', 'warnText', 'warnClose',
  'modeCameraBtn', 'modeMotionBtn', 'cameraMode', 'motionMode', 'scene', 'ambient', 'seismo',
  'camera', 'cameraStage', 'overlay', 'analysisCanvas', 'demoCanvas', 'cameraEmpty', 'startCameraBtn', 'startDemoBtn',
  'tapGuide', 'tapGuideText', 'calibrationPanel', 'calibrationFill', 'calibrationText', 'statusPill', 'statusLabel',
  'resetTargetBtn', 'flipCameraBtn', 'cameraHud', 'confidenceText', 'fpsText', 'wakeText', 'stateText',
  'cameraDeck', 'deckLive', 'deckMore', 'targetDrawer', 'cameraScore',
  'stopCameraBtn', 'monitorBtn', 'monitorBtnText', 'motionScore', 'verticalMove', 'confidenceMetric',
  'areaMetric', 'motionChart', 'targetSwatch', 'targetColorText', 'zoomControl', 'zoomRange', 'cameraSelectRow',
  'cameraSelect', 'demoControls',
  'motionDeck', 'motionStage', 'motionStatusPill', 'motionStatusLabel', 'motionBgChip', 'motionBackground', 'motionGaugeBig', 'motionScoreBig',
  'motionBandText', 'motionStateText', 'motionCalibPanel', 'motionCalibFill', 'motionCalibText', 'motionElapsed',
  'motionMagnitude', 'motionBattery', 'motionStopBtn', 'motionCalibrateBtn', 'motionStartBtn',
  'motionBgNote', 'motionDemoControls', 'motionDemoChips',
  'sessionSince', 'sessionDuration', 'sessionAlarms', 'sessionTrue', 'sessionFalse', 'sessionLost', 'sessionBattery',
  'exportHistoryBtn', 'clearHistoryBtn', 'historyList', 'historyBadge',
  'soundEnabled', 'vibrationEnabled', 'alarmToneGroup', 'alarmVolume', 'alarmVolumeOut', 'alarmDuration', 'failAlert',
  'testAlarmBtn', 'sensitivity', 'sensitivityOutput', 'detectMode', 'nightMode', 'waveCorrection', 'multiSelect',
  'colorTolerance', 'toleranceOutput', 'motionSensitivity', 'motionSensOut', 'motionPresets', 'motionPattern',
  'motionKeepAwake', 'nativeGroup', 'nativeNotifText', 'nativeNotifBtn', 'nativeBatteryText', 'nativeBatteryBtn',
  'nativeSensorText', 'versionText', 'platformPill', 'envText', 'checkEnvBtn', 'replayOnboardingBtn', 'diagPanel',
  'diagState', 'diagConfidence', 'diagPos', 'diagCorrectedDy', 'diagBgDy', 'diagFloatHeight', 'diagCurHeight',
  'diagAreaRatio', 'diagBiteScore', 'diagFps', 'diagExportBtn', 'motionExportBtn', 'guideBgNote',
  'alarmScreen', 'alarmKicker', 'alarmTitle', 'alarmReason', 'alarmScore', 'alarmTime', 'stopAlarmBtn', 'alarmFeedback',
  'onboarding', 'onboardDots', 'onboardSkip', 'onboardNext', 'onboardBgText', 'toast', 'updateBanner', 'reloadBtn'
].forEach((id) => { els[id] = $(id); });
const tabButtons = [...document.querySelectorAll('.dock [data-tab]')];
const panels = { history: $('view-history'), settings: $('view-settings'), guide: $('view-guide') };

const analysisCtx = els.analysisCanvas.getContext('2d', { willReadFrequently: true });
const overlayCtx = els.overlay.getContext('2d');
const chartCtx = els.motionChart.getContext('2d');
const ambientCtx = els.ambient.getContext('2d');

const cameraCtl = new CameraController(els.camera);
const alarmCtl = new AlarmController();
const demo = new DemoScene();
const scene = new LakeScene(els.scene);
const seismo = new Seismograph(els.seismo, { trigger: MOTION.TRIGGER_SCORE, possible: MOTION.POSSIBLE_SCORE });

// ==========================================================================
// Persistent settings
// ==========================================================================
const storedCamera = loadJson(KEYS.camera, {});
const settings = Object.assign({
  sensitivity: 6, detectMode: 'balanced', nightMode: false, waveCorrection: true, multiSelect: false, colorTolerance: 28
}, storedCamera);
const alarmSettings = Object.assign({
  sound: storedCamera.soundEnabled ?? true,
  vibration: storedCamera.vibrationEnabled ?? true,
  tone: 'rise', volume: 100, durationSec: 20, failAlert: true
}, loadJson(KEYS.alarm, {}));
const storedMotion = loadJson(KEYS.motion, {});
const motionSettings = Object.assign({ sensitivity: 5, detectMode: 'all', keepAwake: true }, storedMotion);
const ui = Object.assign({ night: Boolean(storedMotion.dark), onboarded: false, filter: 'all' }, loadJson(KEYS.ui, {}));

const saveCamera = () => saveJson(KEYS.camera, settings);
const saveAlarm = () => saveJson(KEYS.alarm, alarmSettings);
const saveMotion = () => saveJson(KEYS.motion, motionSettings);
const saveUi = () => saveJson(KEYS.ui, ui);

function alarmOptions(extra = {}) {
  return {
    sound: alarmSettings.sound, vibration: alarmSettings.vibration, tone: alarmSettings.tone,
    volume: alarmSettings.volume / 100, durationSec: alarmSettings.durationSec, ...extra
  };
}

function motionControllerSettings() {
  return {
    ...motionSettings,
    sound: alarmSettings.sound, vibration: alarmSettings.vibration, alarmTone: alarmSettings.tone,
    alarmSeconds: alarmSettings.durationSec, volume: alarmSettings.volume / 100
  };
}

// ==========================================================================
// Runtime state
// ==========================================================================
let appMode = 'camera';
let tab = 'watch';
let phase = PHASE.IDLE;
let isDemo = false;
let facingMode = 'environment';
let frameLoopToken = 0;
let lastProcessAt = 0;
let lastFrameAt = 0;
let fpsEma = 0;
let floats = [];               // FloatUnit[] — one per selected float
let calibFrames = 0;
let history = loadJson(KEYS.history, []);
let adaptiveAdjustment = Number(storage.getItem(KEYS.adaptive) || 0);
let lastCameraExport = null;
let lastMotionExport = null;
let motionBaselineReady = false;
let motionState = MotionState.IDLE;
let toastTimer = null;
let themeColors = { lume: '#8df5c8', ember: '#ff6a3d', amber: '#ffc46b' };
let lockAnim = null;           // { x, y, start } — lock-on animation after a tap
let overlayAnimRaf = 0;

// Per-frame analysis scratch (reused; no per-frame big allocations).
let frameImage = null;
let prevLuma = null;
let currLuma = null;
let lumaSize = 0;
let bgOffsetX = 0;             // shared, leaky-integrated background displacement
let bgOffsetY = 0;
let frameDiff = 0;             // mean luma change vs previous frame (floats excluded)
let calibDiffs = [];
let sceneDiffBaseline = 0;     // calm-scene frame difference learned during calibration
let lastShakeAt = -Infinity;
let reanchorPending = false;

// The alarm currently on screen (camera or motion) and its history record.
let activeAlarm = null;        // { mode, recordId }

// Session = since the app was opened.
const session = {
  firstStart: null, monitoredMs: 0, runStart: null, alarms: 0,
  truePos: 0, falsePos: 0, lost: 0, batteryStart: null, battery: null
};

// Monitoring-failure watchdogs.
const safety = {
  lostSince: null, lostWarned: false,
  frozenSince: null, frozenWarned: false,
  sensorTimer: null, hiddenAt: null,
  bannerKind: null
};

const primaryFloat = () => floats[0] || null;
const cameraWatching = () => phase === PHASE.MONITORING || phase === PHASE.ALARM;
const motionRunning = () => MOTION_RUNNING.has(motionState);
const motionWatching = () => MOTION_WATCHING.has(motionState);

// ==========================================================================
// Small UI helpers
// ==========================================================================
function showToast(message, duration = 2600) {
  clearTimeout(toastTimer);
  els.toast.textContent = message;
  els.toast.hidden = false;
  document.body.classList.add('toasting');
  els.toast.style.animation = 'none';
  void els.toast.offsetWidth;
  els.toast.style.animation = '';
  toastTimer = setTimeout(() => { els.toast.hidden = true; document.body.classList.remove('toasting'); }, duration);
}

function formatClock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

function formatDuration(ms) {
  const min = Math.floor(ms / 60000);
  if (min < 60) return `${min}분`;
  return `${Math.floor(min / 60)}시간 ${min % 60}분`;
}

function formatEventTime(timestamp) {
  try {
    return new Intl.DateTimeFormat('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .format(new Date(timestamp));
  } catch { return String(timestamp); }
}

function timeOfDay(date = new Date()) {
  return date.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

function setRangeFill(input) {
  const min = Number(input.min || 0);
  const max = Number(input.max || 100);
  input.style.setProperty('--fill', `${((Number(input.value) - min) / (max - min)) * 100}%`);
}

function readThemeColors() {
  const cs = getComputedStyle(document.body);
  themeColors = {
    lume: cs.getPropertyValue('--lume').trim() || '#8df5c8',
    ember: cs.getPropertyValue('--ember').trim() || '#ff6a3d',
    amber: cs.getPropertyValue('--amber').trim() || '#ffc46b'
  };
  seismo.setColors({ lume: themeColors.lume, ember: themeColors.ember, amber: themeColors.amber, paper: ui.night ? '239,180,169' : '243,239,231' });
}

// The stage sits between the top bar and the control deck; keep it in step
// with the deck's real height (it changes with state and content).
function syncLayout() {
  const deck = appMode === 'motion' ? els.motionDeck : els.cameraDeck;
  const h = deck.offsetHeight || 190;
  document.documentElement.style.setProperty('--deck-h', `${Math.round(h)}px`);
  requestAnimationFrame(() => {
    const stage = (appMode === 'motion' ? els.motionStage : els.cameraStage).getBoundingClientRect();
    // On a short, wide stage (phone on its side) the headline takes the left,
    // so the float moves right instead of sitting under the words.
    const heroShown = appMode === 'motion' ? motionState === MotionState.IDLE : phase === PHASE.IDLE;
    const cramped = stage.width < 720 && stage.width > stage.height * 1.1;
    scene.setCenter(stage.width ? stage.left + stage.width * (heroShown && cramped ? 0.8 : 0.5) : null);
    resizeOverlay(); resizeChart(); seismo.resize(); drawOverlay();
  });
}

function haptic() {
  if (alarmSettings.vibration && typeof navigator.vibrate === 'function') {
    try { navigator.vibrate(8); } catch { /* ignore */ }
  }
}

// The lake animates only while it is what the user is looking at.
function updateScene() {
  const hidden = document.visibilityState === 'hidden';
  const cameraOn = appMode === 'camera' && cameraCtl.isActive;
  if (hidden || cameraOn) { scene.stop(); return; }
  scene.setDim(appMode === 'motion' ? (motionRunning() ? 0.94 : 0.35) : 0);
  if (appMode === 'motion' && motionRunning()) { scene.stop(); scene.draw(performance.now()); }
  else scene.start();
}

// ---- warning banner (monitoring problems) --------------------------------
function warn(kind, title, text, { sound = true } = {}) {
  safety.bannerKind = kind;
  els.warnTitle.textContent = title;
  els.warnText.textContent = text;
  els.warnBanner.hidden = false;
  document.body.classList.add('has-banner');
  if (sound && alarmSettings.failAlert && !activeAlarm) {
    alarmCtl.warn({ sound: alarmSettings.sound, vibration: alarmSettings.vibration, volume: alarmSettings.volume / 100 });
  }
}

function clearWarn(kind) {
  if (kind && safety.bannerKind !== kind) return;
  safety.bannerKind = null;
  els.warnBanner.hidden = true;
  document.body.classList.remove('has-banner');
}

// ==========================================================================
// Tabs, night, focus
// ==========================================================================
function switchTab(next) {
  if (!['watch', 'history', 'settings', 'guide'].includes(next)) return;
  tab = next;
  els.app.dataset.tab = next;
  Object.entries(panels).forEach(([name, panel]) => {
    panel.hidden = name !== next;
    if (name === next) panel.scrollTop = 0;
  });
  document.body.classList.toggle('panel-open', next !== 'watch');
  tabButtons.forEach((b) => {
    if (b.dataset.tab === next) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  if (next === 'history') {
    els.historyBadge.hidden = true;
    renderHistory();
    renderSession();
  }
  if (next === 'settings') refreshNativeInfo();
  if (next === 'watch') requestAnimationFrame(() => { resizeOverlay(); resizeChart(); drawOverlay(); });
}

function applyNight() {
  document.body.classList.toggle('night', ui.night);
  els.nightBtn.setAttribute('aria-pressed', String(ui.night));
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', ui.night ? '#030101' : '#030507');
  scene.setNight(ui.night);
  readThemeColors();
  drawMotionChart();
}

function setFocus(on) {
  els.app.classList.toggle('focus', on);
  document.body.classList.toggle('focus-mode', on);
  els.focusBtn.setAttribute('aria-pressed', String(on));
  els.focusBtn.querySelector('use').setAttribute('href', on ? '#i-shrink' : '#i-expand');
  els.focusBtn.setAttribute('aria-label', on ? '집중 모드 끄기' : '집중 모드');
  if (on) {
    switchTab('watch');
    document.documentElement.requestFullscreen?.({ navigationUI: 'hide' }).catch(() => {});
  } else if (document.fullscreenElement) {
    document.exitFullscreen?.().catch(() => {});
  }
  syncLayout();
}

// ==========================================================================
// Session + live chip
// ==========================================================================
function sessionRun(on) {
  const now = Date.now();
  if (on && !session.runStart) {
    session.runStart = now;
    if (!session.firstStart) session.firstStart = now;
    if (session.batteryStart == null && session.battery) session.batteryStart = session.battery.level;
  } else if (!on && session.runStart) {
    session.monitoredMs += now - session.runStart;
    session.runStart = null;
  }
  renderLiveChip();
}

function renderLiveChip() {
  const watching = cameraWatching() || motionRunning();
  els.app.dataset.watching = String(watching);
  els.liveChip.hidden = !watching;
  if (!watching) return;
  const alarm = Boolean(activeAlarm) || phase === PHASE.ALARM || motionState === MotionState.ALARM;
  els.liveChip.classList.toggle('alert', alarm);
  const run = session.runStart ? Date.now() - session.runStart : 0;
  els.liveChipText.textContent = alarm ? '입질!' : `감시 중 · ${formatClock(run)}`;
}

function renderSession() {
  const total = session.monitoredMs + (session.runStart ? Date.now() - session.runStart : 0);
  els.sessionSince.textContent = session.firstStart
    ? `${new Date(session.firstStart).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}부터`
    : '아직 시작 전';
  els.sessionDuration.textContent = formatDuration(total);
  els.sessionAlarms.textContent = session.alarms;
  els.sessionTrue.textContent = session.truePos;
  els.sessionFalse.textContent = session.falsePos;
  els.sessionLost.textContent = session.lost;
  const used = session.batteryStart != null && session.battery ? Math.round((session.batteryStart - session.battery.level) * 100) : null;
  els.sessionBattery.textContent = used == null ? '—' : `${Math.max(0, used)}%`;
}

function everySecond() {
  renderLiveChip();
  if (tab === 'history') renderSession();
  if (appMode === 'motion' && motionRunning() && !isNativeAvailable() && session.runStart) {
    els.motionElapsed.textContent = formatClock(Date.now() - session.runStart);
  }
}

async function watchBattery() {
  if (!navigator.getBattery) return;
  try {
    session.battery = await navigator.getBattery();
    const show = () => { els.motionBattery.textContent = `${Math.round(session.battery.level * 100)}%`; };
    show();
    session.battery.addEventListener('levelchange', show);
  } catch { /* unsupported */ }
}

// ==========================================================================
// Camera / demo lifecycle
// ==========================================================================
async function startCamera() {
  await stopCamera(true);
  await alarmCtl.ensureAudio();
  if (!navigator.mediaDevices?.getUserMedia) {
    showToast(window.isSecureContext
      ? '이 브라우저는 카메라를 지원하지 않아요.'
      : '카메라는 HTTPS 주소에서만 쓸 수 있어요.', 4500);
    return;
  }
  els.startCameraBtn.disabled = true;
  els.startCameraBtn.querySelector('span').textContent = '카메라 여는 중…';
  try {
    await cameraCtl.start({ facingMode });
    isDemo = false;
    cameraCtl.track?.addEventListener('ended', onCameraTrackEnded, { once: true });
    configureCanvases();
    resetTarget(false);
    setPhase(PHASE.CAMERA);
    startFrameLoop();
    await alarmCtl.requestWakeLock();
    await refreshCameraControls();
    haptic();
    showToast('카메라가 켜졌어요. 찌 끝을 눌러 주세요.');
  } catch (error) {
    console.warn('camera start failed', error);
    let message = '카메라를 열지 못했어요.';
    if (error?.name === 'NotAllowedError') message = '카메라 권한이 거부됐어요. 브라우저·앱 설정에서 허용해 주세요.';
    else if (error?.name === 'NotFoundError') message = '사용할 수 있는 카메라를 찾지 못했어요.';
    else if (error?.name === 'NotReadableError') message = '다른 앱이 카메라를 쓰고 있을 수 있어요.';
    else if (error?.name === 'NotSupportedError') message = '이 브라우저는 카메라를 지원하지 않아요.';
    showToast(message, 4500);
    setPhase(PHASE.IDLE);
  } finally {
    els.startCameraBtn.disabled = false;
    els.startCameraBtn.querySelector('span').textContent = '카메라 켜기';
  }
}

async function startDemo() {
  await stopCamera(true);
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
    showToast('데모가 시작됐어요. 빨간 찌 끝을 눌러 주세요.', 3500);
  } catch (error) {
    console.warn('demo start failed', error);
    showToast('데모 영상을 시작하지 못했어요.');
    await stopCamera(true);
  }
}

async function stopCamera(quiet = false) {
  if (phase === PHASE.ALARM) closeAlarmScreen(null);
  if (cameraWatching()) sessionRun(false);
  frameLoopToken += 1;
  demo.stop();
  cameraCtl.track?.removeEventListener('ended', onCameraTrackEnded);
  await cameraCtl.stop();
  isDemo = false;
  prevLuma = null;
  currLuma = null;
  resetTarget(false);
  clearOverlay();
  resetMetrics();
  resetCameraSafety();
  ambientCtx.clearRect(0, 0, els.ambient.width, els.ambient.height);
  await alarmCtl.releaseWakeLock();
  setPhase(PHASE.IDLE);
  if (!quiet) showToast('카메라를 껐어요.');
}

function onCameraTrackEnded() {
  const wasWatching = cameraWatching();
  stopCamera(true);
  if (wasWatching) warn('camera', '카메라가 꺼졌어요', '감시가 멈췄어요. 카메라를 다시 켜 주세요.');
  else showToast('카메라 연결이 끊겼어요.');
}

async function flipCamera() {
  if (isDemo) return;
  facingMode = facingMode === 'environment' ? 'user' : 'environment';
  await startCamera();
}

async function refreshCameraControls() {
  const inputs = await cameraCtl.listVideoInputs();
  if (inputs.length > 1 && !isDemo) {
    els.cameraSelect.textContent = '';
    inputs.forEach((device, index) => {
      const option = document.createElement('option');
      option.value = device.deviceId;
      option.textContent = device.label || `카메라 ${index + 1}`;
      if (device.deviceId === cameraCtl.deviceId) option.selected = true;
      els.cameraSelect.appendChild(option);
    });
    els.cameraSelectRow.hidden = false;
  } else {
    els.cameraSelectRow.hidden = true;
  }
  const zoom = cameraCtl.getZoomCapability();
  if (zoom && !isDemo) {
    els.zoomRange.min = zoom.min;
    els.zoomRange.max = zoom.max;
    els.zoomRange.step = zoom.step;
    els.zoomRange.value = zoom.current;
    setRangeFill(els.zoomRange);
    els.zoomControl.hidden = false;
  } else {
    els.zoomControl.hidden = true;
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
// Camera phase → chrome
// ==========================================================================
// The numbered start steps double as progress on wide screens:
// done steps turn lume, the current one is marked, the rest wait.
function markSteps(list, done, current) {
  list.querySelectorAll('li').forEach((li, index) => {
    const n = index + 1;
    li.dataset.step = !current ? '' : n <= done ? 'done' : n === current ? 'now' : 'later';
  });
}

function setPhase(next) {
  phase = next;
  const cameraOn = cameraCtl.isActive;
  const watching = next === PHASE.MONITORING || next === PHASE.ALARM;
  els.app.dataset.phase = next;
  els.app.dataset.camera = cameraOn ? 'on' : 'off';
  els.statusPill.dataset.status = next;
  els.statusLabel.textContent = PHASE_TEXT[next][0];
  els.stateText.textContent = PHASE_TEXT[next][1];
  els.cameraEmpty.hidden = next !== PHASE.IDLE;
  els.tapGuide.hidden = next !== PHASE.CAMERA;
  els.calibrationPanel.hidden = next !== PHASE.CALIBRATING;
  els.cameraHud.hidden = next === PHASE.IDLE;
  els.flipCameraBtn.hidden = next === PHASE.IDLE || isDemo;
  els.resetTargetBtn.hidden = !floats.length || next === PHASE.IDLE || next === PHASE.ALARM;
  els.demoControls.hidden = !isDemo || next === PHASE.IDLE;
  els.targetDrawer.hidden = watching;
  els.deckMore.hidden = next === PHASE.IDLE || (watching && !isDemo);
  els.deckLive.hidden = !watching;
  els.startCameraBtn.hidden = next !== PHASE.IDLE;
  els.startDemoBtn.hidden = next !== PHASE.IDLE;
  els.stopCameraBtn.hidden = next === PHASE.IDLE;
  els.monitorBtn.hidden = next === PHASE.IDLE;
  if (next === PHASE.CAMERA) updateTapGuide();

  els.monitorBtn.disabled = !(next === PHASE.READY || watching);
  els.monitorBtn.classList.toggle('stop', watching);
  els.monitorBtn.classList.toggle('ember', !watching);
  els.monitorBtnText.textContent = next === PHASE.MONITORING ? '감시 멈춤' : next === PHASE.ALARM ? '알람 끄기' : '감시 시작';
  const [done, current] = { [PHASE.CAMERA]: [1, 2], [PHASE.CALIBRATING]: [2, 3], [PHASE.READY]: [2, 3] }[next] || [0, 0];
  markSteps(els.cameraDeck.querySelector('.deck-steps'), done, current);
  renderLiveChip();
  updateScene();
  syncLayout();
}

function updateTapGuide() {
  if (settings.multiSelect && floats.length) els.tapGuideText.textContent = `찌 ${floats.length}개 선택됨 · 더 누르거나 잠시 기다리세요`;
  else if (settings.multiSelect) els.tapGuideText.textContent = '감시할 찌들을 차례로 눌러 주세요';
  else els.tapGuideText.textContent = '찌 끝을 톡 눌러 주세요';
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
      try { processFrame(now); } catch (error) { console.warn('frame error', error); }
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
  // Some browsers pause a muted video that scrolls out of view; keep it running.
  if (els.camera.paused) els.camera.play().catch(() => {});
  try { analysisCtx.drawImage(els.camera, 0, 0, aw, ah); } catch { return; }

  if (lastFrameAt) {
    const instantFps = 1000 / Math.max(1, now - lastFrameAt);
    fpsEma = fpsEma ? lerp(fpsEma, instantFps, 0.12) : instantFps;
    els.fpsText.textContent = `${Math.round(fpsEma)}`;
  }
  lastFrameAt = now;

  frameImage = analysisCtx.getImageData(0, 0, aw, ah);
  fillLuma(frameImage.data, aw, ah);
  ambientCtx.drawImage(els.analysisCanvas, 0, 0, els.ambient.width, els.ambient.height);

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
    frameDiff = frameDifference(prevLuma, currLuma, aw, ah, floats.map((f) => floatExclusion(f, aw, ah)));

    if (phase === PHASE.CALIBRATING) handleCalibrationFrame(background);
    else if (phase === PHASE.MONITORING) handleMonitoringFrame(now, background);
    else updateIdleMetrics();
  }
  if (cameraWatching() && prevLuma) checkFrozen(now, aw, ah);

  const swap = prevLuma;
  prevLuma = currLuma;
  currLuma = swap || new Float32Array(lumaSize);
  drawOverlay();
}

// Region around a float (including where it can sink to) that must not count
// as scene change: the float moving is the signal, not camera shake.
function floatExclusion(f, aw, ah) {
  const r = Math.max(24, (f.floatHeight || f.heightEst || 12) * 3);
  const x = clamp(Math.floor(f.x - r), 0, aw);
  const y = clamp(Math.floor(f.y - r), 0, ah);
  return { x, y, width: Math.min(aw - x, Math.ceil(r * 2)), height: Math.min(ah - y, Math.ceil(r * 3)) };
}

function fillLuma(data, aw, ah) {
  if (!currLuma || currLuma.length !== aw * ah) currLuma = new Float32Array(aw * ah);
  for (let p = 0, i = 0; p < currLuma.length; p += 1, i += 4) {
    currLuma[p] = luma(data[i], data[i + 1], data[i + 2]);
  }
}

// A live camera always has sensor noise; a perfectly identical frame for
// seconds means the stream froze (camera taken by another app, driver hiccup).
function checkFrozen(now, aw, ah) {
  const diff = frameDifference(prevLuma, currLuma, aw, ah, []);
  if (diff > 0) {
    safety.frozenSince = null;
    if (safety.frozenWarned) { safety.frozenWarned = false; clearWarn('frozen'); }
    return;
  }
  if (safety.frozenSince == null) safety.frozenSince = now;
  if (!safety.frozenWarned && now - safety.frozenSince > FROZEN_WARN_MS) {
    safety.frozenWarned = true;
    warn('frozen', '카메라 영상이 멈췄어요', '다른 앱이 카메라를 쓰고 있거나 연결이 끊겼을 수 있어요.');
  }
}

function resetCameraSafety() {
  safety.lostSince = null;
  safety.lostWarned = false;
  safety.frozenSince = null;
  safety.frozenWarned = false;
  clearWarn('lost');
  clearWarn('frozen');
}

// ==========================================================================
// Target selection (single or multi)
// ==========================================================================
function handleTargetPointer(event) {
  if (!cameraCtl.isActive || phase === PHASE.IDLE || phase === PHASE.ALARM) return;
  if (phase === PHASE.MONITORING) { showToast('감시를 멈춘 뒤 찌를 다시 선택해 주세요.'); return; }
  if (phase === PHASE.CALIBRATING) return;

  const rect = stageRect();
  const vr = videoRect();
  const point = displayToMedia(event.clientX - rect.left, event.clientY - rect.top, vr, els.camera.videoWidth, els.camera.videoHeight);
  if (!point.inside) { showToast('영상 안쪽의 찌를 눌러 주세요.'); return; }
  selectTarget(point.x / els.camera.videoWidth * els.analysisCanvas.width, point.y / els.camera.videoHeight * els.analysisCanvas.height);
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
    if (!sample) { showToast('색을 읽지 못했어요. 다시 눌러 주세요.'); return; }
    const selection = { x, y, rgb: sample.rgb, hsv: sample.hsv };

    if (settings.multiSelect) {
      const near = floats.find((f) => Math.hypot(f.x - x, f.y - y) <= Math.max(14, f.floatHeight || 12));
      if (near) near.reselect(selection);
      else if (floats.length < MAX_FLOATS) floats.push(new FloatUnit(selection));
      else { showToast(`찌는 최대 ${MAX_FLOATS}개까지 고를 수 있어요.`); return; }
    } else {
      floats = [new FloatUnit(selection)];
    }

    calibFrames = 0;
    calibDiffs = [];
    floats.forEach((f) => f.beginCalibration());
    bgOffsetX = 0; bgOffsetY = 0;
    startLockAnimation();
    haptic();
    updateSelectionUi();
    setPhase(PHASE.CALIBRATING);
    showToast(settings.multiSelect && floats.length > 1 ? `찌 ${floats.length}개 · 잠깐 그대로 두세요.` : '찌를 찾았어요. 잠깐 그대로 두세요.');
  } catch (error) {
    console.warn(error);
    showToast('찌 색을 읽는 중 문제가 생겼어요.');
  }
}

function updateSelectionUi() {
  const primary = primaryFloat();
  if (!primary) { els.targetSwatch.style.background = ''; els.targetColorText.textContent = '아직 없음'; return; }
  els.targetSwatch.style.background = `rgb(${primary.rgb.r}, ${primary.rgb.g}, ${primary.rgb.b})`;
  els.targetColorText.textContent = floats.length > 1 ? `찌 ${floats.length}개` : `${colorName(primary.hsv)} · ${rgbToHex(primary.rgb)}`;
}

// ==========================================================================
// Calibration (per float; multi-float calibrates together)
// ==========================================================================
function handleCalibrationFrame(background) {
  calibFrames += 1;
  const bgMag = Math.hypot(background.dx, background.dy);
  floats.forEach((f) => f.calibrateStep(f.lastResult, bgMag));
  if (calibFrames > 1) calibDiffs.push(frameDiff);
  const progress = clamp(calibFrames / CALIBRATION_FRAMES, 0, 1);
  els.calibrationFill.style.width = `${Math.round(progress * 100)}%`;
  els.calibrationText.textContent = `물결을 익히는 중 · 폰을 움직이지 마세요 · ${Math.round(progress * 100)}%`;
  updateTrackingUi(primaryFloat()?.lastResult);
  if (calibFrames >= CALIBRATION_FRAMES) finalizeCalibration();
}

function finalizeCalibration() {
  const results = floats.map((f) => ({ f, r: f.finishCalibration() }));
  const ok = results.filter((x) => x.r.ok).map((x) => x.f);
  const failed = results.filter((x) => !x.r.ok);

  if (!ok.length) {
    showToast(`${failed[0]?.r.reason || '보정에 실패했어요.'} 다시 선택해 주세요.`, 4200);
    floats = [];
    updateSelectionUi();
    resetMetrics();
    clearOverlay();
    setPhase(PHASE.CAMERA);
    return;
  }
  floats = ok;
  sceneDiffBaseline = calibDiffs.length ? median(calibDiffs) : 0;
  updateSelectionUi();
  if (failed.length) showToast(`찌 ${failed.length}개는 보정에 실패해 뺐어요.`, 3500);
  else showToast(floats.length > 1 ? `보정 완료! 찌 ${floats.length}개를 감시할 수 있어요.` : '보정 완료! 감시를 시작하세요.');
  setPhase(PHASE.READY);
}

// ==========================================================================
// Camera monitoring
// ==========================================================================
function startMonitoring() {
  const ready = floats.filter((f) => f.calibrated);
  if (!ready.length || phase !== PHASE.READY) return;
  alarmCtl.ensureAudio();
  floats = ready;
  const now = performance.now();
  floats.forEach((f) => f.beginMonitoring(now));
  bgOffsetX = 0; bgOffsetY = 0;
  lastShakeAt = -Infinity;
  reanchorPending = false;
  resetCameraSafety();
  haptic();
  setPhase(PHASE.MONITORING);
  sessionRun(true);
  alarmCtl.requestWakeLock();
  showToast(floats.length > 1 ? `찌 ${floats.length}개 감시를 시작했어요.` : '입질 감시를 시작했어요.');
}

function stopMonitoring() {
  if (phase === PHASE.ALARM) { silenceAlarm(); return; }
  if (phase !== PHASE.MONITORING) return;
  const now = performance.now();
  floats.forEach((f) => f.stopMonitoring(now));
  sessionRun(false);
  resetCameraSafety();
  setPhase(PHASE.READY);
  showToast('감시를 멈췄어요.');
}

function detectSceneShake(now, background) {
  const bgMag = Math.hypot(background.dx, background.dy);
  const trusted = background.confidence >= SHAKE.MIN_CONFIDENCE;
  const moved = trusted && floats.some((f) => bgMag / (f.floatHeight || 12) >= SHAKE.ALARM_SUPPRESS_NORM);
  if (moved || isFrameUnstable(frameDiff, sceneDiffBaseline)) {
    lastShakeAt = now;
    reanchorPending = true;
  } else if (reanchorPending && now - lastShakeAt >= SHAKE.SETTLE_MS) {
    // The mount settled — possibly somewhere new. Re-anchor every float.
    reanchorPending = false;
    bgOffsetX = 0; bgOffsetY = 0;
    floats.forEach((f) => f.reanchor(now));
  }
  return now - lastShakeAt < SHAKE.SUPPRESS_MS;
}

function handleMonitoringFrame(now, background) {
  let alarm = null;
  let alarmUnit = null;
  const shaking = detectSceneShake(now, background);
  const scene = { background, bgOffsetY, shaking };
  floats.forEach((f) => {
    const before = f.machine.state;
    const mon = f.monitor(f.lastResult, now, settings, adaptiveAdjustment, scene);
    if (mon.changed && mon.state === TrackState.LOST && before !== TrackState.LOST) session.lost += 1;
    if (mon.alarmEvent && !alarm) { alarm = mon.alarmEvent; alarmUnit = f; }
  });
  checkLost(now);
  reflectTrackingState(shaking);
  updateMonitorUi();
  if (alarm && alarmUnit) triggerCameraAlarm(alarmUnit, alarm, now);
}

function checkLost(now) {
  const lost = floats.some((f) => f.machine.state === TrackState.LOST);
  if (!lost) {
    safety.lostSince = null;
    if (safety.lostWarned) { safety.lostWarned = false; clearWarn('lost'); showToast('찌를 다시 찾았어요.'); }
    return;
  }
  if (safety.lostSince == null) safety.lostSince = now;
  if (!safety.lostWarned && now - safety.lostSince > LOST_WARN_MS) {
    safety.lostWarned = true;
    warn('lost', '찌를 놓쳤어요', '20초 넘게 찌가 보이지 않아요. 찌와 화면, 조명을 확인해 주세요.');
  }
}

function reflectTrackingState(shaking) {
  if (phase !== PHASE.MONITORING) return;
  const states = floats.map((f) => f.machine.state);
  let status = 'monitoring';
  let label = '감시 중';
  let text = PHASE_TEXT[PHASE.MONITORING][1];
  if (shaking) {
    status = 'shake'; label = '흔들림';
    text = '카메라가 흔들려 알람을 잠시 미뤄요. 멈추면 기준을 다시 잡아요.';
  } else if (states.includes(TrackState.LOST)) {
    status = 'lost'; label = '찌 놓침';
    text = '찌가 보이지 않아요. 가려졌는지, 화면을 벗어났는지 확인해 주세요.';
  } else if (states.includes(TrackState.RECOVERING)) {
    status = 'recovering'; label = '다시 찾는 중';
    text = '찌를 다시 찾고 있어요…';
  } else if (states.includes(TrackState.POSSIBLE_BITE)) {
    label = '입질 의심';
    text = '큰 움직임을 지켜보는 중이에요.';
  }
  els.statusPill.dataset.status = status;
  els.statusLabel.textContent = label;
  els.stateText.textContent = text;
}

function updateIdleMetrics() {
  updateTrackingUi(primaryFloat()?.lastResult);
  updateDiagPanel();
}

function updateMonitorUi() {
  const primary = primaryFloat();
  const maxBite = floats.reduce((m, f) => Math.max(m, f.biteScore), 0);
  const value = Math.round(maxBite * 100);
  els.cameraScore.dataset.band = maxBite >= BITE.TRIGGER_SCORE ? 'bite' : maxBite >= BITE.TRIGGER_SCORE * 0.7 ? 'possible' : '';
  els.motionScore.textContent = value;
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
  els.areaMetric.textContent = r.found ? Math.round(clamp((r.area || 0) / areaBase * 100, 0, 160)) : 0;
}

function updateDiagPanel() {
  if (!els.diagPanel.open) return;
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
// Camera alarm
// ==========================================================================
function triggerCameraAlarm(unit, event, now) {
  if (phase !== PHASE.MONITORING) return;
  const idx = floats.indexOf(unit);
  const floatLabel = floats.length > 1 ? `${idx + 1}번 찌` : null;
  const type = CAMERA_TYPE[event.type] || { title: '입질 감지!', reason: '평소 물결보다 큰 움직임이에요.' };
  const score = Math.round(clamp(event.score * 100, 0, 100));
  const record = addHistory({
    mode: 'camera', type: event.type, score,
    reason: floatLabel ? `${floatLabel} · ${type.title}` : type.title
  });

  lastCameraExport = unit.diag.exportEvent(
    { at: event.at, timestamp: record.timestamp, type: event.type, score: event.score },
    { floatHeight: unit.floatHeight, floatArea: unit.floatArea, waveMad: unit.waveMad },
    { deviceInfo: navigator.userAgent, analysisFps: Math.round(fpsEma), appVersion: APP_VERSION }
  );
  lastCameraExport.eventId = record.id;

  unit.machine.set(TrackState.ALARM, now);
  setPhase(PHASE.ALARM);
  alarmCtl.start(alarmOptions());
  openAlarmScreen({
    mode: 'camera', recordId: record.id,
    kicker: floatLabel || '입질 감지',
    title: '입질!', reason: type.title.replace(/!$/, ''), score
  });
}

// Silence the camera alarm and keep watching (the float may still be moving).
function resumeCameraAfterAlarm() {
  alarmCtl.stop();
  if (phase !== PHASE.ALARM) return;
  const now = performance.now();
  floats.forEach((f) => f.resumeAfterAlarm(now));
  setPhase(floats.length && cameraCtl.isActive ? PHASE.MONITORING : cameraCtl.isActive ? PHASE.CAMERA : PHASE.IDLE);
}

// ==========================================================================
// Shared alarm screen
// ==========================================================================
function openAlarmScreen({ mode, recordId, kicker, title, reason, score }) {
  activeAlarm = { mode, recordId };
  const latin = document.createElement('b');
  const label = document.createElement('span');
  latin.textContent = 'Bite';
  label.textContent = kicker;
  els.alarmKicker.replaceChildren(latin, label);
  els.alarmTitle.textContent = title;
  els.alarmReason.textContent = reason;
  els.alarmScore.textContent = score;
  els.alarmTime.textContent = timeOfDay();
  els.alarmScreen.dataset.state = 'ringing';
  els.stopAlarmBtn.textContent = '알람 끄기';
  els.alarmScreen.hidden = false;
  els.stopAlarmBtn.focus({ preventScroll: true });
  renderLiveChip();
}

// Stop the sound/vibration; the screen stays to ask whether it was a bite.
function silenceAlarm() {
  if (!activeAlarm) return;
  if (activeAlarm.mode === 'camera') resumeCameraAfterAlarm();
  else motionCtl.dismissAlarm();
  alarmCtl.stop();
  els.alarmScreen.dataset.state = 'stopped';
  els.stopAlarmBtn.textContent = '닫기';
  renderLiveChip();
}

function closeAlarmScreen(label) {
  if (!activeAlarm) return;
  if (els.alarmScreen.dataset.state === 'ringing') silenceAlarm();
  const { recordId } = activeAlarm;
  activeAlarm = null;
  els.alarmScreen.hidden = true;
  if (label) setFeedback(recordId, label);
  renderLiveChip();
}

// ==========================================================================
// History
// ==========================================================================
function addHistory(entry) {
  const record = {
    id: entry.id ?? Date.now(),
    timestamp: entry.timestamp ?? new Date().toISOString(),
    feedback: null,
    ...entry
  };
  history.unshift(record);
  history = history.slice(0, MAX_HISTORY);
  saveJson(KEYS.history, history);
  session.alarms += 1;
  if (tab !== 'history') els.historyBadge.hidden = false;
  renderHistory();
  return record;
}

function recordMode(record) {
  if (record.mode) return record.mode;
  return MOTION_PATTERN[record.type] ? 'motion' : 'camera';
}

function dayLabel(date) {
  const today = new Date();
  const y = new Date(); y.setDate(today.getDate() - 1);
  const same = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (same(date, today)) return '오늘';
  if (same(date, y)) return '어제';
  return date.toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'short' });
}

function renderHistory() {
  els.historyList.textContent = '';
  const list = history.filter((r) => ui.filter === 'all' || recordMode(r) === ui.filter);
  if (!list.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.innerHTML = '<strong>아직 기록이 없어요</strong><span>입질 알림이 울리면 시각과 종류, 강도가 여기에 차곡차곡 남아요.</span>';
    els.historyList.appendChild(empty);
    return;
  }
  let lastDay = '';
  list.slice(0, 80).forEach((event) => {
    const mode = recordMode(event);
    const when = new Date(event.timestamp);
    const day = dayLabel(when);
    if (day !== lastDay) {
      lastDay = day;
      const h = document.createElement('p');
      h.className = 'day';
      h.textContent = day;
      els.historyList.appendChild(h);
    }
    const item = document.createElement('article');
    item.className = `event ${mode}`;

    const time = document.createElement('div');
    time.className = 'event-time';
    time.textContent = when.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
    const sec = document.createElement('small');
    sec.textContent = `${String(when.getSeconds()).padStart(2, '0')}초`;
    time.appendChild(sec);

    const node = document.createElement('div');
    node.className = 'event-node';
    node.innerHTML = '<i></i>';

    const body = document.createElement('div');
    body.className = 'event-body';
    const title = document.createElement('div');
    title.className = 'event-title';
    const strong = document.createElement('strong');
    strong.textContent = event.reason || '입질';
    const score = document.createElement('span');
    score.textContent = `강도 ${event.score}`;
    title.append(strong, score);
    const bar = document.createElement('div');
    bar.className = 'strength';
    const fill = document.createElement('i');
    fill.style.width = `${clamp(Number(event.score) || 0, 4, 100)}%`;
    bar.appendChild(fill);
    const foot = document.createElement('div');
    foot.className = 'event-foot';
    const src = document.createElement('span');
    src.textContent = mode === 'motion' ? (event.source === 'native' ? '진동 · 안드로이드 앱' : '진동 감지') : '카메라 감지';
    foot.appendChild(src);
    if (event.feedback === true || event.feedback === false || event.feedback === 'unsure') {
      const key = event.feedback === 'unsure' ? 'unsure' : String(event.feedback);
      const tag = document.createElement('span');
      tag.className = `tag ${key}`;
      tag.textContent = { true: '입질 맞음', false: '오탐', unsure: '모름' }[key];
      foot.appendChild(tag);
    } else {
      const verdict = document.createElement('div');
      verdict.className = 'verdict';
      [['true', '맞음'], ['false', '오탐']].forEach(([value, text]) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.dataset.feedbackId = event.id;
        b.dataset.feedbackValue = value;
        b.textContent = text;
        verdict.appendChild(b);
      });
      foot.appendChild(verdict);
    }
    body.append(title, bar, foot);
    item.append(time, node, body);
    els.historyList.appendChild(item);
  });
}

// label: true/'true_positive' | false/'false_positive' | 'unsure'
function setFeedback(id, label) {
  const value = label === true || label === 'true_positive' ? true
    : label === false || label === 'false_positive' ? false : 'unsure';
  const record = history.find((r) => String(r.id) === String(id));
  if (!record) return;
  const before = record.feedback;
  record.feedback = value;
  if (before !== true && value === true) session.truePos += 1;
  if (before !== false && value === false) session.falsePos += 1;

  if (recordMode(record) === 'camera' && value !== 'unsure') {
    adaptiveAdjustment = clamp(adaptiveAdjustment + (value ? -0.018 : 0.055), -0.18, 0.32);
    storage.setItem(KEYS.adaptive, String(adaptiveAdjustment));
    if (lastCameraExport && String(lastCameraExport.eventId) === String(id)) {
      lastCameraExport.event.userLabel = value ? 'true_positive' : 'false_positive';
    }
  }
  if (recordMode(record) === 'motion') {
    const userLabel = value === true ? 'true_positive' : value === false ? 'false_positive' : 'unsure';
    const events = loadJson(KEYS.motionEvents, []);
    const match = events.find((e) => String(e.id) === String(id));
    if (match) { match.userLabel = userLabel; saveJson(KEYS.motionEvents, events); }
    if (lastMotionExport && String(lastMotionExport.id) === String(id)) lastMotionExport.userLabel = userLabel;
  }
  saveJson(KEYS.history, history);
  renderHistory();
  renderSession();
  if (value === true) showToast('입질로 기록했어요.');
  else if (value === false) showToast(recordMode(record) === 'camera' ? '오탐으로 기록했어요. 카메라 감지를 조금 둔감하게 조정해요.' : '오탐으로 기록했어요.');
  else showToast('기록했어요.');
}

function exportHistory() {
  const data = {
    app: 'jjibom', version: APP_VERSION, exportedAt: new Date().toISOString(), platform: platform(),
    history, motionEvents: loadJson(KEYS.motionEvents, [])
  };
  const name = `jjibom-history-${new Date().toISOString().slice(0, 10)}.json`;
  if (!isNativeApp() && downloadJson(name, data)) { showToast('기록을 파일로 내보냈어요.'); return; }
  navigator.clipboard?.writeText(JSON.stringify(data, null, 2))
    .then(() => showToast('기록을 클립보드에 복사했어요.'))
    .catch(() => showToast('이 환경에서는 내보내기를 할 수 없어요.'));
}

async function clearHistory() {
  if (!history.length) return;
  if (!window.confirm('입질 기록을 모두 지울까요?')) return;
  history = [];
  saveJson(KEYS.history, history);
  saveJson(KEYS.motionEvents, []);
  if (isNativeAvailable()) await nativeMotion.clearEvents().catch(() => {});
  renderHistory();
  showToast('기록을 모두 지웠어요.');
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

const easeOut = (t) => 1 - Math.pow(1 - clamp(t, 0, 1), 3);

// A short "lock-on" flourish after tapping a float: brackets close in from far
// out while a ring spreads. Runs its own rAF so it stays smooth at 60 fps.
function startLockAnimation() {
  lockAnim = { start: performance.now() };
  cancelAnimationFrame(overlayAnimRaf);
  const tick = () => {
    drawOverlay();
    if (lockAnim && performance.now() - lockAnim.start < 700) overlayAnimRaf = requestAnimationFrame(tick);
    else { lockAnim = null; drawOverlay(); }
  };
  overlayAnimRaf = requestAnimationFrame(tick);
}

function drawOverlay() {
  const rect = stageRect();
  overlayCtx.clearRect(0, 0, rect.width, rect.height);
  if (!cameraCtl.isActive || !floats.length) return;
  const now = performance.now();
  const vr = videoRect();
  const aw = els.analysisCanvas.width;
  const ah = els.analysisCanvas.height;
  const multi = floats.length > 1;
  const showBaseline = phase === PHASE.READY || cameraWatching();
  const lockT = lockAnim ? easeOut((now - lockAnim.start) / 520) : 1;
  const calibP = phase === PHASE.CALIBRATING ? clamp(calibFrames / CALIBRATION_FRAMES, 0, 1) : null;

  floats.forEach((unit, index) => {
    const p = mediaToDisplay(unit.x / aw * els.camera.videoWidth, unit.y / ah * els.camera.videoHeight, vr);
    const confidence = clamp(unit.confidence, 0, 1);
    const isLost = unit.lostFrames > 2 || unit.machine.state === TrackState.LOST;
    const base = FLOAT_PALETTE[index % FLOAT_PALETTE.length];
    const color = isLost ? '#ff3b2f' : confidence > 0.45 ? base : themeColors.amber;
    const r = 22 + (1 - lockT) * 46;

    overlayCtx.save();
    overlayCtx.globalAlpha = 0.25 + 0.75 * lockT;
    overlayCtx.strokeStyle = color;
    overlayCtx.fillStyle = color;
    overlayCtx.lineWidth = 1.6;
    overlayCtx.lineCap = 'round';
    overlayCtx.shadowColor = color;
    overlayCtx.shadowBlur = 12;
    const k = 8;
    [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(([sx, sy]) => {
      overlayCtx.beginPath();
      overlayCtx.moveTo(p.x + sx * r, p.y + sy * (r - k));
      overlayCtx.lineTo(p.x + sx * r, p.y + sy * r);
      overlayCtx.lineTo(p.x + sx * (r - k), p.y + sy * r);
      overlayCtx.stroke();
    });
    overlayCtx.shadowBlur = 0;
    overlayCtx.beginPath();
    overlayCtx.arc(p.x, p.y, 2.4, 0, Math.PI * 2);
    overlayCtx.fill();

    // Tap ripple that spreads out while locking on.
    if (lockAnim && lockT < 1) {
      overlayCtx.globalAlpha = (1 - lockT) * 0.7;
      overlayCtx.lineWidth = 1.2;
      overlayCtx.beginPath();
      overlayCtx.arc(p.x, p.y, 10 + lockT * 60, 0, Math.PI * 2);
      overlayCtx.stroke();
    }
    overlayCtx.globalAlpha = 1;

    // Calibration: a ring that fills around the float.
    if (calibP != null) {
      overlayCtx.lineWidth = 2;
      overlayCtx.strokeStyle = 'rgba(243,239,231,.14)';
      overlayCtx.beginPath();
      overlayCtx.arc(p.x, p.y, 34, 0, Math.PI * 2);
      overlayCtx.stroke();
      overlayCtx.strokeStyle = themeColors.amber;
      overlayCtx.shadowColor = themeColors.amber;
      overlayCtx.shadowBlur = 10;
      overlayCtx.beginPath();
      overlayCtx.arc(p.x, p.y, 34, -Math.PI / 2, -Math.PI / 2 + calibP * Math.PI * 2);
      overlayCtx.stroke();
      overlayCtx.shadowBlur = 0;
    }

    // Watching: a slow breathing halo.
    if (cameraWatching() && !isLost) {
      const b = 0.5 + 0.5 * Math.sin(now / 520);
      overlayCtx.globalAlpha = 0.18 + b * 0.22;
      overlayCtx.lineWidth = 1;
      overlayCtx.beginPath();
      overlayCtx.arc(p.x, p.y, 32 + b * 5, 0, Math.PI * 2);
      overlayCtx.stroke();
      overlayCtx.globalAlpha = 1;
    }

    if (showBaseline && unit.baselineY) {
      const baseY = mediaToDisplay(0, unit.baselineY / ah * els.camera.videoHeight, vr).y;
      overlayCtx.setLineDash([2, 5]);
      overlayCtx.strokeStyle = 'rgba(243,239,231,.4)';
      overlayCtx.lineWidth = 1;
      overlayCtx.beginPath();
      overlayCtx.moveTo(Math.max(vr.x, p.x - 70), baseY);
      overlayCtx.lineTo(p.x - 40, baseY);
      overlayCtx.moveTo(p.x + 40, baseY);
      overlayCtx.lineTo(Math.min(vr.x + vr.width, p.x + 70), baseY);
      overlayCtx.stroke();
      overlayCtx.setLineDash([]);
    }

    const label = multi
      ? (isLost ? `${index + 1} · 놓침` : `${index + 1} · ${Math.round(confidence * 100)}%`)
      : (isLost ? '놓침' : `${Math.round(confidence * 100)}%`);
    overlayCtx.font = '650 11px "Pretendard Variable", -apple-system, system-ui, sans-serif';
    const tw = overlayCtx.measureText(label).width;
    const ly = p.y + 44;
    overlayCtx.fillStyle = 'rgba(5,8,11,.72)';
    overlayCtx.beginPath();
    roundedRectPath(overlayCtx, p.x - tw / 2 - 9, ly - 11, tw + 18, 22, 11);
    overlayCtx.fill();
    overlayCtx.fillStyle = color;
    overlayCtx.textAlign = 'center';
    overlayCtx.textBaseline = 'middle';
    overlayCtx.fillText(label, p.x, ly + 0.5);
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
  const graph = primaryFloat()?.graph || [];
  const values = graph.length ? graph : Array.from({ length: 80 }, (_, i) => Math.sin(i * 0.2) * 0.018);
  const visible = values.slice(-150);
  const hot = Number(els.motionScore.textContent) >= BITE.TRIGGER_SCORE * 100;
  const color = hot ? themeColors.ember : themeColors.lume;
  const toY = (value) => height / 2 + clamp(value, -1.6, 1.6) / 1.6 * height * 0.42;

  // A short glow under the line, not a slab down to the floor.
  const gradient = chartCtx.createLinearGradient(0, height * 0.3, 0, height * 0.82);
  gradient.addColorStop(0, `${color}30`);
  gradient.addColorStop(1, `${color}00`);
  chartCtx.beginPath();
  visible.forEach((value, index) => {
    const x = visible.length <= 1 ? 0 : index / (visible.length - 1) * width;
    if (index === 0) chartCtx.moveTo(x, toY(value)); else chartCtx.lineTo(x, toY(value));
  });
  chartCtx.lineTo(width, height);
  chartCtx.lineTo(0, height);
  chartCtx.closePath();
  chartCtx.fillStyle = gradient;
  chartCtx.fill();

  chartCtx.beginPath();
  visible.forEach((value, index) => {
    const x = visible.length <= 1 ? 0 : index / (visible.length - 1) * width;
    if (index === 0) chartCtx.moveTo(x, toY(value)); else chartCtx.lineTo(x, toY(value));
  });
  chartCtx.strokeStyle = color;
  chartCtx.lineWidth = 2;
  chartCtx.lineJoin = 'round';
  chartCtx.shadowColor = color;
  chartCtx.shadowBlur = 8;
  chartCtx.stroke();
  chartCtx.shadowBlur = 0;
  chartCtx.strokeStyle = 'rgba(243,239,231,.12)';
  chartCtx.lineWidth = 1;
  chartCtx.setLineDash([2, 5]);
  chartCtx.beginPath(); chartCtx.moveTo(0, height / 2); chartCtx.lineTo(width, height / 2); chartCtx.stroke();
  chartCtx.setLineDash([]);
  // A tall chart (wide layouts) gets quiet guides so the space reads as a scale.
  if (height > 140) {
    chartCtx.strokeStyle = 'rgba(243,239,231,.05)';
    chartCtx.beginPath();
    for (const f of [0.1, 0.3, 0.7, 0.9]) { chartCtx.moveTo(0, Math.round(height * f) + 0.5); chartCtx.lineTo(width, Math.round(height * f) + 0.5); }
    chartCtx.stroke();
  }
}

function resetMetrics() {
  els.cameraScore.dataset.band = '';
  els.motionScore.textContent = '0';
  els.verticalMove.textContent = '0.0';
  els.confidenceMetric.textContent = '0';
  els.areaMetric.textContent = '0';
  els.confidenceText.textContent = '—';
  els.fpsText.textContent = '—';
  drawMotionChart();
}

function resetTarget(showMessage = true) {
  if (phase === PHASE.ALARM) closeAlarmScreen(null);
  if (cameraWatching()) sessionRun(false);
  floats = [];
  calibFrames = 0;
  updateSelectionUi();
  resetMetrics();
  clearOverlay();
  if (cameraCtl.isActive) setPhase(PHASE.CAMERA);
  if (showMessage) showToast('화면에서 찌 끝을 다시 눌러 주세요.');
}

function exportCameraDiagnostics() {
  if (!lastCameraExport) { showToast('내보낼 카메라 이벤트가 아직 없어요.'); return; }
  const name = `jjibom-camera-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  if (downloadJson(name, lastCameraExport)) showToast('이벤트 데이터를 내보냈어요.');
  else showToast('내보내기를 지원하지 않는 환경이에요.');
}

// ==========================================================================
// Motion (vibration) mode
// ==========================================================================
const motionCtl = new MotionController({
  alarm: alarmCtl,
  callbacks: {
    onState: motionOnState,
    onCalibrationProgress: (p) => {
      els.motionCalibFill.style.width = `${Math.round(p * 100)}%`;
      els.motionCalibText.textContent = `낚싯대와 폰을 건드리지 마세요 · ${Math.round(p * 100)}%`;
    },
    onCalibrationDone: () => {
      motionBaselineReady = true;
      showToast('보정 완료! 진동 감시를 시작했어요.');
    },
    onCalibrationFail: (reason) => {
      showToast(reason || '보정에 실패했어요. 다시 시도해 주세요.', 4500);
    },
    onMonitorStart: () => { motionWakeLock(true); },
    onMetrics: motionOnMetrics,
    onAlarm: motionOnAlarm,
    onError: motionOnError,
    onNotice: (kind) => {
      if (kind === 'notifications-denied') showToast('알림이 꺼져 있어요. 감시는 되지만 잠금화면 알림과 알림창의 종료 버튼이 보이지 않아요.', 5000);
    },
    onBackgroundPause: () => { /* surfaced when the page returns (see visibility) */ },
    onResumePrompt: () => { motionCtl.resume(); },
    onTestAlarm: () => showToast('알람을 시험하고 있어요.'),
    onNativeSync: onNativeSync
  }
});

function motionOnState(state) {
  const was = motionState;
  motionState = state;
  els.app.dataset.motion = state;
  els.motionStatusPill.dataset.status = state;
  els.motionStatusLabel.textContent = MotionStateLabel[state] || state;
  els.motionCalibPanel.hidden = state !== MotionState.CALIBRATING;
  const setup = state === MotionState.REQUESTING_PERMISSION || state === MotionState.CALIBRATING;
  markSteps(els.motionDeck.querySelector('.deck-steps'), setup ? 1 : 2, setup ? 2 : MOTION_RUNNING.has(state) ? 3 : 0);
  if (state === MotionState.CALIBRATING && was !== state) {
    els.motionCalibFill.style.width = '0%';
    els.motionCalibText.textContent = '낚싯대와 폰을 건드리지 마세요 · 0%';
  }
  const native = isNativeAvailable();
  const text = {
    [MotionState.IDLE]: '낚싯대에 폰을 고정하고 보정을 시작하세요.',
    [MotionState.REQUESTING_PERMISSION]: '동작 센서 권한을 확인하고 있어요.',
    [MotionState.CALIBRATING]: '평소 흔들림을 익히고 있어요.',
    [MotionState.ARMED]: native ? '감시 중이에요. 화면을 꺼도 이어지고, 알림에서 끌 수 있어요.' : '낚싯대의 떨림을 감시하고 있어요. 화면을 켜 두세요.',
    [MotionState.POSSIBLE_BITE]: '큰 떨림을 지켜보는 중이에요…',
    [MotionState.ALARM]: '입질이 감지됐어요!',
    [MotionState.STABILIZING]: '폰이 움직였어요. 다시 안정되길 기다리는 중…',
    [MotionState.PAUSED]: '화면을 벗어나 감시가 멈췄어요.',
    [MotionState.ERROR]: '센서 신호가 끊겼어요.',
    [MotionState.COOLDOWN]: '방금 알람 후 잠시 쉬었다가 다시 감시해요.'
  }[state];
  if (text) els.motionStateText.textContent = text;

  // Running → session clock; idle → stop it and clear the dial.
  if (MOTION_WATCHING.has(state) || state === MotionState.CALIBRATING) sessionRun(true);
  else if (state === MotionState.IDLE) {
    sessionRun(false);
    motionOnMetrics({ score: 0, band: 'stable', magnitude: 0 });
  }
  if (MOTION_RUNNING.has(state)) seismo.start();
  else { seismo.stop(); seismo.clear(); }

  // The alarm ended on the native side (played out / acknowledged elsewhere).
  if (activeAlarm?.mode === 'motion' && state !== MotionState.ALARM && els.alarmScreen.dataset.state === 'ringing') {
    els.alarmScreen.dataset.state = 'stopped';
    els.stopAlarmBtn.textContent = '닫기';
  }

  // Sensor stalls: warn if it does not recover quickly.
  clearTimeout(safety.sensorTimer);
  if (state === MotionState.ERROR) {
    safety.sensorTimer = setTimeout(() => {
      if (motionState === MotionState.ERROR) warn('sensor', '센서 신호가 끊겼어요', '폰 거치 상태와 센서 권한을 확인해 주세요. 신호가 돌아오면 자동으로 이어져요.');
    }, SENSOR_WARN_MS);
  } else if (safety.bannerKind === 'sensor') {
    clearWarn('sensor');
  }
  renderMotionControls();
  renderLiveChip();
  updateScene();
  syncLayout();
}

function renderMotionControls() {
  const running = motionRunning();
  els.motionCalibrateBtn.hidden = running;
  els.motionStopBtn.hidden = !running;
  els.motionStartBtn.hidden = running || !motionBaselineReady || isNativeAvailable();
}

function motionOnMetrics(m) {
  const score = Math.round(m.score || 0);
  els.motionGaugeBig.dataset.band = m.band === 'bite' ? 'bite' : m.band === 'possible' ? 'possible' : '';
  els.motionScoreBig.textContent = score;
  els.motionBandText.textContent = { stable: '고요', wobble: '작은 흔들림', possible: '입질 가능성', bite: '입질' }[m.band] || '고요';
  els.motionMagnitude.textContent = (m.magnitude || 0).toFixed(2);
  if (motionRunning()) seismo.push(score, m.magnitude || 0);
  if (m.elapsedMs != null) els.motionElapsed.textContent = formatClock(m.elapsedMs);
}

function motionOnAlarm(alarm, exportData) {
  const label = MOTION_PATTERN[alarm.pattern] || '입질';
  const record = addHistory({
    id: alarm.id ?? Date.now(), timestamp: alarm.timestamp || new Date().toISOString(),
    mode: 'motion', type: alarm.pattern, reason: `진동 · ${label}`,
    score: Math.round(alarm.score || 0), source: exportData?.source === 'native' ? 'native' : 'web'
  });
  if (exportData) {
    lastMotionExport = { ...exportData, id: record.id };
    const events = loadJson(KEYS.motionEvents, []);
    events.unshift(lastMotionExport);
    saveJson(KEYS.motionEvents, events.slice(0, 50));
  }
  openAlarmScreen({
    mode: 'motion', recordId: record.id, kicker: '진동 감지',
    title: '입질!', reason: `${label} 감지`, score: record.score
  });
}

function motionOnError(reason, message) {
  if (reason === 'permission') showToast('동작 센서 권한이 필요해요. 권한을 허용해 주세요.', 4500);
  else if (reason === 'foreground') showToast(message || '백그라운드 감시를 시작하지 못했어요.', 4500);
  else if (reason === 'no_sensor') showToast(message || '이 기기에는 가속도 센서가 없어요.', 4500);
  else if (reason === 'max_session') warn('session', '감시를 자동으로 끝냈어요', message || '12시간이 지나 배터리 보호를 위해 종료했어요.', { sound: false });
  else if (message) showToast(message, 4000);
}

async function motionStartCalibration() {
  if (!motionCtl.isSupported()) { showToast('이 기기에서는 동작 센서를 쓸 수 없어요.', 4000); return; }
  if (!isNativeAvailable() && !window.isSecureContext && location.hostname !== 'localhost') {
    showToast('센서를 쓰려면 HTTPS 연결이 필요해요.', 4000);
    return;
  }
  await alarmCtl.ensureAudio();
  haptic();
  motionCtl.setSettings(motionControllerSettings());
  motionBaselineReady = false;
  motionCtl.startCalibration();
}

function motionStopMonitoring() {
  if (activeAlarm?.mode === 'motion') closeAlarmScreen(null);
  motionCtl.stop();
  motionWakeLock(false);
  clearWarn('sensor');
}

function motionWakeLock(active) {
  if (isNativeAvailable()) return; // the service keeps the CPU awake itself
  if (active && motionSettings.keepAwake) alarmCtl.requestWakeLock();
  else if (!active) alarmCtl.releaseWakeLock();
}

function updateMotionAvailabilityUi() {
  const native = isNativeAvailable();
  els.motionBgChip.classList.toggle('native', native);
  els.motionBackground.textContent = native ? '화면 꺼져도 감시' : '화면 켜둔 채 사용';
  els.motionBgNote.textContent = native
    ? '화면을 끄거나 다른 앱을 써도 감시가 이어져요. 알림창에서 언제든 멈출 수 있어요.'
    : '웹에서는 화면이 켜져 있는 동안만 감시해요. 화면을 꺼도 감시하려면 안드로이드 앱을 쓰세요.';
  els.motionBgNote.className = `deck-note${native ? ' ok' : ''}`;
  if (native) {
    els.guideBgNote.classList.add('ok');
    els.guideBgNote.querySelector('span').innerHTML = '<strong>안드로이드 앱을 쓰고 있어요.</strong> 진동 감시는 화면을 꺼도, 다른 앱을 써도 이어져요.';
    els.onboardBgText.textContent = '안드로이드 앱에서는 화면을 꺼도 진동 감시가 이어져요.';
  }
}

function switchMode(mode, { confirmStop = true } = {}) {
  if (mode === appMode) return;
  if (mode === 'motion' && cameraCtl.isActive) {
    if (confirmStop && cameraWatching() && !window.confirm('카메라 감시를 끄고 진동 감지로 바꿀까요?')) return;
    stopCamera(true);
  }
  if (mode === 'camera' && motionRunning()) {
    if (confirmStop && !window.confirm('진동 감시를 끄고 카메라 감지로 바꿀까요?')) return;
    motionStopMonitoring();
  }
  appMode = mode;
  storage.setItem(KEYS.mode, mode);
  els.app.dataset.mode = mode;
  els.cameraMode.hidden = mode !== 'camera';
  els.motionMode.hidden = mode !== 'motion';
  els.modeCameraBtn.setAttribute('aria-selected', String(mode === 'camera'));
  els.modeMotionBtn.setAttribute('aria-selected', String(mode === 'motion'));
  if (mode === 'motion') updateMotionAvailabilityUi();
  updateScene();
  syncLayout();
}

// ==========================================================================
// Native (Android app) integration
// ==========================================================================
async function refreshNativeInfo() {
  if (!isNativeAvailable()) return;
  try {
    const info = await nativeMotion.getInfo();
    els.nativeNotifText.textContent = info.notifications === 'granted'
      ? '켜짐 · 잠금화면 알림과 종료 버튼이 보여요'
      : '꺼짐 · 감시는 되지만 알림창에 표시되지 않아요';
    els.nativeBatteryText.textContent = info.ignoringBatteryOptimizations
      ? '제외됨 · 화면이 꺼져도 가장 안정적이에요'
      : '적용 중 · 일부 기기는 오래 화면이 꺼지면 감시가 느려질 수 있어요';
    const s = info.sensors || {};
    els.nativeSensorText.textContent = [
      s.accelerometer ? '가속도' : null, s.linearAcceleration ? '선형가속도' : null, s.gyroscope ? '자이로' : null
    ].filter(Boolean).join(' · ') || '사용할 수 있는 센서가 없어요';
  } catch {
    els.nativeNotifText.textContent = '확인할 수 없어요';
  }
}

function onNativeSync(state, events) {
  let added = 0;
  events.forEach((e) => {
    if (history.some((r) => String(r.id) === String(e.id))) return;
    history.push({
      id: e.id, timestamp: e.timestamp, mode: 'motion', type: e.pattern,
      reason: `진동 · ${MOTION_PATTERN[e.pattern] || '입질'}`, score: e.score, feedback: null, source: 'native'
    });
    added += 1;
  });
  if (added) {
    history.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    history = history.slice(0, MAX_HISTORY);
    saveJson(KEYS.history, history);
    renderHistory();
    if (tab !== 'history') els.historyBadge.hidden = false;
    showToast(`앱이 백그라운드에서 감지한 입질 ${added}건을 기록에 옮겼어요.`, 4000);
  }
  if (state?.running && appMode !== 'motion') switchMode('motion', { confirmStop: false });
}

// ==========================================================================
// Settings wiring
// ==========================================================================
function applySettingsToUi() {
  els.soundEnabled.checked = alarmSettings.sound;
  els.vibrationEnabled.checked = alarmSettings.vibration;
  els.alarmVolume.value = alarmSettings.volume;
  els.alarmVolumeOut.textContent = `${alarmSettings.volume}%`;
  els.alarmDuration.value = String(alarmSettings.durationSec);
  els.failAlert.checked = alarmSettings.failAlert;
  renderToneOptions();

  els.sensitivity.value = settings.sensitivity;
  els.detectMode.value = settings.detectMode;
  els.nightMode.checked = settings.nightMode;
  els.waveCorrection.checked = settings.waveCorrection;
  els.multiSelect.checked = settings.multiSelect;
  els.colorTolerance.value = settings.colorTolerance;

  els.motionSensitivity.value = motionSettings.sensitivity;
  els.motionPattern.value = motionSettings.detectMode;
  els.motionKeepAwake.checked = motionSettings.keepAwake;
  updateSettingLabels();
  document.querySelectorAll('input[type="range"]').forEach(setRangeFill);
}

function sensLabel(v) {
  return v <= 3 ? '둔감' : v <= 7 ? '보통' : '민감';
}

function updateSettingLabels() {
  const v = Number(els.sensitivity.value);
  els.sensitivityOutput.textContent = `${sensLabel(v)} ${v}`;
  els.toleranceOutput.textContent = els.colorTolerance.value;
  const m = Number(motionSettings.sensitivity);
  els.motionSensOut.textContent = `${sensLabel(m)} ${m}`;
  els.motionPresets.querySelectorAll('[data-preset]').forEach((b) => {
    b.classList.toggle('active', Number(b.dataset.preset) === m);
  });
}

function renderToneOptions() {
  els.alarmToneGroup.textContent = '';
  ALARM_TONES.forEach((tone) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.tone = tone.id;
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(alarmSettings.tone === tone.id));
    b.innerHTML = `<svg viewBox="0 0 48 24"><use href="#i-tone-${tone.id}"/></svg><span></span>`;
    b.querySelector('span').textContent = tone.label;
    els.alarmToneGroup.appendChild(b);
  });
}

function onAlarmSettingsChanged() {
  saveAlarm();
  motionCtl.setSettings(motionControllerSettings());
}

async function testAlarm() {
  if (activeAlarm) return;
  await alarmCtl.ensureAudio();
  if (appMode === 'motion' || isNativeAvailable()) {
    motionCtl.setSettings(motionControllerSettings());
    motionCtl.testAlarm();
  } else {
    alarmCtl.start(alarmOptions({ durationSec: 3 }));
    showToast('알람을 시험하고 있어요.');
  }
}

function checkEnvironment() {
  const facts = [];
  facts.push(isNativeAvailable() ? '안드로이드 앱' : isNativeApp() ? '앱(플러그인 없음)' : `웹 (${window.isSecureContext ? 'HTTPS' : 'HTTP'})`);
  facts.push(navigator.mediaDevices?.getUserMedia ? '카메라 ✓' : '카메라 ✗');
  facts.push(motionCtl.isSupported() ? '동작 센서 ✓' : '동작 센서 ✗');
  facts.push('wakeLock' in navigator ? '화면 켜두기 ✓' : '화면 켜두기 ✗');
  facts.push(typeof navigator.vibrate === 'function' ? '진동 ✓' : '진동 ✗');
  els.envText.textContent = facts.join(' · ');
  showToast(isNativeAvailable()
    ? '앱에서 실행 중이에요. 진동 감시를 화면이 꺼져도 쓸 수 있어요.'
    : '웹에서 실행 중이에요. 감시는 화면을 켜 둔 동안만 동작해요.', 4000);
}

// ==========================================================================
// Onboarding
// ==========================================================================
let onboardIndex = 0;
function showOnboarding() {
  onboardIndex = 0;
  renderOnboarding();
  els.onboarding.hidden = false;
  document.body.classList.add('onboarding-open');
  scene.setLift(true);
  updateScene();
}
function renderOnboarding() {
  els.onboarding.querySelectorAll('.onboard-slide').forEach((s) => { s.hidden = Number(s.dataset.slide) !== onboardIndex; });
  [...els.onboardDots.children].forEach((d, i) => d.classList.toggle('on', i === onboardIndex));
  els.onboardNext.textContent = onboardIndex >= 2 ? '시작하기' : '다음';
}
function finishOnboarding() {
  ui.onboarded = true;
  saveUi();
  els.onboarding.hidden = true;
  document.body.classList.remove('onboarding-open');
  scene.setLift(false);
  syncLayout();
}

// ==========================================================================
// Events
// ==========================================================================
function bindEvents() {
  // shell
  tabButtons.forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
  els.nightBtn.addEventListener('click', () => { ui.night = !ui.night; saveUi(); applyNight(); });
  els.focusBtn.addEventListener('click', () => setFocus(!els.app.classList.contains('focus')));
  els.warnClose.addEventListener('click', () => clearWarn());
  els.modeCameraBtn.addEventListener('click', () => switchMode('camera'));
  els.modeMotionBtn.addEventListener('click', () => switchMode('motion'));

  // camera
  els.startCameraBtn.addEventListener('click', startCamera);
  els.startDemoBtn.addEventListener('click', startDemo);
  els.stopCameraBtn.addEventListener('click', () => stopCamera());
  els.flipCameraBtn.addEventListener('click', flipCamera);
  els.resetTargetBtn.addEventListener('click', () => resetTarget(true));
  els.overlay.addEventListener('pointerdown', handleTargetPointer);
  els.monitorBtn.addEventListener('click', () => {
    if (phase === PHASE.READY) startMonitoring();
    else if (phase === PHASE.MONITORING) stopMonitoring();
    else if (phase === PHASE.ALARM) silenceAlarm();
  });
  els.cameraSelect.addEventListener('change', async () => {
    if (isDemo) return;
    try {
      await cameraCtl.start({ deviceId: els.cameraSelect.value });
      cameraCtl.track?.addEventListener('ended', onCameraTrackEnded, { once: true });
      configureCanvases(); resetTarget(false); setPhase(PHASE.CAMERA); startFrameLoop(); await refreshCameraControls();
    } catch (error) { console.warn(error); showToast('카메라를 바꾸지 못했어요.'); }
  });
  els.zoomRange.addEventListener('input', () => { setRangeFill(els.zoomRange); cameraCtl.setZoom(Number(els.zoomRange.value)); });
  els.demoControls.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-demo-scene]');
    if (!btn) return;
    demo.setScenario(btn.dataset.demoScene);
    btn.classList.add('active');
    setTimeout(() => btn.classList.remove('active'), 600);
    if (phase !== PHASE.MONITORING && ['sink', 'lift', 'twitch'].includes(btn.dataset.demoScene)) {
      showToast('움직임을 만들었어요. 알람을 보려면 감시 시작을 누르세요.');
    }
  });

  // motion
  els.motionCalibrateBtn.addEventListener('click', motionStartCalibration);
  els.motionStartBtn.addEventListener('click', () => {
    if (!motionBaselineReady) return;
    motionCtl.setSettings(motionControllerSettings());
    motionCtl.rearm();
    motionWakeLock(true);
  });
  els.motionStopBtn.addEventListener('click', motionStopMonitoring);
  MOTION_SCENARIOS.forEach((sc) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.scene = sc.id;
    b.textContent = sc.label;
    els.motionDemoChips.appendChild(b);
  });
  els.motionDemoChips.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-scene]');
    if (!btn) return;
    const { samples, loop } = generateScenario(btn.dataset.scene);
    alarmCtl.ensureAudio();
    motionCtl.setSettings(motionControllerSettings());
    motionCtl.playScenario(samples, loop, DEMO_BASELINE);
    motionBaselineReady = true;
    els.motionDemoChips.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === btn));
    showToast(`데모: ${btn.textContent} (실제 감지기로 재생 중)`);
  });

  // alarm screen
  els.stopAlarmBtn.addEventListener('click', () => {
    if (els.alarmScreen.dataset.state === 'ringing') silenceAlarm();
    else closeAlarmScreen(null);
  });
  els.alarmFeedback.addEventListener('click', (e) => {
    const b = e.target.closest('[data-label]');
    if (b) closeAlarmScreen(b.dataset.label);
  });
  alarmCtl.onAutoStop = () => {
    if (activeAlarm && els.alarmScreen.dataset.state === 'ringing') silenceAlarm();
  };

  // history
  els.historyList.addEventListener('click', (event) => {
    const button = event.target.closest('[data-feedback-id]');
    if (button) setFeedback(button.dataset.feedbackId, button.dataset.feedbackValue === 'true');
  });
  document.querySelectorAll('.filter [data-filter]').forEach((b) => b.addEventListener('click', () => {
    ui.filter = b.dataset.filter;
    saveUi();
    document.querySelectorAll('.filter [data-filter]').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
    renderHistory();
  }));
  els.exportHistoryBtn.addEventListener('click', exportHistory);
  els.clearHistoryBtn.addEventListener('click', clearHistory);

  // settings: alarm
  els.soundEnabled.addEventListener('change', () => { alarmSettings.sound = els.soundEnabled.checked; if (!alarmSettings.sound) alarmCtl.stop(); else alarmCtl.ensureAudio(); onAlarmSettingsChanged(); });
  els.vibrationEnabled.addEventListener('change', () => { alarmSettings.vibration = els.vibrationEnabled.checked; onAlarmSettingsChanged(); });
  els.alarmToneGroup.addEventListener('click', (e) => {
    const b = e.target.closest('[data-tone]');
    if (!b) return;
    alarmSettings.tone = b.dataset.tone;
    renderToneOptions();
    onAlarmSettingsChanged();
    if (!activeAlarm) alarmCtl.start(alarmOptions({ vibration: false, sound: true, durationSec: 1.6 }));
  });
  els.alarmVolume.addEventListener('input', () => {
    alarmSettings.volume = Number(els.alarmVolume.value);
    els.alarmVolumeOut.textContent = `${alarmSettings.volume}%`;
    setRangeFill(els.alarmVolume);
  });
  els.alarmVolume.addEventListener('change', onAlarmSettingsChanged);
  els.alarmDuration.addEventListener('change', () => { alarmSettings.durationSec = Number(els.alarmDuration.value); onAlarmSettingsChanged(); });
  els.failAlert.addEventListener('change', () => { alarmSettings.failAlert = els.failAlert.checked; onAlarmSettingsChanged(); });
  els.testAlarmBtn.addEventListener('click', testAlarm);

  // settings: camera
  els.sensitivity.addEventListener('input', () => { settings.sensitivity = Number(els.sensitivity.value); setRangeFill(els.sensitivity); updateSettingLabels(); saveCamera(); });
  els.detectMode.addEventListener('change', () => { settings.detectMode = els.detectMode.value; saveCamera(); });
  els.nightMode.addEventListener('change', () => { settings.nightMode = els.nightMode.checked; saveCamera(); showToast(settings.nightMode ? '야간 LED 찌 모드를 켰어요.' : '일반 색상 모드로 바꿨어요.'); });
  els.waveCorrection.addEventListener('change', () => { settings.waveCorrection = els.waveCorrection.checked; saveCamera(); });
  els.multiSelect.addEventListener('change', () => {
    settings.multiSelect = els.multiSelect.checked;
    saveCamera();
    updateTapGuide();
    showToast(settings.multiSelect ? `여러 찌를 고를 수 있어요. (최대 ${MAX_FLOATS}개)` : '찌 하나만 감시해요.');
  });
  els.colorTolerance.addEventListener('input', () => { settings.colorTolerance = Number(els.colorTolerance.value); setRangeFill(els.colorTolerance); updateSettingLabels(); saveCamera(); });

  // settings: motion
  const setMotionSensitivity = (value) => {
    motionSettings.sensitivity = clamp(value, 1, 10);
    els.motionSensitivity.value = motionSettings.sensitivity;
    setRangeFill(els.motionSensitivity);
    updateSettingLabels();
    saveMotion();
    motionCtl.setSettings(motionControllerSettings());
  };
  els.motionSensitivity.addEventListener('input', () => setMotionSensitivity(Number(els.motionSensitivity.value)));
  els.motionPresets.addEventListener('click', (e) => { const b = e.target.closest('[data-preset]'); if (b) setMotionSensitivity(Number(b.dataset.preset)); });
  els.motionPattern.addEventListener('change', () => { motionSettings.detectMode = els.motionPattern.value; saveMotion(); motionCtl.setSettings(motionControllerSettings()); });
  els.motionKeepAwake.addEventListener('change', () => {
    motionSettings.keepAwake = els.motionKeepAwake.checked;
    saveMotion();
    motionWakeLock(motionWatching() && motionSettings.keepAwake);
  });

  // settings: native + info
  els.nativeNotifBtn.addEventListener('click', () => nativeMotion.openNotificationSettings().catch(() => {}));
  els.nativeBatteryBtn.addEventListener('click', () => nativeMotion.openBatterySettings().catch(() => {}));
  els.checkEnvBtn.addEventListener('click', checkEnvironment);
  els.replayOnboardingBtn.addEventListener('click', showOnboarding);
  els.diagPanel.addEventListener('toggle', updateDiagPanel);
  els.diagExportBtn.addEventListener('click', exportCameraDiagnostics);
  els.motionExportBtn.addEventListener('click', () => {
    if (!lastMotionExport) { showToast('내보낼 진동 이벤트가 아직 없어요.'); return; }
    const name = `jjibom-motion-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    showToast(downloadJson(name, lastMotionExport) ? '이벤트 데이터를 내보냈어요.' : '내보내기를 지원하지 않는 환경이에요.');
  });

  // onboarding
  els.onboardNext.addEventListener('click', () => {
    if (onboardIndex >= 2) finishOnboarding();
    else { onboardIndex += 1; renderOnboarding(); }
  });
  els.onboardSkip.addEventListener('click', finishOnboarding);

  // page lifecycle
  document.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener('resize', syncLayout);
  window.addEventListener('orientationchange', () => setTimeout(() => { if (cameraCtl.isActive) configureCanvases(); syncLayout(); }, 250));
  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(() => syncLayout());
    ro.observe(els.cameraDeck);
    ro.observe(els.motionDeck);
  }
  window.addEventListener('pagehide', () => { cameraCtl.stop(); });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (activeAlarm) { if (els.alarmScreen.dataset.state === 'ringing') silenceAlarm(); else closeAlarmScreen(null); }
    else if (!els.onboarding.hidden) finishOnboarding();
    else if (els.app.classList.contains('focus')) setFocus(false);
    else if (tab !== 'watch') switchTab('watch');
  });
}

function onVisibilityChange() {
  const visible = document.visibilityState === 'visible';
  const native = isNativeAvailable();
  if (!visible) {
    // The web page (and the WebView) stops analysing when hidden; remember when.
    if (cameraWatching() || (appMode === 'motion' && motionRunning() && !native)) safety.hiddenAt = Date.now();
  } else {
    alarmCtl.reacquireIfNeeded();
    if (safety.hiddenAt) {
      const away = Date.now() - safety.hiddenAt;
      safety.hiddenAt = null;
      if (away > 3000) {
        warn('hidden', '화면을 벗어나 있었어요', `${formatDuration(away) === '0분' ? `${Math.round(away / 1000)}초` : formatDuration(away)} 동안은 감시가 멈춰 있었어요.`, { sound: false });
      }
    }
    if (native) motionCtl.refreshNativeState().catch(() => {});
  }
  if (appMode === 'motion') motionCtl.onVisibilityChange();
  updateScene();
}

// ==========================================================================
// Service worker, errors
// ==========================================================================
async function registerServiceWorker() {
  // Inside the Android app the assets ship with the APK; a worker cache would
  // only risk serving stale files after an app update.
  if (isNativeApp()) return;
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
  // Never interrupt an active watch with a reload prompt.
  if (cameraWatching() || motionRunning()) {
    setTimeout(() => showUpdateBanner(registration), 60000);
    return;
  }
  els.updateBanner.hidden = false;
  els.reloadBtn.addEventListener('click', () => { registration.waiting?.postMessage('SKIP_WAITING'); }, { once: true });
}

let lastErrorToastAt = 0;
function installErrorHandlers() {
  const report = () => {
    if (Date.now() - lastErrorToastAt < 15000) return;
    lastErrorToastAt = Date.now();
    showToast('일시적인 문제가 생겼어요. 계속되면 앱을 다시 열어 주세요.', 4000);
  };
  window.addEventListener('error', report);
  window.addEventListener('unhandledrejection', report);
}

// ==========================================================================
// Init
// ==========================================================================
function init() {
  installErrorHandlers();
  alarmCtl.installGestureUnlock();
  alarmCtl.onWakeStateChange = (state) => {
    els.wakeText.textContent = { on: '켜짐', off: '꺼질 수 있음', unsupported: '미지원' }[state] || '—';
  };
  const native = isNativeAvailable();
  els.versionText.textContent = `v${APP_VERSION}`;
  els.platformPill.textContent = native ? '안드로이드 앱' : isNativeApp() ? '앱' : '웹';
  els.platformPill.classList.toggle('ok', native);
  els.nativeGroup.hidden = !native;

  applySettingsToUi();
  applyNight();
  document.querySelectorAll('.filter [data-filter]').forEach((x) => x.setAttribute('aria-selected', String(x.dataset.filter === ui.filter)));
  renderHistory();
  setPhase(PHASE.IDLE);
  bindEvents();
  motionCtl.setSettings(motionControllerSettings());
  updateMotionAvailabilityUi();
  renderMotionControls();
  if (storage.getItem(KEYS.mode) === 'motion') switchMode('motion', { confirmStop: false });
  if (native) {
    motionCtl.attachNative();
    motionCtl.refreshNativeState().catch(() => {});
  }
  watchBattery();
  setInterval(everySecond, 1000);
  registerServiceWorker();
  updateScene();
  syncLayout();
  if (!ui.onboarded) showOnboarding();
  if (!native && !window.isSecureContext && location.hostname !== 'localhost' && location.protocol !== 'file:') {
    showToast('카메라와 센서는 HTTPS 주소에서만 쓸 수 있어요.', 4500);
  }
}

init();
