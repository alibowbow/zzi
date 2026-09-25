package app.jjibom.motion;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * The vibration detector, ported line by line from the web modules
 * (motionFilter.js, motionCalibration.js, vibrationDetector.js, motionState.js).
 * No Android imports, so it runs (and is checked against the JS results) on a
 * plain JVM. StrictMath matches the fdlibm results of the JS engine.
 */
final class MotionDetector {
    private MotionDetector() {}

    // ---------------------------------------------------------------- data

    static final class Sample {
        final double t;      // ms
        final double amag;   // smoothed linear-accel magnitude, m/s²
        final double araw;   // unsmoothed linear-accel magnitude, m/s²
        final double jerk;   // |Δamag| per second
        final double gmag;   // gyro magnitude, deg/s
        final double tilt;   // device tilt from the gravity estimate, degrees

        Sample(double t, double amag, double araw, double jerk, double gmag, double tilt) {
            this.t = t;
            this.amag = amag;
            this.araw = araw;
            this.jerk = jerk;
            this.gmag = gmag;
            this.tilt = tilt;
        }
    }

    static final class Baseline {
        double accelMedian;
        double accelMad;
        double jerkMedian;
        double jerkMad;
        double gyroMedian;
        double gyroMad;
        double baseTilt;
        double vibrationRms;
        double maxAmp;
        double sampleHz;
        double dropRatio;
        int count;
    }

    static final class CalibrationResult {
        final boolean ok;
        final String reason;
        final Baseline stats;

        CalibrationResult(boolean ok, String reason, Baseline stats) {
            this.ok = ok;
            this.reason = reason;
            this.stats = stats;
        }
    }

    static final class Analysis {
        int score;
        String pattern = "none";
        boolean contact;
        String reason = "";
        double peakMad;
        double rawPeak;
        double maxExcessShort;
        int tapCount;
        int longBursts;
        double windiness;
    }

    // ------------------------------------------------------------- helpers

    static double clamp(double v, double lo, double hi) {
        return v < lo ? lo : (v > hi ? hi : v);
    }

    static double alphaForDt(double dtMs, double tauMs) {
        return 1 - StrictMath.exp(-Math.max(0, dtMs) / Math.max(1e-6, tauMs));
    }

    static double magnitude3(double x, double y, double z) {
        return Math.sqrt(x * x + y * y + z * z);
    }

    static double tiltFromGravity(double gx, double gy, double gz) {
        return StrictMath.atan2(Math.sqrt(gx * gx + gy * gy), Math.abs(gz)) * 180 / Math.PI;
    }

    static double median(double[] values) {
        if (values.length == 0) return 0;
        double[] sorted = values.clone();
        Arrays.sort(sorted);
        int mid = sorted.length / 2;
        return sorted.length % 2 == 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    }

    static double mad(double[] values, double center) {
        if (values.length == 0) return 0;
        double[] dev = new double[values.length];
        for (int i = 0; i < values.length; i++) dev[i] = Math.abs(values[i] - center);
        return median(dev) * 1.4826;
    }

    static double rms(double[] values) {
        if (values.length == 0) return 0;
        double sum = 0;
        for (double v : values) sum += v * v;
        return Math.sqrt(sum / values.length);
    }

    static double sensitivityToMad(double sensitivity, double minMult, double maxMult) {
        double t = clamp((sensitivity - 1) / 9.0, 0, 1);
        return maxMult + (minMult - maxMult) * t;
    }

    /** Rising edges (below -> above threshold) with a refractory gap; returns their times. */
    static double[] risingEdges(double[] t, double[] v, double threshold, double refractoryMs) {
        double[] times = new double[v.length];
        int count = 0;
        double last = Double.NEGATIVE_INFINITY;
        boolean prevAbove = v.length > 0 && v[0] >= threshold;
        for (int i = 1; i < v.length; i++) {
            boolean above = v[i] >= threshold;
            if (above && !prevAbove && t[i] - last >= refractoryMs) {
                times[count++] = t[i];
                last = t[i];
            }
            prevAbove = above;
        }
        return Arrays.copyOf(times, count);
    }

    static int countReversals(double[] values, double band) {
        int reversals = 0;
        double lastDir = 0;
        for (double v : values) {
            if (Math.abs(v) < band) continue;
            double dir = Math.signum(v);
            if (lastDir != 0 && dir != lastDir) reversals++;
            lastDir = dir;
        }
        return reversals;
    }

    // ------------------------------------------------------------ front end

