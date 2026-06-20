// nativeBridge.js — thin wrapper over the optional Capacitor "JjibomMotion"
// plugin. Its ONLY job is to tell the app whether a real native background
// service is available and to proxy calls/events to it.
//
// In a plain browser / PWA the plugin is absent: isNativeAvailable() returns
// false and the app uses the in-page web detector (which honestly cannot run in
// the background). We never pretend native background exists when it does not.

function plugin() {
  const cap = globalThis.Capacitor;
  return cap?.isNativePlatform?.() ? cap.Plugins?.JjibomMotion : null;
}

export function isNativeAvailable() {
  return Boolean(plugin());
}

export function platform() {
  return globalThis.Capacitor?.getPlatform?.() ?? 'web';
}

// All methods are no-ops / defaults when native is absent; callers should branch
// on isNativeAvailable() first.
export const nativeMotion = {
  async isSupported() { return plugin() ? (await plugin().isSupported()).value : false; },
  async getAvailableSensors() { return plugin() ? plugin().getAvailableSensors() : { accelerometer: false, gyroscope: false, linearAcceleration: false }; },
  async requestPermissions() { return plugin() ? plugin().requestPermissions() : { granted: false }; },
  async startMonitoring(settings) { return plugin()?.startMonitoring(settings); },
  async pauseMonitoring() { return plugin()?.pauseMonitoring(); },
  async resumeMonitoring() { return plugin()?.resumeMonitoring(); },
  async stopMonitoring() { return plugin()?.stopMonitoring(); },
  async getMonitoringState() { return plugin() ? plugin().getMonitoringState() : { state: 'idle', running: false }; },
  async updateSettings(settings) { return plugin()?.updateSettings(settings); },
  async getLatestMetrics() { return plugin() ? plugin().getLatestMetrics() : null; },
  addListener(eventName, cb) {
    const p = plugin();
    return p ? p.addListener(eventName, cb) : { remove() {} };
  }
};
