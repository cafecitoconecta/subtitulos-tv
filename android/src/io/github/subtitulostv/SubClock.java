package io.github.subtitulostv;

/**
 * Subtitle clock (pure Java, no Android deps, unit-tested on the box and ported 1:1 to test/mock-tv.js).
 *
 * Timeline position (ms on the subtitle track) =
 *   clock mode : syncPos + (now - syncAt) - (held(now) - syncHeld)
 *   media mode : mPos + (now - mAt) * mSpeed + userOff        (only with autoSync, after a pause/seek/resume event)
 * held(now) is the total time the playing app was paused/buffering/stopped (only counted with autoPause on),
 * so the clock freezes while the film is paused. The phone sends the held value it last saw ("held" + "epoch");
 * the TV subtracts whatever happened after that, so stale phone pushes never move a frozen clock.
 *
 * Ads (v0.3): Netflix reports ads as normal playback with the position advancing (position includes ad time).
 * The accessibility probe tells us when an ad is on screen (onAd). With adPause on, an ad counts as "held"
 * (clock frozen, subtitles hidden) and its duration is added to adTotal; with autoSync the media anchor
 * becomes  reported position - adTotal + userOff. No ad signal => behaves exactly like v0.2.
 *
 * Manual ads (v0.4): the phone's "Anuncio" button calls onManualAd(true/false). Same accounting as the probe,
 * but it always freezes/hides (independent of adPause) and only the button can end it.
 *
 * Power (v0.4.4): powerOff() = the phone's ⏻ button or an automatic switch-off. Everything goes back to zero
 * (clock, offset, ads, source app, pause) and while off EVERY input is ignored (media sessions, phone syncs,
 * ad button). Only powerOn() (explicit new subtitles from the phone) brings it back.
 * Automatic switch-off (only once "armed" = the user started the subtitles and the source app then played
 * for ARM_MS, so a home-screen trailer before the film can never switch it off):
 *   A) the source session stops / disappears and does not come back within GRACE_MS (app closed, back to the
 *      Netflix home, live TV). Netflix home trailers start ~4 s after the film stops, so they land here.
 *   B) the source plays again within the grace but far (> RESUME_TOL_MS) from where the film stopped -> other content.
 *   C) another app starts playing.
 *   D) the session publishes metadata with another title, or a duration that differs > 5 s from the one learnt
 *      for the film. Metadata == null (Netflix ads: state 3, position advancing) is NEVER a reason: an ad in the
 *      same, uninterrupted session can't switch it off.
 * A manual pause (phone) is never undone by media events, and only a manual sync / explicit resume ends it.
 */
public final class SubClock {
    public static final int UNKNOWN = 0, PLAYING = 1, HELD = 2, STOPPED = 3;
    public boolean autoPause = true, autoSync = false, adPause = true;
    public boolean hasCues = false;
    public final long epoch;

    public String syncState = "stopped";
    public long syncPos, syncAt, syncHeld;

    // media session (as reported by MediaWatcher)
    public int media = UNKNOWN; public int raw = -1; public String pkg = "", label = "";
    // v0.4.2 source app: the package whose session drove the clock for the loaded track (persisted across restarts).
    // When its session stops / disappears (app closed, back to home or live TV) the subtitles hide and freeze.
    public String srcPkg = "", srcLabel = "";
    private long lastMPos, lastMAt; private float lastMSpeed; // last report, for seek detection

    private long heldDone = 0, heldSince = -1;

    // media anchor (autoSync)
    public boolean mediaAnchor = false; private long mPos, mAt; private float mSpeed; public long userOff = 0;
    public long anchors = 0; // count, for status/tests

    // ads (accessibility probe)
    public boolean ad = false, adManual = false; public long adSince = -1, adTotal = 0, adCount = 0, lastAdMs = 0;
    private long adStartRep = -1; // reported media position when the ad started (-1 unknown)

    // v0.4.4 power + automatic switch-off
    public static final long ARM_MS = 60_000, GRACE_MS = 2_500, RESUME_TOL_MS = 15_000, DUR_TOL_MS = 5_000;
    public boolean off = false; public String offReason = ""; public long offAt = 0, offCount = 0;
    public boolean started = false, armed = false; public long playMs = 0; private long accAt = -1;
    public long pendOffAt = -1; private long stopPos = -1;
    public String srcTitle = ""; public long srcDur = -1;
    public static final String OFF_USER = "user", OFF_CLOSED = "closed", OFF_CONTENT = "content", OFF_OTHER = "other";