    /**
     * Turns raw Android sensor readings into samples, the way motionSensor.js
     * does for DeviceMotionEvent: gravity is low-passed out of the
     * accelerometer (time-based, so any sensor rate behaves the same), the
     * linear magnitude is lightly smoothed, tilt comes from the gravity estimate.
     */
    static final class FrontEnd {
        private double gx = Double.NaN;
        private double gy;
        private double gz;
        private double lastAccelT = Double.NaN;
        private double ema = Double.NaN;
        private double prevAmag = Double.NaN;
        private double prevT = Double.NaN;
        private double gyroDeg;

        void reset() {
            gx = Double.NaN;
            lastAccelT = Double.NaN;
            ema = Double.NaN;
            prevAmag = Double.NaN;
            prevT = Double.NaN;
            gyroDeg = 0;
        }

        /** Gyroscope reading in rad/s (Android) — stored as deg/s like the web. */
        void onGyro(double x, double y, double z) {
            gyroDeg = magnitude3(x, y, z) * 180 / Math.PI;
        }

        /**
         * Accelerometer (gravity included). Returns a sample only when
         * {@code emitSample} (no linear-acceleration sensor on this device).
         */
        Sample onAccel(double t, double x, double y, double z, boolean emitSample) {
            double dt = Double.isNaN(lastAccelT) ? 1000 / MotionConst.TARGET_HZ : clamp(t - lastAccelT, 2, 250);
            lastAccelT = t;
            if (Double.isNaN(gx)) {
                gx = x;
                gy = y;
                gz = z;
            } else {
                double a = alphaForDt(dt, MotionConst.GRAVITY_TAU_MS);
                gx += (x - gx) * a;
                gy += (y - gy) * a;
                gz += (z - gz) * a;
            }
            if (!emitSample) return null;
            return makeSample(t, x - gx, y - gy, z - gz);
        }

        /** Linear acceleration (gravity already removed by the OS). */
        Sample onLinear(double t, double x, double y, double z) {
            return makeSample(t, x, y, z);
        }

        private Sample makeSample(double t, double lx, double ly, double lz) {
            double dtMs = Double.isNaN(prevT) ? 1000 / MotionConst.TARGET_HZ : clamp(t - prevT, 2, 250);
            double araw = magnitude3(lx, ly, lz);
            ema = Double.isNaN(ema) ? araw : ema + (araw - ema) * alphaForDt(dtMs, MotionConst.ACCEL_EMA_TAU_MS);
            double amag = ema;
            double jerk = 0;
            if (!Double.isNaN(prevAmag) && !Double.isNaN(prevT)) {
                jerk = Math.abs(amag - prevAmag) / Math.max(0.001, (t - prevT) / 1000);
            }
            prevAmag = amag;
            prevT = t;
            double tilt = Double.isNaN(gx) ? 0 : tiltFromGravity(gx, gy, gz);
            return new Sample(t, amag, araw, jerk, gyroDeg, tilt);
        }
    }

    // ---------------------------------------------------------- calibration

