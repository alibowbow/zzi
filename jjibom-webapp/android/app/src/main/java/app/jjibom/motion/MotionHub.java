package app.jjibom.motion;

import org.json.JSONObject;

/**
 * Hand-off point between the detection service and the Capacitor plugin (no
 * bound service needed): the service publishes events and a status snapshot,
 * the plugin forwards events to JS and answers getMonitoringState() from the
 * snapshot.
 */
final class MotionHub {
    private MotionHub() {}

    interface Listener {
        void onEvent(String name, JSONObject data);
    }

    private static volatile Listener listener;

    static void setListener(Listener l) {
        listener = l;
    }

    static void emit(String name, JSONObject data) {
        Listener l = listener;
        if (l != null) l.onEvent(name, data);
    }

    // --- status snapshot (written by the service thread, read by the plugin)
    static volatile boolean running;
    static volatile String state = "idle";
    static volatile long startedAtWallMs;
    static volatile long startedAtElapsedMs;
    static volatile int score;
    static volatile String pattern = "none";
    static volatile double calibrationProgress;
    static volatile double sampleHz;
    static volatile boolean hasLinearSensor;
    static volatile boolean hasGyroscope;
    static volatile boolean alarmActive;
    static volatile int alarmCount;
    static volatile String lastError = "";

    static void resetSnapshot() {
        running = false;
        state = "idle";
        score = 0;
        pattern = "none";
        calibrationProgress = 0;
        alarmActive = false;
        alarmCount = 0;
        lastError = "";
    }
}
