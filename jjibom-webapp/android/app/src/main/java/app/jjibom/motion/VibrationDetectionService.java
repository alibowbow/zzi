package app.jjibom.motion;

import android.app.Notification;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.os.Process;
import android.os.SystemClock;

import org.json.JSONException;
import org.json.JSONObject;

/**
 * Foreground service that owns vibration detection on Android, so bites are
 * still detected with the screen off or another app open. Started only by an
 * explicit user action in the app, always visible as an ongoing notification
 * and stoppable from it. Never restarts itself (START_NOT_STICKY, no boot
 * receiver) and holds a partial wake lock only while a session runs.
 *
 * All detection happens on one HandlerThread: sensor callbacks and the 60 ms
 * analysis tick share it, so MotionEngine needs no locking.
 */
public class VibrationDetectionService extends Service implements SensorEventListener {

    static final String ACTION_START = "app.jjibom.motion.action.START";
    static final String ACTION_STOP = "app.jjibom.motion.action.STOP";
    static final String ACTION_PAUSE = "app.jjibom.motion.action.PAUSE";
    static final String ACTION_RESUME = "app.jjibom.motion.action.RESUME";
    static final String ACTION_ACK = "app.jjibom.motion.action.ACK";
    static final String ACTION_TEST = "app.jjibom.motion.action.TEST";
    static final String ACTION_UPDATE = "app.jjibom.motion.action.UPDATE";
    static final String EXTRA_SETTINGS = "settings";

    private static final long WAKE_LOCK_TIMEOUT_MS = 2 * 60 * 60 * 1000L;
    private static final long WAKE_LOCK_REFRESH_MS = 30 * 60 * 1000L;
    private static final long MAX_SESSION_MS = 12 * 60 * 60 * 1000L;
    private static final long METRICS_EVERY_MS = 200;

    private HandlerThread thread;
    private Handler worker;
    private final Handler main = new Handler(Looper.getMainLooper());
    private SensorManager sensors;
    private Sensor accel;
    private Sensor linear;
    private Sensor gyro;
    private boolean listening;
    private final MotionEngine engine = new MotionEngine();
    private AlarmPlayer alarm;
    private PowerManager.WakeLock wakeLock;
    private long wakeLockRefreshedAt;

    private int sensitivity = 5;
    private String detectMode = "all";
    private boolean sound = true;
    private boolean vibration = true;
    private String tone = "rise";
    private int alarmSeconds = 8;

    private volatile boolean session;
    private String lastState = "idle";
    private long lastMetricsAt;
    private int rateCount;
    private long rateWindowStart;

