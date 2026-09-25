package app.jjibom.motion;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * Notification channels and builders for the detection service.
 *  - "입질 감시" (low importance): the ongoing foreground-service notification,
 *    with pause/resume and stop actions and an elapsed-time chronometer.
 *  - "입질 알림" (high importance, heads-up): one per bite. The channel itself is
 *    silent because AlarmPlayer plays the sound/vibration (so the self-vibration
 *    guard covers exactly what we emit). No full-screen intent, no DND bypass.
 */
final class MonitoringNotification {
    private MonitoringNotification() {}

    static final String CHANNEL_MONITORING = "jjibom.monitoring";
    static final String CHANNEL_BITE = "jjibom.bite";
    static final int ID_ONGOING = 1001;
    static final int ID_BITE = 1002;
    private static final int COLOR = 0xFF4FE0B8;

    static void ensureChannels(Context ctx) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        if (nm == null) return;
        NotificationChannel monitoring = new NotificationChannel(CHANNEL_MONITORING, "입질 감시",
                NotificationManager.IMPORTANCE_LOW);
        monitoring.setDescription("진동 감시가 켜져 있는 동안 표시돼요. 여기서 일시 정지하거나 끌 수 있어요.");
        monitoring.setShowBadge(false);
        NotificationChannel bite = new NotificationChannel(CHANNEL_BITE, "입질 알림",
                NotificationManager.IMPORTANCE_HIGH);
        bite.setDescription("입질이 감지되면 표시돼요. 소리와 진동은 앱의 알람 설정을 따라요.");
        bite.setSound(null, null);
        bite.enableVibration(false);
        bite.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        nm.createNotificationChannel(monitoring);
        nm.createNotificationChannel(bite);
    }

    @SuppressWarnings("deprecation")
    private static Notification.Builder builder(Context ctx, String channel) {
        return Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(ctx, channel) : new Notification.Builder(ctx);
    }

    private static PendingIntent serviceAction(Context ctx, String action) {
        Intent intent = new Intent(ctx, VibrationDetectionService.class).setAction(action);
        return PendingIntent.getService(ctx, action.hashCode(), intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    static PendingIntent openApp(Context ctx) {
        Intent launch = new Intent(ctx, MainActivity.class)
                .setAction(Intent.ACTION_MAIN)
                .addCategory(Intent.CATEGORY_LAUNCHER)
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        return PendingIntent.getActivity(ctx, 0, launch,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    static String stateText(String state, int sensitivity) {
        switch (state) {
            case "calibrating": return "보정 중 · 6초 동안 낚싯대를 건드리지 마세요";
            case "possible_bite": return "입질 가능성 · 지켜보는 중";
            case "alarm": return "입질 감지!";
            case "cooldown": return "알람 직후 · 잠시 후 다시 감시해요";
            case "stabilizing": return "폰이 움직였어요 · 멈추면 그 각도에서 다시 감시";
            case "paused": return "일시 정지됨";
            case "error": return "센서 신호가 끊겼어요 · 폰과 거치 상태를 확인하세요";
            default: return "진동 감시 중 · 민감도 " + sensitivity;
        }
    }

    @SuppressWarnings("deprecation")
    static Notification ongoing(Context ctx, String state, int sensitivity, long startedAtWallMs) {
        boolean paused = "paused".equals(state);
        Notification.Builder b = builder(ctx, CHANNEL_MONITORING)
                .setSmallIcon(R.drawable.ic_stat_jjibom)
                .setColor(COLOR)
                .setContentTitle("찌봄 · 입질 감시")
                .setContentText(stateText(state, sensitivity))
                .setContentIntent(openApp(ctx))
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setShowWhen(true)
                .setWhen(startedAtWallMs)
                .setUsesChronometer(true)
                .setCategory(Notification.CATEGORY_SERVICE)
                .setVisibility(Notification.VISIBILITY_PUBLIC)
                .setPriority(Notification.PRIORITY_LOW);
        b.addAction(new Notification.Action.Builder(null, paused ? "다시 시작" : "일시 정지",
                serviceAction(ctx, paused ? VibrationDetectionService.ACTION_RESUME : VibrationDetectionService.ACTION_PAUSE)).build());
        b.addAction(new Notification.Action.Builder(null, "감시 종료",
                serviceAction(ctx, VibrationDetectionService.ACTION_STOP)).build());
        if (Build.VERSION.SDK_INT >= 31) b.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE);
        return b.build();
    }

    static String patternLabel(String pattern) {
        switch (pattern) {
            case "strong_pull": return "강한 당김";
            case "tap": return "토독 입질";
            case "repeated": return "반복 입질";
            default: return "입질";
        }
    }

    @SuppressWarnings("deprecation")
    static Notification bite(Context ctx, String pattern, int score, long epochMs) {
        String time = new SimpleDateFormat("HH:mm:ss", Locale.KOREA).format(new Date(epochMs));
        return builder(ctx, CHANNEL_BITE)
                .setSmallIcon(R.drawable.ic_stat_jjibom)
                .setColor(0xFFFF5A4E)
                .setContentTitle("입질! " + patternLabel(pattern))
                .setContentText("감지 강도 " + score + " · " + time + " · 눌러서 확인")
                .setContentIntent(openApp(ctx))
                .setDeleteIntent(serviceAction(ctx, VibrationDetectionService.ACTION_ACK))
                .addAction(new Notification.Action.Builder(null, "알람 끄기",
                        serviceAction(ctx, VibrationDetectionService.ACTION_ACK)).build())
                .setAutoCancel(true)
                .setCategory(Notification.CATEGORY_ALARM)
                .setVisibility(Notification.VISIBILITY_PUBLIC)
                .setPriority(Notification.PRIORITY_MAX)
                .setShowWhen(true)
                .setWhen(epochMs)
                .build();
    }
}
