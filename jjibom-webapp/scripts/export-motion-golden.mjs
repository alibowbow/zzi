// export-motion-golden.mjs — run the WEB vibration detector over deterministic
// synthetic sensor streams and write the per-tick results. The Android unit test
// (MotionDetectorGoldenTest) regenerates the same streams in Java and must reach
// the same verdicts, which keeps the two detectors from drifting apart.
//
// Usage: node scripts/export-motion-golden.mjs   (rewrites the golden file)
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MotionSensor } from '../src/motionSensor.js';
import { summarizeCalibration } from '../src/motionCalibration.js';
import { analyzeMotion, MotionAlarmGate } from '../src/vibrationDetector.js';
import { MotionMachine, MotionState } from '../src/motionState.js';
import { MOTION } from '../src/motionConfig.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(root, 'android/app/src/test/resources/motion-golden.txt');

export const TICK_MS = 60;
export const END_MS = 47000;
// [startMs, mode] — the stream is silent (no events) during 'dropout'.
export const TIMELINE = [
  [0, 'calm'], [9000, 'pull'], [10000, 'calm'], [19000, 'tap2'], [20000, 'calm'],
  [30000, 'wind'], [36000, 'touch'], [39000, 'calm'], [42000, 'dropout'], [44000, 'calm']
];
export const VARIANTS = [
  { hz: 60, gravityOnly: false },
  { hz: 20, gravityOnly: false },
  { hz: 60, gravityOnly: true },
  { hz: 25, gravityOnly: true }
];

// mulberry32 — integer-only, so the Java port reproduces it bit for bit.
function mulberry32(seed) {
  let a = seed | 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const bump = (t, c, w) => Math.exp(-(((t - c) / w) ** 2));

// Deterministic raw events: { t, acc: [x,y,z] | null, incl: [x,y,z], rotDeg: [a,b,g] }.
export function rawEvents({ hz, gravityOnly }) {
  const rnd = mulberry32(hz * 1000 + (gravityOnly ? 7 : 3));
  const events = [];
  let tilt = 0;
  for (let i = 0; ; i += 1) {
    const t = i * (1000 / hz);
    if (t > END_MS) break;
    let seg = TIMELINE[0];
    for (const s of TIMELINE) if (t >= s[0]) seg = s;
    const [start, mode] = seg;
    if (mode === 'dropout') continue;
    if (mode !== 'touch') tilt = 0;
    const tm = t - start;
    let ax = (rnd() - 0.5) * 0.03;
    const ay0 = (rnd() - 0.5) * 0.03;
    const az = (rnd() - 0.5) * 0.03;
    let rot = (rnd() - 0.5) * 1;
    let ay = ay0;
    if (mode === 'pull') { ax += 5 * bump(tm, 150, 60) + (tm > 200 && tm < 700 ? 0.6 : 0); rot += 25 * bump(tm, 150, 70); }
    if (mode === 'tap2') { ax += 1.6 * bump(tm, 150, 30) + 1.5 * bump(tm, 390, 30); rot += 8 * bump(tm, 150, 30); }
    if (mode === 'wind') { ax += 0.15 * Math.sin(tm * 0.0057); ay += 0.06 * Math.sin(tm * 0.0126); rot += 3 * Math.sin(tm * 0.0057); }
    if (mode === 'touch') { ax += 12 * bump(tm, 150, 40); if (tm > 150) tilt = 20; rot += 40 * bump(tm, 150, 45); }
    const tr = tilt * Math.PI / 180;
    const g = [9.81 * Math.sin(tr), 0, 9.81 * Math.cos(tr)];
    events.push({
      t,
      acc: gravityOnly ? null : [ax, ay, az],
      incl: [ax + g[0], ay + g[1], az + g[2]],
      rotDeg: [rot, rot * 0.5, rot * 0.3]
    });
  }
  return events;
}

// Mirror of MotionController._tick for a fixed tick clock; an alarm is
// dismissed (-> COOLDOWN) one second after it fires, like a user would.
export function runWebDetector(variant) {
  let clock = 0;
  const realNow = performance.now.bind(performance);
  performance.now = () => clock;
  const sensor = new MotionSensor();
  const samples = [];
  sensor.onSample = (s) => samples.push(s);
  const events = rawEvents(variant);
  let ei = 0;
  const feedUntil = (t) => {
    while (ei < events.length && events[ei].t <= t) {
      const e = events[ei++];
      clock = e.t;
      sensor._onMotion({
        acceleration: e.acc ? { x: e.acc[0], y: e.acc[1], z: e.acc[2] } : null,
        accelerationIncludingGravity: { x: e.incl[0], y: e.incl[1], z: e.incl[2] },
        rotationRate: { alpha: e.rotDeg[0], beta: e.rotDeg[1], gamma: e.rotDeg[2] },
        interval: 1000 / variant.hz
      });
    }
  };

  feedUntil(MOTION.CALIB_MS);
  const calib = summarizeCalibration(samples.filter((s) => s.t <= MOTION.CALIB_MS), { durationMs: MOTION.CALIB_MS });
  const lines = [];
  lines.push(`B ${calib.ok ? 1 : 0} ${[calib.stats.accelMedian, calib.stats.accelMad, calib.stats.gyroMedian, calib.stats.gyroMad, calib.stats.baseTilt].map((v) => v.toPrecision(10)).join(' ')}`);

  const gate = new MotionAlarmGate();
  const machine = new MotionMachine();
  machine.set(MotionState.ARMED, MOTION.CALIB_MS);
  let lastContactAt = -Infinity;
  let alarmAt = -Infinity;
  for (let now = MOTION.CALIB_MS + TICK_MS; now <= END_MS; now += TICK_MS) {
    feedUntil(now);
    let a = { score: 0, pattern: 'none', contact: false };
    let ev = null;
    if (machine.isMonitoring()) {
      const buffer = samples.filter((s) => s.t >= now - MOTION.BUFFER_MS && s.t <= now);
      const latestT = buffer.length ? buffer[buffer.length - 1].t : MOTION.CALIB_MS;
      a = analyzeMotion(buffer, calib.stats, { now, sensitivity: 5, detectMode: 'all' });
      if (a.contact) lastContactAt = now;
      ev = gate.update(a.score, a.pattern, a.contact, now, machine.isListening());
      machine.update({
        score: a.score, contact: a.contact, alarmEmitted: Boolean(ev), hidden: false,
        sensorStalled: now - latestT > MOTION.SENSOR_STALL_MS, stableMs: now - lastContactAt,
        cooldownActive: gate.isMuted(now)
      }, now);
      if (ev) { gate.muteForSelfVibration(now); machine.set(MotionState.ALARM, now); alarmAt = now; }
    }
    if (machine.state === MotionState.ALARM && now - alarmAt >= 1000) machine.dismissAlarm(now);
    lines.push(`T ${now} ${a.score} ${a.pattern} ${a.contact ? 1 : 0} ${ev ? 1 : 0} ${machine.state}`);
  }
  performance.now = realNow;
  return lines;
}

if (process.argv[1] && process.argv[1].endsWith('export-motion-golden.mjs')) {
  const out = ['# generated by scripts/export-motion-golden.mjs — do not edit'];
  for (const v of VARIANTS) {
    out.push(`V ${v.hz} ${v.gravityOnly ? 1 : 0}`);
    out.push(...runWebDetector(v));
  }
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${out.join('\n')}\n`);
  const alarms = out.filter((l) => l.startsWith('T ') && l.split(' ')[5] === '1').length;
  console.log(`wrote ${out.length} lines (${alarms} alarms) -> ${OUT}`);
}
