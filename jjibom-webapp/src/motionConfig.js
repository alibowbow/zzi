// motionConfig.js — every tunable number for the vibration (motion-sensor) mode.
// Thresholds are expressed in "MADs above the calibrated baseline" wherever
// possible so sensitivity means the same thing on any phone / mounting.
// The web detector and the Android (Kotlin) detector intentionally share these
// names and semantics.

export const MOTION = Object.freeze({
  TARGET_HZ: 40,                 // requested sensor rate (25–50 Hz range)
  SHORT_WINDOW_MS: 320,          // short analysis window (impacts / taps)
  LONG_WINDOW_MS: 1500,          // long analysis window (sustained / repeated)
  BUFFER_MS: 4000,               // rolling sample buffer kept in memory

  GRAVITY_LP_ALPHA: 0.08,        // low-pass factor estimating the gravity vector
  ACCEL_EMA_ALPHA: 0.4,          // light smoothing of the linear-accel magnitude

  // --- Calibration -------------------------------------------------------
  CALIB_MS: 6000,                // 5–8 s of "do not touch the rod"
  CALIB_MIN_SAMPLES: 70,         // too few => sensor not really delivering
  CALIB_MAX_DROP_RATIO: 0.4,     // fraction of expected samples missing => fail
  CALIB_MAX_MOVING_MAD: 1.4,     // m/s² — phone moving too much during calibration
  CALIB_MIN_ACCEL_MAD: 0.004,    // floor so a perfectly still sensor still works

  // --- Sensitivity -> threshold -----------------------------------------
  // threshold(MAD) = lerp(SENS_MULT_MAX, SENS_MULT_MIN, (sens-1)/9)
  // High sensitivity (10) => low multiplier => easier to trigger.
  SENS_MULT_MIN: 2.4,
  SENS_MULT_MAX: 7.5,
  MIN_ABS_ACCEL: 0.22,           // m/s² absolute floor so noise never triggers

  // --- Peak / pattern detection -----------------------------------------
  PEAK_REFRACTORY_MS: 90,        // min gap between counted peaks
  TAP_MIN_PEAKS: 2,              // peaks in the short window for a "tap"
  TAP_MAX_GAP_MS: 450,           // taps closer than this count as one burst
  REPEATED_MIN_PEAKS: 3,         // peaks in the long window for "repeated"
  STRONG_PULL_MAD: 6.0,          // peak this many MADs => candidate strong pull
  STRONG_PULL_GYRO_MAD: 4.0,     // gyro involvement reinforcing a strong pull

  // --- Phone-contact (not a bite) ---------------------------------------
  CONTACT_ACCEL: 7.0,            // m/s² — a hand-tap sized impact
  CONTACT_TILT_DEG: 16,          // device tilt change marking a knock / re-seat
  STABILIZE_MS: 2500,            // re-stabilise window after contact

  // --- Scoring bands (0–100) --------------------------------------------
  WOBBLE_SCORE: 40,
  POSSIBLE_SCORE: 65,
  TRIGGER_SCORE: 80,
  CONFIRM_MS: 220,               // score must hold ≥ TRIGGER this long (a few frames)
  COOLDOWN_MS: 9000,             // silence after an alarm (same bite)

  // --- Self-vibration guard ---------------------------------------------
  // When OUR alarm vibrates/sounds, ignore sensor input so we don't re-detect
  // our own buzz as a new bite.
  SELF_VIBE_GUARD_MS: 1300,

  // --- Health -----------------------------------------------------------
  SENSOR_STALL_MS: 1500          // no samples for this long => ERROR
});

export const MOTION_VERSION = '0.3.0';
