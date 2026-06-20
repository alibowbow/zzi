// config.js — every tunable number in one place, with units in comments.
// Detection thresholds are expressed in *normalized* units (multiples of the
// calibrated float height) wherever possible so sensitivity does not drift with
// zoom / resolution / float size.

export const ANALYSIS_MAX = 320;          // px — longest side of the low-res analysis canvas
export const PROCESS_INTERVAL_MS = 66;    // ms — ~15 Hz analysis cadence
export const CALIBRATION_FRAMES = 36;     // frames collected while learning the baseline

// --- Region of interest -------------------------------------------------
export const ROI = Object.freeze({
  BASE_RADIUS_PX: 46,        // px — half-size of the ROI box around the prediction
  GROW_PER_LOST_PX: 10,      // px — ROI grows while the float is missing
  MAX_RADIUS_PX: 120,        // px — cap before we fall back to a global search
  GLOBAL_AFTER_LOST: 6,      // frames missing before scanning the whole frame
  GLOBAL_STEP: 2             // px — subsample step for the (rare) global search
});

// --- Blob extraction ----------------------------------------------------
export const BLOB = Object.freeze({
  MIN_AREA_PX: 4,            // px² — ignore specks
  MAX_BLOBS: 24,             // safety cap per frame
  CONNECTIVITY: 8            // 8-connected flood fill
});

// --- Candidate scoring weights (sum need not be 1; result is renormalized) --
export const BLOB_SCORE = Object.freeze({
  W_PREDICTION: 0.34,        // closeness to predicted position
  W_INITIAL: 0.08,           // closeness to the originally selected position
  W_COLOR: 0.26,             // mean colour match quality
  W_SIZE: 0.16,              // area stability vs. calibrated area
  W_SHAPE: 0.16,             // vertical-elongation match (floats stand up)
  PREDICT_SIGMA_K: 1.6,      // prediction gaussian sigma = K * floatHeight
  SIZE_SIGMA_LOG: 0.8,       // gaussian sigma on log(area ratio)
  TARGET_ASPECT: 1.8         // expected height / width of a float tip
});

// --- Tracking confidence ------------------------------------------------
export const CONFIDENCE = Object.freeze({
  W_COLOR: 0.34,
  W_JUMP: 0.22,              // small frame-to-frame jump => high confidence
  W_SIZE: 0.16,
  W_SHAPE: 0.12,
  W_MARGIN: 0.16,            // separation from the 2nd-best blob
  JUMP_SIGMA_K: 0.9,         // jump gaussian sigma = K * floatHeight
  LOW: 0.35,                 // below this we show "추적 불안정"
  UNSTABLE_MS: 1200          // sustained low confidence before going LOST
});

// --- Calibration acceptance --------------------------------------------
export const CALIB = Object.freeze({
  MIN_FOUND_RATIO: 0.6,      // fraction of frames that must find the float
  MIN_MEAN_CONFIDENCE: 0.42, // mean tracking confidence required
  MIN_FLOAT_HEIGHT_PX: 7,    // px — refuse to monitor a float smaller than this
  MAX_BG_SHAKE_NORM: 1.1,    // normalized — too much shake => recalibrate
  MAX_SIMILAR_COVERAGE: 0.55 // fraction of frame matching the colour => ambiguous
});

// --- Camera shake / background motion ----------------------------------
export const SHAKE = Object.freeze({
  SAMPLES: 8,                // background patches sampled for block matching
  PATCH_PX: 12,              // px — patch side
  SEARCH_PX: 4,              // px — block-match search radius (±)
  MIN_CONFIDENCE: 0.35,      // below this we do not trust / subtract bg motion
  ALARM_SUPPRESS_NORM: 0.6,  // normalized bg motion that pauses alarms
  SUPPRESS_MS: 700           // how long a shake keeps alarms paused
});

// --- Bite detection -----------------------------------------------------
// Thresholds are in float-height units unless stated. e.g. 0.45 means "moved
// 45% of the float's height".
export const BITE = Object.freeze({
  WINDOW_MS: 1400,           // ms — sliding window analysed for a bite
  SINK_DISP_NORM: 0.45,      // net downward travel for a sink
  SINK_AREA_DROP: 0.3,       // fractional area/height shrink reinforcing a sink
  LIFT_DISP_NORM: 0.4,       // net upward travel for a lift
  SPEED_NORM: 2.2,           // float-heights / second considered "fast"
  TWITCH_MIN_REVERSALS: 3,   // direction changes for a twitch
  TWITCH_AMP_NORM: 0.28,     // amplitude over baseline noise for a twitch
  WAVE_STEADY_RATIO: 0.7,    // oscillation regularity that marks wave/wind noise
  TRIGGER_SCORE: 0.62,       // bite score (0..1) needed to consider alarming
  CONFIRM_FRAMES: 3,         // consecutive qualifying frames before ALARM
  DEBOUNCE_MS: 600,          // ignore re-triggers within this window
  COOLDOWN_MS: 8500          // silence after an alarm for the same bite
});

// --- Tracking state machine --------------------------------------------
export const TRACK = Object.freeze({
  LOST_GRACE_MS: 650,        // brief loss tolerated before declaring LOST
  RECOVER_FRAMES: 4,         // stable frames near last position to recover
  RECOVER_MAX_DIST_K: 2.5    // max jump (in float-heights) to count as the same float
});

// --- Diagnostics --------------------------------------------------------
export const DIAG = Object.freeze({
  SAMPLE_MS: 20000,          // ms — rolling window of samples kept in memory
  EXPORT_PAD_MS: 4000        // ms of context kept on each side of an event
});

export const APP_VERSION = '0.2.0';
