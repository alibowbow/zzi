import type { CapacitorConfig } from '@capacitor/cli';

// Capacitor configuration for the installable Android app.
// webDir is a copy of the static web assets (see `npm run build:web`).
const config: CapacitorConfig = {
  appId: 'app.jjibom.motion',
  appName: '찌봄',
  webDir: 'www',
  android: {
    // Use the system WebView; no special flags needed for the sensor service.
    allowMixedContent: false
  },
  server: {
    androidScheme: 'https'
  }
};

export default config;
