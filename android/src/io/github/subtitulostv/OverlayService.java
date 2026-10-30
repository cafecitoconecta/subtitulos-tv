package io.github.subtitulostv;

import android.app.*;
import android.content.*;
import android.graphics.*;
import android.graphics.drawable.GradientDrawable;
import android.os.*;
import android.util.TypedValue;
import android.view.*;
import android.widget.TextView;
import org.json.*;
import java.io.*;
import java.net.*;

/** Draws subtitles on top of every app and keeps them in sync with messages from the relay. */
public class OverlayService extends Service {
    public static final String ACTION_STOP = "stop";
    public static volatile String status = "";
    static volatile boolean connectedStatus = false;
    public static volatile boolean running = false;
    // snapshot for /api/status (written on the UI thread)
    public static volatile int cueCount = 0;
    public static volatile String title = "", curText = "", nextText = "", stateNow = "stopped";
    public static volatile long posNow = 0, nextIn = -1, startedAt = 0, lastTick = 0;
    // v0.4.4 power: gen changes on every explicit subtitle load and every switch-off (the phone drops an old track on mismatch)
    public static volatile long gen = 0; public static volatile String offText = "";
    public static String statusJson() {
        try {
            JSONObject o = new JSONObject();
            o.put("ok", true).put("tvConnected", true).put("tvs", 1).put("serverNow", System.currentTimeMillis())
             .put("overlayAlive", running && System.currentTimeMillis() - lastTick < 2000)
             .put("uptimeS", startedAt == 0 ? 0 : (System.currentTimeMillis() - startedAt) / 1000)
             .put("cues", cueCount).put("title", title).put("state", stateNow).put("pos", posNow)
             .put("text", curText).put("next", nextText).put("nextIn", nextIn).put("gen", gen);
            SubClock c = clockRef;
            if (c != null) o.put("power", c.off ? "off" : "on").put("offCode", c.off ? c.offReason : "").put("offReason", c.off ? offText : "")
                             .put("offAt", c.off ? c.offAt : 0).put("armed", c.armed).put("srcTitle", c.srcTitle);
            if (c != null) {
                long now = System.currentTimeMillis();
                o.put("held", c.held(now)).put("epoch", c.epoch).put("anchor", c.mediaAnchor ? "media" : "clock")
                 .put("hiddenByMedia", c.hiddenByMedia() && "locked".equals(c.syncState));
                JSONObject m = new JSONObject();
                m.put("access", MediaWatcher.access).put("listener", MediaListener.connected).put("error", MediaWatcher.lastError)
                 .put("pkg", c.pkg).put("app", c.label).put("raw", c.raw).put("state", SubClock.stateEs(c.raw))
                 .put("kind", new String[]{"unknown", "playing", "held", "stopped"}[c.media])
                 .put("src", c.srcPkg).put("srcApp", c.srcLabel).put("srcGone", c.srcGone() && "locked".equals(c.syncState))
                 .put("autoPause", c.autoPause).put("autoSync", c.autoSync).put("anchors", c.anchors);
                o.put("media", m);
                o.put("hiddenByAd", c.hiddenByAd() && "locked".equals(c.syncState));
                JSONObject a = new JSONObject();
                a.put("adPause", c.adPause).put("clockAd", c.ad).put("adTotal", c.adTotal).put("adCount", c.adCount).put("lastAdMs", c.lastAdMs);
                o.put("a11y", a);
                JSONObject ad = new JSONObject(); // v0.4 manual "Anuncio" button
                ad.put("on", c.ad).put("manual", c.adManual).put("elapsed", c.ad && c.adSince >= 0 ? Math.max(0, now - c.adSince) : 0)
                  .put("count", c.adCount).put("total", c.adTotal).put("last", c.lastAdMs);
                o.put("ad", ad);
            }
            return o.toString();
        } catch (JSONException e) { return "{\"ok\":true,\"tvConnected\":true}"; }
    }

    private WindowManager wm;
    private TextView tv;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private volatile boolean alive;
    private Thread sseThread, clockThread;

    // subtitle state (main thread only)
    private long[] cs = new long[0], ce = new long[0];
    private String[] ct = new String[0];
    private static volatile SubClock clockRef;
    private SubClock clock = new SubClock(System.currentTimeMillis());
    private String tempText; private long tempUntil;
    private float sizeUnits = 48;
    private volatile long serverOffset = 0; // serverNow - System.currentTimeMillis()
    private volatile long bestRtt = Long.MAX_VALUE;

