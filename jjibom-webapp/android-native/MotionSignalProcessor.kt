package app.jjibom.motion

import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sqrt

/**
 * MotionSignalProcessor — Kotlin port of the web detector (src/vibrationDetector.js,
 * motionFilter.js, motionCalibration.js). Thresholds and semantics intentionally
 * mirror src/motionConfig.js so the app and the web behave consistently.
 *
 * Pure-ish: feed samples with push(); call calibrate()/analyze(). No Android deps,
 * so it can be unit-tested with plain JUnit.
 */
object MotionConst {
    const val SHORT_WINDOW_MS = 320L
    const val LONG_WINDOW_MS = 1500L
    const val BUFFER_MS = 4000L
    const val GRAVITY_LP_ALPHA = 0.08
    const val ACCEL_EMA_ALPHA = 0.4
    const val CALIB_MS = 6000L
    const val CALIB_MIN_SAMPLES = 70
    const val CALIB_MAX_DROP_RATIO = 0.4
    const val CALIB_MAX_MOVING_MAD = 1.4
    const val CALIB_MIN_ACCEL_MAD = 0.004
    const val SENS_MULT_MIN = 2.4
    const val SENS_MULT_MAX = 7.5
    const val MIN_ABS_ACCEL = 0.22
    const val PEAK_REFRACTORY_MS = 90L
    const val TAP_MIN_PEAKS = 2
    const val REPEATED_MIN_PEAKS = 3
    const val STRONG_PULL_MAD = 6.0
    const val STRONG_PULL_GYRO_MAD = 4.0
    const val CONTACT_ACCEL = 7.0
    const val CONTACT_TILT_DEG = 16.0
    const val TRIGGER_SCORE = 80
    const val CONFIRM_MS = 320L
    const val COOLDOWN_MS = 9000L
    const val SELF_VIBE_GUARD_MS = 1300L
    const val SENSOR_STALL_MS = 1500L
    const val TARGET_HZ = 40
}

data class MotionSample(val t: Long, val amag: Double, val jerk: Double, val gmag: Double, val tilt: Double)

data class Baseline(
    val accelMedian: Double, val accelMad: Double,
    val gyroMedian: Double, val gyroMad: Double, val baseTilt: Double
)

data class Analysis(val score: Int, val pattern: String, val contact: Boolean)

class MotionSignalProcessor {
    private val buffer = ArrayDeque<MotionSample>()
    private val calib = ArrayList<MotionSample>()
    private var gravityX = Double.NaN; private var gravityY = Double.NaN; private var gravityZ = Double.NaN
    private var accelEma = Double.NaN
    private var prevAmag = Double.NaN
    private var prevT = 0L

    var calibrating = false
    var baseline: Baseline? = null

    private var confirmSince = 0L
    private var cooldownUntil = 0L
    private var muteUntil = 0L

    fun reset() {
        buffer.clear(); calib.clear()
        gravityX = Double.NaN; accelEma = Double.NaN; prevAmag = Double.NaN
        confirmSince = 0L; cooldownUntil = 0L; muteUntil = 0L
        calibrating = false; baseline = null
    }

    /** Convert a raw sensor reading into a normalized sample and store it. */
    fun pushRaw(t: Long, ax: Double, ay: Double, az: Double, hasLinear: Boolean,
                gx: Double, gy: Double, gz: Double, gyroMag: Double) {
        val lx: Double; val ly: Double; val lz: Double
        var gravx = 0.0; var gravy = 0.0; var gravz = 9.81
        if (hasLinear) {
            lx = ax; ly = ay; lz = az
            // still update gravity estimate from gx/gy/gz (TYPE_GRAVITY) when present
            if (!gx.isNaN()) { updateGravity(gx, gy, gz); gravx = gravityX; gravy = gravityY; gravz = gravityZ }
        } else {
            updateGravity(ax, ay, az)
            lx = ax - gravityX; ly = ay - gravityY; lz = az - gravityZ
            gravx = gravityX; gravy = gravityY; gravz = gravityZ
        }
        val raw = sqrt(lx * lx + ly * ly + lz * lz)
        accelEma = if (accelEma.isNaN()) raw else accelEma + (raw - accelEma) * MotionConst.ACCEL_EMA_ALPHA
        val amag = accelEma
        val tilt = Math.toDegrees(Math.atan2(sqrt(gravx * gravx + gravy * gravy), abs(gravz)))
        val jerk = if (!prevAmag.isNaN() && prevT != 0L) abs(amag - prevAmag) / max(0.001, (t - prevT) / 1000.0) else 0.0
        prevAmag = amag; prevT = t
        val s = MotionSample(t, amag, jerk, gyroMag, tilt)
        buffer.addLast(s)
        val cutoff = t - MotionConst.BUFFER_MS
        while (buffer.isNotEmpty() && buffer.first().t < cutoff) buffer.removeFirst()
        if (calibrating) calib.add(s)
    }

