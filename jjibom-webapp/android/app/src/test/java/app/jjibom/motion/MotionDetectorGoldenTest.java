package app.jjibom.motion;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

import org.junit.Test;

/**
 * Replays the synthetic sensor streams of scripts/export-motion-golden.mjs
 * through MotionEngine and checks every tick against the web detector's
 * verdicts in motion-golden.txt. Regenerate the file with
 * `node scripts/export-motion-golden.mjs` after changing detection logic.
 */
public class MotionDetectorGoldenTest {

    private static final double TICK_MS = 60;
    private static final double END_MS = 60000;
    private static final double[] SEG_START = {0, 9000, 10000, 19000, 20000, 30000, 36000, 39000, 42000, 44000, 47000};
    private static final String[] SEG_MODE = {"calm", "pull", "calm", "tap2", "calm", "wind", "touch", "calm", "dropout", "calm", "touch"};

    /** mulberry32, bit-identical to the JS generator. */
    private static final class Rng {
        private int a;

        Rng(int seed) {
            a = seed;
        }

        double next() {
            a = a + 0x6D2B79F5;
            int t = (a ^ (a >>> 15)) * (1 | a);
            t = (t + ((t ^ (t >>> 7)) * (61 | t))) ^ t;
            return ((t ^ (t >>> 14)) & 0xFFFFFFFFL) / 4294967296.0;
        }
    }

    private static double bump(double t, double c, double w) {
        double d = (t - c) / w;
        return StrictMath.exp(-(d * d));
    }

    private static final class Event {
        double t;
        double[] acc;
        double[] incl;
        double[] rotDeg;
    }

    private static List<Event> rawEvents(int hz, boolean gravityOnly) {
        Rng rnd = new Rng(hz * 1000 + (gravityOnly ? 7 : 3));
        List<Event> events = new ArrayList<>();
        double tilt = 0;
        for (int i = 0; ; i++) {
            double t = i * (1000.0 / hz);
            if (t > END_MS) break;
            int seg = 0;
            for (int s = 0; s < SEG_START.length; s++) if (t >= SEG_START[s]) seg = s;
            String mode = SEG_MODE[seg];
            if (mode.equals("dropout")) continue;
            if (!mode.equals("touch")) tilt = 0;
            double tm = t - SEG_START[seg];
            double ax = (rnd.next() - 0.5) * 0.03;
            double ay = (rnd.next() - 0.5) * 0.03;
            double az = (rnd.next() - 0.5) * 0.03;
            double rot = (rnd.next() - 0.5) * 1;
            if (mode.equals("pull")) {
                ax += 5 * bump(tm, 150, 60) + (tm > 200 && tm < 700 ? 0.6 : 0);
                rot += 25 * bump(tm, 150, 70);
            }
            if (mode.equals("tap2")) {
                ax += 1.6 * bump(tm, 150, 30) + 1.5 * bump(tm, 390, 30);
                rot += 8 * bump(tm, 150, 30);
            }
            if (mode.equals("wind")) {
                ax += 0.15 * StrictMath.sin(tm * 0.0057);
                ay += 0.06 * StrictMath.sin(tm * 0.0126);
                rot += 3 * StrictMath.sin(tm * 0.0057);
            }
            if (mode.equals("touch")) {
                ax += 12 * bump(tm, 150, 40);
                if (tm > 150) tilt = 20;
                rot += 40 * bump(tm, 150, 45);
            }
            double tr = tilt * Math.PI / 180;
            double gx = 9.81 * StrictMath.sin(tr);
            double gz = 9.81 * StrictMath.cos(tr);
            Event e = new Event();
            e.t = t;
            e.acc = gravityOnly ? null : new double[] {ax, ay, az};
            e.incl = new double[] {ax + gx, ay, az + gz};
            e.rotDeg = new double[] {rot, rot * 0.5, rot * 0.3};
            events.add(e);
        }
        return events;
    }

    private static final class Variant {
        int hz;
        boolean gravityOnly;
        String[] baseline;
        final List<String[]> ticks = new ArrayList<>();
    }