    @Override public IBinder onBind(Intent i) { return null; }

    @Override public int onStartCommand(Intent intent, int flags, int startId) { L.init(this);
        if (intent != null && ACTION_STOP.equals(intent.getAction())) { stopSelf(); return START_NOT_STICKY; }
        startForegroundCompat();
        if (tv == null) addOverlay();
        if (!alive) { alive = true; startThreads(); ui.post(tick); }
        running = true;
        return START_STICKY;
    }

    private void startForegroundCompat() {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        nm.createNotificationChannel(new NotificationChannel("subs", getString(R.string.channel), NotificationManager.IMPORTANCE_LOW));
        Notification n = new Notification.Builder(this, "subs").setContentTitle(getString(R.string.notif_title))
                .setSmallIcon(android.R.drawable.ic_menu_info_details).build();
        startForeground(1, n);
    }

    private void addOverlay() {
        wm = (WindowManager) getSystemService(WINDOW_SERVICE);
        tv = new TextView(this);
        tv.setTextColor(Color.WHITE);
        tv.setTypeface(Typeface.create(Typeface.SANS_SERIF, Typeface.BOLD));
        tv.setGravity(Gravity.CENTER);
        tv.setShadowLayer(6, 0, 0, Color.BLACK);
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(0xB0000000); bg.setCornerRadius(14);
        tv.setBackground(bg);
        int h = getResources().getDisplayMetrics().heightPixels;
        int pad = h / 90;
        tv.setPadding(pad * 2, pad, pad * 2, pad);
        tv.setMaxWidth(getResources().getDisplayMetrics().widthPixels * 85 / 100);
        applySize();
        tv.setVisibility(View.GONE);
        WindowManager.LayoutParams lp = new WindowManager.LayoutParams(
                WindowManager.LayoutParams.WRAP_CONTENT, WindowManager.LayoutParams.WRAP_CONTENT,
                WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
                        | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
                PixelFormat.TRANSLUCENT);
        lp.gravity = Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL;
        lp.y = h * 7 / 100;
        wm.addView(tv, lp);
    }

    private void applySize() {
        if (tv == null) return;
        int h = getResources().getDisplayMetrics().heightPixels;
        tv.setTextSize(TypedValue.COMPLEX_UNIT_PX, sizeUnits * h / 1080f);
    }

    private long serverNow() { return System.currentTimeMillis() + serverOffset; }

    private final Runnable tick = new Runnable() {
        @Override public void run() {
            if (!alive) return;
            String text = null;
            long now = serverNow();
            String lbl = clock.srcLabel;
            if (clock.tick(now)) wipe(lbl); // v0.4.4: source closed and not back within the grace -> switched off for good
            if (clock.off) { // off: nothing on screen, no overlay window at all
                removeOverlay(); stateNow = "off"; curText = ""; lastTick = System.currentTimeMillis();
                ui.postDelayed(this, 40); return;
            }
            if (tv == null) addOverlay();
            if (tempText != null && now < tempUntil) text = tempText;
            else if ("locked".equals(clock.syncState) && cs.length > 0) { text = computeNow(now); if (clock.hiddenByMedia() || clock.hiddenByAd()) { text = null; curText = ""; } }
            else { stateNow = clock.syncState; curText = ""; }
            lastTick = System.currentTimeMillis();
            if (text == null) { if (tv.getVisibility() != View.GONE) tv.setVisibility(View.GONE); }
            else {
                if (!text.contentEquals(tv.getText())) tv.setText(text);
                if (tv.getVisibility() != View.VISIBLE) tv.setVisibility(View.VISIBLE);
            }
            ui.postDelayed(this, 40);
        }
    };

    /** Current line for the locked timeline; also refreshes the status snapshot. Keeps ticking on the TV clock without the phone. */
    private String computeNow(long now) {
        stateNow = clock.syncState;
        if ("paused".equals(clock.syncState) && !clock.mediaAnchor) posNow = clock.syncPos; // v0.4.2: report the paused position
        if (!"locked".equals(clock.syncState) || cs.length == 0) { curText = ""; return null; }
        long p = clock.pos(now);
        posNow = p;
        int i = find(p);
        curText = i >= 0 ? ct[i] : "";
        int lo = 0, hi = cs.length; while (lo < hi) { int m = (lo + hi) >>> 1; if (cs[m] <= p) lo = m + 1; else hi = m; }
        if (lo < cs.length) { nextText = ct[lo]; nextIn = cs[lo] - p; } else { nextText = ""; nextIn = -1; }
        return i >= 0 ? ct[i] : null;
    }