    static CalibrationResult summarizeCalibration(List<Sample> samples, double durationMs) {
        int count = samples.size();
        double[] amags = new double[count];
        double[] jerks = new double[count];
        double[] gmags = new double[count];
        double[] tilts = new double[count];
        double[] times = new double[count];
        for (int i = 0; i < count; i++) {
            Sample s = samples.get(i);
            amags[i] = s.amag;
            jerks[i] = s.jerk;
            gmags[i] = s.gmag;
            tilts[i] = s.tilt;
            times[i] = s.t;
        }
        Baseline b = new Baseline();
        b.accelMedian = median(amags);
        b.accelMad = Math.max(MotionConst.CALIB_MIN_ACCEL_MAD, mad(amags, b.accelMedian));
        b.jerkMedian = median(jerks);
        b.jerkMad = mad(jerks, b.jerkMedian);
        b.gyroMedian = median(gmags);
        b.gyroMad = mad(gmags, b.gyroMedian);
        b.baseTilt = median(tilts);
        double[] excess = new double[count];
        double maxAmp = 0;
        for (int i = 0; i < count; i++) {
            excess[i] = Math.max(0, amags[i] - b.accelMedian);
            maxAmp = Math.max(maxAmp, excess[i]);
        }
        b.vibrationRms = rms(excess);
        b.maxAmp = maxAmp;

        Arrays.sort(times);
        double[] intervals = new double[Math.max(0, count - 1)];
        for (int i = 1; i < count; i++) intervals[i - 1] = times[i] - times[i - 1];
        double medianInterval = intervals.length > 0 ? median(intervals) : 0;
        double gapLimit = Math.max(3 * medianInterval, MotionConst.CALIB_GAP_MS);
        double gapTime = 0;
        for (double iv : intervals) if (iv > gapLimit) gapTime += iv - medianInterval;
        double spanMs = count > 1 ? times[count - 1] - times[0] : 0;
        double observedMs = Math.max(spanMs, 1);
        b.sampleHz = medianInterval > 0 ? 1000 / medianInterval : 0;
        double tailMissing = Math.max(0, durationMs - spanMs - 2 * medianInterval);
        b.dropRatio = Math.min(1, (gapTime + tailMissing) / Math.max(durationMs, observedMs));
        b.count = count;

        if (count < MotionConst.CALIB_MIN_SAMPLES) {
            return new CalibrationResult(false, "센서 데이터를 받을 수 없어요.", b);
        }
        if (b.sampleHz < MotionConst.CALIB_MIN_HZ) {
            return new CalibrationResult(false, "센서 신호가 너무 느려요. 다른 앱을 닫고 다시 시도해 주세요.", b);
        }
        if (b.dropRatio > MotionConst.CALIB_MAX_DROP_RATIO) {
            return new CalibrationResult(false, "센서 데이터가 자주 끊겨요. 다시 시도해 주세요.", b);
        }
        if (b.maxAmp > MotionConst.CONTACT_ACCEL * 0.7) {
            return new CalibrationResult(false, "낚싯대를 건드리지 말고 다시 보정해 주세요.", b);
        }
        if (b.accelMad > MotionConst.CALIB_MAX_MOVING_MAD) {
            return new CalibrationResult(false, "스마트폰이 계속 움직이고 있어요. 거치대를 더 단단히 고정해 주세요.", b);
        }
        return new CalibrationResult(true, null, b);
    }

    // ------------------------------------------------------------- analysis

