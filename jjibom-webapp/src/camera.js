// camera.js — camera lifecycle: start/stop, device selection, zoom, and a
// robust waitForVideo(). Browser-only (touches getUserMedia / MediaStream).

// Wait until a <video> element actually has frames to read.
//
// This is the fix for the original bug: in the fast path (metadata already
// available) the old code called clearTimeout(timeout) before `timeout` was
// declared, throwing a ReferenceError. Here `timer` is declared up front, a
// single `settled` flag prevents double resolve/reject, and every listener and
// the timer are always cleaned up.
export function waitForVideo(video, timeoutMs = 7000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;

    const cleanup = () => {
      if (timer != null) {
        clearTimeout(timer);
        timer = null;
      }
      video.removeEventListener('loadedmetadata', onReady);
      video.removeEventListener('canplay', onReady);
      video.removeEventListener('error', onError);
    };

    const finish = async () => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        await video.play();
        resolve();
      } catch (error) {
        // Autoplay may be blocked even though frames are available; if we can
        // read a frame, treat it as success, otherwise surface the error.
        if (video.readyState >= 2 && video.videoWidth) resolve();
        else reject(error);
      }
    };

    const onReady = () => {
      if (video.videoWidth) finish();
    };

    const onError = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('비디오를 불러오지 못했어요.'));
    };

    // Fast path — metadata is already there (e.g. fast camera switch / re-run).
    if (video.readyState >= 2 && video.videoWidth) {
      finish();
      return;
    }

    video.addEventListener('loadedmetadata', onReady);
    video.addEventListener('canplay', onReady);
    video.addEventListener('error', onError);
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('영상 준비 시간 초과'));
    }, timeoutMs);
  });
}

export class CameraController {
  constructor(video) {
    this.video = video;
    this.stream = null;
    this.track = null;
    this.facingMode = 'environment';
    this.deviceId = null;
  }

  get isActive() {
    return Boolean(this.stream);
  }

  // Open a real camera. Throws the original DOMException so callers can map
  // error names to friendly messages.
  async start({ facingMode = this.facingMode, deviceId = this.deviceId } = {}) {
    await this.stop();
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new DOMException('getUserMedia unavailable', 'NotSupportedError');
    }
    const common = { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } };
    const video = deviceId
      ? { deviceId: { exact: deviceId }, ...common }
      : { facingMode: { ideal: facingMode }, ...common };
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: false, video });
    this.track = this.stream.getVideoTracks()[0] || null;
    this.facingMode = facingMode;
    this.deviceId = this.track?.getSettings?.().deviceId ?? deviceId ?? null;
    this.video.srcObject = this.stream;
    await waitForVideo(this.video);
    return { stream: this.stream, track: this.track };
  }

  // Drive the <video> from an externally provided stream (the demo canvas).
  async useStream(stream) {
    await this.stop();
    this.stream = stream;
    this.track = stream.getVideoTracks()[0] || null;
    this.video.srcObject = stream;
    await waitForVideo(this.video);
    return { stream, track: this.track };
  }

  // Stop and release every track so the camera light goes off immediately.
  async stop() {
    if (this.stream) {
      this.stream.getTracks().forEach((track) => {
        try { track.stop(); } catch { /* ignore */ }
      });
    }
    this.stream = null;
    this.track = null;
    if (this.video) this.video.srcObject = null;
  }

  async listVideoInputs() {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices.filter((device) => device.kind === 'videoinput');
    } catch {
      return [];
    }
  }

  // Returns { min, max, step, current } if the active track supports zoom, else
  // null. Many phones/browsers do not expose zoom — callers hide the UI then.
  getZoomCapability() {
    if (!this.track?.getCapabilities) return null;
    let caps;
    try { caps = this.track.getCapabilities(); } catch { return null; }
    if (!caps || !('zoom' in caps) || caps.zoom == null) return null;
    const settings = this.track.getSettings?.() ?? {};
    return {
      min: caps.zoom.min ?? 1,
      max: caps.zoom.max ?? 1,
      step: caps.zoom.step ?? 0.1,
      current: settings.zoom ?? caps.zoom.min ?? 1
    };
  }

  async setZoom(value) {
    if (!this.track?.applyConstraints) return false;
    try {
      await this.track.applyConstraints({ advanced: [{ zoom: value }] });
      return true;
    } catch {
      return false;
    }
  }
}