    private void saveState(String cuesJson) {
        try {
            if (cuesJson != null) try (FileOutputStream f = openFileOutput("cues.json", MODE_PRIVATE)) { f.write(cuesJson.getBytes("UTF-8")); }
            getSharedPreferences("sync", MODE_PRIVATE).edit().putString("state", clock.syncState).putLong("pos", clock.pos(serverNow()))
                    .putLong("at", serverNow()).putBoolean("frozen", clock.holding())
                    .putString("srcPkg", clock.srcPkg).putString("srcLabel", clock.srcLabel)
                    .putBoolean("armed", clock.armed).putBoolean("off", clock.off).apply();
        } catch (Exception e) { LocalServer.log("save failed " + e); }
    }

    private void saveAds() {
        getSharedPreferences("sync", MODE_PRIVATE).edit().putLong("adTotal", clock.adTotal).putLong("adCount", clock.adCount)
                .putBoolean("adManual", clock.ad && clock.adManual).apply();
    }

    private static String offText(String code, String label) {
        String app = label == null || label.isEmpty() ? L.s(R.string.the_app) : label;
        switch (code) {
            case SubClock.OFF_CLOSED: return L.s(R.string.off_closed, app);
            case SubClock.OFF_CONTENT: return L.s(R.string.off_content, app);
            case SubClock.OFF_OTHER: return L.s(R.string.off_other);
            default: return L.s(R.string.off_user);
        }
    }

    /** v0.4.4 ⏻: the clock is already off; forget the film everywhere (memory, cues.json, sync prefs) and drop the overlay.
     *  cfg (autoPause/autoSync/size/token) stays. The service and the local server keep running for the phone. */
    private void wipe(String label) {
        long now = serverNow();
        if (!clock.off) clock.powerOff(SubClock.OFF_USER, now);
        offText = offText(clock.offReason, label);
        cs = new long[0]; ce = new long[0]; ct = new String[0]; cueCount = 0; title = "";
        curText = ""; nextText = ""; nextIn = -1; posNow = 0; stateNow = "off"; tempText = null;
        deleteFile("cues.json");
        SharedPreferences cfg = getSharedPreferences("cfg", MODE_PRIVATE);
        gen = cfg.getLong("gen", 0) + 1; cfg.edit().putLong("gen", gen).apply();
        getSharedPreferences("sync", MODE_PRIVATE).edit().clear().putBoolean("off", true).putString("offCode", clock.offReason)
                .putString("offText", offText).putLong("offAt", clock.offAt).apply();
        removeOverlay();
        status = L.s(R.string.st_off_fmt, offText);
        LocalServer.log("POWER OFF (" + clock.offReason + "): " + offText + " · film, clock, offset, ads and source app wiped");
    }

    private void removeOverlay() {
        if (tv != null) { try { wm.removeView(tv); } catch (Exception ignored) { } tv = null; }
    }