    private final Runnable tickTask = new Runnable() {
        @Override
        public void run() {
            if (!session) return;
            tick();
            if (session) worker.postDelayed(this, MotionConst.TICK_MS);
        }
    };

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        thread = new HandlerThread("jjibom-motion", Process.THREAD_PRIORITY_DEFAULT);
        thread.start();
        worker = new Handler(thread.getLooper());
        sensors = (SensorManager) getSystemService(SENSOR_SERVICE);
        if (sensors != null) {
            accel = sensors.getDefaultSensor(Sensor.TYPE_ACCELEROMETER);
            linear = sensors.getDefaultSensor(Sensor.TYPE_LINEAR_ACCELERATION);
            gyro = sensors.getDefaultSensor(Sensor.TYPE_GYROSCOPE);
        }
        alarm = new AlarmPlayer(this, worker);
        MonitoringNotification.ensureChannels(this);
        applySettings(MotionEventStore.loadSettings(this));
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : null;
        if (ACTION_START.equals(action)) {
            applySettings(parse(intent.getStringExtra(EXTRA_SETTINGS)));
            if (!enterForeground()) {
                stopSelf();
                return START_NOT_STICKY;
            }
            worker.post(this::startSession);
        } else if (ACTION_STOP.equals(action)) {
            worker.post(this::stopSession);
        } else if (ACTION_PAUSE.equals(action)) {
            worker.post(this::pauseSession);
        } else if (ACTION_RESUME.equals(action)) {
            worker.post(this::resumeSession);
        } else if (ACTION_ACK.equals(action)) {
            worker.post(this::acknowledgeAlarm);
        } else if (ACTION_TEST.equals(action)) {
            worker.post(this::testAlarm);
        } else if (ACTION_UPDATE.equals(action)) {
            applySettings(parse(intent.getStringExtra(EXTRA_SETTINGS)));
            worker.post(() -> {
                engine.setSettings(sensitivity, detectMode);
                refreshNotification();
            });
        } else if (!session) {
            // Recreated by the system without a request: never resume on our own.
            stopSelf();
        }
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        session = false;
        worker.removeCallbacksAndMessages(null);
        unregisterSensors();
        alarm.stop();
        releaseWakeLock();
        engine.stop();
        MotionHub.resetSnapshot();
        emit("stateChanged", json("state", "idle"));
        thread.quitSafely();
        super.onDestroy();
    }

    // ------------------------------------------------------------ settings

    private static JSONObject parse(String raw) {
        if (raw == null) return new JSONObject();
        try {
            return new JSONObject(raw);
        } catch (JSONException e) {
            return new JSONObject();
        }
    }

    private void applySettings(JSONObject o) {
        sensitivity = Math.max(1, Math.min(10, o.optInt("sensitivity", sensitivity)));
        detectMode = o.optString("detectMode", detectMode);
        sound = o.optBoolean("sound", sound);
        vibration = o.optBoolean("vibration", vibration);
        tone = o.optString("alarmTone", tone);
        alarmSeconds = Math.max(2, Math.min(60, o.optInt("alarmSeconds", alarmSeconds)));
        JSONObject saved = new JSONObject();
        try {
            saved.put("sensitivity", sensitivity).put("detectMode", detectMode).put("sound", sound)
                    .put("vibration", vibration).put("alarmTone", tone).put("alarmSeconds", alarmSeconds);
        } catch (JSONException ignored) {
            // plain values
        }
        MotionEventStore.saveSettings(this, saved);
    }

    // ------------------------------------------------------------- session

    private boolean enterForeground() {
        Notification n = MonitoringNotification.ongoing(this, "calibrating", sensitivity, System.currentTimeMillis());
        try {
            if (Build.VERSION.SDK_INT >= 34) {
                startForeground(MonitoringNotification.ID_ONGOING, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
            } else {
                startForeground(MonitoringNotification.ID_ONGOING, n);
            }
            return true;
        } catch (RuntimeException e) {
            MotionHub.lastError = "foreground";
            emit("sensorError", json("reason", "foreground", "message",
                    "백그라운드 감시를 시작할 수 없어요. 앱을 연 상태에서 다시 시작해 주세요."));
            return false;
        }
    }

    private void startSession() {
        if (accel == null && linear == null) {
            MotionHub.lastError = "no_sensor";
            emit("sensorError", json("reason", "no_sensor", "message", "이 기기에는 가속도 센서가 없어요."));
            stopSession();
            return;
        }
        alarm.stop();
        registerSensors();
        acquireWakeLock();
        engine.setHasLinearSensor(linear != null);
        engine.setSettings(sensitivity, detectMode);
        engine.startCalibration(now());
        session = true;
        lastState = "";
        MotionHub.running = true;
        MotionHub.startedAtWallMs = System.currentTimeMillis();
        MotionHub.startedAtElapsedMs = SystemClock.elapsedRealtime();
        MotionHub.hasLinearSensor = linear != null;
        MotionHub.hasGyroscope = gyro != null;
        MotionHub.alarmCount = 0;
        MotionHub.alarmActive = false;
        MotionHub.lastError = "";
        rateCount = 0;
        rateWindowStart = SystemClock.elapsedRealtime();
        publishState(MotionDetector.State.CALIBRATING.id);
        worker.removeCallbacks(tickTask);
        worker.post(tickTask);
    }

    private void pauseSession() {
        if (!session) {
            stopIfIdle();
            return;
        }
        alarm.stop();
        engine.pause(now());
        unregisterSensors();
        releaseWakeLock();
        publishState(MotionDetector.State.PAUSED.id);
    }

    private void resumeSession() {
        if (!session) {
            stopIfIdle();
            return;
        }
        registerSensors();
        acquireWakeLock();
        engine.resume(now());
        publishState(engine.state().id);
    }

    private void stopSession() {
        session = false;
        worker.removeCallbacks(tickTask);
        unregisterSensors();
        alarm.stop();
        releaseWakeLock();
        engine.stop();
        MotionHub.resetSnapshot();
        lastState = "idle";
        emit("stateChanged", json("state", "idle"));
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm != null) nm.cancel(MonitoringNotification.ID_BITE);
        main.post(() -> {
            stopForeground(STOP_FOREGROUND_REMOVE);
            stopSelf();
        });
    }

    private void stopIfIdle() {
        if (!session && !alarm.isActive()) main.post(this::stopSelf);
    }

    // ---------------------------------------------------------------- tick

    private void tick() {
        double now = now();
        MotionEngine.Tick t = engine.tick(now);

        if (t.calibration != null) {
            if (!t.calibration.ok) {
                MotionHub.lastError = "calibration";
                emit("sensorError", json("reason", "calibration", "message", t.calibration.reason));
                stopSession();
                return;
            }
            MotionDetector.Baseline b = t.calibration.stats;
            JSONObject info = json("ok", true);
            try {
                info.put("sampleHz", b.sampleHz).put("accelMad", b.accelMad).put("dropRatio", b.dropRatio);
            } catch (JSONException ignored) {
                // plain values
            }
            emit("calibration", info);
        }
        MotionHub.calibrationProgress = engine.state() == MotionDetector.State.CALIBRATING ? t.calibrationProgress : 1;
        MotionHub.score = t.score;
        MotionHub.pattern = t.pattern;

        if (t.alarm) fireAlarm(t.pattern, t.score, now);
        if (engine.state() == MotionDetector.State.ALARM && !alarm.isActive()) {
            engine.dismissAlarm(now); // alarm played out -> cooldown, keep watching
            MotionHub.alarmActive = false;
        }
        publishState(engine.state().id);

        long wall = SystemClock.elapsedRealtime();
        if (wall - wakeLockRefreshedAt > WAKE_LOCK_REFRESH_MS && wakeLock != null && wakeLock.isHeld()) acquireWakeLock();
        if (wall - MotionHub.startedAtElapsedMs > MAX_SESSION_MS) {
            emit("sensorError", json("reason", "max_session", "message", "12시간이 지나 감시를 자동으로 종료했어요."));
            stopSession();
            return;
        }
        if (wall - lastMetricsAt >= METRICS_EVERY_MS) {
            lastMetricsAt = wall;
            JSONObject m = json("score", t.score, "pattern", t.pattern);
            try {
                m.put("state", engine.state().id)
                        .put("magnitude", t.magnitude)
                        .put("sampleHz", MotionHub.sampleHz)
                        .put("calibrationProgress", MotionHub.calibrationProgress)
                        .put("elapsedMs", wall - MotionHub.startedAtElapsedMs);
            } catch (JSONException ignored) {
                // plain values
            }
            emit("metrics", m);
        }
    }

    private void fireAlarm(String pattern, int score, double now) {
        long durationMs = alarmSeconds * 1000L;
        engine.muteForSelfVibration(now, durationMs + MotionConst.SELF_VIBE_GUARD_MS);
        alarm.start(sound, vibration, tone, durationMs);
        PowerManager pm = getSystemService(PowerManager.class);
        boolean screenOn = pm != null && pm.isInteractive();
        JSONObject event = MotionEventStore.add(this, pattern, score, screenOn);
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm != null) {
            nm.notify(MonitoringNotification.ID_BITE,
                    MonitoringNotification.bite(this, pattern, score, event.optLong("epochMs", System.currentTimeMillis())));
        }
        MotionHub.alarmActive = true;
        MotionHub.alarmCount += 1;
        emit("biteDetected", event);
    }

    private void acknowledgeAlarm() {
        alarm.stop();
        MotionHub.alarmActive = false;
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm != null) nm.cancel(MonitoringNotification.ID_BITE);
        if (!session) {
            stopIfIdle();
            return;
        }
        double now = now();
        engine.endSelfVibration(now, 600);
        engine.dismissAlarm(now);
        publishState(engine.state().id);
    }

    private void testAlarm() {
        long durationMs = 2500;
        if (session) engine.muteForSelfVibration(now(), durationMs + MotionConst.SELF_VIBE_GUARD_MS);
        alarm.start(sound, vibration, tone, durationMs);
        if (!session) worker.postDelayed(this::stopIfIdle, durationMs + 200);
    }

    private void publishState(String state) {
        if (state.equals(lastState)) return;
        lastState = state;
        MotionHub.state = state;
        emit("stateChanged", json("state", state));
        refreshNotification();
    }

    private void refreshNotification() {
        if (!session) return;
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm == null) return;
        nm.notify(MonitoringNotification.ID_ONGOING,
                MonitoringNotification.ongoing(this, lastState, sensitivity, MotionHub.startedAtWallMs));
    }

    // ------------------------------------------------------------- sensors

    private void registerSensors() {
        if (listening || sensors == null) return;
        int period = MotionConst.SAMPLING_PERIOD_US;
        if (accel != null) sensors.registerListener(this, accel, period, 0, worker);
        if (linear != null) sensors.registerListener(this, linear, period, 0, worker);
        if (gyro != null) sensors.registerListener(this, gyro, period, 0, worker);
        listening = true;
    }

    private void unregisterSensors() {
        if (!listening || sensors == null) return;
        sensors.unregisterListener(this);
        listening = false;
    }

    @Override
    public void onSensorChanged(SensorEvent event) {
        double arrival = SystemClock.elapsedRealtimeNanos() / 1e6;
        double t = event.timestamp / 1e6;
        // A few devices stamp events with another clock; fall back to arrival time.
        if (Math.abs(arrival - t) > 500) t = arrival;
        float[] v = event.values;
        int type = event.sensor.getType();
        if (type == Sensor.TYPE_ACCELEROMETER) {
            engine.onAccel(t, v[0], v[1], v[2]);
            if (linear == null) countSample();
        } else if (type == Sensor.TYPE_LINEAR_ACCELERATION) {
            engine.onLinear(t, v[0], v[1], v[2]);
            countSample();
        } else if (type == Sensor.TYPE_GYROSCOPE) {
            engine.onGyro(v[0], v[1], v[2]);
        }
    }

    private void countSample() {
        rateCount++;
        long wall = SystemClock.elapsedRealtime();
        long span = wall - rateWindowStart;
        if (span >= 2000) {
            MotionHub.sampleHz = rateCount * 1000.0 / span;
            rateCount = 0;
            rateWindowStart = wall;
        }
    }

    @Override
    public void onAccuracyChanged(Sensor sensor, int accuracy) {
        // not used
    }

    // ------------------------------------------------------------ wake lock

    private void acquireWakeLock() {
        if (wakeLock == null) {
            PowerManager pm = getSystemService(PowerManager.class);
            if (pm == null) return;
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "jjibom:monitoring");
            wakeLock.setReferenceCounted(false);
        }
        wakeLock.acquire(WAKE_LOCK_TIMEOUT_MS); // re-acquiring pushes the timeout out
        wakeLockRefreshedAt = SystemClock.elapsedRealtime();
    }

    private void releaseWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
    }

    // -------------------------------------------------------------- helpers

    private static double now() {
        return SystemClock.elapsedRealtimeNanos() / 1e6;
    }

    private static JSONObject json(Object... kv) {
        JSONObject o = new JSONObject();
        try {
            for (int i = 0; i + 1 < kv.length; i += 2) o.put((String) kv[i], kv[i + 1]);
        } catch (JSONException ignored) {
            // plain values
        }
        return o;
    }

    private static void emit(String name, JSONObject data) {
        MotionHub.emit(name, data);
    }
}
