package app.jjibom.motion;

import android.Manifest;
import android.app.NotificationManager;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.hardware.Sensor;
import android.hardware.SensorManager;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.os.SystemClock;
import android.provider.Settings;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Bridge between the web UI (src/nativeBridge.js) and VibrationDetectionService.
 * The service is the single owner of detection and alarms on Android; this
 * plugin only starts/stops it, relays its events and reports its real state.
 */
@CapacitorPlugin(
        name = "JjibomMotion",
        permissions = {@Permission(alias = "notifications", strings = {Manifest.permission.POST_NOTIFICATIONS})}
)
public class JjibomMotionPlugin extends Plugin {

    private AlarmPlayer testPlayer;

    @Override
    public void load() {
        MotionHub.setListener((name, data) -> {
            try {
                notifyListeners(name, JSObject.fromJSONObject(data));
            } catch (JSONException ignored) {
                // data comes from our own JSONObject; cannot be malformed
            }
        });
    }

    @Override
    protected void handleOnDestroy() {
        MotionHub.setListener(null);
        if (testPlayer != null) testPlayer.stop();
        super.handleOnDestroy();
    }

    // ---------------------------------------------------------------- info

    @PluginMethod
    public void getInfo(PluginCall call) {
        Context ctx = getContext();
        SensorManager sm = (SensorManager) ctx.getSystemService(Context.SENSOR_SERVICE);
        boolean accel = sm != null && sm.getDefaultSensor(Sensor.TYPE_ACCELEROMETER) != null;
        JSObject sensors = new JSObject();
        sensors.put("accelerometer", accel);
        sensors.put("linearAcceleration", sm != null && sm.getDefaultSensor(Sensor.TYPE_LINEAR_ACCELERATION) != null);
        sensors.put("gyroscope", sm != null && sm.getDefaultSensor(Sensor.TYPE_GYROSCOPE) != null);
        PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
        JSObject out = new JSObject();
        out.put("supported", accel);
        out.put("sensors", sensors);
        out.put("notifications", notificationState());
        out.put("ignoringBatteryOptimizations", pm != null && pm.isIgnoringBatteryOptimizations(ctx.getPackageName()));
        out.put("sdk", Build.VERSION.SDK_INT);
        out.put("manufacturer", Build.MANUFACTURER);
        out.put("model", Build.MODEL);
        call.resolve(out);
    }