    private void restoreState() {
        SharedPreferences sp0 = getSharedPreferences("sync", MODE_PRIVATE);
        gen = getSharedPreferences("cfg", MODE_PRIVATE).getLong("gen", 0);
        if (sp0.getBoolean("off", false)) { // switched off before the restart: stay off, nothing to restore
            clock.powerOff(sp0.getString("offCode", SubClock.OFF_USER), sp0.getLong("offAt", serverNow()));
            offText = sp0.getString("offText", offText(clock.offReason, ""));
            status = L.s(R.string.st_off_fmt, offText); stateNow = "off";
            LocalServer.log("restored: switched off (" + offText + ")");
            return;
        }
        try (FileInputStream f = openFileInput("cues.json")) {
            ByteArrayOutputStream b = new ByteArrayOutputStream(); byte[] buf = new byte[65536]; int r;
            while ((r = f.read(buf)) > 0) b.write(buf, 0, r);
            loadCues(new JSONObject(b.toString("UTF-8")));
            SharedPreferences sp = getSharedPreferences("sync", MODE_PRIVATE);
            clock.syncState = sp.getString("state", "stopped"); clock.syncPos = sp.getLong("pos", 0); clock.syncAt = sp.getLong("at", 0);
            if (sp.getBoolean("frozen", false)) clock.syncAt = serverNow(); // was paused/stopped when saved: don't add the downtime
            clock.srcPkg = sp.getString("srcPkg", ""); clock.srcLabel = sp.getString("srcLabel", "");
            if (!clock.srcPkg.isEmpty() && clock.srcLabel.isEmpty()) {
                try { android.content.pm.PackageManager pm = getPackageManager(); clock.srcLabel = pm.getApplicationLabel(pm.getApplicationInfo(clock.srcPkg, 0)).toString(); }
                catch (Exception ignored) { clock.srcLabel = clock.srcPkg; }
            }
                if (clock.srcLabel.equals(clock.srcPkg)) { // API 30 package visibility hides other apps' labels
                    String[][] known = {{"com.netflix.ninja","Netflix"},{"com.amazon.amazonvideo.livingroom","Prime Video"},{"com.disney.disneyplus","Disney+"},
                        {"com.google.android.youtube.tv","YouTube"},{"com.hbo.hbonow","Max"},{"com.wbd.stream","Max"},{"com.apple.atve.androidtv.appletv","Apple TV"}};
                    for (String[] k : known) if (k[0].equals(clock.srcPkg)) clock.srcLabel = k[1];
                }
            clock.syncHeld = 0; clock.hasCues = cs.length > 0;
            clock.armed = sp.getBoolean("armed", false); clock.started = clock.armed; // armed + source gone after a restart -> switches off after the grace
            clock.restoreAds(sp.getLong("adTotal", 0), sp.getLong("adCount", 0));
            if (sp.getBoolean("adManual", false)) { long c0 = clock.adCount; clock.onManualAd(true, serverNow()); clock.adCount = c0; } // ad was running when the service died
            LocalServer.log("restored " + cs.length + " cues, state=" + clock.syncState + " src=" + clock.srcPkg + (sp.getBoolean("frozen", false) ? " frozen" : ""));
        } catch (FileNotFoundException e) { /* first run */ } catch (Exception e) { LocalServer.log("restore failed " + e); }
    }

    private void loadCues(JSONObject o) throws JSONException {
        JSONArray a = o.getJSONArray("cues");
        long[] s = new long[a.length()], e = new long[a.length()]; String[] t = new String[a.length()];
        for (int i = 0; i < a.length(); i++) { JSONObject c = a.getJSONObject(i); s[i] = c.getLong("s"); e[i] = c.getLong("e"); t[i] = c.getString("t"); }
        cs = s; ce = e; ct = t; cueCount = t.length; clock.hasCues = t.length > 0; title = o.optString("title", "");
        status = L.s(R.string.st_connected_fmt, title, t.length); connectedStatus = true;
    }

    private int find(long p) { // last cue with start <= p, if p < end
        int lo = 0, hi = cs.length - 1, ans = -1;
        while (lo <= hi) { int m = (lo + hi) >>> 1; if (cs[m] <= p) { ans = m; lo = m + 1; } else hi = m - 1; }
        if (ans >= 0 && p < ce[ans]) return ans;
        if (ans > 0 && p < ce[ans - 1]) return ans - 1;
        return -1;
    }

