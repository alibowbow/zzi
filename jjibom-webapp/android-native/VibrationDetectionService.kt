package app.jjibom.motion

import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.*
import org.json.JSONObject
import kotlin.math.sqrt

/**
 * VibrationDetectionService — a Foreground Service that reads the motion sensors
 * and detects bites even while the app is backgrounded or the screen is off
 * (on devices whose sensors keep delivering; see README for caveats).
 *
 * It is the SINGLE owner of detection on Android. The web UI (via JjibomMotionPlugin)
 * only starts/stops it and reflects its state/events.
 */
class VibrationDetectionService : Service(), SensorEventListener {

    companion object {
        const val ACTION_START = "app.jjibom.motion.START"
        const val ACTION_PAUSE = "app.jjibom.motion.PAUSE"
        const val ACTION_RESUME = "app.jjibom.motion.RESUME"
        const val ACTION_STOP = "app.jjibom.motion.STOP"
        const val EXTRA_SETTINGS = "settings_json"

        // Shared, read by the plugin's getMonitoringState().
        @Volatile var state: String = "idle"
        @Volatile var running: Boolean = false
        @Volatile var lastScore: Int = 0
        @Volatile var startedAt: Long = 0
    }

    private lateinit var sensorManager: SensorManager
    private var linear: Sensor? = null
    private var accel: Sensor? = null
    private var gravity: Sensor? = null
    private var gyro: Sensor? = null
    private val processor = MotionSignalProcessor()

    private var sensitivity = 5
    private var detectMode = "all"
    private var soundEnabled = true
    private var vibrationEnabled = true
    private var paused = false

    private var lastGyroMag = 0.0
    private var lastGrav = doubleArrayOf(0.0, 0.0, 9.81)
    private var hasLinear = false
    private var lastSampleAt = 0L
    private var lastContactAt = Long.MIN_VALUE

    private var wakeLock: PowerManager.WakeLock? = null
    private val handler = Handler(Looper.getMainLooper())
    private var calibEndAt = 0L

