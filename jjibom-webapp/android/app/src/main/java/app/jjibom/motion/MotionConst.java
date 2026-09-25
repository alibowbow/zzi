package app.jjibom.motion;

/**
 * Every tunable number of the vibration detector. Mirrors src/motionConfig.js
 * (same names, same meaning) so the web and the native detector agree.
 */
final class MotionConst {
    private MotionConst() {}

    static final double TARGET_HZ = 40;
    static final int SAMPLING_PERIOD_US = 20_000;     // ask Android for ~50 Hz
    static final double SHORT_WINDOW_MS = 320;
    static final double LONG_WINDOW_MS = 1500;
    static final double BUFFER_MS = 4000;

    static final double GRAVITY_TAU_MS = 200;
    static final double ACCEL_EMA_TAU_MS = 35;

    static final long CALIB_MS = 6000;
    static final int CALIB_MIN_SAMPLES = 70;
    static final double CALIB_MAX_DROP_RATIO = 0.4;
    static final double CALIB_MIN_HZ = 15;
    static final double CALIB_GAP_MS = 150;
    static final double CALIB_MAX_MOVING_MAD = 1.4;
    static final double CALIB_MIN_ACCEL_MAD = 0.004;

    static final double SENS_MULT_MIN = 2.4;
    static final double SENS_MULT_MAX = 7.5;
    static final double MIN_ABS_ACCEL = 0.22;

    static final double PEAK_REFRACTORY_MS = 90;
    static final int TAP_MIN_PEAKS = 2;
    static final double TAP_MAX_GAP_MS = 450;
    static final double TAP_WINDOW_MS = 650;
    static final int REPEATED_MIN_PEAKS = 3;
    static final double STRONG_PULL_MAD = 6.0;
    static final double STRONG_PULL_GYRO_MAD = 4.0;

    static final double CONTACT_ACCEL = 7.0;
    static final double CONTACT_TILT_DEG = 16;
    static final double STABILIZE_MS = 2500;
    static final double REST_TILT_TOL_DEG = 3;
    static final double REST_ADOPT_MS = 5000;

    static final int WOBBLE_SCORE = 40;
    static final int POSSIBLE_SCORE = 65;
    static final int TRIGGER_SCORE = 80;
    static final double CONFIRM_MS = 220;
    static final double COOLDOWN_MS = 9000;

    static final double SELF_VIBE_GUARD_MS = 1300;
    static final double SENSOR_STALL_MS = 1500;

    static final long TICK_MS = 60;
}
