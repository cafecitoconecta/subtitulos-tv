package io.github.subtitulostv;

import android.content.Context;
import org.json.JSONObject;
import java.io.*;
import java.net.*;
import java.security.KeyStore;
import java.util.*;
import java.util.zip.GZIPInputStream;
import javax.net.ssl.*;

/** HTTPS server on the TV (port 8443, self-signed cert): serves the phone page, proxies
 *  OpenSubtitles requests and receives sync messages from the phone. */
public class LocalServer {
    public static final int PORT = 9443;
    public interface Sink { void onMessage(String json); }
    private static LocalServer inst;
    private final Context ctx; private final Sink sink; private final String token;
    private SSLServerSocket ss; private volatile boolean alive = true;
    public static volatile long lastPhone = 0;
    private static String lastSyncState = "";
    static final ArrayDeque<String> RING = new ArrayDeque<>();
    static void log(String m) {
        android.util.Log.i("SubsTV", m);
        String l = new java.text.SimpleDateFormat("HH:mm:ss", Locale.ROOT).format(new Date()) + " " + m;
        synchronized (RING) { RING.addLast(l); while (RING.size() > 400) RING.removeFirst(); }
    }

    public static synchronized void start(Context c, String token, Sink sink) {
        if (inst != null) { inst.stop(); }
        inst = new LocalServer(c.getApplicationContext(), token, sink);
        new Thread(inst::run, "https").start();
    }
    public static synchronized void stopAll() { if (inst != null) { inst.stop(); inst = null; } }

    private LocalServer(Context c, String t, Sink s) { L.init(c); ctx = c; token = t; sink = s; }
    private void stop() { alive = false; try { if (ss != null) ss.close(); } catch (Exception ignored) { } }