    private fun updateGravity(x: Double, y: Double, z: Double) {
        if (gravityX.isNaN()) { gravityX = x; gravityY = y; gravityZ = z } else {
            gravityX += (x - gravityX) * MotionConst.GRAVITY_LP_ALPHA
            gravityY += (y - gravityY) * MotionConst.GRAVITY_LP_ALPHA
            gravityZ += (z - gravityZ) * MotionConst.GRAVITY_LP_ALPHA
        }
    }

    fun beginCalibration() { calib.clear(); calibrating = true; baseline = null }

    /** Returns null reason on success, otherwise a Korean failure reason. */
    fun finishCalibration(durationMs: Long): String? {
        calibrating = false
        if (calib.size < MotionConst.CALIB_MIN_SAMPLES) return "센서 데이터를 받을 수 없어요."
        val amags = calib.map { it.amag }
        val median = median(amags)
        val mad = max(MotionConst.CALIB_MIN_ACCEL_MAD, mad(amags, median))
        val excess = amags.map { max(0.0, it - median) }
        val maxAmp = excess.maxOrNull() ?: 0.0
        val expected = (durationMs / 1000.0) * MotionConst.TARGET_HZ
        val dropRatio = if (expected > 0) max(0.0, 1 - calib.size / expected) else 1.0
        if (dropRatio > MotionConst.CALIB_MAX_DROP_RATIO) return "센서 데이터가 자주 끊겨요. 다시 시도해 주세요."
        if (maxAmp > MotionConst.CONTACT_ACCEL * 0.7) return "낚싯대를 건드리지 말고 다시 보정해 주세요."
        if (mad > MotionConst.CALIB_MAX_MOVING_MAD) return "스마트폰이 계속 움직이고 있어요. 거치대를 더 단단히 고정해 주세요."
        val gmags = calib.map { it.gmag }
        val tilts = calib.map { it.tilt }
        baseline = Baseline(median, mad, median(gmags), max(1e-3, mad(gmags, median(gmags))), median(tilts))
        return null
    }

    fun muteForSelfVibration(now: Long, ms: Long = MotionConst.SELF_VIBE_GUARD_MS) {
        muteUntil = max(muteUntil, now + ms); confirmSince = 0
    }
    fun isMuted(now: Long) = now < muteUntil || now < cooldownUntil

