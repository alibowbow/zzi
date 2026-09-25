package app.jjibom.motion;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;

/**
 * Persists bite events detected by the service (so events that happened while
 * the WebView was paused or the app was closed reach the history later) and the
 * last monitoring settings. Only stored on the device; nothing is uploaded.
 */
final class MotionEventStore {
    private MotionEventStore() {}

    private static final String PREFS = "jjibom_motion";
    private static final String KEY_EVENTS = "events";
    private static final String KEY_SETTINGS = "settings";
    private static final int MAX_EVENTS = 200;

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static String isoNow(long epochMs) {
        SimpleDateFormat f = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);
        f.setTimeZone(TimeZone.getTimeZone("UTC"));
        return f.format(new Date(epochMs));
    }

    static synchronized JSONObject add(Context ctx, String pattern, int score, boolean screenOn) {
        long now = System.currentTimeMillis();
        JSONObject e = new JSONObject();
        try {
            e.put("id", "n-" + now);
            e.put("timestamp", isoNow(now));
            e.put("epochMs", now);
            e.put("mode", "motion");
            e.put("source", "native");
            e.put("pattern", pattern);
            e.put("score", score);
            e.put("screenOn", screenOn);
        } catch (JSONException ignored) {
            // keys and values are plain; cannot fail
        }
        JSONArray all = all(ctx);
        JSONArray next = new JSONArray();
        int start = Math.max(0, all.length() - (MAX_EVENTS - 1));
        for (int i = start; i < all.length(); i++) next.put(all.opt(i));
        next.put(e);
        prefs(ctx).edit().putString(KEY_EVENTS, next.toString()).apply();
        return e;
    }

    static synchronized JSONArray all(Context ctx) {
        try {
            return new JSONArray(prefs(ctx).getString(KEY_EVENTS, "[]"));
        } catch (JSONException e) {
            return new JSONArray();
        }
    }

    static synchronized void clear(Context ctx) {
        prefs(ctx).edit().remove(KEY_EVENTS).apply();
    }

    static void saveSettings(Context ctx, JSONObject settings) {
        prefs(ctx).edit().putString(KEY_SETTINGS, settings.toString()).apply();
    }

    static JSONObject loadSettings(Context ctx) {
        try {
            return new JSONObject(prefs(ctx).getString(KEY_SETTINGS, "{}"));
        } catch (JSONException e) {
            return new JSONObject();
        }
    }
}