    private val ticker = object : Runnable {
        override fun run() {
            tick()
            handler.postDelayed(this, 60)
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        sensorManager = getSystemService(SENSOR_SERVICE) as SensorManager
        linear = sensorManager.getDefaultSensor(Sensor.TYPE_LINEAR_ACCELERATION)
        accel = sensorManager.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)
        gravity = sensorManager.getDefaultSensor(Sensor.TYPE_GRAVITY)
        gyro = sensorManager.getDefaultSensor(Sensor.TYPE_GYROSCOPE)
        MonitoringNotification.ensureChannels(this)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_PAUSE -> { pauseMonitoring(); return START_STICKY }
            ACTION_RESUME -> { resumeMonitoring(); return START_STICKY }
            ACTION_STOP -> { stopEverything(); return START_NOT_STICKY }
            else -> {
                intent?.getStringExtra(EXTRA_SETTINGS)?.let { applySettings(it) }
                startMonitoring()
            }
        }
        return START_STICKY
    }

    private fun applySettings(json: String) {
        try {
            val o = JSONObject(json)
            sensitivity = o.optInt("sensitivity", sensitivity)
            detectMode = o.optString("detectMode", detectMode)
            soundEnabled = o.optBoolean("sound", soundEnabled)
            vibrationEnabled = o.optBoolean("vibration", vibrationEnabled)
        } catch (_: Exception) { }
    }

    private fun startForeground() {
        val n = MonitoringNotification.ongoing(this, paused, sensLabel())
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            // Android 14+: declare the special-use foreground service type.
            startForeground(MonitoringNotification.ONGOING_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else {
            startForeground(MonitoringNotification.ONGOING_ID, n)
        }
    }

    private fun startMonitoring() {
        startForeground()
        acquireWakeLock()
        registerSensors()
        processor.reset()
        processor.beginCalibration()
        calibEndAt = SystemClock.elapsedRealtime() + MotionConst.CALIB_MS
        running = true; paused = false; startedAt = SystemClock.elapsedRealtime()
        setState("calibrating")
        handler.removeCallbacks(ticker); handler.post(ticker)
    }

    private fun pauseMonitoring() {
        paused = true
        sensorManager.unregisterListener(this)
        setState("paused")
        refreshOngoing()
    }

    private fun resumeMonitoring() {
        if (!running) return
        paused = false
        registerSensors()
        lastSampleAt = SystemClock.elapsedRealtime()
        setState("armed")
        refreshOngoing()
    }

    private fun stopEverything() {
        running = false
        handler.removeCallbacks(ticker)
        sensorManager.unregisterListener(this)
        releaseWakeLock()
        setState("idle")
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onDestroy() {
        // Always clean up, even on unexpected teardown.
        running = false
        handler.removeCallbacks(ticker)
        sensorManager.unregisterListener(this)
        releaseWakeLock()
        super.onDestroy()
    }

    private fun registerSensors() {
        // Priority: LINEAR_ACCELERATION, else ACCELEROMETER (+ GRAVITY). Prefer
        // wake-up sensors when available so the screen can be off.
        val rate = SensorManager.SENSOR_DELAY_GAME // ~50 Hz
        hasLinear = linear != null
        if (linear != null) sensorManager.registerListener(this, linear, rate)
        else if (accel != null) sensorManager.registerListener(this, accel, rate)
        if (gravity != null && linear != null) sensorManager.registerListener(this, gravity, rate)
        if (gyro != null) sensorManager.registerListener(this, gyro, rate)
    }

    override fun onSensorChanged(event: SensorEvent) {
        val now = SystemClock.elapsedRealtime()
        lastSampleAt = now
        when (event.sensor.type) {
            Sensor.TYPE_GYROSCOPE -> {
                lastGyroMag = Math.toDegrees(
                    sqrt(event.values[0].toDouble() * event.values[0] +
                         event.values[1].toDouble() * event.values[1] +
                         event.values[2].toDouble() * event.values[2])
                )
            }
            Sensor.TYPE_GRAVITY -> { lastGrav = doubleArrayOf(event.values[0].toDouble(), event.values[1].toDouble(), event.values[2].toDouble()) }
            Sensor.TYPE_LINEAR_ACCELERATION -> {
                processor.pushRaw(now, event.values[0].toDouble(), event.values[1].toDouble(), event.values[2].toDouble(),
                    true, lastGrav[0], lastGrav[1], lastGrav[2], lastGyroMag)
            }
            Sensor.TYPE_ACCELEROMETER -> {
                processor.pushRaw(now, event.values[0].toDouble(), event.values[1].toDouble(), event.values[2].toDouble(),
                    false, Double.NaN, Double.NaN, Double.NaN, lastGyroMag)
            }
        }
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {}

    private fun tick() {
        if (!running || paused) return
        val now = SystemClock.elapsedRealtime()

        if (processor.calibrating) {
            if (now >= calibEndAt) {
                val reason = processor.finishCalibration(MotionConst.CALIB_MS)
                if (reason != null) { emit("sensorError", JSONObject().put("reason", "calibration").put("message", reason)); stopEverything(); return }
                setState("armed")
            }
            return
        }
        if (now - lastSampleAt > MotionConst.SENSOR_STALL_MS) { setState("error"); emit("sensorError", JSONObject().put("reason", "stall")); return }

        val a = processor.analyze(now, sensitivity, detectMode)
        lastScore = a.score
        if (a.contact) { lastContactAt = now; setState("stabilizing") }
        else if (state == "stabilizing" && now - lastContactAt > 2500) setState("armed")
        else if (state == "armed" && a.score >= 65) setState("possible_bite")
        else if (state == "possible_bite" && a.score < 40) setState("armed")

        emit("metrics", JSONObject().put("score", a.score).put("pattern", a.pattern)
            .put("state", state).put("elapsedMs", now - startedAt))

        val fired = processor.gate(a, now)
        if (fired != null && state != "cooldown") fireAlarm(fired, a.score, now)
    }

    private fun fireAlarm(pattern: String, score: Int, now: Long) {
        // Mute BEFORE we buzz so our own vibration is not re-detected.
        processor.muteForSelfVibration(now)
        setState("alarm")
        val nm = getSystemService(android.app.NotificationManager::class.java)
        nm.notify(MonitoringNotification.ALERT_ID, MonitoringNotification.alert(this, pattern, score))
        if (vibrationEnabled) vibrate()
        emit("biteDetected", JSONObject().put("pattern", pattern).put("score", score)
            .put("timestamp", System.currentTimeMillis()))
        handler.postDelayed({ if (running) setState("cooldown") }, 200)
        handler.postDelayed({ if (running && !paused) setState("armed") }, MotionConst.COOLDOWN_MS)
    }

    private fun vibrate() {
        val v = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S)
            (getSystemService(VIBRATOR_MANAGER_SERVICE) as VibratorManager).defaultVibrator
        else @Suppress("DEPRECATION") getSystemService(VIBRATOR_SERVICE) as Vibrator
        val pattern = longArrayOf(0, 280, 120, 280, 120, 620)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) v.vibrate(VibrationEffect.createWaveform(pattern, -1))
        else @Suppress("DEPRECATION") v.vibrate(pattern, -1)
    }

    private fun acquireWakeLock() {
        if (wakeLock?.isHeld == true) return
        val pm = getSystemService(POWER_SERVICE) as PowerManager
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "jjibom:motion").apply {
            setReferenceCounted(false); acquire(/* timeout */ 6 * 60 * 60 * 1000L)
        }
    }
    private fun releaseWakeLock() {
        try { if (wakeLock?.isHeld == true) wakeLock?.release() } catch (_: Exception) {} finally { wakeLock = null }
    }

    private fun refreshOngoing() {
        val nm = getSystemService(android.app.NotificationManager::class.java)
        nm.notify(MonitoringNotification.ONGOING_ID, MonitoringNotification.ongoing(this, paused, sensLabel()))
    }
    private fun sensLabel() = if (sensitivity <= 3) "둔감" else if (sensitivity <= 7) "보통" else "민감"

    private fun setState(s: String) {
        if (state == s) return
        state = s
        emit("stateChanged", JSONObject().put("state", s))
        if (s == "paused" || s == "armed" || s == "calibrating") refreshOngoing()
    }

    private fun emit(event: String, data: JSONObject) {
        MotionEventBus.sink?.invoke(event, data)
    }
}

/** Bridges service events to the Capacitor plugin without a bound service. */
object MotionEventBus {
    @Volatile var sink: ((String, JSONObject) -> Unit)? = null
}