    public SubClock(long epoch) { this.epoch = epoch; }

    /** Switch everything off and back to zero. Media events, syncs and ads are ignored until powerOn(). */
    public void powerOff(String reason, long now) {
        off = true; offReason = reason == null ? OFF_USER : reason; offAt = now; offCount++;
        syncState = "off"; syncPos = 0; syncAt = now; syncHeld = 0; hasCues = false;
        heldDone = 0; heldSince = -1; mediaAnchor = false; mPos = 0; mAt = now; mSpeed = 0; userOff = 0; anchors = 0;
        ad = false; adManual = false; adSince = -1; adTotal = 0; adCount = 0; lastAdMs = 0; adStartRep = -1;
        srcPkg = ""; srcLabel = ""; srcTitle = ""; srcDur = -1;
        started = false; armed = false; playMs = 0; accAt = -1; pendOffAt = -1; stopPos = -1;
    }
    /** Explicit new subtitles from the phone: back on, from zero (the caller loads the cues). */
    public void powerOn(long now) {
        off = false; offReason = ""; syncState = "searching"; syncPos = 0; syncAt = now; syncHeld = 0;
        heldDone = 0; heldSince = -1; mediaAnchor = false; started = false; armed = false; playMs = 0; accAt = -1;
        pendOffAt = -1; stopPos = -1; srcTitle = ""; srcDur = -1;
        ad = false; adManual = false; adSince = -1; adStartRep = -1;
        refreshHolding(now);
    }
    /** Called every tick (40 ms on the TV). Returns true when it just switched off on its own. */
    public boolean tick(long now) {
        if (off) return false;
        accumulate(now);
        if (pendOffAt >= 0 && now - pendOffAt >= GRACE_MS) { powerOff(OFF_CLOSED, now); return true; }
        return false;
    }
    private void accumulate(long now) {
        boolean on = started && media == PLAYING && !srcPkg.isEmpty() && pkg.equals(srcPkg);
        if (on && accAt >= 0) playMs += Math.max(0, now - accAt);
        accAt = on ? now : -1;
        if (!armed && playMs >= ARM_MS) armed = true;
    }
    private static boolean live(String st) { return "locked".equals(st) || "hidden".equals(st) || "paused".equals(st); }

    public long held(long now) { return heldDone + (heldSince >= 0 ? Math.max(0, now - heldSince) : 0); }

    private void setHolding(boolean on, long now) {
        if (on && heldSince < 0) heldSince = now;
        else if (!on && heldSince >= 0) { heldDone += Math.max(0, now - heldSince); heldSince = -1; }
    }
    private boolean adOn() { return ad && (adPause || adManual); }
    private void refreshHolding(long now) { if (off) { heldSince = -1; return; } setHolding((autoPause && (media == HELD || media == STOPPED)) || adOn(), now); }
    /** Reported media position extrapolated to now (only meaningful while PLAYING/HELD). */
    public long reported(long now) { return lastMPos + (long) ((now - lastMAt) * lastMSpeed); }
    private void resetAds() { adTotal = 0; adCount = ad ? 1 : 0; if (!ad) adStartRep = -1; }

    public long pos(long now) {
        if (off) return 0;
        if (mediaAnchor) return mPos + (long) ((now - mAt) * mSpeed) + userOff;
        long el = Math.max(0, Math.min(now - syncAt, 6L * 3600 * 1000));
        return syncPos + el - (held(now) - syncHeld);
    }

    /** Subtitles hidden because the app stopped / closed the film. */
    public boolean hiddenByMedia() { return off || (autoPause && media == STOPPED); }
    /** The source app's session is gone (app closed / back to home or live TV), not just "stopped". */
    public boolean srcGone() { return media == STOPPED && raw < 0 && !srcPkg.isEmpty(); }
    /** Clock currently frozen (paused / stopped / ad). */
    public boolean holding() { return heldSince >= 0; }
    /** Subtitles hidden because an ad is on screen. */
    public boolean hiddenByAd() { return adOn(); }

