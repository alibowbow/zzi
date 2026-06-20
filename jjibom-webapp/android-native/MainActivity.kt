// Replace the generated android/app/src/main/java/app/jjibom/motion/MainActivity.kt
// with this so the local plugin is registered. (Capacitor generates MainActivity
// in the appId package, app.jjibom.motion.)
package app.jjibom.motion

import android.os.Bundle
import com.getcapacitor.BridgeActivity

class MainActivity : BridgeActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        // Register the local plugin BEFORE super.onCreate so it is available to the
        // WebView bridge on first load.
        registerPlugin(JjibomMotionPlugin::class.java)
        super.onCreate(savedInstanceState)
    }
}
