package app.jjibom.motion

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build

/**
 * Notification channels + builders for the vibration-detection service.
 *  - An ONGOING low-importance channel for the "monitoring" notification
 *    (with Pause / Stop actions).
 *  - A high-importance channel for the bite alert (heads-up, sound, vibration).
 * No Full Screen Intent is used and Do-Not-Disturb is not bypassed.
 */
object MonitoringNotification {
    const val ONGOING_CHANNEL = "jjibom_monitoring"
    const val ALERT_CHANNEL = "jjibom_bite_alert"
    const val ONGOING_ID = 1001
    const val ALERT_ID = 1002

    fun ensureChannels(ctx: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = ctx.getSystemService(NotificationManager::class.java)
        val ongoing = NotificationChannel(ONGOING_CHANNEL, "입질 감시", NotificationManager.IMPORTANCE_LOW).apply {
            description = "진동 감지가 실행 중임을 알려요."
            setShowBadge(false)
        }
        val alert = NotificationChannel(ALERT_CHANNEL, "입질 알림", NotificationManager.IMPORTANCE_HIGH).apply {
            description = "입질이 감지되면 소리와 진동으로 알려요."
            enableVibration(true)
            vibrationPattern = longArrayOf(0, 280, 120, 280, 120, 620)
        }
        nm.createNotificationChannel(ongoing)
        nm.createNotificationChannel(alert)
    }

    private fun action(ctx: Context, label: String, act: String): Notification.Action {
        val intent = Intent(ctx, VibrationDetectionService::class.java).setAction(act)
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        val pi = PendingIntent.getService(ctx, act.hashCode(), intent, flags)
        return Notification.Action.Builder(null, label, pi).build()
    }

    private fun openAppIntent(ctx: Context): PendingIntent {
        val launch = ctx.packageManager.getLaunchIntentForPackage(ctx.packageName)
        return PendingIntent.getActivity(
            ctx, 0, launch, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
    }

    fun ongoing(ctx: Context, paused: Boolean, sensitivityLabel: String): Notification {
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
            Notification.Builder(ctx, ONGOING_CHANNEL) else @Suppress("DEPRECATION") Notification.Builder(ctx)
        builder.setContentTitle("찌봄이 입질을 감시하고 있어요")
            .setContentText(if (paused) "일시 정지됨 · 민감도 $sensitivityLabel" else "진동 감지 중 · 민감도 $sensitivityLabel")
            .setSmallIcon(android.R.drawable.ic_menu_compass)
            .setOngoing(true)
            .setContentIntent(openAppIntent(ctx))
            .setOnlyAlertOnce(true)
        if (paused) builder.addAction(action(ctx, "다시 시작", VibrationDetectionService.ACTION_RESUME))
        else builder.addAction(action(ctx, "일시 정지", VibrationDetectionService.ACTION_PAUSE))
        builder.addAction(action(ctx, "종료", VibrationDetectionService.ACTION_STOP))
        return builder.build()
    }

    fun alert(ctx: Context, pattern: String, score: Int): Notification {
        val label = when (pattern) {
            "strong_pull" -> "강한 당김"; "tap" -> "토독 입질"; "repeated" -> "반복 입질"; else -> "입질"
        }
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
            Notification.Builder(ctx, ALERT_CHANNEL) else @Suppress("DEPRECATION") Notification.Builder(ctx)
        return builder.setContentTitle("입질 감지! ($label)")
            .setContentText("감지 강도 $score · ${timeNow()}")
            .setSmallIcon(android.R.drawable.ic_menu_compass)
            .setAutoCancel(true)
            .setContentIntent(openAppIntent(ctx))
            .build()
    }

    private fun timeNow(): String {
        val c = java.util.Calendar.getInstance()
        return String.format("%02d:%02d:%02d", c.get(11), c.get(12), c.get(13))
    }
}