    public static int map(int rawState) {
        switch (rawState) {
            case 3: return PLAYING;                                  // STATE_PLAYING
            case 2: case 6: case 8: case 4: case 5: case 9: case 10: case 11: return HELD; // paused, buffering, connecting, ff/rw, skipping
            default: return STOPPED;                                 // 0 none, 1 stopped, 7 error, -1 no session
        }
    }
    static boolean seeking(int r) { return r == 4 || r == 5 || r == 9 || r == 10 || r == 11; }

    private void dropAnchor(long now) {
        if (!mediaAnchor) return;
        long p = pos(now) - userOff; // keep the user offset inside syncPos (phone sends pos incl. offset)
        mediaAnchor = false; syncPos = p + userOff; syncAt = now; syncHeld = held(now);
    }

    /** rawState = PlaybackState.getState() (-1 = no session); posNow = media position extrapolated to now. */
    public void onMedia(String pkg, String label, int rawState, long posNow, float speed, long now) { onMedia(pkg, label, rawState, posNow, speed, null, -1, now); }
    /** title / durMs: MediaMetadata of the session (null / -1 when the app publishes none, e.g. Netflix ads). Returns true if it just switched off. */
    public boolean onMedia(String pkg, String label, int rawState, long posNow, float speed, String title, long durMs, long now) {
        if (pkg == null) pkg = ""; if (label == null) label = "";
        if (off) { // ignore everything; only remember what is on screen (for the status line)
            this.pkg = pkg; this.label = label; raw = rawState; media = map(rawState); lastMPos = posNow; lastMAt = now; lastMSpeed = rawState == 3 ? speed : 0;
            return false;
        }
        accumulate(now);
        int m0 = map(rawState);
        if (armed && !srcPkg.isEmpty()) {
            // C) another app plays
            if (!pkg.isEmpty() && !pkg.equals(srcPkg) && m0 == PLAYING) { powerOff(OFF_OTHER, now); return true; }
            if (pkg.equals(srcPkg)) {
                // D) metadata of another film / episode (null metadata = ad or app without metadata: ignored)
                if (title != null && !title.isEmpty() && (m0 == PLAYING || m0 == HELD)) {
                    if (srcTitle.isEmpty()) { srcTitle = title; srcDur = durMs > 0 ? durMs : -1; }
                    else if (!title.equals(srcTitle) || (srcDur > 0 && durMs > 0 && Math.abs(durMs - srcDur) > DUR_TOL_MS)) { powerOff(OFF_CONTENT, now); return true; }
                    else if (srcDur <= 0 && durMs > 0) srcDur = durMs;
                }
                // A) stopped / gone -> wait GRACE_MS (tick); B) plays again: same spot = resume, elsewhere = other content
                if (m0 == STOPPED && pendOffAt < 0) {
                    pendOffAt = now; stopPos = (media == PLAYING || media == HELD) ? reported(now) : -1;
                } else if ((m0 == PLAYING || m0 == HELD) && pendOffAt >= 0) {
                    if (stopPos < 0 || Math.abs(posNow - stopPos) > RESUME_TOL_MS) { powerOff(OFF_CONTENT, now); return true; }
                    pendOffAt = -1; stopPos = -1;
                }
            }
        } else if (armed && pkg.isEmpty() && pendOffAt < 0 && !srcPkg.isEmpty()) { pendOffAt = now; stopPos = (media == PLAYING || media == HELD) ? reported(now) : -1; }
        else if (!armed && title != null && !title.isEmpty() && started && pkg.equals(srcPkg) && m0 == PLAYING && srcTitle.isEmpty()) { srcTitle = title; srcDur = durMs > 0 ? durMs : -1; }
        onMediaLegacy(pkg, label, rawState, posNow, speed, now);
        return false;
    }
    private void onMediaLegacy(String pkg, String label, int rawState, long posNow, float speed, long now) {
        int prevRaw = raw, prevMedia = media;
        int m = map(rawState);
        if (!srcPkg.isEmpty()) {
            if (pkg.isEmpty()) { pkg = srcPkg; label = srcLabel; } // no session at all (e.g. after a restart): the source is gone
            else if (!pkg.equals(srcPkg) && m != PLAYING) { pkg = srcPkg; label = srcLabel; rawState = -1; posNow = 0; m = STOPPED; } // only an idle other app left
        }
        if ((m == PLAYING || (m == HELD && srcPkg.isEmpty())) && !pkg.isEmpty() && !pkg.equals(srcPkg)) { srcPkg = pkg; srcLabel = label; }
        if (!pkg.isEmpty() && !this.pkg.isEmpty() && !pkg.equals(this.pkg)) resetAds();
        if (m == STOPPED && prevMedia == UNKNOWN && srcPkg.isEmpty()) m = UNKNOWN; // never saw this film play: don't interfere (Supaflix…)
        boolean jump = false;
        if (rawState == 3 && prevRaw == 3) {
            long exp = lastMPos + (long) ((now - lastMAt) * lastMSpeed);
            jump = Math.abs(posNow - exp) > 2000;
            if (!jump) return; // periodic update, nothing new
        }
        if (rawState == prevRaw && !jump && pkg.equals(this.pkg)) { lastMPos = posNow; lastMAt = now; lastMSpeed = rawState == 3 ? speed : 0; return; }
        this.pkg = pkg; this.label = label; raw = rawState; media = m;
        lastMPos = posNow; lastMAt = now; lastMSpeed = rawState == 3 ? speed : 0;
        refreshHolding(now);
        if (m == STOPPED || m == UNKNOWN) { dropAnchor(now); return; }
        // re-anchor only on exact events: pause, resume after pause/seek, or a jump while playing.
        // NOT the first "playing" after start/buffering (Prime reports it ~3 s early).
        boolean exact = rawState == 2 || (rawState == 3 && (prevRaw == 2 || seeking(prevRaw) || jump));
        if (adOn()) { // ad on screen: keep frozen, the anchor is fixed when the ad ends
            if (mediaAnchor) { mPos = mPos + (long) ((now - mAt) * mSpeed); mAt = now; mSpeed = 0; }
            return;
        }
        if (autoSync && hasCues && exact) {
            mediaAnchor = true; mPos = posNow - adTotal; mAt = now; mSpeed = rawState == 3 ? speed : 0; anchors++;
            if (!"hidden".equals(syncState) && !"paused".equals(syncState)) syncState = "locked";
            if (!started) { started = true; accAt = -1; }
        } else if (mediaAnchor) { // keep own extrapolation, just start/stop it
            mPos = mPos + (long) ((now - mAt) * mSpeed); mAt = now; mSpeed = rawState == 3 ? speed : 0;
        }
    }

