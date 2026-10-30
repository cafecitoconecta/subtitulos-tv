package io.github.subtitulostv;

import android.app.Activity;
import android.content.*;
import android.graphics.*;
import android.net.Uri;
import android.os.*;
import android.provider.Settings;
import android.view.*;
import android.widget.*;
import java.io.InputStream;
import java.net.*;

/** Start/stop the overlay and show the phone URL + QR. Config can be pushed with
 *  adb shell am start -n io.github.subtitulostv/.MainActivity --es relay https://... --es token XXX
 *  Public build: a random token is generated on first run. */
public class MainActivity extends Activity {
    private TextView statusTv, urlTv;
    private ImageView qr;
    private Button toggle, notif;
    private final Handler h = new Handler(Looper.getMainLooper());

    @Override protected void onCreate(Bundle b) {
        super.onCreate(b);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.HORIZONTAL);
        root.setBackgroundColor(0xFF121212);
        int pad = 48; root.setPadding(pad * 2, pad, pad * 2, pad);

        LinearLayout left = new LinearLayout(this); left.setOrientation(LinearLayout.VERTICAL);
        TextView title = text("Subtítulos TV", 40, 0xFF78C8FF);
        left.addView(title);
        left.addView(text("1. En el móvil, escanea el código o abre:", 22, 0xFFDDDDDD));
        urlTv = text("", 22, 0xFFFFFFFF); left.addView(urlTv);
        left.addView(text("2. Busca la peli o serie y pulsa «Empezar a escuchar».", 22, 0xFFDDDDDD));
        left.addView(text("3. Abre Prime, HBO… Los subtítulos saldrán encima.", 22, 0xFFDDDDDD));
        statusTv = text("", 22, 0xFFFFD060); statusTv.setPadding(0, 24, 0, 24); left.addView(statusTv);
        LinearLayout row = new LinearLayout(this);
        toggle = new Button(this); toggle.setTextSize(22); row.addView(toggle);
        Button test = new Button(this); test.setText("Probar"); test.setTextSize(22); row.addView(test);
        notif = new Button(this); notif.setText("Permitir pausa automática"); notif.setTextSize(22); row.addView(notif);
        left.addView(row);
        root.addView(left, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 1));
        qr = new ImageView(this);
        root.addView(qr, new LinearLayout.LayoutParams(420, 420));
        setContentView(root);

        toggle.setOnClickListener(v -> {
            if (OverlayService.running) stopOverlay(); else startOverlay();
            h.postDelayed(this::refresh, 300);
        });
        test.setOnClickListener(v -> Toast.makeText(this, "Usa «Probar en la tele» en el móvil", Toast.LENGTH_LONG).show());
        notif.setOnClickListener(v -> {
            try { startActivity(new Intent("android.settings.ACTION_NOTIFICATION_LISTENER_SETTINGS")); }
            catch (Exception e) { Toast.makeText(this, "Ajustes → Aplicaciones → Aplicaciones con accesos especiales → Acceso a notificaciones → Subtítulos TV", Toast.LENGTH_LONG).show(); }
        });
        toggle.requestFocus();
        handleIntent(getIntent());
    }

    @Override protected void onNewIntent(Intent i) { super.onNewIntent(i); handleIntent(i); }

    private void handleIntent(Intent i) {
        SharedPreferences p = getSharedPreferences("cfg", MODE_PRIVATE);
        if (i != null && i.hasExtra("src")) // v0.4.2 admin: seed the source app of the loaded track (read on the next service start)
            getSharedPreferences("sync", MODE_PRIVATE).edit().putString("srcPkg", i.getStringExtra("src")).putString("srcLabel", "").apply();
        if (i != null && i.hasExtra("relay")) {
            p.edit().putString("relay", i.getStringExtra("relay").replaceAll("/+$", ""))
                    .putString("token", i.getStringExtra("token")).apply();
            if (OverlayService.running) { stopOverlay(); h.postDelayed(this::startOverlay, 500); }
        }
        if (i != null && i.getBooleanExtra("start", false)) startOverlay();
        if (i != null && i.getBooleanExtra("stop", false)) stopOverlay();
        if (i != null && i.getBooleanExtra("background", false)) moveTaskToBack(true);
        loadQr();
    }

    private void startOverlay() {
        if (!Settings.canDrawOverlays(this)) {
            try { startActivity(new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:" + getPackageName()))); }
            catch (Exception e) { Toast.makeText(this, "Falta el permiso de superposición", Toast.LENGTH_LONG).show(); }
            return;
        }
        getSharedPreferences("cfg", MODE_PRIVATE).edit().putBoolean("enabled", true).apply();
        startForegroundService(new Intent(this, OverlayService.class));
    }

    private void stopOverlay() {
        getSharedPreferences("cfg", MODE_PRIVATE).edit().putBoolean("enabled", false).apply();
        stopService(new Intent(this, OverlayService.class));
    }

    static String lanIp() {
        try {
            for (NetworkInterface ni : java.util.Collections.list(NetworkInterface.getNetworkInterfaces()))
                for (InetAddress a : java.util.Collections.list(ni.getInetAddresses()))
                    if (a instanceof Inet4Address && !a.isLoopbackAddress()) return a.getHostAddress();
        } catch (Exception ignored) { }
        return "?";
    }

    private void loadQr() {
        SharedPreferences p = getSharedPreferences("cfg", MODE_PRIVATE);
        final String relay = p.getString("relay", "local"), token = token(this);
        if (relay.isEmpty() || relay.equals("local")) {
            String url = "https://" + lanIp() + ":" + LocalServer.PORT + "/?k=" + token;
            urlTv.setText(url);
            qr.setImageBitmap(qrBitmap(url));
            return;
        }
        urlTv.setText(relay.isEmpty() ? "(sin configurar)" : relay + "/?k=" + token);
        if (relay.isEmpty()) return;
        new Thread(() -> {
            try (InputStream in = new URL(relay + "/qr.png?k=" + URLEncoder.encode(token, "UTF-8")).openStream()) {
                Bitmap bm = BitmapFactory.decodeStream(in);
                h.post(() -> qr.setImageBitmap(bm));
            } catch (Exception ignored) { }
        }).start();
    }

    /** Random per-device token, created on first run. */
    static String token(android.content.Context c) {
        SharedPreferences p = c.getSharedPreferences("cfg", MODE_PRIVATE);
        String t = p.getString("token", "");
        if (t == null || t.isEmpty()) {
            String abc = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
            java.security.SecureRandom r = new java.security.SecureRandom(); StringBuilder sb = new StringBuilder();
            for (int i = 0; i < 16; i++) sb.append(abc.charAt(r.nextInt(abc.length())));
            t = sb.toString(); p.edit().putString("token", t).apply();
        }
        return t;
    }

    static Bitmap qrBitmap(String text) {
        io.nayuki.qrcodegen.QrCode q = io.nayuki.qrcodegen.QrCode.encodeText(text, io.nayuki.qrcodegen.QrCode.Ecc.MEDIUM);
        int b = 2, n = q.size + b * 2, s = 10; Bitmap bm = Bitmap.createBitmap(n * s, n * s, Bitmap.Config.ARGB_8888);
        for (int y = 0; y < n * s; y++) for (int x = 0; x < n * s; x++)
            bm.setPixel(x, y, q.getModule(x / s - b, y / s - b) ? 0xFF000000 : 0xFFFFFFFF);
        return bm;
    }

    private final Runnable loop = new Runnable() { public void run() { refresh(); h.postDelayed(this, 1000); } };
    @Override protected void onResume() { super.onResume(); h.post(loop); }
    @Override protected void onPause() { super.onPause(); h.removeCallbacks(loop); }

    private void refresh() {
        boolean perm = Settings.canDrawOverlays(this);
        statusTv.setText(!perm ? "Falta el permiso para dibujar encima de otras apps" :
                OverlayService.running ? "Estado: " + OverlayService.status : "Estado: subtítulos desactivados");
        toggle.setText(OverlayService.running ? "Desactivar subtítulos" : "Activar subtítulos");
        notif.setVisibility(MediaWatcher.access ? View.GONE : View.VISIBLE);
    }

    private TextView text(String s, float size, int color) {
        TextView t = new TextView(this); t.setText(s); t.setTextSize(size); t.setTextColor(color); t.setPadding(0, 6, 0, 6); return t;
    }
}
