package io.github.subtitulostv;

import android.content.*;
import android.provider.Settings;

public class BootReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context ctx, Intent i) { L.init(ctx);
        boolean on = ctx.getSharedPreferences("cfg", Context.MODE_PRIVATE).getBoolean("enabled", false);
        if (on && Settings.canDrawOverlays(ctx)) ctx.startForegroundService(new Intent(ctx, OverlayService.class));
    }
}