    /** Analyse the current window. sensitivity 1..10, detectMode all/strong/tap/repeated. */
    fun analyze(now: Long, sensitivity: Int, detectMode: String): Analysis {
        val b = baseline ?: return Analysis(0, "none", false)
        val threshMad = MotionConst.SENS_MULT_MAX +
            (MotionConst.SENS_MULT_MIN - MotionConst.SENS_MULT_MAX) * ((sensitivity.coerceIn(1, 10) - 1) / 9.0)
        val accelMad = max(b.accelMad, MotionConst.CALIB_MIN_ACCEL_MAD)
        val peakThr = max(MotionConst.MIN_ABS_ACCEL, threshMad * accelMad)

        val longS = buffer.filter { it.t >= now - MotionConst.LONG_WINDOW_MS }
        val shortS = longS.filter { it.t >= now - MotionConst.SHORT_WINDOW_MS }
        if (shortS.size < 4) return Analysis(0, "none", false)

        val shortExcess = shortS.map { max(0.0, it.amag - b.accelMedian) }
        val longExcess = longS.map { max(0.0, it.amag - b.accelMedian) }
        val maxExcessShort = shortExcess.maxOrNull() ?: 0.0
        val absPeak = maxExcessShort + b.accelMedian

        val shortBursts = risingEdges(shortS.map { it.t }, shortExcess, peakThr)
        val longBursts = risingEdges(longS.map { it.t }, longExcess, peakThr)

        var reversals = 0; var lastDir = 0
        for (i in 1 until longS.size) {
            val slope = longS[i].amag - longS[i - 1].amag
            if (abs(slope) < 2 * accelMad) continue
            val dir = if (slope > 0) 1 else -1
            if (lastDir != 0 && dir != lastDir) reversals++
            lastDir = dir
        }
        val gyroPeakMad = (longS.maxOf { it.gmag } - b.gyroMedian) / b.gyroMad
        val tiltChange = shortS.maxOf { abs(it.tilt - b.baseTilt) }
        val dt = if (longS.size > 1) (longS.last().t - longS.first().t).toDouble() / (longS.size - 1) else 25.0
        val durationMs = longExcess.count { it >= peakThr } * dt
        val contact = absPeak > MotionConst.CONTACT_ACCEL || tiltChange > MotionConst.CONTACT_TILT_DEG

        val shortRms = rms(shortExcess); val longRms = rms(longExcess)
        val transientRatio = shortRms / (longRms + 1e-3)
        val peakMad = maxExcessShort / accelMad
        val ampFactor = (maxExcessShort / peakThr).coerceIn(0.0, 1.5)

        val strongThr = max(peakThr, MotionConst.STRONG_PULL_MAD * accelMad)
        val strongMag = (maxExcessShort / strongThr).coerceIn(0.0, 1.3)
        val gyroBoost = (gyroPeakMad / MotionConst.STRONG_PULL_GYRO_MAD).coerceIn(0.0, 1.0)
        val sustain = (durationMs / 400).coerceIn(0.0, 1.0)
        val sustained = maxExcessShort >= peakThr && durationMs >= 150
        val strongScore = if (sustained) (0.5 * strongMag + 0.2 * gyroBoost + 0.3 * sustain).coerceIn(0.0, 1.0)
                          else (0.3 * strongMag).coerceIn(0.0, 0.5)

        val tapCount = shortBursts
        val tapScore = if (tapCount >= MotionConst.TAP_MIN_PEAKS)
            ((tapCount.toDouble() / MotionConst.TAP_MIN_PEAKS) * 0.6 + ampFactor * 0.4).coerceIn(0.0, 1.0) else 0.0
        val repeatedScore = if (longBursts >= MotionConst.REPEATED_MIN_PEAKS)
            (0.5 * (longBursts.toDouble() / (MotionConst.REPEATED_MIN_PEAKS + 1)) + 0.3 * (reversals / 5.0) + 0.2 * ampFactor).coerceIn(0.0, 1.0) else 0.0

        val oscillation = (reversals / 6.0).coerceIn(0.0, 1.0)
        val steady = (1 - max(0.0, transientRatio - 1)).coerceIn(0.0, 1.0)
        val modest = (1 - (peakMad - threshMad) / (5 * threshMad)).coerceIn(0.0, 1.0)
        val windiness = (oscillation * steady * modest).coerceIn(0.0, 1.0)

        var base = when (detectMode) {
            "strong" -> max(strongScore, max(0.5 * tapScore, 0.4 * repeatedScore))
            "tap" -> max(tapScore, max(0.5 * strongScore, 0.4 * repeatedScore))
            "repeated" -> max(repeatedScore, max(0.5 * strongScore, 0.4 * tapScore))
            else -> max(strongScore, max(tapScore, repeatedScore))
        }
        base = (base * (1 - 0.75 * windiness)).coerceIn(0.0, 1.0)

        val pattern = when {
            contact -> "contact"
            longBursts >= MotionConst.REPEATED_MIN_PEAKS -> "repeated"
            tapCount >= MotionConst.TAP_MIN_PEAKS -> "tap"
            base > 0.2 -> "strong_pull"
            else -> "none"
        }
        val score = if (contact) (min(base, 0.4) * 100).toInt() else (base * 100).toInt()
        return Analysis(score, pattern, contact)
    }

    /** Returns a fired event pattern (or null) applying confirm/cooldown/mute/contact veto. */
    fun gate(a: Analysis, now: Long): String? {
        if (a.contact || isMuted(now)) { confirmSince = 0; return null }
        if (a.score >= MotionConst.TRIGGER_SCORE) {
            if (confirmSince == 0L) confirmSince = now
            if (now - confirmSince >= MotionConst.CONFIRM_MS) {
                confirmSince = 0; cooldownUntil = now + MotionConst.COOLDOWN_MS
                return a.pattern
            }
        } else confirmSince = 0
        return null
    }

    // --- helpers ---
    private fun risingEdges(times: List<Long>, values: List<Double>, thr: Double): Int {
        var count = 0; var last = Long.MIN_VALUE
        var prevAbove = values.isNotEmpty() && values[0] >= thr
        for (i in 1 until values.size) {
            val above = values[i] >= thr
            if (above && !prevAbove && times[i] - last >= MotionConst.PEAK_REFRACTORY_MS) { count++; last = times[i] }
            prevAbove = above
        }
        return count
    }
    private fun median(v: List<Double>): Double {
        if (v.isEmpty()) return 0.0
        val s = v.sorted(); val m = s.size / 2
        return if (s.size % 2 == 1) s[m] else (s[m - 1] + s[m]) / 2
    }
    private fun mad(v: List<Double>, center: Double): Double {
        if (v.isEmpty()) return 0.0
        return median(v.map { abs(it - center) }) * 1.4826
    }
    private fun rms(v: List<Double>): Double {
        if (v.isEmpty()) return 0.0
        return sqrt(v.sumOf { it * it } / v.size)
    }
}