    private static List<Variant> loadGolden() throws Exception {
        InputStream in = MotionDetectorGoldenTest.class.getClassLoader().getResourceAsStream("motion-golden.txt");
        assertTrue("motion-golden.txt on the test classpath", in != null);
        List<Variant> variants = new ArrayList<>();
        try (BufferedReader r = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8))) {
            String line;
            Variant cur = null;
            while ((line = r.readLine()) != null) {
                if (line.isEmpty() || line.startsWith("#")) continue;
                String[] p = line.split(" ");
                if (p[0].equals("V")) {
                    cur = new Variant();
                    cur.hz = Integer.parseInt(p[1]);
                    cur.gravityOnly = p[2].equals("1");
                    variants.add(cur);
                } else if (p[0].equals("B")) {
                    cur.baseline = p;
                } else if (p[0].equals("T")) {
                    cur.ticks.add(p);
                }
            }
        }
        return variants;
    }

    @Test
    public void nativeDetectorMatchesTheWebDetector() throws Exception {
        List<Variant> variants = loadGolden();
        assertEquals(4, variants.size());
        StringBuilder mismatches = new StringBuilder();
        int compared = 0;
        int alarms = 0;

        for (Variant v : variants) {
            MotionEngine engine = new MotionEngine();
            engine.setHasLinearSensor(!v.gravityOnly);
            engine.setSettings(5, "all");
            engine.startCalibration(0);
            List<Event> events = rawEvents(v.hz, v.gravityOnly);
            int ei = 0;

            while (ei < events.size() && events.get(ei).t <= MotionConst.CALIB_MS) feed(engine, events.get(ei++));
            MotionEngine.Tick calib = engine.tick(MotionConst.CALIB_MS);
            assertTrue("calibration finished", calib.calibration != null);
            assertEquals(v.baseline[1].equals("1"), calib.calibration.ok);
            MotionDetector.Baseline b = calib.calibration.stats;
            double[] expected = new double[5];
            for (int i = 0; i < 5; i++) expected[i] = Double.parseDouble(v.baseline[i + 2]);
            double[] actual = {b.accelMedian, b.accelMad, b.gyroMedian, b.gyroMad, b.baseTilt};
            for (int i = 0; i < 5; i++) {
                assertEquals("baseline[" + i + "] @" + v.hz + "Hz", expected[i], actual[i], 1e-6 + Math.abs(expected[i]) * 1e-6);
            }

            double alarmAt = Double.NEGATIVE_INFINITY;
            int k = 0;
            for (double now = MotionConst.CALIB_MS + TICK_MS; now <= END_MS; now += TICK_MS) {
                while (ei < events.size() && events.get(ei).t <= now) feed(engine, events.get(ei++));
                MotionEngine.Tick t = engine.tick(now);
                if (engine.state() == MotionDetector.State.ALARM && t.alarm) alarmAt = now;
                if (engine.state() == MotionDetector.State.ALARM && now - alarmAt >= 1000) engine.dismissAlarm(now);

                String[] g = v.ticks.get(k++);
                compared++;
                int score = Integer.parseInt(g[2]);
                boolean alarm = g[5].equals("1");
                if (alarm) alarms++;
                boolean same = Math.abs(score - t.score) <= 1
                        && g[3].equals(t.pattern)
                        && g[4].equals(t.contact ? "1" : "0")
                        && alarm == t.alarm
                        && g[6].equals(engine.state().id);
                if (!same) {
                    mismatches.append(String.format("%dHz%s t=%s web[%s %s c%s a%s %s] native[%d %s c%s a%s %s]%n",
                            v.hz, v.gravityOnly ? "/g" : "", g[1], g[2], g[3], g[4], g[5], g[6],
                            t.score, t.pattern, t.contact ? 1 : 0, t.alarm ? 1 : 0, engine.state().id));
                }
            }
            assertEquals("every golden tick replayed", v.ticks.size(), k);
        }
        assertTrue("golden file has alarms to compare", alarms >= 8);
        assertEquals("ticks that differ from the web detector (of " + compared + "):\n" + mismatches, 0, mismatches.length());
    }

    private static void feed(MotionEngine engine, Event e) {
        engine.onGyro(e.rotDeg[0] * Math.PI / 180, e.rotDeg[1] * Math.PI / 180, e.rotDeg[2] * Math.PI / 180);
        engine.onAccel(e.t, e.incl[0], e.incl[1], e.incl[2]);
        if (e.acc != null) engine.onLinear(e.t, e.acc[0], e.acc[1], e.acc[2]);
    }
}
