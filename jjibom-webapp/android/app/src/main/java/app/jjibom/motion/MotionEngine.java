package app.jjibom.motion;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;

import app.jjibom.motion.MotionDetector.AlarmGate;
import app.jjibom.motion.MotionDetector.Analysis;
import app.jjibom.motion.MotionDetector.Baseline;
import app.jjibom.motion.MotionDetector.CalibrationResult;
import app.jjibom.motion.MotionDetector.FrontEnd;
import app.jjibom.motion.MotionDetector.Sample;
import app.jjibom.motion.MotionDetector.Signals;
import app.jjibom.motion.MotionDetector.State;

/**
 * Sensor readings in, per-tick verdicts out: calibration, analysis, alarm gate
 * and state machine, exactly as MotionController._tick does on the web. Pure
 * Java and single-threaded (the service drives it from one HandlerThread), so
 * the golden-file unit test exercises the very code the service runs.
 */
final class MotionEngine {

    static final class Tick {
        State state;
        boolean stateChanged;
        int score;
        String pattern = "none";
        boolean contact;
        boolean alarm;
        double magnitude;
        double calibrationProgress;
        CalibrationResult calibration; // set on the tick that finished calibrating
    }

    private final FrontEnd frontEnd = new FrontEnd();
    private final ArrayDeque<Sample> buffer = new ArrayDeque<>();
    private final List<Sample> calibSamples = new ArrayList<>();
    private final AlarmGate gate = new AlarmGate();

    private boolean hasLinear;
    private double sensitivity = 5;
    private String detectMode = "all";

    private State state = State.IDLE;
    private double calibStart;
    private double monitorStart;
    private double lastSampleT = Double.NEGATIVE_INFINITY;
    private double lastContactAt = Double.NEGATIVE_INFINITY;
    private Baseline baseline;
    private boolean hidden;

    void setHasLinearSensor(boolean hasLinear) {
        this.hasLinear = hasLinear;
    }

    void setSettings(double sensitivity, String detectMode) {
        this.sensitivity = sensitivity;
        this.detectMode = detectMode == null ? "all" : detectMode;
    }

    State state() {
        return state;
    }

    Baseline baseline() {
        return baseline;
    }

    double lastSampleT() {
        return lastSampleT;
    }

    // ---------------------------------------------------------- sensor input

    void onAccel(double t, double x, double y, double z) {
        push(frontEnd.onAccel(t, x, y, z, !hasLinear));
    }

    void onLinear(double t, double x, double y, double z) {
        if (hasLinear) push(frontEnd.onLinear(t, x, y, z));
    }

    void onGyro(double x, double y, double z) {
        frontEnd.onGyro(x, y, z);
    }

    private void push(Sample s) {
        if (s == null) return;
        lastSampleT = s.t;
        buffer.addLast(s);
        double cutoff = s.t - MotionConst.BUFFER_MS;
        while (!buffer.isEmpty() && buffer.peekFirst().t < cutoff) buffer.removeFirst();
        if (state == State.CALIBRATING) calibSamples.add(s);
    }

    // --------------------------------------------------------------- control

    void startCalibration(double now) {
        frontEnd.reset();
        buffer.clear();
        calibSamples.clear();
        baseline = null;
        calibStart = now;
        lastSampleT = Double.NEGATIVE_INFINITY;
        state = State.CALIBRATING;
    }

    /** Re-arm with the existing baseline (after a pause, or when settings change). */
    void arm(double now) {
        if (baseline == null) return;
        gate.reset();
        monitorStart = now;
        lastContactAt = Double.NEGATIVE_INFINITY;
        hidden = false;
        state = State.ARMED;
    }

    void pause(double now) {
        if (state != State.IDLE && state != State.CALIBRATING) state = State.PAUSED;
        hidden = true;
    }

    void resume(double now) {
        hidden = false;
        if (state == State.PAUSED) {
            monitorStart = now;
            state = State.ARMED;
        }
    }

    void dismissAlarm(double now) {
        if (state == State.ALARM) state = State.COOLDOWN;
    }

    /** Mute detection while our own alarm buzzes, so it is not re-detected. */
    void muteForSelfVibration(double now, double ms) {
        gate.muteForSelfVibration(now, ms);
    }

    /** The alarm was stopped early: keep only a short trailing mute. */
    void endSelfVibration(double now, double trailingMs) {
        gate.endSelfVibration(now, trailingMs);
    }

    void stop() {
        state = State.IDLE;
        buffer.clear();
        calibSamples.clear();
    }

    // ------------------------------------------------------------------ tick

    Tick tick(double now) {
        Tick out = new Tick();
        State before = state;

        if (state == State.CALIBRATING) {
            out.calibrationProgress = Math.min(1, (now - calibStart) / MotionConst.CALIB_MS);
            if (now - calibStart >= MotionConst.CALIB_MS) {
                CalibrationResult result = MotionDetector.summarizeCalibration(calibSamples, MotionConst.CALIB_MS);
                out.calibration = result;
                calibSamples.clear();
                if (result.ok) {
                    baseline = result.stats;
                    arm(now);
                } else {
                    state = State.IDLE;
                }
            }
            out.state = state;
            out.stateChanged = state != before;
            return out;
        }
        if (!MotionDetector.isUpdatable(state) || baseline == null) {
            out.state = state;
            return out;
        }

        List<Sample> window = new ArrayList<>(buffer.size());
        Iterator<Sample> it = buffer.iterator();
        while (it.hasNext()) {
            Sample s = it.next();
            if (s.t >= now - MotionConst.BUFFER_MS && s.t <= now) window.add(s);
        }
        double latestT = window.isEmpty() ? monitorStart : Math.max(window.get(window.size() - 1).t, monitorStart);
        boolean stalled = now - latestT > MotionConst.SENSOR_STALL_MS;

        Analysis a = MotionDetector.analyze(window, baseline, now, sensitivity, detectMode);
        if (a.contact) lastContactAt = now;
        boolean listening = state == State.ARMED || state == State.POSSIBLE_BITE;
        boolean fired = gate.update(a.score, a.contact || !listening, now);

        Signals sig = new Signals();
        sig.score = a.score;
        sig.contact = a.contact;
        sig.alarmEmitted = fired;
        sig.hidden = hidden;
        sig.sensorStalled = stalled;
        sig.stableMs = now - lastContactAt;
        sig.cooldownActive = gate.isMuted(now);
        state = MotionDetector.decide(state, sig);

        if (fired) {
            gate.muteForSelfVibration(now, MotionConst.SELF_VIBE_GUARD_MS);
            state = State.ALARM;
        }

        out.state = state;
        out.stateChanged = state != before;
        out.score = a.score;
        out.pattern = a.pattern;
        out.contact = a.contact;
        out.alarm = fired;
        out.magnitude = window.isEmpty() ? 0 : window.get(window.size() - 1).amag;
        return out;
    }
}
