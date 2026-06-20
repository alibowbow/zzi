// diagnostics.js — in-memory rolling buffer of tracking samples plus local
// (never networked) export of an event with its surrounding context. Used by
// the diagnostic panel and the "맞음/오탐/놓침" labeling.

import { DIAG, APP_VERSION } from './config.js';

export class Diagnostics {
  constructor(windowMs = DIAG.SAMPLE_MS) {
    this.windowMs = windowMs;
    this.samples = [];
  }

  // sample: { t, x, y, correctedDy, confidence, found, areaRatio, heightRatio }
  push(sample) {
    this.samples.push(sample);
    const cutoff = sample.t - this.windowMs;
    // Trim from the front; samples are pushed in time order.
    let drop = 0;
    while (drop < this.samples.length && this.samples[drop].t < cutoff) drop += 1;
    if (drop) this.samples.splice(0, drop);
  }

  recentWindow(ms, now) {
    const cutoff = now - ms;
    return this.samples.filter((s) => s.t >= cutoff);
  }

  clear() {
    this.samples = [];
  }

  // Build an exportable, privacy-safe event record (coordinates + features only,
  // no imagery). `padMs` of context is kept on each side of the event time.
  exportEvent(event, calibration, meta = {}) {
    const padMs = DIAG.EXPORT_PAD_MS;
    const from = event.at - padMs;
    const to = event.at + padMs;
    const slice = this.samples.filter((s) => s.t >= from && s.t <= to);
    const t0 = slice.length ? slice[0].t : event.at;
    return {
      appVersion: APP_VERSION,
      timestamp: new Date(event.timestamp ?? Date.now()).toISOString(),
      deviceInfo: meta.deviceInfo ?? '',
      analysisFps: meta.analysisFps ?? 0,
      calibration: {
        floatHeight: round(calibration.floatHeight, 2),
        floatArea: round(calibration.floatArea, 1),
        waveMad: round(calibration.waveMad, 4)
      },
      event: {
        predictedType: event.type ?? 'none',
        biteScore: round(event.score ?? 0, 3),
        userLabel: event.userLabel ?? null
      },
      samples: slice.map((s) => ({
        t: round((s.t - t0) / 1000, 3),
        x: round(s.x, 4),
        y: round(s.y, 4),
        correctedDy: round(s.correctedDy, 4),
        confidence: round(s.confidence, 3)
      }))
    };
  }
}

function round(value, places) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}
