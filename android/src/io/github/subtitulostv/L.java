package io.github.subtitulostv;

import android.content.Context;

/** Localized TV-side strings (res/values = English, res/values-es = Spanish). */
final class L {
    static volatile Context ctx;
    static void init(Context c) { if (ctx == null && c != null) ctx = c.getApplicationContext(); }
    static String s(int id, Object... a) {
        Context c = ctx;
        if (c == null) return "";
        return a.length == 0 ? c.getString(id) : c.getString(id, a);
    }
}