    private void handle(String json) {
        try {
            JSONObject o = new JSONObject(json);
            String type = o.optString("type");
            switch (type) {
                case "cues": {
                    boolean explicit = o.optBoolean("explicit");
                    if (clock.off && !explicit) { LocalServer.log("cues ignored: switched off (only an explicit new load turns it on)"); break; }
                    if (explicit) { // v0.4.4: a new film from the phone = everything from zero (and turns it back on)
                        clock.powerOn(serverNow()); offText = "";
                        SharedPreferences cfg = getSharedPreferences("cfg", MODE_PRIVATE);
                        gen = cfg.getLong("gen", 0) + 1; cfg.edit().putLong("gen", gen).apply();
                    }
                    loadCues(o); clock.syncState = "searching"; clock.mediaAnchor = false; clock.newMedia(); saveState(json); saveAds();
                    if (tv == null) addOverlay();
                    break;
                }
                case "power": { // v0.4.4 ⏻ on the phone: {on:false}. There is no "on": loading new subtitles turns it on.
                    if (!o.optBoolean("on", false)) { String lbl = clock.srcLabel; clock.powerOff(SubClock.OFF_USER, serverNow()); wipe(lbl); }
                    break;
                }
                case "sync": {
                    // phone clock vs TV clock skew or manual start: SubClock anchors on the TV's own clock
                    if (clock.off) break; // switched off: ignore
                    clock.onSync(o.optString("state"), o.optLong("pos"), o.optLong("at"), o.optBoolean("manual"), o.optBoolean("resume"),
                            o.has("held") ? o.optLong("held") : null, o.has("epoch") ? o.optLong("epoch") : null,
                            o.has("off") ? o.optLong("off") : null, serverNow());
                    saveState(null);
                    break;
                }
                case "text":
                    if (clock.off) break;
                    tempText = o.optString("text"); tempUntil = serverNow() + o.optLong("ms", 5000);
                    if (tempText.isEmpty()) tempText = null;
                    break;
                case "media": { // options from the phone page
                    Boolean ap = o.has("autoPause") ? o.optBoolean("autoPause") : null, as = o.has("autoSync") ? o.optBoolean("autoSync") : null,
                            adp = o.has("adPause") ? o.optBoolean("adPause") : null;
                    clock.setOptions(ap, as, adp, serverNow());
                    getSharedPreferences("cfg", MODE_PRIVATE).edit().putBoolean("autoPause", clock.autoPause).putBoolean("autoSync", clock.autoSync)
                            .putBoolean("adPause", clock.adPause).apply();
                    LocalServer.log("media options autoPause=" + clock.autoPause + " autoSync=" + clock.autoSync + " adPause=" + clock.adPause);
                    break;
                }
                case "ad": { // v0.4: phone "Anuncio" button. {on:true|false} or {reset:true}
                    if (clock.off) break;
                    long now = serverNow(), before = clock.pos(now);
                    if (o.optBoolean("reset")) clock.resetAdTime();
                    else clock.onManualAd(o.optBoolean("on"), now);
                    saveAds();
                    LocalServer.log("manual ad " + (o.optBoolean("reset") ? "reset" : o.optBoolean("on") ? "start" : "end") + " subs " + before + " -> " + clock.pos(now)
                            + " lastAd=" + clock.lastAdMs + " adTotal=" + clock.adTotal + " n=" + clock.adCount + " anchor=" + (clock.mediaAnchor ? "media" : "clock"));
                    break;
                }
                case "style":
                    sizeUnits = (float) o.optDouble("size", 48); applySize();
                    getSharedPreferences("cfg", MODE_PRIVATE).edit().putFloat("size", sizeUnits).apply();
                    break;
            }
        } catch (Exception ex) { LocalServer.log("handle error " + ex); }
        computeNow(serverNow());
    }