    private void run() {
        try {
            KeyStore ks = KeyStore.getInstance("PKCS12");
            try (InputStream in = ctx.getAssets().open("tv.p12")) { ks.load(in, "android".toCharArray()); }
            KeyManagerFactory kmf = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm());
            kmf.init(ks, "android".toCharArray());
            SSLContext sc = SSLContext.getInstance("TLS");
            sc.init(kmf.getKeyManagers(), null, null);
            ss = (SSLServerSocket) sc.getServerSocketFactory().createServerSocket();
            ss.setReuseAddress(true);
            ss.bind(new InetSocketAddress(PORT));
            while (alive) {
                final Socket s = ss.accept();
                new Thread(() -> serve(s)).start();
            }
        } catch (Exception e) {
            if (alive) OverlayService.status = L.s(R.string.st_server_err_fmt, e.getClass().getSimpleName() + " " + e.getMessage());
        }
    }

    private static String readLine(InputStream in) throws IOException {
        StringBuilder b = new StringBuilder(); int c;
        while ((c = in.read()) != -1) { if (c == '\n') break; if (c != '\r') b.append((char) c); }
        if (c == -1 && b.length() == 0) return null;
        return b.toString();
    }

    private void serve(Socket s) {
        try {
            s.setSoTimeout(30000);
            InputStream in = new BufferedInputStream(s.getInputStream());
            OutputStream out = new BufferedOutputStream(s.getOutputStream());
            while (true) {
                String req = readLine(in);
                if (req == null || req.isEmpty()) break;
                String[] parts = req.split(" ");
                String method = parts[0], target = parts.length > 1 ? parts[1] : "/";
                int len = 0; boolean close = false; String h;
                while ((h = readLine(in)) != null && !h.isEmpty()) {
                    String lh = h.toLowerCase(Locale.ROOT);
                    if (lh.startsWith("content-length:")) len = Integer.parseInt(h.substring(15).trim());
                    if (lh.startsWith("connection:") && lh.contains("close")) close = true;
                }
                byte[] body = new byte[len]; int off = 0;
                while (off < len) { int r = in.read(body, off, len - off); if (r < 0) break; off += r; }
                handle(method, target, body, out);
                out.flush();
                if (close) break;
            }
        } catch (Exception ignored) {
        } finally { try { s.close(); } catch (Exception ignored) { } }
    }

    private static Map<String, String> query(String q) throws UnsupportedEncodingException {
        Map<String, String> m = new HashMap<>();
        if (q == null) return m;
        for (String kv : q.split("&")) {
            int i = kv.indexOf('='); if (i < 0) continue;
            m.put(URLDecoder.decode(kv.substring(0, i), "UTF-8"), URLDecoder.decode(kv.substring(i + 1), "UTF-8"));
        }
        return m;
    }

    private void handle(String method, String target, byte[] body, OutputStream out) throws IOException {
        int qi = target.indexOf('?');
        String path = qi < 0 ? target : target.substring(0, qi);
        Map<String, String> q = query(qi < 0 ? null : target.substring(qi + 1));
        if (path.equals("/") || path.equals("/index.html")) { asset(out, "web/index.html", "text/html; charset=utf-8"); return; }
        if (path.equals("/app.js") || path.equals("/oslib.js")) { asset(out, "web" + path, "application/javascript; charset=utf-8"); return; }
        if (path.equals("/favicon.ico")) { send(out, 404, "text/plain", new byte[0]); return; }
        // v0.4: home-screen app ("Añadir a pantalla de inicio"). start_url carries the token only if the caller already has it.
        if (path.equals("/icon-192.png") || path.equals("/icon-512.png") || path.equals("/apple-touch-icon.png") || path.equals("/apple-touch-icon-precomposed.png")) {
            asset(out, "web" + (path.startsWith("/apple") ? "/apple-touch-icon.png" : path), "image/png"); return; }
        if (path.equals("/manifest.webmanifest") || path.equals("/manifest.json")) {
            String start = token.equals(q.get("k")) ? "/?k=" + token : "/";
            send(out, 200, "application/manifest+json; charset=utf-8", manifest(start).getBytes("UTF-8")); return; }
        if (!path.equals("/api/status") && !path.equals("/api/send") && !path.equals("/api/log") && !path.equals("/api/a11y")) log(method + " " + path);
        if (!token.equals(q.get("k"))) { json(out, 403, "{\"error\":\"bad token\"}"); return; }
        try {
            switch (path) {
                case "/api/log": {
                    StringBuilder sb = new StringBuilder();
                    synchronized (RING) { for (String l : RING) sb.append(l).append('\n'); }
                    send(out, 200, "text/plain; charset=utf-8", sb.toString().getBytes("UTF-8"));
                    return;
                }
                case "/api/a11y": {
                    int tail = 0; try { tail = Math.min(2000, Integer.parseInt(q.containsKey("tail") ? q.get("tail") : "0")); } catch (NumberFormatException ignored) { }
                    json(out, 200, "{\"enabled\":false}");
                    return;
                }
                case "/api/status":
                    lastPhone = System.currentTimeMillis();
                    json(out, 200, OverlayService.statusJson());
                    return;
                case "/api/send": {
                    lastPhone = System.currentTimeMillis();
                    String msg = new String(body, "UTF-8");
                    JSONObject jo = new JSONObject(msg);
                    String ty = jo.optString("type");
                    if (ty.equals("log")) { log("phone: " + jo.optString("msg")); json(out, 200, "{\"ok\":true}"); return; }
                    if (!ty.equals("sync")) log("send " + ty + (ty.equals("cues") ? " n=" + jo.optJSONArray("cues").length() : ""));
                    else if (!jo.optString("state").equals(lastSyncState)) { lastSyncState = jo.optString("state"); log("sync " + lastSyncState + " pos=" + jo.optLong("pos")); }
                    sink.onMessage(msg); // blocks until the overlay applied it (max 1.5 s)
                    if (ty.equals("sync") && jo.optBoolean("manual")) log("manual start pos=" + jo.optLong("pos") + " -> tv text=" + OverlayService.curText + " cues=" + OverlayService.cueCount);
                    json(out, 200, OverlayService.statusJson());
                    return;
                }
                case "/api/push": {
                    JSONObject o = new JSONObject().put("type", "text").put("text", q.containsKey("text") ? q.get("text") : "")
                            .put("ms", q.containsKey("ms") ? Long.parseLong(q.get("ms")) : 5000);
                    sink.onMessage(o.toString());
                    json(out, 200, "{\"ok\":true,\"tvs\":1}");
                    return;
                }
                case "/os": {
                    String u = q.get("u");
                    URL url = new URL(u);
                    String host = url.getHost();
                    if (!url.getProtocol().equals("https") && !url.getProtocol().equals("http")
                            || !(host.equals("rest.opensubtitles.org") || host.endsWith(".opensubtitles.org") || host.equals("opensubtitles.org"))) {
                        json(out, 400, "{\"error\":\"host not allowed\"}"); return;
                    }
                    HttpURLConnection c = (HttpURLConnection) url.openConnection();
                    c.setRequestProperty("User-Agent", "TemporaryUserAgent");
                    c.setRequestProperty("X-User-Agent", "TemporaryUserAgent");
                    c.setConnectTimeout(15000); c.setReadTimeout(30000);
                    int code = c.getResponseCode();
                    InputStream is = code < 400 ? c.getInputStream() : c.getErrorStream();
                    byte[] data = readAll(is);
                    if (data.length > 2 && (data[0] & 0xff) == 0x1f && (data[1] & 0xff) == 0x8b) data = readAll(new GZIPInputStream(new ByteArrayInputStream(data)));
                    send(out, code, "application/octet-stream", data);
                    return;
                }
            }
            json(out, 404, "{\"error\":\"not found\"}");
        } catch (Exception e) {
            try { json(out, 500, new JSONObject().put("error", String.valueOf(e.getMessage())).toString()); } catch (org.json.JSONException ignored) { }
        }
    }

    private static byte[] readAll(InputStream is) throws IOException {
        if (is == null) return new byte[0];
        ByteArrayOutputStream b = new ByteArrayOutputStream(); byte[] buf = new byte[16384]; int r;
        while ((r = is.read(buf)) > 0) b.write(buf, 0, r);
        is.close(); return b.toByteArray();
    }
    static String manifest(String start) {
        return "{\"name\":\"Subtítulos TV\",\"short_name\":\"Subtítulos\",\"lang\":\"es\",\"id\":\"/\",\"start_url\":\"" + start
            + "\",\"scope\":\"/\",\"display\":\"standalone\",\"orientation\":\"portrait\",\"background_color\":\"#0f1115\",\"theme_color\":\"#0f1115\","
            + "\"icons\":[{\"src\":\"/icon-192.png\",\"sizes\":\"192x192\",\"type\":\"image/png\"},{\"src\":\"/icon-512.png\",\"sizes\":\"512x512\",\"type\":\"image/png\"}]}";
    }
    private void asset(OutputStream out, String name, String type) throws IOException {
        try (InputStream in = ctx.getAssets().open(name)) { send(out, 200, type, readAll(in)); }
    }
    private static void json(OutputStream out, int code, String s) throws IOException { send(out, code, "application/json; charset=utf-8", s.getBytes("UTF-8")); }
    private static void send(OutputStream out, int code, String type, byte[] data) throws IOException {
        String head = "HTTP/1.1 " + code + (code == 200 ? " OK" : " X") + "\r\nContent-Type: " + type + "\r\nContent-Length: " + data.length
                + "\r\nCache-Control: no-store\r\nConnection: keep-alive\r\n\r\n";
        out.write(head.getBytes("UTF-8")); out.write(data);
    }
}
