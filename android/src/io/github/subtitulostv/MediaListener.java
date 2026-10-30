package io.github.subtitulostv;

import android.service.notification.NotificationListenerService;

/** Only exists so the user can grant "notification access", which unlocks MediaSessionManager.getActiveSessions(). */
public class MediaListener extends NotificationListenerService {
    public static volatile boolean connected = false;
    @Override public void onListenerConnected() { connected = true; LocalServer.log("notification listener connected"); MediaWatcher.kick(); }
    @Override public void onListenerDisconnected() { connected = false; LocalServer.log("notification listener disconnected"); }
}
