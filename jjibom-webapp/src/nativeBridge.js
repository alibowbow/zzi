// nativeBridge.js — thin wrapper over the Capacitor "JjibomMotion" plugin that
// ships inside the Android app (android/app/src/main/java/app/jjibom/motion).
// It tells the app whether a real native background service exists and
// proxies calls/events to it.
//
// In a plain browser / PWA the plugin is absent: isNativeAvailable() returns
// false and the app uses the in-page web detector (which honestly cannot run in
// the background). We never pretend native background exists when it does not.

let cachedPlugin = null;

function capacitor() {
  return globalThis.Capacitor;
}

function plugin() {
  const cap = capacitor();
  if (!cap?.isNativePlatform?.() || cap.getPlatform?.() !== 'android') return null;
  if (!cachedPlugin) {
    cachedPlugin = typeof cap.registerPlugin === 'function'
      ? cap.registerPlugin('JjibomMotion')
      : cap.Plugins?.JjibomMotion ?? null;
  }
  return cachedPlugin;
}

// True inside the installed app (Android WebView), whatever the plugin state.
export function isNativeApp() {
  return Boolean(capacitor()?.isNativePlatform?.());
}

export function isNativeAvailable() {
  return Boolean(plugin());
}

export function platform() {
  return capacitor()?.getPlatform?.() ?? 'web';
}

function call(method, arg) {
  const p = plugin();
  if (!p) return Promise.reject(new Error('native plugin unavailable'));
  return p[method](arg);
}

// Settings the native service understands (the rest of the web settings stay web-only).
export function nativeSettings(s) {
  return {
    sensitivity: Number(s.sensitivity) || 5,
    detectMode: s.detectMode || 'all',
    sound: s.sound !== false,
    vibration: s.vibration !== false,
    alarmTone: s.alarmTone || 'rise',
    alarmSeconds: Number(s.alarmSeconds) || 8
  };
}

export const nativeMotion = {
  getInfo: () => call('getInfo'),
  requestNotificationPermission: () => call('requestNotificationPermission'),
  startMonitoring: (settings) => call('startMonitoring', nativeSettings(settings)),
  stopMonitoring: () => call('stopMonitoring'),
  pauseMonitoring: () => call('pauseMonitoring'),
  resumeMonitoring: () => call('resumeMonitoring'),
  updateSettings: (settings) => call('updateSettings', nativeSettings(settings)),
  acknowledgeAlarm: () => call('acknowledgeAlarm'),
  testAlarm: (settings) => call('testAlarm', nativeSettings(settings)),
  getMonitoringState: () => call('getMonitoringState'),
  getEvents: () => call('getEvents'),
  clearEvents: () => call('clearEvents'),
  openNotificationSettings: () => call('openNotificationSettings'),
  openBatterySettings: () => call('openBatterySettings'),
  openAppSettings: () => call('openAppSettings'),
  // Capacitor returns a Promise<handle>; hide that so callers can remove() at once.
  addListener(eventName, cb) {
    const p = plugin();
    if (!p) return { remove() {} };
    const pending = Promise.resolve(p.addListener(eventName, cb));
    return { remove: () => pending.then((h) => h?.remove?.()).catch(() => {}) };
  }
};
