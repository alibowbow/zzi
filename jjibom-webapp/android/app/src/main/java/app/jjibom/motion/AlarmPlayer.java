package app.jjibom.motion;

import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioTrack;
import android.os.Build;
import android.os.Handler;
import android.os.VibrationAttributes;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.os.VibratorManager;

/**
 * Plays the bite alarm: a synthesised tone pattern on the ALARM audio stream
 * (loud, and not silenced by the ringer switch) plus a vibration pattern, for a
 * bounded time. The same three tone presets exist in the web app (alarm.js).
 */
final class AlarmPlayer {
    private static final int RATE = 44100;
    private static final long[] VIBRATION = {0, 420, 160, 420, 160, 760, 380};

    private final Context ctx;
    private final Handler handler;
    private AudioTrack track;
    private Vibrator vibrator;
    private boolean active;
    private final Runnable autoStop = this::stop;

    AlarmPlayer(Context ctx, Handler handler) {
        this.ctx = ctx.getApplicationContext();
        this.handler = handler;
    }

    boolean isActive() {
        return active;
    }

    void start(boolean sound, boolean vibration, String tone, long durationMs) {
        stop();
        active = true;
        if (sound) startTone(tone);
        if (vibration) startVibration();
        handler.postDelayed(autoStop, Math.max(500, durationMs));
    }

    void stop() {
        handler.removeCallbacks(autoStop);
        active = false;
        if (track != null) {
            try {
                track.pause();
                track.flush();
                track.stop();
            } catch (IllegalStateException ignored) {
                // already stopped
            }
            track.release();
            track = null;
        }
        if (vibrator != null) {
            vibrator.cancel();
            vibrator = null;
        }
    }

    private void startTone(String tone) {
        short[] pcm = pattern(tone);
        try {
            AudioTrack t = new AudioTrack.Builder()
                    .setAudioAttributes(new AudioAttributes.Builder()
                            .setUsage(AudioAttributes.USAGE_ALARM)
                            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                            .build())
                    .setAudioFormat(new AudioFormat.Builder()
                            .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                            .setSampleRate(RATE)
                            .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                            .build())
                    .setTransferMode(AudioTrack.MODE_STATIC)
                    .setBufferSizeInBytes(pcm.length * 2)
                    .build();
            t.write(pcm, 0, pcm.length);
            t.setLoopPoints(0, pcm.length, -1);
            t.play();
            track = t;
        } catch (RuntimeException e) {
            // No audio output available — vibration and the notification still alert.
            track = null;
        }
    }

    @SuppressWarnings("deprecation")
    private void startVibration() {
        Vibrator v;
        if (Build.VERSION.SDK_INT >= 31) {
            VibratorManager vm = (VibratorManager) ctx.getSystemService(Context.VIBRATOR_MANAGER_SERVICE);
            v = vm != null ? vm.getDefaultVibrator() : null;
        } else {
            v = (Vibrator) ctx.getSystemService(Context.VIBRATOR_SERVICE);
        }
        if (v == null || !v.hasVibrator()) return;
        vibrator = v;
        if (Build.VERSION.SDK_INT >= 33) {
            v.vibrate(VibrationEffect.createWaveform(VIBRATION, 0),
                    VibrationAttributes.createForUsage(VibrationAttributes.USAGE_ALARM));
        } else if (Build.VERSION.SDK_INT >= 26) {
            v.vibrate(VibrationEffect.createWaveform(VIBRATION, 0),
                    new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM).build());
        } else {
            v.vibrate(VIBRATION, 0);
        }
    }

    /** One loop of the chosen preset (about a second), as 16-bit mono PCM. */
    static short[] pattern(String tone) {
        if ("siren".equals(tone)) return siren();
        if ("beep".equals(tone)) return notes(new double[] {1320, 0, 1320, 0, 1320}, new int[] {150, 90, 150, 90, 150}, 420);
        return notes(new double[] {880, 0, 1175, 0, 1568}, new int[] {170, 60, 170, 60, 260}, 360);
    }

    private static short[] notes(double[] freqs, int[] ms, int tailMs) {
        int total = tailMs;
        for (int m : ms) total += m;
        short[] out = new short[RATE * total / 1000];
        int pos = 0;
        for (int n = 0; n < freqs.length; n++) {
            int len = RATE * ms[n] / 1000;
            for (int i = 0; i < len && pos < out.length; i++, pos++) {
                if (freqs[n] <= 0) continue;
                double env = Math.min(1, Math.min(i, len - i) / (RATE * 0.006)); // 6 ms fades: no clicks
                double s = Math.sin(2 * Math.PI * freqs[n] * i / RATE);
                double square = Math.signum(s) * 0.35 + s * 0.65;             // a little edge carries outdoors
                out[pos] = (short) (square * env * 0.92 * Short.MAX_VALUE);
            }
        }
        return out;
    }

    private static short[] siren() {
        int len = RATE; // 1 s: 650 -> 1450 Hz and back
        short[] out = new short[len];
        double phase = 0;
        for (int i = 0; i < len; i++) {
            double x = (double) i / len;
            double f = 650 + 800 * (x < 0.5 ? x * 2 : (1 - x) * 2);
            phase += 2 * Math.PI * f / RATE;
            double env = Math.min(1, Math.min(i, len - i) / (RATE * 0.01));
            out[i] = (short) (Math.sin(phase) * env * 0.92 * Short.MAX_VALUE);
        }
        return out;
    }
}
