package app.jjibom.motion

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.hardware.Sensor
import android.hardware.SensorManager
import android.os.Build
import androidx.core.content.ContextCompat
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback

/**
 * JjibomMotionPlugin — the Capacitor bridge the web app talks to (see
 * src/nativeBridge.js). Methods proxy to VibrationDetectionService; service
 * events are forwarded to JS listeners (stateChanged / biteDetected / metrics /
 * sensorError).
 */
@CapacitorPlugin(
    name = "JjibomMotion",
    permissions = [
        Permission(alias = "notifications", strings = [Manifest.permission.POST_NOTIFICATIONS])
    ]
)
class JjibomMotionPlugin : Plugin() {

    override fun load() {
        // Forward service -> JS. Runs on the main thread for notifyListeners.
        MotionEventBus.sink = { event, data ->
            activity?.runOnUiThread { notifyListeners(event, JSObject.fromJSONObject(data)) }
        }
    }

    private fun sensorManager() = context.getSystemService(Context.SENSOR_SERVICE) as SensorManager

    @PluginMethod
    fun isSupported(call: PluginCall) {
        val ok = sensorManager().getDefaultSensor(Sensor.TYPE_ACCELEROMETER) != null
        call.resolve(JSObject().put("value", ok))
    }

    @PluginMethod
    fun getAvailableSensors(call: PluginCall) {
        val sm = sensorManager()
        call.resolve(
            JSObject()
                .put("accelerometer", sm.getDefaultSensor(Sensor.TYPE_ACCELEROMETER) != null)
                .put("linearAcceleration", sm.getDefaultSensor(Sensor.TYPE_LINEAR_ACCELERATION) != null)
                .put("gyroscope", sm.getDefaultSensor(Sensor.TYPE_GYROSCOPE) != null)
        )
    }

    @PluginMethod
    fun requestPermissions(call: PluginCall) {
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            requestPermissionForAlias("notifications", call, "notifResult")
        } else {
            call.resolve(JSObject().put("granted", true))
        }
    }

    @PermissionCallback
    private fun notifResult(call: PluginCall) {
        val granted = getPermissionState("notifications").toString() == "granted"
        // Notifications are recommended but not strictly required to detect; we
        // still allow monitoring (the alert will be silent if denied).
        call.resolve(JSObject().put("granted", true).put("notifications", granted))
    }

    @PluginMethod
    fun startMonitoring(call: PluginCall) {
        val intent = Intent(context, VibrationDetectionService::class.java)
            .setAction(VibrationDetectionService.ACTION_START)
            .putExtra(VibrationDetectionService.EXTRA_SETTINGS, call.data.toString())
        ContextCompat.startForegroundService(context, intent)
        call.resolve()
    }

    @PluginMethod fun pauseMonitoring(call: PluginCall) { send(VibrationDetectionService.ACTION_PAUSE); call.resolve() }
    @PluginMethod fun resumeMonitoring(call: PluginCall) { send(VibrationDetectionService.ACTION_RESUME); call.resolve() }
    @PluginMethod fun stopMonitoring(call: PluginCall) { send(VibrationDetectionService.ACTION_STOP); call.resolve() }

    @PluginMethod
    fun updateSettings(call: PluginCall) {
        // Re-send settings; the running service re-reads them on the START action.
        val intent = Intent(context, VibrationDetectionService::class.java)
            .setAction(VibrationDetectionService.ACTION_START)
            .putExtra(VibrationDetectionService.EXTRA_SETTINGS, call.data.toString())
        if (VibrationDetectionService.running) ContextCompat.startForegroundService(context, intent)
        call.resolve()
    }

    @PluginMethod
    fun getMonitoringState(call: PluginCall) {
        call.resolve(
            JSObject()
                .put("state", VibrationDetectionService.state)
                .put("running", VibrationDetectionService.running)
                .put("elapsedMs", if (VibrationDetectionService.running) android.os.SystemClock.elapsedRealtime() - VibrationDetectionService.startedAt else 0)
        )
    }

    @PluginMethod
    fun getLatestMetrics(call: PluginCall) {
        call.resolve(JSObject().put("score", VibrationDetectionService.lastScore).put("state", VibrationDetectionService.state))
    }

    private fun send(action: String) {
        context.startService(Intent(context, VibrationDetectionService::class.java).setAction(action))
    }

    override fun handleOnDestroy() {
        MotionEventBus.sink = null
        super.handleOnDestroy()
    }
}
