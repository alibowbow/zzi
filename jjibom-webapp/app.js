(() => {
  'use strict';

  const memoryStore = new Map();
  const storage = {
    getItem(key) {
      try { return window.localStorage.getItem(key); }
      catch { return memoryStore.has(key) ? memoryStore.get(key) : null; }
    },
    setItem(key, value) {
      try { window.localStorage.setItem(key, String(value)); }
      catch { memoryStore.set(key, String(value)); }
    }
  };

  const ANALYSIS_MAX = 320;
  const PROCESS_INTERVAL = 66;
  const CALIBRATION_FRAMES = 36;
  const HISTORY_KEY = 'jjibom-history-v1';
  const SETTINGS_KEY = 'jjibom-settings-v1';
  const ADAPTIVE_KEY = 'jjibom-adaptive-v1';

  const STATES = Object.freeze({
    IDLE: 'idle',
    CAMERA: 'camera',
    CALIBRATING: 'calibrating',
    READY: 'ready',
    MONITORING: 'monitoring',
    ALARM: 'alarm'
  });

  const $ = (id) => document.getElementById(id);
  const els = {
    camera: $('camera'),
    cameraStage: $('cameraStage'),
    overlay: $('overlay'),
    analysisCanvas: $('analysisCanvas'),
    demoCanvas: $('demoCanvas'),
    cameraEmpty: $('cameraEmpty'),
    tapGuide: $('tapGuide'),
    calibrationPanel: $('calibrationPanel'),
    calibrationText: $('calibrationText'),
    cameraHud: $('cameraHud'),
    startCameraBtn: $('startCameraBtn'),
    startDemoBtn: $('startDemoBtn'),
    stopCameraBtn: $('stopCameraBtn'),
    flipCameraBtn: $('flipCameraBtn'),
    resetTargetBtn: $('resetTargetBtn'),
    monitorBtn: $('monitorBtn'),
    statusPill: $('statusPill'),
    statusLabel: $('statusLabel'),
    stateText: $('stateText'),
    confidenceText: $('confidenceText'),
    fpsText: $('fpsText'),
    wakeText: $('wakeText'),
    targetSwatch: $('targetSwatch'),
    targetColorText: $('targetColorText'),
    demoControls: $('demoControls'),
    alarmLayer: $('alarmLayer'),
    alarmTitle: $('alarmTitle'),
    alarmReason: $('alarmReason'),
    alarmScore: $('alarmScore'),
    stopAlarmBtn: $('stopAlarmBtn'),
    motionGauge: $('motionGauge'),
    motionScore: $('motionScore'),
    verticalMove: $('verticalMove'),
    confidenceMetric: $('confidenceMetric'),
    areaMetric: $('areaMetric'),
    motionChart: $('motionChart'),
    sensitivity: $('sensitivity'),
    sensitivityOutput: $('sensitivityOutput'),
    detectMode: $('detectMode'),
    nightMode: $('nightMode'),
    soundEnabled: $('soundEnabled'),
    vibrationEnabled: $('vibrationEnabled'),
    waveCorrection: $('waveCorrection'),
    colorTolerance: $('colorTolerance'),
    toleranceOutput: $('toleranceOutput'),
    historyList: $('historyList'),
    clearHistoryBtn: $('clearHistoryBtn'),
    installBtn: $('installBtn'),
    helpBtn: $('helpBtn'),
    helpModal: $('helpModal'),
    closeHelpBtn: $('closeHelpBtn'),
    helpOkayBtn: $('helpOkayBtn'),
    feedbackModal: $('feedbackModal'),
    feedbackTrueBtn: $('feedbackTrueBtn'),
    feedbackFalseBtn: $('feedbackFalseBtn'),
    feedbackSkipBtn: $('feedbackSkipBtn'),
    toast: $('toast')
  };

  const analysisCtx = els.analysisCanvas.getContext('2d', { willReadFrequently: true });
  const overlayCtx = els.overlay.getContext('2d');
  const chartCtx = els.motionChart.getContext('2d');
  const demoCtx = els.demoCanvas.getContext('2d');

  let appState = STATES.IDLE;
  let stream = null;
  let videoTrack = null;
  let facingMode = 'environment';
  let isDemo = false;
  let frameLoopToken = 0;
  let demoLoopToken = 0;
  let lastProcessAt = 0;
  let lastFrameAt = 0;
  let fpsEma = 0;
  let wakeLock = null;
  let target = null;
  let calibrationSamples = [];
  let motion = createMotionState();
  let history = loadJson(HISTORY_KEY, []);
  let adaptiveAdjustment = Number(storage.getItem(ADAPTIVE_KEY) || 0);
  let currentEventId = null;
  let feedbackEventId = null;
  let deferredInstallPrompt = null;
  let toastTimer = null;
  let alarmTimer = null;
  let alarmRepeatTimer = null;
  let audioContext = null;
  let demoBite = null;
  let demoStartTime = 0;

  const settings = Object.assign({
    sensitivity: 6,
    detectMode: 'balanced',
    nightMode: false,
    soundEnabled: true,
    vibrationEnabled: true,
    waveCorrection: true,
    colorTolerance: 28
  }, loadJson(SETTINGS_KEY, {}));

  function createMotionState() {
    return {
      baselineY: 0,
      baselineArea: 0,
      noisePx: 0.8,
      prevY: null,
      prevTime: null,
      recentDy: [],
      recentVelocity: [],
      graph: [],
      triggerStreak: 0,
      cooldownUntil: 0,
      score: 0,
      dy: 0,
      thresholdPx: 4,
      reason: '움직임 없음'
    };
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  function smoothStep(t) {
    const x = clamp(t, 0, 1);
    return x * x * (3 - 2 * x);
  }

  function median(values) {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  }

  function loadJson(key, fallback) {
    try {
      const value = JSON.parse(storage.getItem(key));
      return value ?? fallback;
    } catch {
      return fallback;
    }
  }

  function saveSettings() {
    storage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }

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

  function setState(next) {
    appState = next;
    const labels = {
      [STATES.IDLE]: ['대기', '카메라를 켜고 찌를 선택하세요.'],
      [STATES.CAMERA]: ['찌 선택', '화면에서 찌 끝의 선명한 색을 터치하세요.'],
      [STATES.CALIBRATING]: ['보정 중', '평소 물결 움직임을 잠깐 배우고 있어요.'],
      [STATES.READY]: ['준비 완료', '감시 시작을 누르면 입질 알람이 켜집니다.'],
      [STATES.MONITORING]: ['감시 중', '찌 움직임을 실시간으로 살펴보고 있어요.'],
      [STATES.ALARM]: ['입질!', '큰 움직임이 감지됐어요.']
    };

    els.statusPill.dataset.status = next;
    els.statusLabel.textContent = labels[next][0];
    els.stateText.textContent = labels[next][1];
    els.cameraEmpty.classList.toggle('hidden', next !== STATES.IDLE);
    els.tapGuide.classList.toggle('hidden', next !== STATES.CAMERA);
    els.calibrationPanel.classList.toggle('hidden', next !== STATES.CALIBRATING);
    els.cameraHud.classList.toggle('hidden', next === STATES.IDLE);
    els.stopCameraBtn.classList.toggle('hidden', next === STATES.IDLE);
    els.flipCameraBtn.classList.toggle('hidden', next === STATES.IDLE || isDemo);
    els.resetTargetBtn.classList.toggle('hidden', !target || next === STATES.IDLE || next === STATES.ALARM);
    els.demoControls.classList.toggle('hidden', !isDemo || next === STATES.IDLE);
    els.alarmLayer.classList.toggle('hidden', next !== STATES.ALARM);

    const canMonitor = next === STATES.READY || next === STATES.MONITORING || next === STATES.ALARM;
    els.monitorBtn.disabled = !canMonitor;
    els.monitorBtn.classList.toggle('monitoring', next === STATES.MONITORING || next === STATES.ALARM);
    if (next === STATES.MONITORING) {
      els.monitorBtn.innerHTML = '<span class="record-dot"></span>감시 멈춤';
    } else if (next === STATES.ALARM) {
      els.monitorBtn.innerHTML = '<span class="record-dot"></span>알람 멈춤';
    } else {
      els.monitorBtn.innerHTML = '<span class="record-dot"></span>감시 시작';
    }
  }

  function showToast(message, duration = 2500) {
    clearTimeout(toastTimer);
    els.toast.textContent = message;
    els.toast.classList.remove('hidden');
    toastTimer = setTimeout(() => els.toast.classList.add('hidden'), duration);
  }

  function showModal(modal) {
    modal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
  }

  function hideModal(modal) {
    modal.classList.add('hidden');
    if (els.helpModal.classList.contains('hidden') && els.feedbackModal.classList.contains('hidden')) {
      document.body.style.overflow = '';
    }
  }

  async function startCamera() {
    await stopCamera(true);
    await ensureAudioContext();

    if (!navigator.mediaDevices?.getUserMedia) {
      const reason = window.isSecureContext
        ? '이 브라우저는 카메라 기능을 지원하지 않아요.'
        : '카메라는 HTTPS 주소 또는 localhost에서만 사용할 수 있어요.';
      showToast(reason, 4500);
      return;
    }

    els.startCameraBtn.disabled = true;
    els.startCameraBtn.textContent = '카메라 여는 중…';

    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: facingMode },
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30, max: 30 }
        }
      });
      isDemo = false;
      videoTrack = stream.getVideoTracks()[0] || null;
      els.camera.srcObject = stream;
      await waitForVideo();
      configureCanvases();
      resetTarget(false);
      setState(STATES.CAMERA);
      startFrameLoop();
      await requestWakeLock();
      showToast('카메라가 켜졌어요. 찌 끝을 터치하세요.');
    } catch (error) {
      console.error(error);
      let message = '카메라를 열지 못했어요.';
      if (error?.name === 'NotAllowedError') message = '카메라 권한이 거부됐어요. 브라우저 설정에서 허용해주세요.';
      if (error?.name === 'NotFoundError') message = '사용할 수 있는 카메라를 찾지 못했어요.';
      if (error?.name === 'NotReadableError') message = '다른 앱이 카메라를 사용 중일 수 있어요.';
      showToast(message, 4500);
      setState(STATES.IDLE);
    } finally {
      els.startCameraBtn.disabled = false;
      els.startCameraBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M14.5 6 13 4H7L5.5 6H3v13h18V6z"/><circle cx="12" cy="12.5" r="4"/></svg>카메라 켜기';
    }
  }

  async function startDemo() {
    await stopCamera(true);
    await ensureAudioContext();

    if (!els.demoCanvas.captureStream) {
      showToast('이 브라우저에서는 데모 영상을 만들 수 없어요.');
      return;
    }

    isDemo = true;
    facingMode = 'environment';
    els.demoCanvas.width = 960;
    els.demoCanvas.height = 540;
    demoStartTime = performance.now();
    startDemoAnimation();
    stream = els.demoCanvas.captureStream(30);
    videoTrack = stream.getVideoTracks()[0] || null;
    els.camera.srcObject = stream;

    try {
      await waitForVideo();
      configureCanvases();
      resetTarget(false);
      setState(STATES.CAMERA);
      startFrameLoop();
      await requestWakeLock();
      showToast('데모가 시작됐어요. 빨간 찌 끝을 터치하세요.', 3500);
    } catch (error) {
      console.error(error);
      showToast('데모 영상을 시작하지 못했어요.');
      await stopCamera(true);
    }
  }

  function waitForVideo() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = async () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        try {
          await els.camera.play();
          resolve();
        } catch (error) {
          reject(error);
        }
      };
      if (els.camera.readyState >= 2 && els.camera.videoWidth) {
        finish();
        return;
      }
      els.camera.addEventListener('loadedmetadata', finish, { once: true });
      const timeout = setTimeout(() => reject(new Error('영상 준비 시간 초과')), 7000);
    });
  }

  async function stopCamera(quiet = false) {
    stopAlarm(false);
    frameLoopToken += 1;
    demoLoopToken += 1;
    demoBite = null;

    if (stream) {
      stream.getTracks().forEach((track) => track.stop());
    }
    stream = null;
    videoTrack = null;
    els.camera.srcObject = null;
    isDemo = false;
    resetTarget(false);
    clearOverlay();
    resetMetrics();
    await releaseWakeLock();
    setState(STATES.IDLE);
    if (!quiet) showToast('카메라를 껐어요.');
  }

  async function flipCamera() {
    if (isDemo) return;
    facingMode = facingMode === 'environment' ? 'user' : 'environment';
    await startCamera();
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
    resizeOverlay();
    resizeChart();
  }

  function resizeOverlay() {
    const rect = els.cameraStage.getBoundingClientRect();
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

  function getVideoDisplayRect() {
    const stage = els.cameraStage.getBoundingClientRect();
    const vw = els.camera.videoWidth || 16;
    const vh = els.camera.videoHeight || 9;
    const scale = Math.min(stage.width / vw, stage.height / vh);
    const width = vw * scale;
    const height = vh * scale;
    return {
      x: (stage.width - width) / 2,
      y: (stage.height - height) / 2,
      width,
      height
    };
  }

  function startFrameLoop() {
    const token = ++frameLoopToken;
    lastProcessAt = 0;
    lastFrameAt = 0;
    fpsEma = 0;

    const callback = (now) => {
      if (token !== frameLoopToken || !stream) return;
      if (!lastProcessAt || now - lastProcessAt >= PROCESS_INTERVAL) {
        processFrame(now);
        lastProcessAt = now;
      }
      if (typeof els.camera.requestVideoFrameCallback === 'function') {
        els.camera.requestVideoFrameCallback(callback);
      } else {
        requestAnimationFrame(callback);
      }
    };

    if (typeof els.camera.requestVideoFrameCallback === 'function') {
      els.camera.requestVideoFrameCallback(callback);
    } else {
      requestAnimationFrame(callback);
    }
  }

  function processFrame(now) {
    if (!els.camera.videoWidth || !els.analysisCanvas.width) return;
    try {
      analysisCtx.drawImage(els.camera, 0, 0, els.analysisCanvas.width, els.analysisCanvas.height);
    } catch {
      return;
    }

    if (lastFrameAt) {
      const instantFps = 1000 / Math.max(1, now - lastFrameAt);
      fpsEma = fpsEma ? lerp(fpsEma, instantFps, 0.12) : instantFps;
      els.fpsText.textContent = `${Math.round(fpsEma)}`;
    }
    lastFrameAt = now;

    if (target) {
      const image = analysisCtx.getImageData(0, 0, els.analysisCanvas.width, els.analysisCanvas.height);
      const result = trackTarget(image);
      if (appState === STATES.CALIBRATING) updateCalibration(result);
      if (appState === STATES.MONITORING) updateMotion(result, now);
      updateTrackingUi(result);
    }

    drawOverlay();
  }

  function handleTargetPointer(event) {
    if (!stream || appState === STATES.IDLE || appState === STATES.ALARM) return;
    if (appState === STATES.MONITORING) {
      showToast('감시를 먼저 멈춘 뒤 찌를 다시 선택해주세요.');
      return;
    }
    if (appState === STATES.CALIBRATING) return;

    const stageRect = els.cameraStage.getBoundingClientRect();
    const videoRect = getVideoDisplayRect();
    const x = event.clientX - stageRect.left;
    const y = event.clientY - stageRect.top;
    if (x < videoRect.x || x > videoRect.x + videoRect.width || y < videoRect.y || y > videoRect.y + videoRect.height) {
      showToast('영상 안쪽의 찌를 터치해주세요.');
      return;
    }

    const ax = (x - videoRect.x) / videoRect.width * els.analysisCanvas.width;
    const ay = (y - videoRect.y) / videoRect.height * els.analysisCanvas.height;
    selectTarget(ax, ay);
  }

  function selectTarget(x, y) {
    try {
      analysisCtx.drawImage(els.camera, 0, 0, els.analysisCanvas.width, els.analysisCanvas.height);
      const sample = sampleColor(x, y);
      if (!sample) {
        showToast('색을 읽지 못했어요. 다시 터치해주세요.');
        return;
      }

      target = {
        x,
        y,
        rgb: sample.rgb,
        hsv: sample.hsv,
        initialArea: 0,
        baselineArea: 0,
        baselineY: y,
        area: 0,
        rawArea: 0,
        confidence: 1,
        lostFrames: 0
      };
      calibrationSamples = [];
      motion = createMotionState();
      updateTargetColorUi();
      setState(STATES.CALIBRATING);
      showToast('찌를 찾았어요. 잠깐만 그대로 두세요.');
    } catch (error) {
      console.error(error);
      showToast('찌 색을 읽는 중 문제가 생겼어요.');
    }
  }

  function sampleColor(cx, cy) {
    const radius = 5;
    const x0 = clamp(Math.floor(cx - radius), 0, els.analysisCanvas.width - 1);
    const y0 = clamp(Math.floor(cy - radius), 0, els.analysisCanvas.height - 1);
    const x1 = clamp(Math.ceil(cx + radius), 1, els.analysisCanvas.width);
    const y1 = clamp(Math.ceil(cy + radius), 1, els.analysisCanvas.height);
    const image = analysisCtx.getImageData(x0, y0, x1 - x0, y1 - y0);
    const candidates = [];

    for (let i = 0; i < image.data.length; i += 4) {
      const r = image.data[i];
      const g = image.data[i + 1];
      const b = image.data[i + 2];
      const hsv = rgbToHsv(r, g, b);
      const centerBoost = hsv.s * 0.7 + hsv.v * 0.3;
      candidates.push({ r, g, b, hsv, centerBoost });
    }
    if (!candidates.length) return null;

    candidates.sort((a, b) => b.centerBoost - a.centerBoost);
    const keep = candidates.slice(0, Math.max(9, Math.floor(candidates.length * 0.42)));
    const rgb = {
      r: Math.round(median(keep.map((p) => p.r))),
      g: Math.round(median(keep.map((p) => p.g))),
      b: Math.round(median(keep.map((p) => p.b)))
    };
    return { rgb, hsv: rgbToHsv(rgb.r, rgb.g, rgb.b) };
  }

  function rgbToHsv(r, g, b) {
    const rn = r / 255;
    const gn = g / 255;
    const bn = b / 255;
    const max = Math.max(rn, gn, bn);
    const min = Math.min(rn, gn, bn);
    const delta = max - min;
    let h = 0;
    if (delta) {
      if (max === rn) h = 60 * (((gn - bn) / delta) % 6);
      else if (max === gn) h = 60 * ((bn - rn) / delta + 2);
      else h = 60 * ((rn - gn) / delta + 4);
    }
    if (h < 0) h += 360;
    return { h, s: max === 0 ? 0 : delta / max, v: max };
  }

  function hueDistance(a, b) {
    const diff = Math.abs(a - b);
    return Math.min(diff, 360 - diff);
  }

  function trackTarget(image) {
    const width = image.width;
    const height = image.height;
    const data = image.data;
    const tolerance = Number(settings.colorTolerance);
    const lost = target.lostFrames || 0;
    const searchRadius = lost > 7 ? Math.max(width, height) : clamp(52 + lost * 15, 52, 135);
    const x0 = lost > 7 ? 0 : Math.max(0, Math.floor(target.x - searchRadius));
    const x1 = lost > 7 ? width : Math.min(width, Math.ceil(target.x + searchRadius));
    const y0 = lost > 7 ? 0 : Math.max(0, Math.floor(target.y - searchRadius));
    const y1 = lost > 7 ? height : Math.min(height, Math.ceil(target.y + searchRadius));
    const step = lost > 7 ? 3 : 2;
    const sigma = lost > 7 ? Math.max(width, height) * 0.42 : searchRadius * 0.65;
    const sigma2 = 2 * sigma * sigma;

    let sumW = 0;
    let sumX = 0;
    let sumY = 0;
    let count = 0;
    let qualitySum = 0;

    for (let y = y0; y < y1; y += step) {
      for (let x = x0; x < x1; x += step) {
        const idx = (y * width + x) * 4;
        const r = data[idx];
        const g = data[idx + 1];
        const b = data[idx + 2];
        const hsv = rgbToHsv(r, g, b);
        let colorQuality = 0;
        let matched = false;

        if (target.hsv.s < 0.16) {
          const dr = r - target.rgb.r;
          const dg = g - target.rgb.g;
          const db = b - target.rgb.b;
          const distance = Math.sqrt(dr * dr + dg * dg + db * db);
          const maxDistance = tolerance * 4.2;
          matched = distance <= maxDistance;
          colorQuality = 1 - distance / maxDistance;
        } else {
          const hd = hueDistance(hsv.h, target.hsv.h);
          const sd = Math.abs(hsv.s - target.hsv.s);
          const vd = Math.abs(hsv.v - target.hsv.v);
          const hueLimit = settings.nightMode ? tolerance * 1.35 : tolerance;
          const satLimit = settings.nightMode ? 0.68 : 0.52;
          const valueLimit = settings.nightMode ? 0.58 : 0.62;
          const brightEnough = !settings.nightMode || hsv.v >= Math.max(0.40, target.hsv.v - 0.42);
          matched = brightEnough && hd <= hueLimit && sd <= satLimit && vd <= valueLimit;
          colorQuality = 1 - (hd / hueLimit * 0.58 + sd / satLimit * 0.22 + vd / valueLimit * 0.20);
        }

        if (!matched || colorQuality <= 0) continue;
        const dx = x - target.x;
        const dy = y - target.y;
        const spatialWeight = Math.exp(-(dx * dx + dy * dy) / sigma2);
        const weight = Math.max(0.03, colorQuality) * (lost > 7 ? 0.72 + spatialWeight * 0.28 : 0.18 + spatialWeight * 0.82);
        sumW += weight;
        sumX += x * weight;
        sumY += y * weight;
        qualitySum += colorQuality;
        count += 1;
      }
    }

    if (count < 4 || sumW <= 0.01) {
      target.lostFrames += 1;
      target.confidence *= 0.72;
      target.rawArea = 0;
      return {
        found: false,
        x: target.x,
        y: target.y,
        area: 0,
        confidence: target.confidence,
        lostFrames: target.lostFrames
      };
    }

    const foundX = sumX / sumW;
    const foundY = sumY / sumW;
    const rawArea = count * step * step;
    if (!target.initialArea) target.initialArea = rawArea;
    const expectedArea = target.baselineArea || target.initialArea || rawArea;
    const areaQuality = clamp(rawArea / Math.max(12, expectedArea * 0.55), 0, 1);
    const colorQuality = clamp(qualitySum / count, 0, 1);
    const confidence = clamp(colorQuality * 0.58 + areaQuality * 0.42, 0, 1);
    const smoothing = confidence > 0.62 ? 0.54 : confidence > 0.35 ? 0.38 : 0.24;

    target.x = lerp(target.x, foundX, smoothing);
    target.y = lerp(target.y, foundY, smoothing);
    target.rawArea = rawArea;
    target.area = target.area ? lerp(target.area, rawArea, 0.36) : rawArea;
    target.confidence = confidence;
    target.lostFrames = 0;

    return {
      found: true,
      x: target.x,
      y: target.y,
      area: rawArea,
      confidence,
      lostFrames: 0
    };
  }

  function updateCalibration(result) {
    if (!result.found || result.confidence < 0.22) {
      if (target.lostFrames > 18) {
        showToast('찌를 놓쳤어요. 더 선명한 부분을 다시 선택해주세요.', 3500);
        resetTarget(true);
      }
      return;
    }

    calibrationSamples.push({ y: result.y, area: result.area });
    const progress = clamp(calibrationSamples.length / CALIBRATION_FRAMES, 0, 1);
    els.calibrationText.textContent = `폰을 움직이지 말아주세요 · ${Math.round(progress * 100)}%`;

    if (calibrationSamples.length >= CALIBRATION_FRAMES) {
      const ys = calibrationSamples.map((item) => item.y);
      const areas = calibrationSamples.map((item) => item.area);
      const baselineY = median(ys);
      const baselineArea = Math.max(8, median(areas));
      const deviations = ys.map((value) => Math.abs(value - baselineY));
      const noisePx = Math.max(0.55, median(deviations) * 1.4826);

      target.baselineY = baselineY;
      target.baselineArea = baselineArea;
      target.noisePx = noisePx;
      motion = createMotionState();
      motion.baselineY = baselineY;
      motion.baselineArea = baselineArea;
      motion.noisePx = noisePx;
      motion.prevY = target.y;
      setState(STATES.READY);
      showToast('보정 완료! 이제 감시를 시작할 수 있어요.');
    }
  }

  function startMonitoring() {
    if (!target || appState !== STATES.READY) return;
    ensureAudioContext();
    motion = createMotionState();
    motion.baselineY = target.baselineY || target.y;
    motion.baselineArea = target.baselineArea || target.area || target.initialArea;
    motion.noisePx = Math.max(0.55, target.noisePx || 0.8);
    motion.prevY = target.y;
    motion.prevTime = performance.now();
    setState(STATES.MONITORING);
    requestWakeLock();
    showToast('입질 감시를 시작했어요.');
  }

  function stopMonitoring() {
    if (appState === STATES.ALARM) {
      stopAlarm(true);
      return;
    }
    if (appState !== STATES.MONITORING) return;
    motion.triggerStreak = 0;
    setState(STATES.READY);
    showToast('감시를 잠시 멈췄어요.');
  }

  function updateMotion(result, now) {
    const sensitivityT = (Number(settings.sensitivity) - 1) / 9;
    const adaptiveFactor = clamp(1 + adaptiveAdjustment, 0.78, 1.34);
    const baseThreshold = lerp(8.2, 1.75, sensitivityT) * adaptiveFactor;
    const noiseThreshold = motion.noisePx * lerp(5.0, 2.8, sensitivityT);
    const thresholdPx = Math.max(baseThreshold, noiseThreshold);
    const velocityThreshold = lerp(46, 11, sensitivityT) * adaptiveFactor;
    const dt = clamp((now - (motion.prevTime || now - PROCESS_INTERVAL)) / 1000, 0.03, 0.25);
    const currentY = result.found ? result.y : (motion.prevY ?? motion.baselineY);
    const dy = currentY - motion.baselineY;
    const velocity = result.found ? (currentY - (motion.prevY ?? currentY)) / dt : 0;
    const areaRatio = motion.baselineArea > 0 ? result.area / motion.baselineArea : 1;
    const areaDrop = clamp(1 - areaRatio, 0, 1);

    motion.recentDy.push(dy);
    motion.recentVelocity.push(velocity);
    if (motion.recentDy.length > 18) motion.recentDy.shift();
    if (motion.recentVelocity.length > 18) motion.recentVelocity.shift();

    const recentRange = motion.recentDy.length > 4
      ? Math.max(...motion.recentDy) - Math.min(...motion.recentDy)
      : 0;
    let signChanges = 0;
    for (let i = 2; i < motion.recentVelocity.length; i += 1) {
      const a = motion.recentVelocity[i - 1];
      const b = motion.recentVelocity[i];
      if (Math.abs(a) > velocityThreshold * 0.18 && Math.abs(b) > velocityThreshold * 0.18 && Math.sign(a) !== Math.sign(b)) {
        signChanges += 1;
      }
    }

    let displacementRatio = Math.abs(dy) / thresholdPx;
    let speedRatio = Math.abs(velocity) / velocityThreshold;
    if (settings.detectMode === 'sink') {
      displacementRatio = Math.max(0, dy) / thresholdPx;
      speedRatio = Math.max(0, velocity) / velocityThreshold;
    } else if (settings.detectMode === 'lift') {
      displacementRatio = Math.max(0, -dy) / thresholdPx;
      speedRatio = Math.max(0, -velocity) / velocityThreshold;
    }

    const twitchRatio = (recentRange / Math.max(1, thresholdPx * 1.45)) * clamp(signChanges / 3, 0, 1.2);
    const areaRatioScore = areaDrop / (settings.detectMode === 'sink' ? 0.34 : 0.46);
    const lostRatio = result.lostFrames >= 3 ? clamp((result.lostFrames - 1) / 5, 0, 1.35) : 0;

    let rawRatio;
    if (settings.detectMode === 'twitch') {
      rawRatio = Math.max(twitchRatio * 1.12, speedRatio * 0.5, displacementRatio * 0.38, areaRatioScore * 0.42);
    } else {
      rawRatio = Math.max(displacementRatio, speedRatio * 0.82, twitchRatio * 0.92, areaRatioScore, lostRatio);
    }

    const score = Math.round(clamp(rawRatio * 80, 0, 100));
    let reason = '움직임 없음';
    const components = [
      ['잠김 또는 사라짐', Math.max(areaRatioScore, lostRatio)],
      ['토독 떨림 감지', twitchRatio * (settings.detectMode === 'twitch' ? 1.12 : 0.92)],
      [dy >= 0 ? '급하강 감지' : '급상승 감지', Math.max(displacementRatio, speedRatio * 0.82)]
    ].sort((a, b) => b[1] - a[1]);
    if (rawRatio > 0.28) reason = components[0][0];

    motion.score = score;
    motion.dy = dy;
    motion.thresholdPx = thresholdPx;
    motion.reason = reason;
    motion.prevY = currentY;
    motion.prevTime = now;
    motion.graph.push(clamp(dy / Math.max(1, thresholdPx * 2.2), -1.5, 1.5));
    if (motion.graph.length > 150) motion.graph.shift();

    if (settings.waveCorrection && result.found && result.confidence > 0.35 && rawRatio < 0.42) {
      motion.baselineY = lerp(motion.baselineY, result.y, 0.007);
      motion.baselineArea = lerp(motion.baselineArea, result.area, 0.004);
    }

    const hardSink = (areaDrop > 0.68 && result.lostFrames >= 1) || result.lostFrames >= 5;
    if ((rawRatio >= 1 || hardSink) && now >= motion.cooldownUntil) {
      motion.triggerStreak += 1;
    } else {
      motion.triggerStreak = Math.max(0, motion.triggerStreak - 1);
    }

    if (motion.triggerStreak >= (hardSink ? 2 : 3)) {
      motion.triggerStreak = 0;
      motion.cooldownUntil = now + 8500;
      triggerAlarm(reason === '움직임 없음' ? '큰 움직임 감지' : reason, Math.max(score, hardSink ? 94 : 82));
    }

    updateMotionUi();
  }

  function updateTrackingUi(result) {
    const confidence = Math.round(clamp(result.confidence * 100, 0, 100));
    els.confidenceText.textContent = result.found ? `${confidence}%` : '놓침';
    els.confidenceMetric.textContent = confidence;
    const areaBase = target?.baselineArea || target?.initialArea || result.area || 1;
    const areaPercent = Math.round(clamp(result.area / areaBase * 100, 0, 160));
    els.areaMetric.textContent = result.found ? areaPercent : 0;
    if (appState !== STATES.MONITORING && appState !== STATES.ALARM) {
      els.verticalMove.textContent = target?.baselineY ? (target.y - target.baselineY).toFixed(1) : '0.0';
    }
  }

  function updateMotionUi() {
    const displayScore = clamp(motion.score, 0, 100);
    els.motionGauge.style.setProperty('--value', displayScore);
    els.motionScore.textContent = displayScore;
    els.verticalMove.textContent = motion.dy.toFixed(1);
    drawMotionChart();
  }

  function resetMetrics() {
    motion = createMotionState();
    els.motionGauge.style.setProperty('--value', 0);
    els.motionScore.textContent = '0';
    els.verticalMove.textContent = '0.0';
    els.confidenceMetric.textContent = '0';
    els.areaMetric.textContent = '0';
    els.confidenceText.textContent = '—';
    els.fpsText.textContent = '—';
    drawMotionChart();
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
      chartCtx.beginPath();
      chartCtx.moveTo(0, y);
      chartCtx.lineTo(width, y);
      chartCtx.stroke();
    }

    chartCtx.setLineDash([5, 6]);
    chartCtx.strokeStyle = 'rgba(255, 135, 94, 0.28)';
    chartCtx.beginPath();
    chartCtx.moveTo(0, height * 0.18);
    chartCtx.lineTo(width, height * 0.18);
    chartCtx.moveTo(0, height * 0.82);
    chartCtx.lineTo(width, height * 0.82);
    chartCtx.stroke();
    chartCtx.setLineDash([]);

    const values = motion.graph.length ? motion.graph : Array.from({ length: 80 }, (_, i) => Math.sin(i * 0.2) * 0.018);
    const maxPoints = 150;
    const visible = values.slice(-maxPoints);
    chartCtx.beginPath();
    visible.forEach((value, index) => {
      const x = visible.length <= 1 ? 0 : index / (visible.length - 1) * width;
      const y = height / 2 + clamp(value, -1.5, 1.5) / 1.5 * height * 0.42;
      if (index === 0) chartCtx.moveTo(x, y);
      else chartCtx.lineTo(x, y);
    });
    chartCtx.strokeStyle = motion.score >= 80 ? '#ff6b7c' : '#42edc4';
    chartCtx.lineWidth = 2;
    chartCtx.shadowColor = motion.score >= 80 ? 'rgba(255,107,124,.35)' : 'rgba(66,237,196,.28)';
    chartCtx.shadowBlur = 8;
    chartCtx.stroke();
    chartCtx.shadowBlur = 0;

    chartCtx.strokeStyle = 'rgba(255,255,255,.15)';
    chartCtx.lineWidth = 1;
    chartCtx.beginPath();
    chartCtx.moveTo(0, height / 2);
    chartCtx.lineTo(width, height / 2);
    chartCtx.stroke();
  }

  function drawOverlay() {
    const stageRect = els.cameraStage.getBoundingClientRect();
    overlayCtx.clearRect(0, 0, stageRect.width, stageRect.height);
    if (!stream || !target) return;

    const videoRect = getVideoDisplayRect();
    const x = videoRect.x + target.x / els.analysisCanvas.width * videoRect.width;
    const y = videoRect.y + target.y / els.analysisCanvas.height * videoRect.height;
    const confidence = clamp(target.confidence, 0, 1);
    const isLost = target.lostFrames > 2;
    const color = isLost ? '#ff5f70' : confidence > 0.45 ? '#42edc4' : '#ffdb75';
    const radius = 20;

    overlayCtx.save();
    overlayCtx.strokeStyle = color;
    overlayCtx.fillStyle = color;
    overlayCtx.lineWidth = 1.6;
    overlayCtx.shadowColor = color;
    overlayCtx.shadowBlur = 9;

    overlayCtx.beginPath();
    overlayCtx.arc(x, y, radius, 0, Math.PI * 2);
    overlayCtx.stroke();
    overlayCtx.shadowBlur = 0;
    overlayCtx.beginPath();
    overlayCtx.moveTo(x - radius - 9, y);
    overlayCtx.lineTo(x - radius + 3, y);
    overlayCtx.moveTo(x + radius - 3, y);
    overlayCtx.lineTo(x + radius + 9, y);
    overlayCtx.moveTo(x, y - radius - 9);
    overlayCtx.lineTo(x, y - radius + 3);
    overlayCtx.moveTo(x, y + radius - 3);
    overlayCtx.lineTo(x, y + radius + 9);
    overlayCtx.stroke();
    overlayCtx.beginPath();
    overlayCtx.arc(x, y, 2.5, 0, Math.PI * 2);
    overlayCtx.fill();

    if ((appState === STATES.READY || appState === STATES.MONITORING || appState === STATES.ALARM) && motion.baselineY) {
      const baselineY = videoRect.y + motion.baselineY / els.analysisCanvas.height * videoRect.height;
      overlayCtx.setLineDash([5, 5]);
      overlayCtx.strokeStyle = 'rgba(255,255,255,.35)';
      overlayCtx.beginPath();
      overlayCtx.moveTo(Math.max(videoRect.x, x - 64), baselineY);
      overlayCtx.lineTo(Math.min(videoRect.x + videoRect.width, x + 64), baselineY);
      overlayCtx.stroke();
      overlayCtx.setLineDash([]);
    }

    const label = isLost ? '찌 놓침' : appState === STATES.MONITORING ? `감시 ${Math.round(confidence * 100)}%` : `찌 ${Math.round(confidence * 100)}%`;
    overlayCtx.font = '700 11px system-ui, sans-serif';
    const textWidth = overlayCtx.measureText(label).width;
    overlayCtx.fillStyle = 'rgba(3,15,21,.78)';
    overlayCtx.beginPath();
    roundedRectPath(overlayCtx, x - textWidth / 2 - 8, y + 29, textWidth + 16, 23, 7);
    overlayCtx.fill();
    overlayCtx.fillStyle = color;
    overlayCtx.textAlign = 'center';
    overlayCtx.textBaseline = 'middle';
    overlayCtx.fillText(label, x, y + 40.5);
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

  function clearOverlay() {
    const rect = els.cameraStage.getBoundingClientRect();
    overlayCtx.clearRect(0, 0, rect.width, rect.height);
  }

  function resetTarget(showMessage = true) {
    if (appState === STATES.ALARM) stopAlarm(false);
    target = null;
    calibrationSamples = [];
    motion = createMotionState();
    els.targetSwatch.style.background = '';
    els.targetColorText.textContent = '아직 없음';
    resetMetrics();
    clearOverlay();
    if (stream) setState(STATES.CAMERA);
    if (showMessage) showToast('화면에서 찌 끝을 다시 터치하세요.');
  }

  function updateTargetColorUi() {
    if (!target) return;
    const { r, g, b } = target.rgb;
    const hex = `#${[r, g, b].map((value) => value.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
    els.targetSwatch.style.background = `rgb(${r}, ${g}, ${b})`;
    els.targetColorText.textContent = `${colorName(target.hsv)} · ${hex}`;
  }

  function colorName(hsv) {
    if (hsv.v < 0.18) return '어두운색';
    if (hsv.s < 0.15) return hsv.v > 0.78 ? '흰색 계열' : '회색 계열';
    const h = hsv.h;
    if (h < 16 || h >= 345) return '빨강 계열';
    if (h < 46) return '주황 계열';
    if (h < 72) return '노랑 계열';
    if (h < 165) return '초록 계열';
    if (h < 205) return '청록 계열';
    if (h < 255) return '파랑 계열';
    if (h < 300) return '보라 계열';
    return '분홍 계열';
  }

  function triggerAlarm(reason, score) {
    if (appState !== STATES.MONITORING) return;
    const event = {
      id: Date.now(),
      timestamp: new Date().toISOString(),
      reason,
      score: Math.round(score),
      feedback: null
    };
    history.unshift(event);
    history = history.slice(0, 30);
    saveHistory();
    renderHistory();
    currentEventId = event.id;
    els.alarmTitle.textContent = reason.includes('잠김') ? '찌가 잠겼어요!' : '입질 감지!';
    els.alarmReason.textContent = reason === '토독 떨림 감지' ? '짧고 빠른 떨림이 이어졌어요.' : '평소 물결보다 큰 움직임이에요.';
    els.alarmScore.textContent = event.score;
    setState(STATES.ALARM);
    playAlarm();
    alarmTimer = setTimeout(() => stopAlarm(true), 12000);
  }

  function stopAlarm(showFeedback = true) {
    clearTimeout(alarmTimer);
    alarmTimer = null;
    stopAlarmSound();
    if (navigator.vibrate) navigator.vibrate(0);

    if (appState === STATES.ALARM) {
      setState(target && stream ? STATES.MONITORING : stream ? STATES.CAMERA : STATES.IDLE);
      if (showFeedback && currentEventId) {
        feedbackEventId = currentEventId;
        setTimeout(() => showModal(els.feedbackModal), 120);
      }
    }
    currentEventId = null;
  }

  async function ensureAudioContext() {
    if (!audioContext) {
      const AudioCtor = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtor) return null;
      audioContext = new AudioCtor();
    }
    if (audioContext.state === 'suspended') {
      try { await audioContext.resume(); } catch { /* no-op */ }
    }
    return audioContext;
  }

  async function playAlarm() {
    if (settings.vibrationEnabled && navigator.vibrate) {
      navigator.vibrate([280, 120, 280, 120, 620, 180, 280]);
    }
    if (!settings.soundEnabled) return;
    await ensureAudioContext();
    playBeepPattern();
    clearInterval(alarmRepeatTimer);
    alarmRepeatTimer = setInterval(playBeepPattern, 1900);
  }

  function playBeepPattern() {
    if (!audioContext || !settings.soundEnabled) return;
    const start = audioContext.currentTime + 0.02;
    [0, 0.34, 0.68].forEach((offset, index) => {
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(index === 2 ? 980 : 820, start + offset);
      oscillator.frequency.exponentialRampToValueAtTime(index === 2 ? 680 : 610, start + offset + 0.18);
      gain.gain.setValueAtTime(0.0001, start + offset);
      gain.gain.exponentialRampToValueAtTime(0.22, start + offset + 0.018);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + 0.22);
      oscillator.connect(gain).connect(audioContext.destination);
      oscillator.start(start + offset);
      oscillator.stop(start + offset + 0.24);
    });
  }

  function stopAlarmSound() {
    clearInterval(alarmRepeatTimer);
    alarmRepeatTimer = null;
  }

  function saveHistory() {
    storage.setItem(HISTORY_KEY, JSON.stringify(history));
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
      icon.innerHTML = event.reason.includes('떨림')
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
        yes.type = 'button';
        yes.dataset.feedbackId = event.id;
        yes.dataset.feedbackValue = 'true';
        yes.textContent = '입질';
        const no = document.createElement('button');
        no.type = 'button';
        no.dataset.feedbackId = event.id;
        no.dataset.feedbackValue = 'false';
        no.textContent = '오탐';
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
    } catch {
      return timestamp;
    }
  }

  function setFeedback(id, value) {
    const event = history.find((item) => Number(item.id) === Number(id));
    if (!event) return;
    event.feedback = value;
    adaptiveAdjustment = clamp(adaptiveAdjustment + (value ? -0.018 : 0.055), -0.18, 0.32);
    storage.setItem(ADAPTIVE_KEY, String(adaptiveAdjustment));
    saveHistory();
    renderHistory();
    showToast(value ? '입질로 기록했어요.' : '오탐으로 기록했어요. 민감도를 조금 낮춰 반영합니다.');
  }

  async function requestWakeLock() {
    if (!('wakeLock' in navigator)) {
      els.wakeText.textContent = '미지원';
      return;
    }
    if (wakeLock || document.visibilityState !== 'visible') return;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      els.wakeText.textContent = '켜짐';
      wakeLock.addEventListener('release', () => {
        wakeLock = null;
        els.wakeText.textContent = '풀림';
      }, { once: true });
    } catch {
      els.wakeText.textContent = '풀림';
    }
  }

  async function releaseWakeLock() {
    if (!wakeLock) return;
    try { await wakeLock.release(); } catch { /* no-op */ }
    wakeLock = null;
    els.wakeText.textContent = '—';
  }

  function startDemoAnimation() {
    const token = ++demoLoopToken;
    const width = els.demoCanvas.width;
    const height = els.demoCanvas.height;

    const draw = (now) => {
      if (token !== demoLoopToken || !isDemo) return;
      const elapsed = now - demoStartTime;
      const waterY = 322;
      let biteOffset = 0;
      if (demoBite) {
        const t = (now - demoBite.start) / demoBite.duration;
        if (t >= 1) {
          demoBite = null;
        } else if (demoBite.type === 'sink') {
          if (t < 0.22) biteOffset = smoothStep(t / 0.22) * 58;
          else if (t < 0.56) biteOffset = 58 + Math.sin(t * 52) * 2;
          else biteOffset = (1 - smoothStep((t - 0.56) / 0.44)) * 58;
        } else if (demoBite.type === 'lift') {
          if (t < 0.28) biteOffset = -smoothStep(t / 0.28) * 36;
          else if (t < 0.58) biteOffset = -36;
          else biteOffset = -(1 - smoothStep((t - 0.58) / 0.42)) * 36;
        } else if (demoBite.type === 'twitch') {
          biteOffset = Math.sin(t * Math.PI * 16) * 13 * Math.sin(Math.PI * t);
        }
      }

      const sky = demoCtx.createLinearGradient(0, 0, 0, waterY);
      sky.addColorStop(0, '#0b2531');
      sky.addColorStop(1, '#183d49');
      demoCtx.fillStyle = sky;
      demoCtx.fillRect(0, 0, width, waterY);

      const glow = demoCtx.createRadialGradient(710, 90, 5, 710, 90, 240);
      glow.addColorStop(0, 'rgba(112,211,225,.23)');
      glow.addColorStop(1, 'rgba(112,211,225,0)');
      demoCtx.fillStyle = glow;
      demoCtx.fillRect(0, 0, width, waterY);

      demoCtx.fillStyle = 'rgba(5,19,27,.58)';
      demoCtx.beginPath();
      demoCtx.moveTo(0, 260);
      for (let x = 0; x <= width; x += 70) {
        const hill = 248 + Math.sin(x * 0.013) * 20 + Math.sin(x * 0.027) * 9;
        demoCtx.lineTo(x, hill);
      }
      demoCtx.lineTo(width, waterY);
      demoCtx.lineTo(0, waterY);
      demoCtx.fill();

      const water = demoCtx.createLinearGradient(0, waterY, 0, height);
      water.addColorStop(0, '#0d4656');
      water.addColorStop(1, '#072a38');
      demoCtx.fillStyle = water;
      demoCtx.fillRect(0, waterY, width, height - waterY);

      for (let row = 0; row < 13; row += 1) {
        const y = waterY + 8 + row * 18;
        demoCtx.strokeStyle = `rgba(127, 220, 225, ${0.12 - row * 0.005})`;
        demoCtx.lineWidth = row % 3 === 0 ? 2 : 1;
        demoCtx.beginPath();
        for (let x = -20; x <= width + 20; x += 8) {
          const wave = Math.sin(x * 0.024 + elapsed * 0.0016 + row * 0.85) * (2.2 + row * 0.08);
          if (x === -20) demoCtx.moveTo(x, y + wave);
          else demoCtx.lineTo(x, y + wave);
        }
        demoCtx.stroke();
      }

      const floatX = width * 0.53 + Math.sin(elapsed * 0.00035) * 1.7;
      const idle = Math.sin(elapsed * 0.0042) * 2.1 + Math.sin(elapsed * 0.009) * 0.7;
      const floatY = waterY - 27 + idle + biteOffset;

      demoCtx.save();
      demoCtx.translate(floatX, floatY);
      demoCtx.rotate(Math.sin(elapsed * 0.0026) * 0.012);
      demoCtx.shadowColor = 'rgba(255,76,55,.72)';
      demoCtx.shadowBlur = 15;
      demoCtx.fillStyle = '#ff543d';
      demoCtx.fillRect(-4, -76, 8, 39);
      demoCtx.shadowBlur = 0;
      demoCtx.fillStyle = '#ff6a45';
      roundRectFill(demoCtx, -11, -41, 22, 30, 9);
      demoCtx.fillStyle = '#edf9f6';
      demoCtx.fillRect(-11, -24, 22, 22);
      demoCtx.fillStyle = '#203b45';
      roundRectFill(demoCtx, -11, -4, 22, 33, 9);
      demoCtx.fillStyle = '#152e38';
      demoCtx.fillRect(-2, 28, 4, 24);
      demoCtx.restore();

      demoCtx.fillStyle = 'rgba(10,66,80,.44)';
      demoCtx.fillRect(0, waterY, width, height - waterY);
      demoCtx.strokeStyle = 'rgba(179,238,238,.38)';
      demoCtx.lineWidth = 2;
      demoCtx.beginPath();
      for (let x = 0; x <= width; x += 7) {
        const wave = Math.sin(x * 0.032 + elapsed * 0.0022) * 3;
        if (x === 0) demoCtx.moveTo(x, waterY + wave);
        else demoCtx.lineTo(x, waterY + wave);
      }
      demoCtx.stroke();

      demoCtx.fillStyle = 'rgba(236,250,250,.78)';
      demoCtx.font = '600 18px system-ui, sans-serif';
      demoCtx.fillText('빨간 찌 끝을 터치해보세요', 34, 45);
      demoCtx.fillStyle = 'rgba(236,250,250,.48)';
      demoCtx.font = '500 13px system-ui, sans-serif';
      demoCtx.fillText('보정이 끝나면 아래 입질 버튼으로 알람을 시험할 수 있어요.', 34, 70);

      requestAnimationFrame(draw);
    };
    requestAnimationFrame(draw);
  }

  function roundRectFill(ctx, x, y, width, height, radius) {
    ctx.beginPath();
    roundedRectPath(ctx, x, y, width, height, radius);
    ctx.fill();
  }

  function triggerDemoBite(type) {
    if (!isDemo) return;
    const durations = { sink: 2100, lift: 1900, twitch: 1800 };
    demoBite = { type, start: performance.now(), duration: durations[type] || 1900 };
    if (appState !== STATES.MONITORING) {
      showToast('움직임은 만들었지만, 알람을 보려면 감시 시작을 눌러주세요.');
    }
  }

  function bindEvents() {
    els.startCameraBtn.addEventListener('click', startCamera);
    els.startDemoBtn.addEventListener('click', startDemo);
    els.stopCameraBtn.addEventListener('click', () => stopCamera());
    els.flipCameraBtn.addEventListener('click', flipCamera);
    els.resetTargetBtn.addEventListener('click', () => resetTarget(true));
    els.overlay.addEventListener('pointerdown', handleTargetPointer);
    els.monitorBtn.addEventListener('click', () => {
      if (appState === STATES.READY) startMonitoring();
      else if (appState === STATES.MONITORING || appState === STATES.ALARM) stopMonitoring();
    });
    els.stopAlarmBtn.addEventListener('click', () => stopAlarm(true));

    els.sensitivity.addEventListener('input', () => {
      settings.sensitivity = Number(els.sensitivity.value);
      updateSettingLabels();
      saveSettings();
    });
    els.detectMode.addEventListener('change', () => {
      settings.detectMode = els.detectMode.value;
      saveSettings();
    });
    els.nightMode.addEventListener('change', () => {
      settings.nightMode = els.nightMode.checked;
      saveSettings();
      showToast(settings.nightMode ? '야간 LED 모드를 켰어요.' : '일반 색상 모드로 바꿨어요.');
    });
    els.soundEnabled.addEventListener('change', () => {
      settings.soundEnabled = els.soundEnabled.checked;
      saveSettings();
      if (!settings.soundEnabled) stopAlarmSound();
      else ensureAudioContext();
    });
    els.vibrationEnabled.addEventListener('change', () => {
      settings.vibrationEnabled = els.vibrationEnabled.checked;
      saveSettings();
    });
    els.waveCorrection.addEventListener('change', () => {
      settings.waveCorrection = els.waveCorrection.checked;
      saveSettings();
    });
    els.colorTolerance.addEventListener('input', () => {
      settings.colorTolerance = Number(els.colorTolerance.value);
      updateSettingLabels();
      saveSettings();
    });

    els.demoControls.addEventListener('click', (event) => {
      const button = event.target.closest('[data-demo-bite]');
      if (button) triggerDemoBite(button.dataset.demoBite);
    });

    els.historyList.addEventListener('click', (event) => {
      const button = event.target.closest('[data-feedback-id]');
      if (!button) return;
      setFeedback(button.dataset.feedbackId, button.dataset.feedbackValue === 'true');
    });
    els.clearHistoryBtn.addEventListener('click', () => {
      if (!history.length) return;
      if (window.confirm('입질 기록을 모두 지울까요?')) {
        history = [];
        saveHistory();
        renderHistory();
        showToast('기록을 모두 지웠어요.');
      }
    });

    els.helpBtn.addEventListener('click', () => showModal(els.helpModal));
    els.closeHelpBtn.addEventListener('click', () => hideModal(els.helpModal));
    els.helpOkayBtn.addEventListener('click', () => hideModal(els.helpModal));
    els.helpModal.addEventListener('click', (event) => {
      if (event.target === els.helpModal) hideModal(els.helpModal);
    });

    els.feedbackTrueBtn.addEventListener('click', () => {
      if (feedbackEventId) setFeedback(feedbackEventId, true);
      feedbackEventId = null;
      hideModal(els.feedbackModal);
    });
    els.feedbackFalseBtn.addEventListener('click', () => {
      if (feedbackEventId) setFeedback(feedbackEventId, false);
      feedbackEventId = null;
      hideModal(els.feedbackModal);
    });
    els.feedbackSkipBtn.addEventListener('click', () => {
      feedbackEventId = null;
      hideModal(els.feedbackModal);
    });

    window.addEventListener('beforeinstallprompt', (event) => {
      event.preventDefault();
      deferredInstallPrompt = event;
      els.installBtn.classList.remove('hidden');
    });
    els.installBtn.addEventListener('click', async () => {
      if (!deferredInstallPrompt) {
        showToast('브라우저 메뉴에서 “홈 화면에 추가”를 선택해주세요.');
        return;
      }
      deferredInstallPrompt.prompt();
      await deferredInstallPrompt.userChoice;
      deferredInstallPrompt = null;
      els.installBtn.classList.add('hidden');
    });
    window.addEventListener('appinstalled', () => {
      deferredInstallPrompt = null;
      els.installBtn.classList.add('hidden');
      showToast('찌봄을 홈 화면에 설치했어요.');
    });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && stream) requestWakeLock();
    });
    window.addEventListener('resize', () => {
      resizeOverlay();
      resizeChart();
      drawOverlay();
    });
    window.addEventListener('orientationchange', () => setTimeout(() => {
      resizeOverlay();
      resizeChart();
    }, 250));
    window.addEventListener('beforeunload', () => {
      if (stream) stream.getTracks().forEach((track) => track.stop());
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        hideModal(els.helpModal);
        hideModal(els.feedbackModal);
        if (appState === STATES.ALARM) stopAlarm(true);
      }
    });
  }

  function registerServiceWorker() {
    if ('serviceWorker' in navigator && (window.isSecureContext || location.hostname === 'localhost')) {
      navigator.serviceWorker.register('./sw.js').catch((error) => console.warn('Service worker registration failed:', error));
    }
  }

  function init() {
    applySettingsToUi();
    renderHistory();
    setState(STATES.IDLE);
    bindEvents();
    registerServiceWorker();
    resizeChart();
    drawMotionChart();

    if (!window.isSecureContext && location.hostname !== 'localhost' && location.protocol !== 'file:') {
      showToast('실제 카메라 사용에는 HTTPS 연결이 필요해요.', 4200);
    }
  }

  init();
})();
