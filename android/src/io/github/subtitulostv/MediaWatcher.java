package io.github.subtitulostv;

import android.content.*;
import android.content.pm.PackageManager;
import android.media.session.*;
import android.os.*;
import java.util.*;

/** Follows the media session of the app playing the film (Prime, HBO, Netflix…). Main thread only. */
public class MediaWatcher implements MediaSessionManager.OnActiveSessionsChangedListener {
    /** title / durMs = MediaMetadata (null / -1 when the app publishes none, e.g. Netflix during ads). */
    public interface Sink { void onMedia(String pkg, String label, int state, long posNow, float speed, String title, long durMs); }
    private static MediaWatcher inst;
    public static volatile boolean access = false;
    public static volatile String lastError = "";

    private final Context ctx; private final Sink sink; private final Handler h = new Handler(Looper.getMainLooper());
    private final ComponentName cn; private MediaSessionManager msm;
    private final Map<MediaController, MediaController.Callback> cbs = new HashMap<>();
    private String trackedPkg = ""; private boolean registered = false, alive = true;

    private MediaWatcher(Context c, Sink s) { ctx = c.getApplicationContext(); sink = s; cn = new ComponentName(ctx, MediaListener.class); }

    public static void start(Context c, Sink s) { start(c, "", s); }
    /** srcPkg: app that drove the clock before a restart, followed first (so "no session" is reported as that app gone). */
    public static void start(Context c, String srcPkg, Sink s) { stop(); inst = new MediaWatcher(c, s); if (srcPkg != null) inst.trackedPkg = srcPkg; inst.tryStart(); }
    public static void stop() { if (inst != null) { inst.shutdown(); inst = null; } }
    public static void kick() { final MediaWatcher w = inst; if (w != null) w.h.post(w::tryStart); }

    private final Runnable retry = this::tryStart;
    private void tryStart() {
        if (!alive || registered) return;
        try {
            msm = (MediaSessionManager) ctx.getSystemService(Context.MEDIA_SESSION_SERVICE);
            List<MediaController> l = msm.getActiveSessions(cn);
            msm.addOnActiveSessionsChangedListener(this, cn, h);
            registered = true; access = true; lastError = "";
            LocalServer.log("media watcher on, sessions=" + l.size());
            onActiveSessionsChanged(l);
        } catch (SecurityException e) {
            access = false; lastError = "sin permiso";
            h.postDelayed(retry, 5000); // user may grant it later
        } catch (Exception e) {
            access = false; lastError = e.getClass().getSimpleName();
            h.postDelayed(retry, 10000);
        }
    }

    private void shutdown() {
        alive = false; h.removeCallbacks(retry);
        if (registered) try { msm.removeOnActiveSessionsChangedListener(this); } catch (Exception ignored) { }
        for (Map.Entry<MediaController, MediaController.Callback> e : cbs.entrySet()) e.getKey().unregisterCallback(e.getValue());
        cbs.clear(); registered = false;
    }

    @Override public void onActiveSessionsChanged(List<MediaController> list) {
        if (!alive) return;
        for (Map.Entry<MediaController, MediaController.Callback> e : cbs.entrySet()) e.getKey().unregisterCallback(e.getValue());
        cbs.clear();
        if (list != null) for (final MediaController c : list) {
            if (ctx.getPackageName().equals(c.getPackageName())) continue;
            MediaController.Callback cb = new MediaController.Callback() {
                @Override public void onPlaybackStateChanged(PlaybackState s) { evaluate(); }
                @Override public void onSessionDestroyed() { evaluate(); }
                @Override public void onMetadataChanged(android.media.MediaMetadata m) { evaluate(); } // v0.4.4: content change
            };
            c.registerCallback(cb, h); cbs.put(c, cb);
        }
        evaluate();
    }

    private static boolean active(int st) { return st == 3 || st == 6 || st == 8 || st == 4 || st == 5 || st == 9 || st == 10 || st == 11; }

    /** Pick the controller: the playing one; else the one we were following; else the first (most recent) one. */
    private void evaluate() {
        MediaController best = null; int bestScore = -1;
        int i = 0;
        for (MediaController c : cbs.keySet()) {
            PlaybackState s = c.getPlaybackState(); int st = s == null ? 0 : s.getState();
            int score = st == 3 ? 400 : active(st) ? 300 : c.getPackageName().equals(trackedPkg) ? 200 : st == 2 ? 100 : 0;
            if (score > bestScore) { best = c; bestScore = score; }
            i++;
        }
        if (best == null) { sink.onMedia(trackedPkg, label(trackedPkg), -1, 0, 0, null, -1); return; }
        PlaybackState s = best.getPlaybackState();
        int st = s == null ? 0 : s.getState();
        if (bestScore == 0 && !best.getPackageName().equals(trackedPkg) && !trackedPkg.isEmpty()) {
            // nothing playing: report the app we followed as gone instead of jumping to an idle one (e.g. Spotify)
            sink.onMedia(trackedPkg, label(trackedPkg), -1, 0, 0, null, -1); return;
        }
        trackedPkg = best.getPackageName();
        long pos = 0; float sp = 0;
        if (s != null) {
            sp = s.getPlaybackSpeed(); pos = s.getPosition();
            if (st == 3 && s.getLastPositionUpdateTime() > 0) pos += (long) ((SystemClock.elapsedRealtime() - s.getLastPositionUpdateTime()) * (sp == 0 ? 1 : sp));
            if (sp == 0) sp = 1;
        }
        String title = null; long dur = -1;
        try {
            android.media.MediaMetadata md = best.getMetadata();
            if (md != null) {
                CharSequence ti = md.getText(android.media.MediaMetadata.METADATA_KEY_TITLE);
                if (ti != null && ti.length() > 0) title = ti.toString();
                long d = md.getLong(android.media.MediaMetadata.METADATA_KEY_DURATION);
                if (d > 0) dur = d;
            }
        } catch (Exception ignored) { }
        sink.onMedia(trackedPkg, label(trackedPkg), st, Math.max(0, pos), sp, title, dur);
    }

    private final Map<String, String> labels = new HashMap<>();
    private String label(String pkg) {
        if (pkg == null || pkg.isEmpty()) return "";
        String l = labels.get(pkg); if (l != null) return l;
        try { PackageManager pm = ctx.getPackageManager(); l = pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0)).toString(); }
        catch (Exception e) { l = pkg; }
        if (pkg.startsWith("com.amazon.amazonvideo")) l = "Prime Video";
        labels.put(pkg, l); return l;
    }
}