    static Analysis analyze(List<Sample> samples, Baseline baseline, double now, double sensitivityIn, String detectMode) {
        Analysis out = new Analysis();
        double sensitivity = clamp(sensitivityIn, 1, 10);
        double shortMs = MotionConst.SHORT_WINDOW_MS;
        double longMs = MotionConst.LONG_WINDOW_MS;

        double accelMad = Math.max(baseline.accelMad, MotionConst.CALIB_MIN_ACCEL_MAD);
        double accelMedian = baseline.accelMedian;
        double gyroMad = Math.max(baseline.gyroMad, 1e-3);
        double gyroMedian = baseline.gyroMedian;
        double baseTilt = baseline.baseTilt;

        double threshMad = sensitivityToMad(sensitivity, MotionConst.SENS_MULT_MIN, MotionConst.SENS_MULT_MAX);
        double peakThr = Math.max(MotionConst.MIN_ABS_ACCEL, threshMad * accelMad);

        List<Sample> longS = new ArrayList<>();
        for (Sample s : samples) if (s.t >= now - longMs && s.t <= now) longS.add(s);
        List<Sample> shortS = new ArrayList<>();
        for (Sample s : longS) if (s.t >= now - shortMs) shortS.add(s);
        if (shortS.size() < 4) {
            out.reason = "insufficient";
            return out;
        }
        double longSpan = longS.size() > 1 ? longS.get(longS.size() - 1).t - longS.get(0).t : 0;
        if (longSpan < longMs * 0.95) {
            out.reason = "warming";
            return out;
        }

        int nS = shortS.size();
        int nL = longS.size();
        double[] shortT = new double[nS];
        double[] shortExcess = new double[nS];
        double maxExcessShort = 0;
        double rawPeak = 0;
        double tiltChange = 0;
        for (int i = 0; i < nS; i++) {
            Sample s = shortS.get(i);
            shortT[i] = s.t;
            shortExcess[i] = Math.max(0, s.amag - accelMedian);
            maxExcessShort = Math.max(maxExcessShort, shortExcess[i]);
            rawPeak = Math.max(rawPeak, Double.isNaN(s.araw) ? s.amag : s.araw);
            tiltChange = Math.max(tiltChange, Math.abs(s.tilt - baseTilt));
        }
        double[] longT = new double[nL];
        double[] longExcess = new double[nL];
        double gyroPeakExcess = 0;
        int aboveCount = 0;
        for (int i = 0; i < nL; i++) {
            Sample s = longS.get(i);
            longT[i] = s.t;
            longExcess[i] = Math.max(0, s.amag - accelMedian);
            gyroPeakExcess = Math.max(gyroPeakExcess, s.gmag - gyroMedian);
            if (longExcess[i] >= peakThr) aboveCount++;
        }
        double[] shortEdges = risingEdges(shortT, shortExcess, peakThr, MotionConst.PEAK_REFRACTORY_MS);
        double[] longEdges = risingEdges(longT, longExcess, peakThr, MotionConst.PEAK_REFRACTORY_MS);
        double absPeak = maxExcessShort + accelMedian;

        double[] slopes = new double[Math.max(0, nL - 1)];
        for (int i = 1; i < nL; i++) slopes[i - 1] = longS.get(i).amag - longS.get(i - 1).amag;
        int reversals = countReversals(slopes, 2 * accelMad);

        double gyroPeakMad = gyroPeakExcess / gyroMad;
        double dt = nL > 1 ? longSpan / (nL - 1) : 25;
        double durationMs = aboveCount * dt;

        boolean contact = Math.max(absPeak, rawPeak) > MotionConst.CONTACT_ACCEL
                || tiltChange > MotionConst.CONTACT_TILT_DEG;

        double shortRmsE = rms(shortExcess);
        double longRmsE = rms(longExcess);
        double transientRatio = shortRmsE / (longRmsE + 1e-3);
        double peakMad = maxExcessShort / accelMad;
        double ampFactor = clamp(maxExcessShort / peakThr, 0, 1.5);

        // A. Strong pull: a big peak that leaves a lasting change.
        double strongThr = Math.max(peakThr, MotionConst.STRONG_PULL_MAD * accelMad);
        double strongMag = clamp(maxExcessShort / strongThr, 0, 1.3);
        double gyroBoost = clamp(gyroPeakMad / MotionConst.STRONG_PULL_GYRO_MAD, 0, 1);
        double sustain = clamp(durationMs / 400, 0, 1);
        boolean sustained = maxExcessShort >= peakThr && durationMs >= 150;
        double strongScore = sustained
                ? clamp(0.5 * strongMag + 0.2 * gyroBoost + 0.3 * sustain, 0, 1)
                : clamp(0.3 * strongMag, 0, 0.5);

        // B. Tap (토독): ≥2 bursts close together, the latest still fresh.
        int tapCount = 0;
        int firstTap = 0;
        while (firstTap < longEdges.length && longEdges[firstTap] < now - MotionConst.TAP_WINDOW_MS) firstTap++;
        int lastTap = longEdges.length - 1;
        if (lastTap >= firstTap && now - longEdges[lastTap] <= shortMs) {
            tapCount = 1;
            for (int i = lastTap; i > firstTap; i--) {
                if (longEdges[i] - longEdges[i - 1] > MotionConst.TAP_MAX_GAP_MS) break;
                tapCount++;
            }
        }
        double tapScore = tapCount >= MotionConst.TAP_MIN_PEAKS
                ? clamp(((double) tapCount / MotionConst.TAP_MIN_PEAKS) * 0.6 + ampFactor * 0.4, 0, 1)
                : 0;

        // C. Repeated vibration: several bursts over 1–2 s.
        double repeatedScore = longEdges.length >= MotionConst.REPEATED_MIN_PEAKS
                ? clamp(0.5 * ((double) longEdges.length / (MotionConst.REPEATED_MIN_PEAKS + 1))
                        + 0.3 * (reversals / 5.0) + 0.2 * ampFactor, 0, 1)
                : 0;

        // E. Wind / steady jitter suppression.
        double oscillation = clamp(reversals / 6.0, 0, 1);
        double steady = clamp(1 - Math.max(0, transientRatio - 1), 0, 1);
        double modest = clamp(1 - (peakMad - threshMad) / (5 * threshMad), 0, 1);
        double windiness = clamp(oscillation * steady * modest, 0, 1);

        double base;
        if ("strong".equals(detectMode)) base = Math.max(strongScore, Math.max(0.5 * tapScore, 0.4 * repeatedScore));
        else if ("tap".equals(detectMode)) base = Math.max(tapScore, Math.max(0.5 * strongScore, 0.4 * repeatedScore));
        else if ("repeated".equals(detectMode)) base = Math.max(repeatedScore, Math.max(0.5 * strongScore, 0.4 * tapScore));
        else base = Math.max(strongScore, Math.max(tapScore, repeatedScore));
        base = clamp(base * (1 - 0.85 * windiness), 0, 1);

        String pattern;
        if (contact) pattern = "contact";
        else if (longEdges.length >= MotionConst.REPEATED_MIN_PEAKS) pattern = "repeated";
        else if (tapCount >= MotionConst.TAP_MIN_PEAKS) pattern = "tap";
        else if (base > 0.2) pattern = "strong_pull";
        else pattern = "none";

        out.score = contact ? (int) Math.round(clamp(base, 0, 0.4) * 100) : (int) Math.round(base * 100);
        out.pattern = pattern;
        out.contact = contact;
        out.peakMad = peakMad;
        out.rawPeak = rawPeak;
        out.maxExcessShort = maxExcessShort;
        out.tapCount = tapCount;
        out.longBursts = longEdges.length;
        out.windiness = windiness;
        return out;
    }