    /** Message from the phone. held/epoch may be null (old page or manual start). */
    public void onSync(String state, long pos, long at, boolean manual, Long held, Long ep, Long off, long now) { onSync(state, pos, at, manual, false, held, ep, off, now); }
    /** resume = the phone explicitly ends its own pause (mic re-sync). Without it (or manual) a pause can't be undone. */
    public void onSync(String state, long pos, long at, boolean manual, boolean resume, Long held, Long ep, Long off, long now) {
        if (this.off) return; // switched off: only new subtitles turn it on
        if ("paused".equals(syncState) && !manual && !resume && !"paused".equals(state)) return; // stale page pushing "locked"
        if (off != null) userOff = off;
        if (live(state)) { if (!started) accAt = -1; started = true; }
        if (manual) {
            syncState = state; syncPos = pos; syncAt = now; syncHeld = held(now); mediaAnchor = false;
            if (media == STOPPED) { media = UNKNOWN; refreshHolding(now); } // e.g. other app without media session
            return;
        }
        if (holding() && (ep == null || ep != epoch)) { // v0.4.2: frozen (e.g. source app closed) and the phone has not seen this
            // TV run yet (service restarted): its clock never froze, so don't let it move ours; it adopts our position first.
            if ("locked".equals(state) || "hidden".equals(state) || "paused".equals(state)) syncState = state;
            return;
        }
        if (mediaAnchor) { // TV owns the position; phone only controls show/hide and the offset
            if ("locked".equals(state) || "hidden".equals(state) || "paused".equals(state)) syncState = state;
            return;
        }
        syncState = state; syncPos = pos;
        syncAt = Math.abs(now - at) > 3000 ? now : at;
        syncHeld = (held != null && ep != null && ep == epoch) ? Math.min(held, held(now)) : held(now);
    }