    private void startThreads() {
        sizeUnits = getSharedPreferences("cfg", MODE_PRIVATE).getFloat("size", 48);
        SharedPreferences cfg = getSharedPreferences("cfg", MODE_PRIVATE);
        String relay0 = cfg.getString("relay", "local");
        if (relay0.isEmpty() || relay0.equals("local")) { // TV is the server (LAN HTTPS)
            serverOffset = 0;
            status = L.s(R.string.st_ready);
            startedAt = System.currentTimeMillis();
            restoreState();
            clock.autoPause = cfg.getBoolean("autoPause", true); clock.autoSync = cfg.getBoolean("autoSync", false);
            clock.adPause = cfg.getBoolean("adPause", true);
            clockRef = clock;
            MediaWatcher.start(this, clock.srcPkg, (pkg, label, st, pos, sp, mTitle, mDur) -> {
                int before = clock.raw, m0 = clock.media; long a0 = clock.anchors; String src0 = clock.srcPkg, lbl0 = clock.srcLabel;
                boolean wasOff = clock.off;
                if (clock.onMedia(pkg, label, st, pos, sp, mTitle, mDur, serverNow())) {
                    LocalServer.log("media " + label + " " + SubClock.stateEs(st) + " (" + st + ") pos=" + pos + " title=" + mTitle + " dur=" + mDur + " -> SWITCH OFF");
                    wipe(lbl0); return;
                }
                if (wasOff) { if (before != clock.raw) LocalServer.log("media (off) " + label + " " + SubClock.stateEs(st) + " (" + st + ") pos=" + pos); return; }
                if (before != clock.raw || a0 != clock.anchors || m0 != clock.media)
                    LocalServer.log("media " + label + " " + SubClock.stateEs(st) + " (" + st + ") pos=" + pos + (a0 != clock.anchors ? " -> anchored" : "")
                            + " kind=" + clock.media + " src=" + clock.srcPkg + (clock.hiddenByMedia() ? " HIDDEN" : "") + " subs=" + clock.pos(serverNow())
                            + " title=" + mTitle + " dur=" + mDur + (clock.pendOffAt >= 0 ? " PENDING-OFF" : "") + (clock.armed ? " armed" : ""));
                if (m0 != clock.media || !src0.equals(clock.srcPkg)) saveState(null);
            });
            
            LocalServer.log("overlay service started");
            LocalServer.start(this, MainActivity.token(this), d -> {
                java.util.concurrent.CountDownLatch l = new java.util.concurrent.CountDownLatch(1);
                ui.post(() -> { try { handle(d); } finally { l.countDown(); } });
                try { l.await(1500, java.util.concurrent.TimeUnit.MILLISECONDS); } catch (InterruptedException ignored) { }
            });
            return;
        }
        sseThread = new Thread(() -> {
            long backoff = 1000;
            while (alive) {
                SharedPreferences p = getSharedPreferences("cfg", MODE_PRIVATE);
                String relay = p.getString("relay", ""), token = p.getString("token", "");
                if (relay.isEmpty()) { status = L.s(R.string.st_no_server); sleep(3000); continue; }
                HttpURLConnection c = null;
                try {
                    status = L.s(R.string.st_connecting); connectedStatus = false;
                    c = (HttpURLConnection) new URL(relay + "/tv/events?k=" + URLEncoder.encode(token, "UTF-8")).openConnection();
                    c.setConnectTimeout(10000); c.setReadTimeout(35000);
                    c.setRequestProperty("Accept", "text/event-stream");
                    BufferedReader r = new BufferedReader(new InputStreamReader(c.getInputStream(), "UTF-8"), 1 << 16);
                    if (!connectedStatus) { status = L.s(R.string.st_connected_wait); connectedStatus = true; };
                    backoff = 1000;
                    String line;
                    while (alive && (line = r.readLine()) != null) {
                        if (line.startsWith("data: ")) { final String d = line.substring(6); ui.post(() -> handle(d)); }
                    }
                } catch (Exception e) {
                    status = L.s(R.string.st_retry_fmt, e.getClass().getSimpleName()); connectedStatus = false;
                } finally { if (c != null) c.disconnect(); }
                sleep(backoff); backoff = Math.min(backoff * 2, 10000);
            }
        });
        sseThread.start();
        clockThread = new Thread(() -> { // estimate server clock offset (NTP-style, keep min-RTT sample)
            int n = 0;
            while (alive) {
                try {
                    SharedPreferences p = getSharedPreferences("cfg", MODE_PRIVATE);
                    String relay = p.getString("relay", ""), token = p.getString("token", "");
                    if (!relay.isEmpty()) {
                        long t0 = System.currentTimeMillis();
                        HttpURLConnection c = (HttpURLConnection) new URL(relay + "/api/status?k=" + URLEncoder.encode(token, "UTF-8")).openConnection();
                        c.setConnectTimeout(8000); c.setReadTimeout(8000);
                        String body = new BufferedReader(new InputStreamReader(c.getInputStream())).readLine();
                        long t1 = System.currentTimeMillis(), rtt = t1 - t0;
                        long sn = new JSONObject(body).getLong("serverNow");
                        if (rtt <= bestRtt + 30) { serverOffset = sn - (t0 + rtt / 2); bestRtt = Math.min(bestRtt, rtt); }
                        c.disconnect();
                    }
                } catch (Exception ignored) { }
                n++;
                sleep(n < 6 ? 2000 : 30000);
            }
        });
        clockThread.start();
    }

    private static void sleep(long ms) { try { Thread.sleep(ms); } catch (InterruptedException ignored) { } }

    @Override public void onDestroy() {
        alive = false; running = false; status = L.s(R.string.st_off); LocalServer.log("overlay service destroyed");
        LocalServer.stopAll(); MediaWatcher.stop(); clockRef = null;
        ui.removeCallbacksAndMessages(null);
        removeOverlay();
        if (sseThread != null) sseThread.interrupt();
        if (clockThread != null) clockThread.interrupt();
        super.onDestroy();
    }
}