    // ----------------------------------------------------------- alarm gate

    /** Turns per-tick scores into discrete alarms: confirm, cooldown, self-vibration mute, contact veto. */
    static final class AlarmGate {
        private double confirmSince;
        private double cooldownUntil;
        private double muteUntil;

        void reset() {
            confirmSince = 0;
            cooldownUntil = 0;
            muteUntil = 0;
        }

        void muteForSelfVibration(double now, double ms) {
            muteUntil = Math.max(muteUntil, now + ms);
            confirmSince = 0;
        }

        boolean isMuted(double now) {
            return now < muteUntil || now < cooldownUntil;
        }

        /** Returns true when an alarm fires on this tick. */
        boolean update(int score, boolean contact, double now) {
            if (contact || isMuted(now)) {
                confirmSince = 0;
                return false;
            }
            if (score >= MotionConst.TRIGGER_SCORE) {
                if (confirmSince == 0) confirmSince = now;
                if (now - confirmSince >= MotionConst.CONFIRM_MS) {
                    confirmSince = 0;
                    cooldownUntil = now + MotionConst.COOLDOWN_MS;
                    return true;
                }
            } else {
                confirmSince = 0;
            }
            return false;
        }
    }

    // -------------------------------------------------------- state machine

    /** Same state ids as motionState.js so the web UI can show them directly. */
    enum State {
        IDLE("idle"), CALIBRATING("calibrating"), ARMED("armed"), POSSIBLE_BITE("possible_bite"),
        ALARM("alarm"), COOLDOWN("cooldown"), STABILIZING("stabilizing"), PAUSED("paused"), ERROR("error");

        final String id;

        State(String id) {
            this.id = id;
        }
    }

    static final class Signals {
        int score;
        boolean contact;
        boolean alarmEmitted;
        boolean hidden;
        boolean sensorStalled;
        double stableMs;
        boolean cooldownActive;
    }

    static State decide(State state, Signals s) {
        switch (state) {
            case ARMED:
                if (s.sensorStalled) return State.ERROR;
                if (s.hidden) return State.PAUSED;
                if (s.alarmEmitted) return State.ALARM;
                if (s.contact) return State.STABILIZING;
                if (s.score >= MotionConst.POSSIBLE_SCORE) return State.POSSIBLE_BITE;
                return State.ARMED;
            case POSSIBLE_BITE:
                if (s.sensorStalled) return State.ERROR;
                if (s.hidden) return State.PAUSED;
                if (s.alarmEmitted) return State.ALARM;
                if (s.contact) return State.STABILIZING;
                if (s.score < MotionConst.WOBBLE_SCORE) return State.ARMED;
                return State.POSSIBLE_BITE;
            case COOLDOWN:
                if (s.hidden) return State.PAUSED;
                if (s.contact) return State.STABILIZING;
                if (!s.cooldownActive) return State.ARMED;
                return State.COOLDOWN;
            case STABILIZING:
                if (s.sensorStalled) return State.ERROR;
                if (s.hidden) return State.PAUSED;
                if (!s.contact && s.stableMs >= MotionConst.STABILIZE_MS) return State.ARMED;
                return State.STABILIZING;
            case PAUSED:
                if (!s.hidden) return State.ARMED;
                return State.PAUSED;
            case ERROR:
                if (!s.sensorStalled) return State.ARMED;
                return State.ERROR;
            default:
                return state;
        }
    }

    static boolean isUpdatable(State s) {
        return s == State.ARMED || s == State.POSSIBLE_BITE || s == State.COOLDOWN
                || s == State.STABILIZING || s == State.PAUSED || s == State.ERROR;
    }
}