    private String notificationState() {
        NotificationManager nm = (NotificationManager) getContext().getSystemService(Context.NOTIFICATION_SERVICE);
        boolean enabled = nm != null && nm.areNotificationsEnabled();
        if (enabled) return "granted";
        if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.DENIED) return "prompt";
        return "denied";
    }

    @PluginMethod
    public void requestNotificationPermission(PluginCall call) {
        if (Build.VERSION.SDK_INT < 33 || getPermissionState("notifications") == PermissionState.GRANTED) {
            call.resolve(new JSObject().put("notifications", notificationState()));
            return;
        }
        requestPermissionForAlias("notifications", call, "onNotificationPermission");
    }

    @PermissionCallback
    private void onNotificationPermission(PluginCall call) {
        call.resolve(new JSObject().put("notifications", notificationState()));
    }

    // ------------------------------------------------------------- control

    @PluginMethod
    public void startMonitoring(PluginCall call) {
        Intent intent = serviceIntent(VibrationDetectionService.ACTION_START)
                .putExtra(VibrationDetectionService.EXTRA_SETTINGS, call.getData().toString());
        try {
            if (Build.VERSION.SDK_INT >= 26) getContext().startForegroundService(intent);
            else getContext().startService(intent);
            call.resolve();
        } catch (RuntimeException e) {
            call.reject("백그라운드 감시를 시작할 수 없어요. 앱을 연 상태에서 다시 시도해 주세요.", "FOREGROUND_NOT_ALLOWED", e);
        }
    }

    @PluginMethod
    public void stopMonitoring(PluginCall call) {
        sendIfRunning(VibrationDetectionService.ACTION_STOP, null);
        call.resolve();
    }

    @PluginMethod
    public void pauseMonitoring(PluginCall call) {
        sendIfRunning(VibrationDetectionService.ACTION_PAUSE, null);
        call.resolve();
    }

    @PluginMethod
    public void resumeMonitoring(PluginCall call) {
        sendIfRunning(VibrationDetectionService.ACTION_RESUME, null);
        call.resolve();
    }

    @PluginMethod
    public void updateSettings(PluginCall call) {
        sendIfRunning(VibrationDetectionService.ACTION_UPDATE, call.getData().toString());
        call.resolve();
    }

    @PluginMethod
    public void acknowledgeAlarm(PluginCall call) {
        sendIfRunning(VibrationDetectionService.ACTION_ACK, null);
        call.resolve();
    }

    /** Plays the real alarm (same sound, volume stream and vibration) without recording a bite. */
    @PluginMethod
    public void testAlarm(PluginCall call) {
        JSObject data = call.getData();
        if (MotionHub.running) {
            sendIfRunning(VibrationDetectionService.ACTION_TEST, null);
        } else {
            if (testPlayer == null) testPlayer = new AlarmPlayer(getContext(), new Handler(Looper.getMainLooper()));
            testPlayer.start(data.optBoolean("sound", true), data.optBoolean("vibration", true),
                    data.optString("alarmTone", "rise"), 2500);
        }
        call.resolve();
    }

    @PluginMethod
    public void getMonitoringState(PluginCall call) {
        JSObject out = new JSObject();
        out.put("running", MotionHub.running);
        out.put("state", MotionHub.state);
        out.put("elapsedMs", MotionHub.running ? SystemClock.elapsedRealtime() - MotionHub.startedAtElapsedMs : 0);
        out.put("startedAt", MotionHub.running ? MotionEventStore.isoNow(MotionHub.startedAtWallMs) : null);
        out.put("score", MotionHub.score);
        out.put("pattern", MotionHub.pattern);
        out.put("calibrationProgress", MotionHub.calibrationProgress);
        out.put("sampleHz", MotionHub.sampleHz);
        out.put("alarmActive", MotionHub.alarmActive);
        out.put("alarmCount", MotionHub.alarmCount);
        out.put("hasLinearSensor", MotionHub.hasLinearSensor);
        out.put("hasGyroscope", MotionHub.hasGyroscope);
        out.put("lastError", MotionHub.lastError);
        call.resolve(out);
    }

    // -------------------------------------------------------------- events

    @PluginMethod
    public void getEvents(PluginCall call) {
        JSONArray events = MotionEventStore.all(getContext());
        JSArray arr = new JSArray();
        for (int i = 0; i < events.length(); i++) {
            JSONObject e = events.optJSONObject(i);
            if (e == null) continue;
            try {
                arr.put(JSObject.fromJSONObject(e));
            } catch (JSONException ignored) {
                // skip a corrupt entry
            }
        }
        call.resolve(new JSObject().put("events", arr));
    }

    @PluginMethod
    public void clearEvents(PluginCall call) {
        MotionEventStore.clear(getContext());
        call.resolve();
    }

    // ------------------------------------------------------ system settings

    @PluginMethod
    public void openNotificationSettings(PluginCall call) {
        Intent intent;
        if (Build.VERSION.SDK_INT >= 26) {
            intent = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                    .putExtra(Settings.EXTRA_APP_PACKAGE, getContext().getPackageName());
        } else {
            intent = appDetails();
        }
        open(intent, call);
    }

    /** Opens the battery-optimisation list so the user can decide; we never request the exemption. */
    @PluginMethod
    public void openBatterySettings(PluginCall call) {
        open(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS), call);
    }

    @PluginMethod
    public void openAppSettings(PluginCall call) {
        open(appDetails(), call);
    }

    private Intent appDetails() {
        return new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
                .setData(Uri.fromParts("package", getContext().getPackageName(), null));
    }

    private void open(Intent intent, PluginCall call) {
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            getContext().startActivity(intent);
        } catch (ActivityNotFoundException e) {
            try {
                getContext().startActivity(appDetails().addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            } catch (ActivityNotFoundException ignored) {
                call.reject("설정 화면을 열 수 없어요.");
                return;
            }
        }
        call.resolve();
    }

    // ------------------------------------------------------------- helpers

    private Intent serviceIntent(String action) {
        return new Intent(getContext(), VibrationDetectionService.class).setAction(action);
    }

    private void sendIfRunning(String action, String settings) {
        if (!MotionHub.running && !VibrationDetectionService.ACTION_ACK.equals(action)) return;
        Intent intent = serviceIntent(action);
        if (settings != null) intent.putExtra(VibrationDetectionService.EXTRA_SETTINGS, settings);
        try {
            getContext().startService(intent);
        } catch (RuntimeException ignored) {
            // service not reachable (app backgrounded); state stays as reported
        }
    }
}