    /** Ad on screen (true) / gone (false), from the accessibility probe. Never ends a manual ad. */
    public void onAd(boolean on, long now) {
        if (off || adManual) return;
        adEvent(on, now);
    }

    /** "Anuncio" button on the phone: start (true) / end (false). Takes over a probe ad already running. */
    public void onManualAd(boolean on, long now) {
        if (off) return;
        if (on) {
            if (ad) { // probe ad already running (with adPause off it was not frozen yet)
                boolean was = adOn(); adManual = true;
                if (!was && mediaAnchor) { mPos = mPos + (long) ((now - mAt) * mSpeed); mAt = now; mSpeed = 0; }
                refreshHolding(now); return;
            }
            adManual = true; adEvent(true, now);
        }
        else { if (!ad) { adManual = false; return; } adEvent(false, now); }
    }

    /** "Reiniciar tiempo de anuncios": forget the ads counted so far (a running ad keeps going). */
    public void resetAdTime() { adTotal = 0; adCount = ad ? 1 : 0; lastAdMs = 0; }

    /** Restore counters after a service restart. */
    public void restoreAds(long total, long count) { adTotal = Math.max(0, total); adCount = Math.max(0, count); }

    private void adEvent(boolean on, long now) {
        if (on == ad) return;
        if (on) {
            ad = true; adSince = now; adCount++;
            adStartRep = (media == PLAYING || media == HELD) ? reported(now) : -1;
            if (adOn() && mediaAnchor) { mPos = mPos + (long) ((now - mAt) * mSpeed); mAt = now; mSpeed = 0; }
            refreshHolding(now);
            return;
        }
        boolean counted = adPause || adManual;
        ad = false; adManual = false;
        long wall = Math.max(0, now - adSince);
        long dur = wall;
        if (adStartRep >= 0 && (media == PLAYING || media == HELD)) {
            long d = reported(now) - adStartRep; // position advanced during the ad = ad length
            if (d >= 0 && d <= wall + 2000) dur = d;
        }
        lastAdMs = dur; adSince = -1; adStartRep = -1;
        if (!counted) { refreshHolding(now); return; } // only counted for info
        adTotal += dur;
        refreshHolding(now);
        if (mediaAnchor || (autoSync && hasCues && media == PLAYING)) {
            if (autoSync && hasCues && media == PLAYING) { // re-anchor on the app position minus the ads
                mediaAnchor = true; mPos = reported(now) - adTotal; mAt = now; mSpeed = lastMSpeed == 0 ? 1 : lastMSpeed; anchors++;
                if (!"hidden".equals(syncState) && !"paused".equals(syncState)) syncState = "locked";
            } else { mAt = now; mSpeed = media == PLAYING ? (lastMSpeed == 0 ? 1 : lastMSpeed) : 0; }
        }
    }

    /** New subtitles loaded (new episode): forget the ads counted so far. */
    public void newMedia() { resetAds(); if (!(media == PLAYING || media == HELD)) { srcPkg = ""; srcLabel = ""; } else if (!pkg.isEmpty()) { srcPkg = pkg; srcLabel = label; } }

    public void setOptions(Boolean ap, Boolean as, long now) { setOptions(ap, as, null, now); }
    public void setOptions(Boolean ap, Boolean as, Boolean adp, long now) {
        if (adp != null && adp != adPause) {
            if (!adp && ad && !adManual && mediaAnchor) { mAt = now; mSpeed = media == PLAYING ? (lastMSpeed == 0 ? 1 : lastMSpeed) : 0; }
            adPause = adp; refreshHolding(now);
        }
        if (ap != null && ap != autoPause) { autoPause = ap; refreshHolding(now); }
        if (as != null && as != autoSync) { autoSync = as; if (!as) dropAnchor(now); }
    }

    public static String stateEs(int raw) {
        switch (raw) {
            case 3: return "reproduciendo"; case 2: return "en pausa"; case 6: case 8: return "cargando";
            case 4: case 5: case 9: case 10: case 11: return "buscando posición"; case 1: return "detenido";
            case 7: return "error"; case 0: return "sin reproducir"; default: return "sin reproducción";
        }
    }
}
