// Subtítulos TV — phone page. Speech recognition + matching against the original-language
// subtitle track, then drives the Spanish subtitle clock on the TV.
'use strict';

// ---------- text utils ----------
function norm(s) {
  return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/['’]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}
function words(s) { const n = norm(s); return n ? n.split(' ') : []; }
const CJK = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/;
function tokens(s) { // for CJK languages fall back to character tokens
  if (CJK.test(s)) return [...norm(s).replace(/\s+/g, '')];
  return words(s);
}

// ---------- matcher ----------
class Matcher {
  constructor(cues) {
    this.W = []; // {w, t}
    for (const c of cues) {
      const ws = tokens(c.t); const n = ws.length; if (!n) continue;
      const dur = Math.max(300, c.e - c.s);
      ws.forEach((w, i) => this.W.push({ w, t: c.s + dur * (i + 0.5) / n, cs: c.s, ct: c.t }));
    }
    this.pos = new Map(); // word -> indices
    this.W.forEach((x, i) => { if (!this.pos.has(x.w)) this.pos.set(x.w, []); this.pos.get(x.w).push(i); });
    const N = this.W.length;
    this.weight = w => { const f = this.pos.has(w) ? this.pos.get(w).length : 0; return f ? Math.max(0.15, Math.min(2, Math.log10(N / f) - 0.3)) : 0; };
  }
  // T: recognized tokens (most recent last). Returns best alignment or null.
  match(T, nearT = null, nearWin = 8000) {
    T = T.slice(-14);
    if (T.length < 2) return null;
    const votes = new Map();
    for (let j = 0; j < T.length; j++) {
      const list = this.pos.get(T[j]);
      if (!list || list.length > 60) continue;
      const wt = this.weight(T[j]);
      for (const k of list) {
        const b = Math.round((k + (T.length - 1 - j)) / 4);
        votes.set(b, (votes.get(b) || 0) + wt);
      }
    }
    if (nearT != null) { // always evaluate the neighbourhood of the current position
      const i = this.idxAt(nearT); votes.set(Math.round(i / 4), (votes.get(Math.round(i / 4)) || 0) + 100);
    }
    if (!votes.size) return null;
    const cands = [...votes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
    const results = [];
    for (const [b] of cands) { const r = this.score(T, b * 4); if (r) results.push(r); }
    if (!results.length) return null;
    results.sort((a, b) => b.score - a.score);
    const best = results[0];
    const second = results.find(r => Math.abs(r.idx - best.idx) > 8);
    best.margin = second ? best.score - second.score : best.score;
    if (nearT != null) {
      const nr = results.filter(r => Math.abs(r.t - nearT) < nearWin).sort((a, b) => b.score - a.score)[0];
      best.near = nr || null;
    }
    return best;
  }
  idxAt(t) { let lo = 0, hi = this.W.length - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (this.W[m].t < t) lo = m + 1; else hi = m; } return lo; }
  // Weighted in-order alignment (LCS) of T against W[anchor-window .. anchor+8]
  score(T, anchor) {
    const lo = Math.max(0, anchor - 2 * T.length - 6), hi = Math.min(this.W.length - 1, anchor + 10);
    const n = T.length, m = hi - lo + 1; if (m <= 0) return null;
    // dp[j][k]: best score aligning T[0..j) with W[lo..lo+k)
    let prev = new Float64Array(m + 1), cur;
    const back = []; // store for last-match recovery: best end index per row
    const last = new Int32Array((n + 1) * (m + 1)).fill(-1);
    const cnt = new Int32Array((n + 1) * (m + 1));
    for (let j = 1; j <= n; j++) {
      cur = new Float64Array(m + 1);
      const wt = this.weight(T[j - 1]);
      for (let k = 1; k <= m; k++) {
        let v = prev[k], L = last[(j - 1) * (m + 1) + k], C = cnt[(j - 1) * (m + 1) + k];
        if (cur[k - 1] > v) { v = cur[k - 1]; L = last[j * (m + 1) + k - 1]; C = cnt[j * (m + 1) + k - 1]; }
        if (wt > 0 && this.W[lo + k - 1].w === T[j - 1]) {
          const d = prev[k - 1] + wt + 0.3;
          if (d >= v) { v = d; L = (j - 1) * 100000 + (lo + k - 1); C = cnt[(j - 1) * (m + 1) + k - 1] + 1; }
        }
        cur[k] = v; last[j * (m + 1) + k] = L; cnt[j * (m + 1) + k] = C;
      }
      prev = cur;
    }
    const L = last[n * (m + 1) + m], matched = cnt[n * (m + 1) + m];
    if (L < 0 || matched < 2) return null;
    const lastTj = Math.floor(L / 100000), idx = L % 100000;
    return { idx, t: this.W[idx].t, after: n - 1 - lastTj, matched, n, score: prev[m] };
  }
}

// ---------- sync state machine ----------
// position (ms on the original-track timeline) = anchorPos + (now - anchorWall)
class Syncer {
  constructor(matcher, origCues, opts = {}) {
    this.m = matcher; this.cues = origCues;
    this.lag = opts.lag ?? 700; // recognizer delay between hearing a word and reporting it
    this.state = 'searching'; this.anchorPos = 0; this.anchorWall = 0;
    this.pending = null; this.lastConfirm = 0; this.misses = 0; this.paused = false;
    this.onChange = () => {};
  }
  pos(now) { return this.paused ? this.anchorPos : this.anchorPos + (now - this.anchorWall); }
  setState(s, now) { if (this.state !== s) { this.state = s; this.onChange(s, now); } }
  // tokens: recognized tokens of current utterance (+ some context); isFinal; now: wall clock ms
  feed(T, isFinal, now) {
    if (this.paused) return null;
    const locked = this.state === 'locked';
    const cur = locked ? this.pos(now) : null;
    const r = this.m.match(T, cur);
    const estOf = x => x.t + this.lag + x.after * 300; // estimated current position
    if (locked) {
      const nr = r && r.near;
      if (nr && nr.score >= 3 && Math.abs(estOf(nr) - cur) < 3000) {
        const delta = estOf(nr) - cur;
        // partial correction to avoid jitter; bigger errors are corrected faster
        this.anchorPos = cur + delta * (Math.abs(delta) > 800 ? 0.8 : 0.4);
        this.anchorWall = now; this.lastConfirm = now; this.misses = 0; this.pending = null;
        return { kind: 'confirm', delta, r: nr };
      }
      if (!this.manual && r && r.score >= 7 && r.margin >= 3 && Math.abs(estOf(r) - cur) > 5000) { // looks like a seek: hide until confirmed
        const out = this.candidate(estOf(r), now, r);
        if (out.kind === 'candidate') this.setState('searching', now);
        return out;
      }
      if (isFinal && T.length >= 5) this.miss(now);
      return null;
    }
    if (r && r.score >= 5 && r.margin >= 2) return this.candidate(estOf(r), now, r);
    return null;
  }
  candidate(est, now, r) {
    const off = est - now;
    if (this.pending && Math.abs(this.pending.off - off) < 2000 && now - this.pending.at < 20000) {
      this.lock(est, now); return { kind: 'lock', r };
    }
    if (r.score >= 10 && r.margin >= 4) { this.lock(est, now); return { kind: 'lock', r }; }
    this.pending = { off, at: now };
    return { kind: 'candidate', r };
  }
  lock(est, now) {
    this.anchorPos = est; this.anchorWall = now; this.lastConfirm = now; this.misses = 0; this.pending = null;
    this.setState('locked', now);
  }
  miss(now) {
    if (this.manual) return;
    this.misses++;
    if (this.misses >= 2) this.lose(now);
  }
  manualLock(pos, now) { this.paused = false; this.manual = true; this.lock(pos, now); }
  lose(now) { this.manual = false; this.pending = null; this.misses = 0; this.setState('searching', now); }
  // periodic check: dialogue expected but nothing confirmed for a while -> hide (pause, ads, seek)
  tick(now) {
    if (this.state !== 'locked' || this.paused || this.manual) return;
    const p = this.pos(now), since = now - this.lastConfirm;
    if (since < 12000) return;
    let n = 0; for (const c of this.cues) if (c.s > p - since && c.s < p) n++;
    if ((n >= 3 && since > 12000) || since > 45000) this.lose(now);
  }
  setPaused(on, now) {
    if (on === this.paused) return;
    if (on) { this.anchorPos = this.pos(now); this.paused = true; }
    else { this.paused = false; this.anchorWall = now; this.setState('searching', now); this.pending = { off: this.anchorPos - now, at: now }; }
  }
}


// ---------- v0.5.1: audio resync (phone mic) ----------
// The phone records ~12 s, we turn it into a speech-activity curve (50 ms frames) and slide it over the
// subtitle timing (1 inside a cue, 0 outside). The best correlation gives the film time at recording start.
const AS_FR = 50;
function envFromSamples(x, rate) { // log energy in the voice band (≈300–3000 Hz), one value per 50 ms
  const hpA = Math.exp(-2 * Math.PI * 300 / rate), lpA = Math.exp(-2 * Math.PI * 3000 / rate);
  const per = Math.round(rate * AS_FR / 1000), n = Math.floor(x.length / per), env = new Float32Array(n);
  let hpY = 0, hpX = 0, lp = 0;
  for (let f = 0, i = 0; f < n; f++) {
    let s = 0;
    for (let k = 0; k < per; k++, i++) { const v = x[i]; hpY = hpA * (hpY + v - hpX); hpX = v; lp = lp * lpA + (1 - lpA) * hpY; s += lp * lp; }
    env[f] = Math.log10(s / per + 1e-10);
  }
  return env;
}
function speechAct(env) { // robust z-score, clipped, lightly smoothed, zero mean
  // v0.5.1: syllabic modulation (|Δ log energy| averaged over ±0.4 s) separates dialogue from music/FX far better than loudness
  const n0 = env.length, md = new Float32Array(n0), W = 8;
  for (let i = 0; i < n0; i++) { let s = 0, c = 0; for (let j = Math.max(1, i - W); j <= Math.min(n0 - 1, i + W); j++) { s += Math.abs(env[j] - env[j - 1]); c++; } md[i] = c ? s / c : 0; }
  env = md;
  const n = env.length, srt = Array.from(env).sort((a, b) => a - b), med = srt[n >> 1];
  const dev = Array.from(env, v => Math.abs(v - med)).sort((a, b) => a - b), mad = dev[n >> 1] * 1.4826 + 1e-3;
  const z = Array.from(env, v => Math.max(-2, Math.min(3, (v - med) / mad)));
  const a = Float64Array.from(z);
  let m = 0; for (const v of a) m += v; m /= n; let q = 0; for (let i = 0; i < n; i++) { a[i] -= m; q += a[i] * a[i]; }
  return { a, norm: Math.sqrt(q) };
}
// env: Float32Array of frames; cues: [{s,e}] ms; center: expected film ms at recording start (null = whole film); win: ± ms
function alignAudio(env, cues, center, win = 60000) {
  const n = env.length; if (n < 100 || !cues || !cues.length) return { ok: false, why: 'short' };
  const { a, norm } = speechAct(env); if (norm < 1e-6) return { ok: false, why: 'silence' };
  const end = cues.reduce((m, c) => Math.max(m, c.e), 0) + 60000, T = Math.ceil(end / AS_FR) + n;
  const S = new Uint8Array(T); for (const c of cues) for (let k = Math.max(0, Math.floor(c.s / AS_FR)); k < Math.min(T, Math.ceil(c.e / AS_FR)); k++) S[k] = 1;
  const P = new Int32Array(T + 1); for (let k = 0; k < T; k++) P[k + 1] = P[k] + S[k];
  let lo = 0, hi = T - n; if (center != null) { lo = Math.max(lo, Math.floor((center - win) / AS_FR)); hi = Math.min(hi, Math.ceil((center + win) / AS_FR)); }
  if (hi < lo) return { ok: false, why: 'range' };
  const r = new Float64Array(hi - lo + 1);
  for (let k = lo; k <= hi; k++) {
    const sum = P[k + n] - P[k], v = sum - sum * sum / n; if (sum < 10 || v < 1) { r[k - lo] = 0; continue; } // <0.5 s of dialogue
    let d = 0; for (let i = 0; i < n; i++) if (S[k + i]) d += a[i];
    r[k - lo] = d / (norm * Math.sqrt(v)) * Math.sqrt(Math.min(1, sum / (n * AS_DENS))); // sparse-cue windows match by chance: shrink them
  }
  let b = 0; for (let i = 1; i < r.length; i++) if (r[i] > r[b]) b = i;
  const ex = Math.round(2500 / AS_FR); let r2 = -1; for (let i = 0; i < r.length; i++) if (Math.abs(i - b) > ex && r[i] > r2) r2 = r[i];
  const best = r[b], pos = (b + lo) * AS_FR, sp = P[b + lo + n] - P[b + lo];
  const ok = best >= AS_MINR && best - Math.max(0, r2) >= AS_MARGIN && sp >= 20;
  return { ok, pos, r: best, r2, rr: r, lo, speech: sp * AS_FR, why: ok ? '' : best < AS_MINR ? 'weak' : sp < 20 ? 'nodialog' : 'ambiguous' };
}

// Full recording + its two overlapping halves must agree (±0.6 s): independent chance matches rarely do.
function resync(env, cues, center, win = 15000) {
  const full = alignAudio(env, cues, center, win); if (!full.ok) return full;
  const h = Math.floor(env.length * 0.6), off = env.length - h, d = 600;
  const a = alignAudio(env.subarray(0, h), cues, full.pos, 3000), b = alignAudio(env.subarray(off), cues, full.pos + off * AS_FR, 3000);
  const agA = a.ok !== undefined && a.pos !== undefined && Math.abs(a.pos - full.pos) <= d && a.r >= AS_MINR;
  const agB = b.pos !== undefined && Math.abs(b.pos - off * AS_FR - full.pos) <= d && b.r >= AS_MINR;
  return Object.assign({}, full, { ok: agA && agB, halves: [agA, agB], why: agA && agB ? '' : 'inconsistent' });
}
// v0.5.5 manual tap: chance peaks inside ±30 s often score within 0.05 of the true one -> 'ambiguous'.
// Instead of rejecting, test every near-best local peak with the two-halves check and keep those that pass;
// if several pass, take the one nearest the current clock (the user just shifted it, a few s off at most).
function resyncManual(env, cues, center, win = 30000) {
  const full = alignAudio(env, cues, center, win); if (full.pos === undefined || !full.rr) return full;
  if (full.r < AS_MINR) return full; if (full.why === 'nodialog') return full;
  const { rr, lo } = full, n = env.length, cands = [], ex = Math.round(1500 / AS_FR);
  for (let i = 0; i < rr.length; i++) { if (rr[i] < AS_MINR || rr[i] < full.r - 0.06) continue; let pk = true; for (let j = Math.max(0, i - ex); j <= Math.min(rr.length - 1, i + ex); j++) if (rr[j] > rr[i]) { pk = false; break; } if (pk) cands.push(i); }
  const h = Math.floor(n * 0.6), off = n - h, d = 600, pass = [];
  for (const i of cands) {
    const pos = (i + lo) * AS_FR;
    const a = alignAudio(env.subarray(0, h), cues, pos, 3000), b = alignAudio(env.subarray(off), cues, pos + off * AS_FR, 3000);
    const agA = a.pos !== undefined && Math.abs(a.pos - pos) <= d && a.r >= AS_MINR;
    const agB = b.pos !== undefined && Math.abs(b.pos - off * AS_FR - pos) <= d && b.r >= AS_MINR;
    const c = { pos, r: rr[i], ha: +(a.r || 0).toFixed(2), hb: +(b.r || 0).toFixed(2), agA, agB };
    if (agA && agB) pass.push(c); full.cands = (full.cands || []).concat(c);
  }
  if (!pass.length) return Object.assign({}, full, { ok: false, why: cands.length > 1 ? 'ambiguous' : 'inconsistent' });
  // score: correlation minus a small distance penalty (0.02 per 10 s from the clock)
  const sc = c => c.r - (center == null ? 0 : Math.abs(c.pos - center) / 10000 * 0.03);
  pass.sort((x, y) => sc(y) - sc(x)); const w = pass[0];
  return Object.assign({}, full, { ok: true, pos: w.pos, r: w.r, why: '', picked: pass.length });
}
// v0.6.0: word resync. phrases: [{tok:[...], text, tw}] tw = phone wall ms when the phrase's first interim result
// appeared; clockAt(wall) = film ms the app believes at that wall time. Returns {ok, pos, tw, why, ...}:
// pos = film ms of the matched cue start, which we assume was spoken at tw - WR_LAG.
const WR_LAG = 2900; // v0.6.1: dictation reports ~2 s later than estimated
function wordResync(m, phrases, clockAt) {
  const ests = [];
  for (let i = 0; i < phrases.length; i++) {
    const P = phrases[i]; if (P.tok.length < 3) continue;
    const ctx = (phrases[i - 1] ? phrases[i - 1].tok.slice(-4) : []).concat(P.tok);
    const near = clockAt(P.tw);
    const r = m.match(ctx, near, 30000); if (!r) continue;
    const pick = r.near && r.near.score >= r.score - 1.5 ? r.near : r; // prefer the spot near the clock if almost as good
    const marg = pick === r ? r.margin : Math.max(0, r.margin);
    // first matched word of this phrase ≈ idx - (matched-1) words back (in-order alignment)
    const w0 = m.W[Math.max(0, pick.idx - Math.max(0, Math.min(pick.matched, P.tok.length) - 1))];
    const pos = w0.cs, tw = P.tw - WR_LAG;
    ests.push({ pos, tw, off: pos - clockAt(tw), matched: pick.matched, score: pick.score, margin: marg, text: P.text, line: w0.ct });
  }
  const good = ests.filter(e => e.matched >= 3 && e.score >= 4 && (e.margin >= 2 || Math.abs(e.off) < 30000 && e.margin >= 1));
  const base = { ests, why: '' };
  if (!good.length) return Object.assign(base, { ok: false, why: ests.length ? 'pocas palabras coinciden' : 'no reconocí frases útiles' });
  // agreement: largest cluster of offsets within ±1.5 s
  let best = []; for (const g of good) { const c = good.filter(h => Math.abs(h.off - g.off) <= 1500); if (c.length > best.length || c.length === best.length && c.reduce((a, b) => a + b.score, 0) > best.reduce((a, b) => a + b.score, 0)) best = c; }
  const strong = best.length >= 2 || best[0].matched >= 5 && best[0].margin >= 4;
  if (!strong) return Object.assign(base, { ok: false, why: 'solo una frase dudosa', best: best[0] });
  if (good.length - best.length > best.length) return Object.assign(base, { ok: false, why: 'frases contradictorias', best: best[0] });
  const offs = best.map(e => e.off).sort((a, b) => a - b), off = offs[offs.length >> 1];
  const e = best.find(x => x.off === off);
  return Object.assign(base, { ok: true, pos: e.pos, tw: e.tw, off, n: best.length, best: e });
}
let AS_MINR = 0.4, AS_MARGIN = 0.05, AS_DENS = +((typeof process !== 'undefined' && process.env.DENS) || 0.3);
if (typeof module !== 'undefined') { module.exports = { wordResync, Matcher, Syncer, tokens, norm, envFromSamples, alignAudio, resync, resyncManual, setAS: (r, m) => { AS_MINR = r; AS_MARGIN = m; } }; }

// ---------- UI ----------
if (typeof window !== 'undefined') (function () {
  const $ = id => document.getElementById(id);
  const K = new URLSearchParams(location.search).get('k') || localStorage.getItem('k') || '';
  if (K) localStorage.setItem('k', K);
  let serverOffset = 0, bestRtt = 1e9;
  let track = null, matcher = null, syncer = null, rec = null, listening = false, wakeLock = null;
  let userOffset = +(localStorage.getItem('offset') || 0), fontSize = +(localStorage.getItem('fontSize') || 48);
  // Shown with the button sign convention: negative = subtitles earlier (userOffset > 0).
  const offTxt = () => { const v = -userOffset / 1000; return '⇆ ' + (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(2).replace('.', ',') + ' s' + (v < 0 ? ' · tarde' : v > 0 ? ' · pronto' : ''); };
  let tvSeenAt = 0, tvHidden = false, lastSent = 0, lastFinalTokens = [], tvLast = null, tvFail = 0;
  // Auto-pause: the TV counts how long the film was paused ("held"); we keep the value we last applied.
  let tvHeld = null, tvEpoch = null, mediaOptsShown = false;
  const sendChecked = msg => fetch('/api/send?k=' + encodeURIComponent(K), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(msg) })
    .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
  // v0.4.4: explicit = a film the user just chose (turns the TV on again after ⏻). The automatic re-send after a TV
  // restart is NOT explicit, so a switched-off TV ignores it and never comes back on by itself.
  const VERSION = 'v0.5.3';
  // v0.4.5: inline SVG standby icon (Android fonts lack U+23FB, it showed as a box)
  const PWR = '<svg class="pwi" viewBox="0 0 24 24" width="1em" height="1em" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M7.05 6.05a8 8 0 1 0 9.9 0"/><path d="M12 2.8v8.4"/></svg>';
  let lastTrack = null, myGen = null; // lastTrack: film to offer "↺ Volver a cargar" after an AUTOMATIC switch-off
  const sendCues = (explicit = false) => sendChecked({ type: 'cues', title: track.title, cues: track.spa, explicit: !!explicit })
    .then(r => { if (explicit && r && r.gen !== undefined) myGen = r.gen; return r; });
  const tvOff = () => !!(tvLast && tvLast.power === 'off');
  function showTv(s) {
    const el = document.getElementById('tvnow'); if (!el || !s || s.state === undefined) return;
    if (s.power === 'off') { el.className = 'muted'; el.textContent = ''; return; } // the ⏻ box says it all
    if (!s.overlayAlive) { el.className = 'err'; el.textContent = '❌ La app de la tele no está dibujando (servicio parado). Abre «Subtítulos TV» en la tele y pulsa Iniciar.'; return; }
    if (s.state !== 'locked') { el.className = 'muted'; el.textContent = 'Tele: ' + (s.cues ? s.cues + ' frases cargadas, esperando sincronización' : 'sin subtítulos cargados'); return; }
    if (s.hiddenByAd) { el.className = 'muted'; el.textContent = '📺 Anuncio en curso · subtítulos ocultos, siguen en ' + fmt(s.pos) + ' cuando pulses «Termina anuncio».'; return; }
    if (s.hiddenByMedia && s.media && s.media.srcGone) { el.className = 'muted'; el.textContent = '⏹ ' + (s.media.srcApp || s.media.app || 'La app') + ' cerrado: subtítulos ocultos y parados en ' + fmt(s.pos) + '. Vuelven solos al reproducir otra vez en ' + (s.media.srcApp || s.media.app || 'la app') + '.'; return; }
    if (s.hiddenByMedia) { el.className = 'muted'; el.textContent = '⏹ ' + (s.media.app || 'La app') + ' no está reproduciendo: subtítulos ocultos hasta que vuelvas a darle a reproducir.'; return; }
    if (s.media && s.media.autoPause && s.media.kind === 'held') { el.className = 'muted'; el.textContent = '⏸ Tele congelada en ' + fmt(s.pos) + ' (' + s.media.app + ' ' + s.media.state + ')' + (s.text ? ' · «' + s.text.replace(/\n/g, ' ') + '»' : ''); return; }
    el.className = 'ok'; // v0.4: the big time and the subtitle box already show position and text
    el.textContent = s.text ? '' : '💬 Sin diálogo' + (s.nextIn >= 0 ? ' · siguiente frase en ' + Math.round(s.nextIn / 1000) + ' s' : '');
  }

  const api = (p, opt) => (window.OSLIB && /^\/api\/(search|tracks|upload)/.test(p)) ? window.OSLIB.route(p, opt) : fetch(p + (p.includes('?') ? '&' : '?') + 'k=' + encodeURIComponent(K), opt).then(r => r.json());
  const send = msg => api('/api/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(msg) }).catch(() => {});
  const serverNow = () => Date.now() + serverOffset;
  const rlog = m => { try { fetch('/api/send?k=' + encodeURIComponent(K), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'log', msg: String(m).slice(0, 300) }) }).catch(() => {}); } catch (e) {} };
  rlog('page load secure=' + window.isSecureContext + ' SR=' + !!(window.SpeechRecognition || window.webkitSpeechRecognition) + ' ua=' + navigator.userAgent);
  const recState = t => { $('recst').textContent = t; };
  const fmt = ms => { ms = Math.max(0, ms); const s = Math.floor(ms / 1000); return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };

  async function status() {
    const t0 = Date.now();
    try {
      let s = await api('/api/status'); const t1 = Date.now(); const rtt = t1 - t0;
      if (rtt < bestRtt + 30) { serverOffset = s.serverNow - (t0 + rtt / 2); bestRtt = Math.min(bestRtt, rtt); }
      tvLast = s; tvSeenAt = Date.now() - rtt / 2; tvFail = 0;
      applyMedia(s, t1 - rtt / 2);
      // v0.5.3: mirror the TV clock on the phone (TV is authoritative); skip slow replies (phone waking up)
      if (syncer && syncer.state === 'locked' && !syncer.paused && !listening && s.pos !== undefined && (s.state === 'locked' || s.state === 'hidden') && rtt < 600) {
        syncer.anchorPos = s.pos - userOffset; syncer.anchorWall = t1 - rtt / 2; }
      if (s.power === 'off' && track) { // switched off (here, by another phone, or on its own): forget the film here too
        rlog('tv is off (' + s.offCode + ') -> dropping the track on the phone');
        const keep = s.offCode !== 'user' ? track : null; resetPhone(); lastTrack = keep;
      }
      if (track && track.restored && (!s.cues || s.title && s.title !== track.title)) { rlog('restored track not on tv, dropped'); track = null; matcher = null; syncer = null; }
      else if (track && track.restored) track.restored = false;
      if (track && s.power !== 'off' && s.cues !== undefined && s.cues !== track.spa.length) { rlog('tv has ' + s.cues + ' cues, resending ' + track.spa.length); await sendCues(); if (s.state !== 'locked' && s.state !== 'hidden') pushSync(); s = await api('/api/status'); }
      showTv(s); tvLast = s; showNow();
      $('tvdot').className = 'dot' + (s.tvConnected ? ' on' : '');
      $('tvtxt').textContent = s.tvConnected ? 'Tele' : 'Tele desconectada';
    } catch (e) { tvFail++; $('tvdot').className = 'dot'; $('tvtxt').textContent = '❌ Sin tele'; $('tvnow').className = 'err'; $('tvnow').textContent = '❌ No llego a la tele (' + (e.message || e) + '). ¿Está encendida, con la app abierta y en la misma wifi?'; showNow(); }
  }
  setInterval(status, 2000); status();

  // Keep the phone clock in step with what the TV did on its own (pause/resume of the film, auto-sync).
  function applyMedia(s, at) {
    if (s.held === undefined) return;
    if (s.power === 'off') { tvHeld = null; tvEpoch = null; showMedia(s); return; }
    if (s.epoch !== tvEpoch || tvHeld == null) { tvEpoch = s.epoch; tvHeld = s.held; }
    else if (s.held > tvHeld) {
      const d = s.held - tvHeld; tvHeld = s.held;
      if (syncer && !syncer.paused && s.anchor !== 'media') { syncer.anchorPos -= d; rlog('film was paused ' + (d / 1000).toFixed(1) + ' s -> phone clock shifted'); }
    }
    // v0.4.2: TV frozen on its own (app paused/closed, ad): mirror its position so our pushes can't move it
    const tvFrozen = s.hiddenByMedia || s.hiddenByAd || (s.media && s.media.autoPause && s.media.kind === 'held');
    if (tvFrozen && s.anchor !== 'media' && syncer && s.state === 'locked' && syncer.state === 'locked' && !syncer.paused && !listening) {
      syncer.anchorPos = s.pos - userOffset; syncer.anchorWall = at;
    }
    if (s.anchor === 'media' && syncer && s.state === 'locked' && !syncer.paused) { // TV follows the app's position
      syncer.anchorPos = s.pos - userOffset; syncer.anchorWall = at;
      if (syncer.state !== 'locked') { syncer.manual = true; syncer.state = 'locked'; render(); }
    }
    showMedia(s);
  }
  // v0.4 manual "Anuncio" button. The TV owns the state (s.ad); we only mirror it.
  let adTv = null, adSeenAt = 0, adBusy = false;
  const mmss = ms => { const t = Math.max(0, Math.floor(ms / 1000)); return String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0'); };
  const segs = ms => (Math.round(ms / 100) / 10).toLocaleString('es-ES') + ' s';
  function showAd(s) {
    if (s && s.ad === undefined) { $('adBox').style.display = 'none'; return; } // old TV app
    if (s) { adTv = s.ad; adSeenAt = Date.now(); }
    $('adBox').style.display = '';
    const a = adTv; if (!a) return;
    const btn = $('adBtn'), info = $('adInfo'), rst = $('adReset');
    setBtn(btn, a.on ? '▶' : '📺', a.on ? 'Termina anuncio' : 'Empieza anuncio');
    btn.classList.toggle('on', !!a.on); btn.disabled = adBusy;
    if (a.on) { info.className = 'on'; info.textContent = 'Anuncio en curso (' + mmss(a.elapsed + Date.now() - adSeenAt) + ') · subtítulos ocultos'; rst.style.display = 'none'; return; }
    rst.style.display = a.count ? '' : 'none';
    info.className = 'muted';
    info.textContent = a.count ? 'Anuncios: ' + a.count + ', total ' + segs(a.total) + ' (último ' + segs(a.last) + ') · descontados de los subtítulos'
      : 'Pulsa al empezar y al acabar los anuncios';
  }
  setInterval(() => { if (adTv && adTv.on) { showAd(null); showNow(); } }, 500);
  async function adSend(msg) {
    if (adBusy) return; adBusy = true; showAd(null);
    try {
      const t0 = Date.now(), r = await sendChecked(msg);
      rlog('ad ' + JSON.stringify(msg) + ' -> ' + JSON.stringify(r.ad));
      adBusy = false; applyMedia(r, (t0 + Date.now()) / 2); if (r.state !== undefined) { tvLast = r; tvSeenAt = (t0 + Date.now()) / 2; } showAd(r); showTv(r); showNow();
    } catch (e) { adBusy = false; showAd(null); $('adInfo').className = 'err'; $('adInfo').textContent = '❌ No llego a la tele: ' + e.message; }
  }
  $('adBtn').onclick = () => tvOff() ? offNote() : adSend({ type: 'ad', on: !(adTv && adTv.on) });
  $('adReset').onclick = e => { e.preventDefault(); if (confirm('¿Reiniciar el tiempo de anuncios de este capítulo?')) adSend({ type: 'ad', reset: true }); };
  function showMedia(s) {
    const m = s.media; if (!m) return;
    if (!mediaOptsShown) { $('autoPause').checked = !!m.autoPause; $('autoSync').checked = !!m.autoSync; mediaOptsShown = true; }
    showAd(s);
    const el = $('mediaSt'), hint = $('mediaHint');
    if (!m.access) {
      el.className = 'muted'; el.textContent = 'Pausa automática: falta un permiso en la tele.';
      hint.style.display = ''; return;
    }
    hint.style.display = 'none';
    if (!m.app) { el.className = 'muted'; el.textContent = 'Pausa automática activa · ninguna app está reproduciendo ahora.'; return; }
    const icon = m.kind === 'playing' ? '▶' : m.kind === 'held' ? '⏸' : m.kind === 'stopped' ? '⏹' : '•';
    let extra = '';
    if (m.autoPause && s.state === 'locked') extra = m.kind === 'held' ? ' · subtítulos congelados' : m.kind === 'stopped' ? ' · subtítulos ocultos' : '';
    if (m.srcGone) { el.className = 'muted'; el.textContent = '⏹ ' + (m.srcApp || m.app) + ': cerrado' + (m.autoPause ? ' · subtítulos ocultos' : ' · pausa automática desactivada'); return; }
    if (!m.autoPause) extra = ' · pausa automática desactivada';
    el.className = m.kind === 'playing' ? 'ok' : 'muted';
    el.textContent = icon + ' ' + m.app + ': ' + m.state + extra + (s.anchor === 'media' ? ' · siguiendo la posición de la app' : '');
  }
  $('offsetTxt').textContent = offTxt();
  function setBtn(b, ic, tx) { b.querySelector('.ic').textContent = ic; b.querySelector('.tx').textContent = tx; }
  // v0.4 UI: the "now playing" card (big time + state chips), fed by the TV status and the phone clock.
  function showNow() {
    const s = tvLast && tvLast.state !== undefined ? tvLast : null, now = Date.now();
    const tvLocked = !!(s && s.state === 'locked');
    const adOn = !!(adTv && adTv.on) || !!(s && s.hiddenByAd);
    const frozen = tvLocked && (adOn || s.hiddenByMedia || (s.media && s.media.autoPause && s.media.kind === 'held'));
    const phoneLocked = !!(syncer && syncer.state === 'locked');
    let p = null;
    if (frozen) p = s.pos;
    else if (phoneLocked) p = syncer.pos(now) + userOffset;
    else if (tvLocked) p = s.pos + (now - tvSeenAt);
    const t = $('npTime');
    t.textContent = p == null ? '–:––:––' : fmt(p);
    t.className = p == null || frozen || (syncer && syncer.paused) || tvHidden ? 'dim' : '';
    const chip = $('npChip'); let cls = '', txt = '';
    const m = s && s.media, off = !!(s && s.power === 'off');
    showPower(s);
    if (off) { cls = 'off'; txt = 'Apagado'; }
    else if (adOn) { cls = 'ad'; txt = '📺 Anuncio' + (adTv && adTv.on ? ' ' + mmss(adTv.elapsed + now - adSeenAt) : ''); }
    else if (s && s.hiddenByMedia) { cls = 'stop'; const app = m.srcApp || m.app; txt = m.srcGone ? '⏹ ' + (app || 'App') + ' cerrado · subtítulos ocultos' : '⏹ ' + (app ? app + ' detenido' : 'Parado') + ' · subtítulos ocultos'; }
    else if (m && m.app) { cls = m.kind === 'playing' ? 'play' : m.kind === 'held' ? 'held' : 'stop'; txt = (m.kind === 'playing' ? '▶ ' : m.kind === 'held' ? '⏸ ' : '⏹ ') + m.app; }
    else if (tvHidden) { cls = 'held'; txt = '🙈 Ocultos'; }
    chip.className = 'chip ' + cls; chip.textContent = txt; if (off) chip.insertAdjacentHTML('afterbegin', PWR + ' '); chip.style.display = txt ? '' : 'none';
    showPause();
    if (!track) { const tt = $('npTitle'); // page reopened: show what the TV already has
      if (off) tt.textContent = 'Apagado · carga subtítulos para encender ↓';
      else if (s && s.cues) { $('manualRow').style.display = ''; tt.innerHTML = ''; const b = document.createElement('b'); b.textContent = s.title || 'Subtítulos en la tele'; tt.appendChild(b); tt.appendChild(document.createTextNode(' · ' + s.cues + ' frases')); }
      else tt.textContent = 'Sin subtítulos · elige qué vas a ver ↓'; }
    if (!syncer) { $('line').textContent = tvLocked && !adOn && !(s && s.hiddenByMedia) ? (s.text || '') : ''; const st = $('state'); st.className = 'chip ' + (tvLocked ? 'locked' : 'searching'); st.textContent = tvLocked ? '✔ Sincronizado' : '⏳ Sin sincronizar'; st.style.display = off ? 'none' : ''; }
    else $('state').style.display = '';
    $('syncCta').style.display = track && !tvLocked && !phoneLocked && !$('s3').open ? '' : 'none';
  }
  // ---------- v0.4.4 ⏻ power ----------
  function showPower(s) {
    const off = !!(s && s.power === 'off'), box = $('offBox'), rb = $('reloadBtn'), pb = $('powerBtn');
    pb.classList.toggle('off', off); document.body.classList.toggle('pwoff', off); pb.querySelector('.ptx').textContent = off ? 'Apagado' : 'Apagar';
    if (!off) { box.style.display = 'none'; rb.style.display = 'none'; return; }
    box.style.display = 'block';
    box.innerHTML = '<b>' + PWR + ' Subtítulos apagados</b> · ';
    box.appendChild(document.createTextNode((s.offReason || 'Apagado') + '. No saldrá nada en la tele hasta que cargues subtítulos.'));
    rb.style.display = lastTrack ? 'block' : 'none';
    if (lastTrack) rb.textContent = '↺ Volver a cargar «' + lastTrack.title + '»';
  }
  // Everything on the phone back to zero (track, clock, offset, pause, ads mirror, mic). Keeps the token and the text size.
  function resetPhone() {
    if (listening) { listening = false; try { rec && rec.stop(); } catch (e) {} if (wakeLock) wakeLock.release().catch(() => {}); wakeLock = null; }
    if (syncer) syncer.onChange = () => {};
    track = null; matcher = null; syncer = null; lastTrack = null; myGen = null; localStorage.removeItem('lastTrack');
    userOffset = 0; localStorage.removeItem('offset'); $('offsetTxt').textContent = offTxt();
    tvHidden = false; $('hideBtn').textContent = '🙈 Ocultar'; tvPausedPos = null; tvHeld = null; tvEpoch = null; adTv = null;
    $('manualT').value = ''; $('manualMsg').textContent = ''; $('manualMsg').className = 'muted'; $('manualRow').style.display = 'none';
    $('fSpa').value = ''; $('fOrig').value = ''; $('results').innerHTML = ''; $('loaded').textContent = ''; $('s1sum').textContent = ''; $('s1').open = true;
    ['heard', 'match', 'dbg', 'recst', 'pos', 'line'].forEach(id => { $(id).textContent = ''; });
    $('listenBtn').textContent = '🎤 Empezar a escuchar'; $('listenBtn').classList.remove('stop'); $('listenBtn').disabled = true;
    $('npTitle').textContent = 'Sin subtítulos · elige qué vas a ver ↓';
    showNow();
  }
  $('powerBtn').onclick = async () => {
    rlog('⏻ power off from the phone');
    resetPhone();
    try { const r = await sendChecked({ type: 'power', on: false }); if (r && r.state !== undefined) { tvLast = r; tvSeenAt = Date.now(); } }
    catch (e) { $('tvnow').className = 'err'; $('tvnow').textContent = '❌ No llego a la tele para apagarla: ' + e.message; }
    showNow(); showTv(tvLast);
  };
  $('reloadBtn').onclick = () => { const t = lastTrack; if (t) { rlog('reload after auto-off ' + t.title); useTrack(t); } };
  const offNote = el => { el = el || $('tvnow'); el.className = 'err'; el.innerHTML = PWR + ' La tele está apagada: carga subtítulos para encender.'; };
  $('ver').textContent = 'Subtítulos TV ' + VERSION;
  $('syncCta').onclick = () => {
    $('s3').open = true; $('manualRow').style.display = '';
    $('manualRow').scrollIntoView({ behavior: 'smooth', block: 'center' }); showNow(); // no focus(): don't pop the keyboard
  };
  $('s3').addEventListener('toggle', () => showNow());

  $('searchBtn').onclick = async () => {
    const q = $('q').value.trim(); if (!q) return;
    $('results').innerHTML = '<p class="muted">Buscando…</p>';
    const p = new URLSearchParams({ q, season: $('season').value, episode: $('episode').value });
    const d = await api('/api/search?' + p).catch(e => ({ error: e.message }));
    if (d.error) { $('results').innerHTML = '<p>Error: ' + d.error + '</p>'; return; }
    if (!d.results.length) { $('results').innerHTML = '<p>No he encontrado subtítulos en español. Prueba con el título original o en inglés, o sube un .srt.</p>'; return; }
    $('results').innerHTML = '';
    for (const r of d.results) {
      const div = document.createElement('div'); div.className = 'res';
      div.innerHTML = `<b></b><br><small></small>`;
      div.querySelector('b').textContent = r.name + (r.year ? ` (${r.year})` : '');
      div.querySelector('small').textContent = (r.kind === 'episode' ? `T${r.season} E${r.episode} · ` : '') + `${r.count} subtítulos en español`;
      div.onclick = () => loadTracks(r);
      $('results').appendChild(div);
    }
  };

  async function loadTracks(r) {
    $('loaded').textContent = 'Descargando subtítulos…';
    const [orig] = $('orig').value.split('|');
    const p = new URLSearchParams({ imdb: r.imdb, orig, service: $('service').value });
    const d = await api('/api/tracks?' + p).catch(e => ({ error: e.message }));
    if (d.error) { $('loaded').textContent = 'Error: ' + d.error; return; }
    useTrack(d);
  }

  $('uploadBtn').onclick = async () => {
    const f1 = $('fSpa').files[0], f2 = $('fOrig').files[0];
    if (!f1) { alert('Elige el .srt en español'); return; }
    const body = { title: f1.name, spa: await f1.text(), orig: f2 ? await f2.text() : '' };
    const d = await api('/api/upload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (d.error) { $('loaded').textContent = 'Error: ' + d.error; return; }
    useTrack(d);
  };

  function useTrack(d, quiet) {
    track = d; lastTrack = null;
    try { localStorage.setItem('lastTrack', JSON.stringify(d)); } catch (e) {}
    const hasOrig = d.orig && d.orig.length > 20;
    $('loaded').innerHTML = '';
    const b = document.createElement('div');
    b.textContent = `✔ ${d.title} — ${d.spa.length} frases en español` + (hasOrig ? `, ${d.orig.length} en versión original.` : '. Sin pista original: no se puede sincronizar escuchando.');
    $('loaded').appendChild(b);
    if (d.spaRelease) { const s = document.createElement('div'); s.textContent = 'Versión: ' + d.spaRelease; $('loaded').appendChild(s); }
    matcher = hasOrig ? new Matcher(d.orig) : null;
    if (syncer) syncer.onChange = () => {};
    syncer = new Syncer(matcher || new Matcher(d.spa), d.orig && d.orig.length ? d.orig : d.spa);
    if (syncer) syncer.onChange = (st) => { rlog('state ' + st + ' pos=' + fmt(syncer.pos(Date.now()))); pushSync(); render(); };
    if (!quiet) sendCues(true).then(r => { rlog('tv cues ok ' + r.cues + ' gen=' + r.gen); if (r && r.state !== undefined) { tvLast = r; tvSeenAt = Date.now(); showNow(); } }).catch(e => { $('manualMsg').className = 'err'; $('manualMsg').textContent = '❌ No he podido mandar los subtítulos a la tele: ' + e.message; });
    rlog('track ' + d.title + ' spa=' + d.spa.length + ' orig=' + (d.orig ? d.orig.length : 0) + ' align=' + JSON.stringify(d.align) + ' rel=' + d.spaRelease + ' / ' + d.origRelease);
    $('manualRow').style.display = '';
    $('listenBtn').disabled = !matcher;
    $('npTitle').innerHTML = ''; { const b = document.createElement('b'); b.textContent = d.title; $('npTitle').appendChild(b); }
    $('s1sum').textContent = '· ' + d.title; $('s1').open = false;
    window.scrollTo({ top: 0, behavior: 'smooth' }); showNow();
  }

  function pushSync(force, resume) {
    if (!syncer || tvOff()) return;
    const now = Date.now();
    const st = tvHidden ? 'hidden' : (syncer.paused ? 'paused' : syncer.state);
    const msg = { type: 'sync', state: st, pos: Math.round(syncer.pos(now) + userOffset), at: Math.round(now + serverOffset), off: userOffset };
    if (tvHeld != null && !syncer.paused) { msg.held = tvHeld; msg.epoch = tvEpoch; } // TV subtracts pauses we have not seen yet
    if (resume) msg.resume = true; // v0.4.4: only an explicit resume ends a pause on the TV (stale 'locked' pushes can't)
    send(msg);
    lastSent = now;
  }

  function currentLine(pos) {
    if (!track) return '';
    const c = track.spa.find(c => c.s <= pos && pos < c.e);
    return c ? c.t : '';
  }

  function render() {
    if (!syncer) return;
    const now = Date.now();
    const labels = { locked: '✔ Sincronizado', searching: '🔎 Buscando…' };
    const tvLocked = !!(tvLast && tvLast.state === 'locked');
    const idle = !listening && syncer.state !== 'locked';
    $('state').className = 'chip ' + (syncer.paused ? 'paused' : idle && tvLocked ? 'locked' : syncer.state);
    $('state').textContent = syncer.paused ? '⏸ En pausa' : idle ? (tvLocked ? '✔ Sincronizado' : '⏳ Sin sincronizar') : labels[syncer.state];
    const p = syncer.pos(now) + userOffset;
    $('pos').textContent = syncer.state === 'locked' ? 'Posición: ' + fmt(p) : '';
    $('line').textContent = syncer.state === 'locked' && !syncer.paused ? currentLine(p) : '';
  }
  setInterval(() => {
    showNow();
    if (!syncer) return;
    syncer.tick(Date.now()); render();
    // v0.5.3: the TV owns the clock. No periodic pushes: a locked/resumed phone must never move it (only taps do).
    if (listening && Date.now() - lastSent > 2000) pushSync();
  }, 200);

  // ---------- speech ----------
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  function startRec() {
    if (!SR) { alert('Este navegador no tiene reconocimiento de voz. Usa Chrome.'); return; }
    rec = new SR();
    rec.lang = $('orig').value.split('|')[1];
    rec.onstart = () => { recState('🎤 Escuchando (' + rec.lang + ')'); rlog('rec start ' + rec.lang); };
    rec.onaudiostart = () => rlog('rec audio start');
    rec.continuous = true; rec.interimResults = true; rec.maxAlternatives = 1;
    rec.onresult = ev => {
      const now = Date.now();
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const res = ev.results[i]; const text = res[0].transcript;
        const T = lastFinalTokens.slice(-4).concat(tokens(text));
        $('heard').textContent = '🎤 ' + text;
        const out = syncer.feed(T, res.isFinal, now);
        if (out && (out.kind === 'confirm' || out.kind === 'lock')) pushSync();
        if (res.isFinal) { lastFinalTokens = tokens(text); nFinal++; rlog('heard[' + syncer.state + '] ' + text + ' | ' + scoreTxt(T)); }
        nResults++; recState('🎤 Escuchando (' + rec.lang + ') · ' + nResults + ' resultados');
        dbg(out, T);
      }
    };
    rec.onerror = e => { recState('⚠ Error del micrófono: ' + e.error); rlog('rec error ' + e.error + ' ' + (e.message || ''));
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') { alert('Chrome no deja usar el micrófono (' + e.error + '). Revisa el permiso del sitio (candado → Permisos → Micrófono).'); stopListening(); } };
    rec.onend = () => { if (listening) setTimeout(() => { try { rec.start(); } catch (e) { rlog('restart fail ' + e.message); } }, 250); };
    rec.start();
  }
  let nResults = 0, nFinal = 0;
  function scoreTxt(T) {
    const r = matcher && matcher.match(T, syncer && syncer.state === 'locked' ? syncer.pos(Date.now()) : null);
    return r ? `coincidencia ${r.matched}/${r.n} palabras · puntos ${r.score.toFixed(1)} (hace falta 5) · margen ${r.margin.toFixed(1)} (hace falta 2)` : 'sin coincidencia';
  }
  function dbg(out, T) {
    $('match').textContent = scoreTxt(T);
    if (!out) return;
    $('dbg').textContent = `${out.kind} · ${out.r.matched}/${out.r.n} palabras` + (out.delta != null ? ` · corrección ${Math.round(out.delta)} ms` : '');
  }
  async function startListening() {
    listening = true; startRec();
    try { wakeLock = await navigator.wakeLock.request('screen'); } catch (e) {}
    $('listenBtn').textContent = '⏹ Dejar de escuchar'; $('listenBtn').classList.add('stop');
    render();
  }
  function stopListening() {
    listening = false; try { rec && rec.stop(); } catch (e) {}
    if (wakeLock) wakeLock.release().catch(() => {}); wakeLock = null;
    if (syncer && !syncer.manual) { syncer.lose(Date.now()); send({ type: 'sync', state: 'stopped', pos: 0, at: serverNow() }); }
    $('listenBtn').textContent = '🎤 Empezar a escuchar'; $('listenBtn').classList.remove('stop');
    render();
  }
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible' && listening && !wakeLock) { try { wakeLock = await navigator.wakeLock.request('screen'); } catch (e) {} }
  });

  // ---------- v0.5.1: Resincronizar (phone mic, ~20 s, then the mic is released) ----------
  let avLat = +(localStorage.getItem('avLat') || 0);
  $('avLat').value = avLat; $('avLat').onchange = () => { avLat = Math.round(+$('avLat').value || 0); localStorage.setItem('avLat', avLat); };
  let micBusy = false, autoArmedFor = null, autoTimer = null;
  $('autoMic').checked = localStorage.getItem('autoMic') !== '0';
  $('autoMic').onchange = () => { localStorage.setItem('autoMic', $('autoMic').checked ? '1' : '0'); if (!$('autoMic').checked) autoStop('Desactivado.'); };
  const clockNow = () => { const now = Date.now();
    if (syncer && syncer.state === 'locked' && !syncer.paused) return syncer.pos(now) + userOffset;
    const s = tvLast; if (s && (s.state === 'locked' || s.state === 'hidden') && !(s.media && s.media.kind === 'held')) return tvPosNow();
    return null; };
  async function recordEnv(ms, onTick) { // returns { env, t0 } ; t0 = wall clock of the first sample
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    rlog('mic open ' + stream.getAudioTracks().map(t => t.readyState + '/' + t.muted).join(','));
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    try { if (ac.state !== 'running') await ac.resume(); } catch (e) {}
    let hid = document.hidden; const vh = () => { if (document.hidden) hid = true; }; document.addEventListener('visibilitychange', vh);
    try {
      const src = ac.createMediaStreamSource(stream), sp = ac.createScriptProcessor(4096, 1, 1), parts = []; let got = 0, t0 = null;
      const need = Math.round(ac.sampleRate * ms / 1000);
      await new Promise(res => {
        sp.onaudioprocess = e => { const d = e.inputBuffer.getChannelData(0);
          parts.push(new Float32Array(d)); got += d.length;
          // audio clock: sample 0 = now − samples so far; the minimum over callbacks drops JS scheduling delay
          const est = performance.timeOrigin + performance.now() - got / ac.sampleRate * 1000 - (ac.baseLatency || 0) * 1000; if (t0 == null || est < t0) t0 = est; if (onTick) onTick(got / need); if (got >= need) res(); };
        src.connect(sp); sp.connect(ac.destination);
        setTimeout(res, ms + 4000);
        // v0.5.4: no audio frames at all (suspended context / track ended) -> fail loudly instead of a silent no-op
        setTimeout(() => { if (!got) { rlog('no audio frames, ac=' + ac.state); res(); } }, 4000);
        stream.getAudioTracks().forEach(t => t.onended = () => { rlog('mic track ended'); res(); });
      });
      sp.disconnect(); src.disconnect();
      const x = new Float32Array(got); let o = 0; for (const p of parts) { x.set(p, o); o += p.length; }
      // v0.5.3: phone locked/backgrounded while listening -> audio is gappy, never use it
      if (!got) throw new Error('noaudio');
      if (hid || got < ms / 1000 * ac.sampleRate * 0.95) { rlog('resync discarded: hidden=' + hid + ' got=' + got); throw new Error('hidden'); }
      let pk = 0; for (let i = 0; i < x.length; i += 64) pk = Math.max(pk, Math.abs(x[i])); rlog('mic peak=' + pk.toFixed(4)); if (pk < 1e-4) throw new Error('noaudio');
      return { env: envFromSamples(x, ac.sampleRate), t0 };
    } finally { document.removeEventListener('visibilitychange', vh); stream.getTracks().forEach(t => t.stop()); ac.close().catch(() => {}); } // mic off
  }
  async function applyAudioPos(pos, t0) {
    // pos = film time of sample 0 (phone wall clock t0); +avLat = TV sound comes out later than the picture/subs.
    // The TV gets it as pos + 'at' in TV clock (serverOffset, NTP-style), so network/processing delay cancels.
    const P = Math.round(pos + (Date.now() - t0) - avLat), before = clockNow();
    // v0.6.1: the TV owns the clock (mediaAnchor) and ignores non-manual pushes -> always send a manual sync
    if (syncer) { syncer.manualLock(P - userOffset, Date.now()); render(); }
    await tvSync(tvHidden ? 'hidden' : 'locked', P, true);
    return before == null ? null : P - before;
  }
  async function resyncOnce(win, msgEl, manual) {
    const cues = track && track.spa; if (!cues) throw new Error('nocues');
    const t0c = clockNow(), tc = Date.now();
    const { env, t0 } = await recordEnv(20000, f => { msgEl.textContent = '🎧 Escuchando… ' + Math.min(100, Math.round(f * 100)) + ' %'; });
    const center = t0c == null ? null : t0c + (t0 - tc);
    const r = (manual && center != null ? resyncManual : resync)(env, cues, center, center == null ? 1e9 : win);
    try { const hist = JSON.parse(localStorage.getItem('resyncHist') || '[]'); hist.unshift({ t: new Date().toLocaleTimeString(), manual: !!manual, ok: r.ok, why: r.why || '', r: +(r.r || 0).toFixed(2), r2: +(r.r2 || 0).toFixed(2), off: r.pos != null && center != null ? +((r.pos - center) / 1000).toFixed(1) : null, speech: Math.round((r.speech || 0) / 200), cands: (r.cands || []).map(c => ((c.pos - (center || 0)) / 1000).toFixed(1) + 's/' + c.r.toFixed(2) + (c.agA && c.agB ? '✓' : '✗')).join(' ') }); localStorage.setItem('resyncHist', JSON.stringify(hist.slice(0, 6))); showHist(); } catch (e) {}
    rlog('resync rtt=' + Math.round(bestRtt) + 'ms r=' + (r.r || 0).toFixed(2) + ' r2=' + (r.r2 || 0).toFixed(2) + ' ok=' + r.ok + ' ' + (r.why || '') + ' pos=' + fmt(r.pos || 0));
    return { r, t0, env, cues };
  }
  function askJump(at) { return new Promise(res => { const m = $('resyncMsg'); m.className = 'muted'; m.innerHTML = '';
    m.append('Encontrado en ' + at + ', ¿saltar? ');
    for (const [t, v] of [['Sí', true], ['No', false]]) { const b = document.createElement('button'); b.textContent = t; b.style.margin = '0 4px'; b.onclick = () => res(v); m.append(b); } }); }
  // v0.6.0: manual Resincronizar = speech recognition of ~20 s, words matched against the subtitle text.
  function srListen(lang, ms, msgEl) { return new Promise((res, rej) => {
    const r = new SR(), ph = new Map(); let done = false, t0 = Date.now(), errE = null;
    r.lang = lang; r.continuous = true; r.interimResults = true; r.maxAlternatives = 1;
    r.onresult = ev => { const now = Date.now();
      for (let i = ev.resultIndex; i < ev.results.length; i++) { const k = i + '@' + gen; const o = ph.get(k) || { tw: now }; o.text = ev.results[i][0].transcript; o.fin = ev.results[i].isFinal; ph.set(k, o); }
      const left = Math.max(0, Math.round((ms - (now - t0)) / 1000));
      msgEl.textContent = '🎧 Escuchando (' + lang + ', ' + left + ' s)… «' + [...ph.values()].map(x => x.text).join(' · ').slice(-90) + '»'; };
    let gen = 0;
    r.onerror = e => { rlog('wr error ' + e.error); if (e.error === 'not-allowed' || e.error === 'service-not-allowed') errE = e.error; };
    r.onend = () => { if (!done && !errE && Date.now() - t0 < ms) { gen++; try { r.start(); return; } catch (e) {} } fin(); };
    const fin = () => { if (done) return; done = true; try { r.abort(); } catch (e) {}
      if (errE) return rej(new Error('srdeny'));
      res([...ph.values()].filter(x => x.text && x.text.trim()).map(x => ({ tok: tokens(x.text), text: x.text.trim(), tw: x.tw }))); };
    setTimeout(() => { done = true; try { r.stop(); } catch (e) {} setTimeout(() => { done = false; fin(); }, 1200); }, ms);
    try { r.start(); } catch (e) { rej(e); }
  }); }
  const lastRes = { wall: 0, pos: 0 };
  function showHist() { let el = $('resyncHist'); if (!el) { el = document.createElement('pre'); el.id = 'resyncHist'; el.style.cssText = 'font-size:11px;white-space:pre-wrap;opacity:.7'; $('resyncMsg').after(el); }
    const h = JSON.parse(localStorage.getItem('resyncHist') || '[]'); el.textContent = h.length ? 'Últimos intentos:\n' + h.map(x => x.t + ' ' + x.lang + ' ' + (x.ok ? 'OK ' : 'NO (' + x.why + ') ') + (x.off != null ? 'desfase ' + x.off + ' s ' : '') + '\n  oído: «' + x.heard + '»' + (x.line ? '\n  subtítulo: «' + x.line + '»' : '')).join('\n') : ''; }
  try { showHist(); } catch (e) {}
  $('srLang').value = localStorage.getItem('srLang') || 'spa|es-ES';
  $('srLang').onchange = () => localStorage.setItem('srLang', $('srLang').value);
  $('resyncBtn').onclick = async () => {
    const msg = $('resyncMsg'); msg.className = 'muted';
    if (micBusy) return; if (tvOff()) return offNote(msg);
    if (!track) { msg.className = 'err'; msg.textContent = '❌ Carga primero los subtítulos en esta página (🔎 Subtítulos).'; return; }
    if (!SR) { msg.className = 'err'; msg.textContent = '❌ Este navegador no tiene reconocimiento de voz. Usa Chrome.'; return; }
    if (listening) { msg.className = 'err'; msg.textContent = '❌ Para antes «Dejar de escuchar».'; return; }
    if (clockNow() == null) { msg.className = 'err'; msg.textContent = '❌ Pon antes el tiempo aproximado («Empezar aquí») o dale a reproducir.'; return; }
    let [key, lang] = $('srLang').value.split('|');
    if (key === 'orig') lang = $('orig').value.split('|')[1];
    const cues = key === 'orig' ? track.orig : track.spa;
    if (!cues || !cues.length) { msg.className = 'err'; msg.textContent = '❌ No hay pista de subtítulos ' + (key === 'orig' ? 'original' : 'en español') + ' cargada. Cambia «Idioma del audio».'; return; }
    autoStop(); micBusy = true; $('resyncBtn').disabled = true;
    msg.textContent = '🎧 Escuchando palabras 20 s (' + lang + ')… deja el móvil encendido cerca de la tele';
    const c0 = clockNow(), w0 = Date.now(); rlog('wresync tap clock=' + fmt(c0) + ' ' + lang);
    let r = null, heard = '';
    try {
      const phrases = await srListen(lang, 20000, msg);
      heard = phrases.map(p => p.text).join(' · ');
      const m = new Matcher(cues);
      r = wordResync(m, phrases, w => c0 + (w - w0));
      rlog('wresync ok=' + r.ok + ' ' + r.why + ' off=' + (r.off != null ? Math.round(r.off) : '-') + ' heard=' + heard + ' ests=' + JSON.stringify(r.ests.map(e => [Math.round(e.off), e.matched, +e.score.toFixed(1), +e.margin.toFixed(1)])));
      if (r.ok && Math.abs(r.off) > 60000 && !(await askJump(fmt(r.pos + (Date.now() - r.tw))))) { msg.className = 'muted'; msg.textContent = 'Vale, no salto. Tiempo sin cambios.'; r.why = 'salto rechazado'; r.ok = false; return; }
      if (!r.ok) { msg.className = 'err'; msg.textContent = '🤷 No seguro (' + r.why + '): dejo el tiempo como estaba. Oído: «' + (heard || 'nada') + '»'; return; }
      const d = await applyAudioPos(r.pos, r.tw);
      msg.className = 'ok'; msg.textContent = '✔ Ajustado' + (d != null ? ' ' + (d >= 0 ? '+' : '−') + Math.abs(d / 1000).toFixed(1).replace('.', ',') + ' s' : '') + ' (' + r.n + ' frase' + (r.n > 1 ? 's' : '') + ' coinciden: «' + r.best.line + '»).';
    } catch (e) { r = { ok: false, why: e.message }; msg.className = 'err'; msg.textContent = e.message === 'srdeny' ? '❌ Chrome no deja usar el micrófono para reconocer voz. Candado → Permisos → Micrófono.' : '❌ Error del reconocimiento de voz: ' + (e.name || e.message); rlog('wresync fail ' + e.message); }
    finally { micBusy = false; $('resyncBtn').disabled = false;
      try { const b = r && (r.best || (r.ests && r.ests.slice().sort((x, y) => y.score - x.score)[0]));
        const hist = JSON.parse(localStorage.getItem('resyncHist') || '[]'); hist.unshift({ t: new Date().toLocaleTimeString(), lang, ok: !!(r && r.ok), why: r ? r.why : '', off: r && r.ok ? +(r.off / 1000).toFixed(1) : b ? +(b.off / 1000).toFixed(1) : null, heard: heard.slice(0, 160), line: b ? b.line : '' }); localStorage.setItem('resyncHist', JSON.stringify(hist.slice(0, 6))); showHist(); } catch (e) {} }
  };
  // Auto at the start: once the clock runs for a newly loaded film, listen in 20 s chunks until a confident match
  // (two chunks must agree when the clock was not set by hand), max 4 min, then the mic stays off.
  function autoStop(why) { if (autoTimer) { clearTimeout(autoTimer); autoTimer = null; } if (why) $('resyncMsg').textContent = why; }
  function autoArm() {
    if (!$('autoMic').checked || !track || autoArmedFor === track) return;
    autoArmedFor = track;
    // v0.5.3: only once per title, even after reconnects/page reloads
    const key = 'autoDone:' + track.title; if (localStorage.getItem(key)) return; localStorage.setItem(key, String(Date.now())); const t = track, until = Date.now() + 5 * 60000; let last = null;
    const step = async () => {
      autoTimer = null; const msg = $('resyncMsg');
      if (track !== t || !$('autoMic').checked || tvOff()) return;
      if (Date.now() > until) { msg.className = 'muted'; msg.textContent = 'Ajuste automático: no he oído diálogo claro; el micro está apagado. Usa 🎧 Resincronizar si hace falta.'; return; }
      if (micBusy || document.hidden || clockNow() == null) { autoTimer = setTimeout(step, 3000); return; }
      micBusy = true;
      try {
        const { r, t0 } = await resyncOnce(15000, msg);
        if (r.ok) {
          const off = r.pos - t0; // film ms minus wall ms -> comparable between chunks
          if (syncer && syncer.manual || (last != null && Math.abs(off - last) < 700)) {
            const d = await applyAudioPos(r.pos, t0); msg.className = 'ok';
            msg.textContent = '✔ Ajustado al empezar' + (d != null ? ' (' + (d >= 0 ? '+' : '−') + Math.abs(d / 1000).toFixed(1).replace('.', ',') + ' s)' : '') + '. Micro apagado.'; return;
          }
          last = off;
        }
        msg.className = 'muted'; msg.textContent = '🎧 Ajuste automático: sigo escuchando…';
      } catch (e) { if (e.message === 'hidden' && Date.now() < until) { micBusy = false; msg.className = 'muted'; msg.textContent = '🎧 Ajuste automático en espera (pantalla del móvil apagada)…'; autoTimer = setTimeout(step, 3000); return; }
        msg.className = 'err'; msg.textContent = '❌ Ajuste automático sin micro: ' + (e.name || e.message); return; }
      finally { micBusy = false; }
      autoTimer = setTimeout(step, 500);
    };
    autoTimer = setTimeout(step, 1000);
  }
  setInterval(() => { if (track && autoArmedFor !== track && clockNow() != null) autoArm(); }, 2000);
  // v0.4.3: the phone's numeric keyboard has no ':' -> any of : . , ; space ' ’ " and h/m/s work as separators.
  // 1:10, 1.10, 1,10, 1 10, 0.01.10, 1h05m30, 56m46s, 30s; digits only: 110 -> 1:10, 5646 -> 56:46, 10530 -> 1:05:30, 42 -> 42:00
  const parseT = v => {
    v = String(v).trim().toLowerCase(); if (!v) return null;
    if (/[^\d:.,;\s'’"hms]/.test(v.replace(/min/g, 'm'))) return null;
    let p;
    if (/[hms]/.test(v)) { // units: 1h05m30, 1h05, 56m46s, 56m, 30s
      const u = v.replace(/min/g, 'm').replace(/[\s:.,;'’"]+/g, '');
      const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/.exec(u); if (!m || !u) return null;
      let [, hh, mm, ss] = m; if (hh != null && mm == null && ss != null && !/s$/.test(u)) { mm = ss; ss = null; } // 1h05 -> 1:05:00
      p = [+(hh || 0), +(mm || 0), +(ss || 0)];
    } else {
      v = v.replace(/[.,;\s'’"]+/g, ':').replace(/:+$/, '');
      if (/^\d+$/.test(v)) { if (v.length <= 2) p = [+v, 0]; else { const ss = +v.slice(-2), mm = +v.slice(-4, -2), hh = v.length > 4 ? +v.slice(0, -4) : 0; p = [hh, mm, ss]; } }
      else p = v.split(':').map(Number);
    }
    if (!p.length || p.some(x => isNaN(x) || x < 0) || p.length > 3 || p.slice(1).some(x => x >= 60)) return null;
    return p.reduce((a, b) => a * 60 + b, 0) * 1000;
  };
  if (typeof module !== 'undefined') module.exports.parseT = parseT;
  $('manualBtn').onclick = async () => {
    const msg = $('manualMsg'); msg.className = 'muted';
    if (tvOff() && !track) return offNote(msg);
    const ms = parseT($('manualT').value || '');
    if (ms == null) { msg.className = 'err'; msg.textContent = '❌ No entiendo «' + $('manualT').value + '». Escribe el tiempo del reproductor con dos puntos, puntos o solo números, p. ej. 23:15, 1:05:30, 56.46 o 10530.'; return; }
    if (userOffset) { rlog('manual time: drop offset ' + userOffset); userOffset = 0; localStorage.removeItem('offset'); $('offsetTxt').textContent = offTxt(); } // v0.5.6: typed time is absolute, old +/- correction made it show 70 s off
    if (!track || !syncer) { // v0.4.3: page reloaded, the TV still holds the track -> set the TV's own clock (like Pausa in v0.4.2)
      if (!tvLast || !tvLast.cues) { msg.className = 'err'; msg.textContent = '❌ Primero busca y carga los subtítulos (🔎 Subtítulos).'; return; }
      msg.textContent = 'Enviando a la tele…'; tvPausedPos = null; rlog('tv manual ' + $('manualT').value + ' -> ' + fmt(ms));
      await tvSync(tvHidden ? 'hidden' : 'locked', ms + userOffset, true);
      const r = tvLast;
      if (!r || r.state === undefined) { msg.className = 'err'; msg.textContent = '❌ No llego a la tele. Comprueba que la app está abierta en la tele y recarga esta página.'; return; }
      if (!r.overlayAlive) { msg.className = 'err'; msg.textContent = '❌ La tele recibió la orden pero la app no está dibujando. Abre «Subtítulos TV» en la tele y pulsa Iniciar.'; return; }
      if (r.state !== 'locked' && r.state !== 'hidden') { msg.className = 'err'; msg.textContent = '❌ La tele no ha arrancado (estado ' + r.state + ').'; return; }
      msg.className = 'ok'; msg.textContent = r.media && r.media.kind === 'held' && r.media.autoPause ? '✔ Listo en ' + fmt(r.pos) + '. ' + r.media.app + ' está en pausa: los subtítulos arrancan cuando le des a reproducir.'
        : r.hiddenByMedia ? '✔ Listo en ' + fmt(r.pos) + '. Los subtítulos salen cuando vuelvas a reproducir en ' + ((r.media && (r.media.srcApp || r.media.app)) || 'la app') + '.'
        : '✔ La tele va en ' + fmt(r.pos) + ' y sigue sola aunque bloquees el móvil.';
      return;
    }
    syncer.manualLock(ms, Date.now()); rlog('manual lock ' + $('manualT').value + ' -> ' + fmt(ms)); render();
    msg.textContent = 'Enviando a la tele…';
    const syncMsg = () => ({ type: 'sync', manual: true, state: tvHidden ? 'hidden' : 'locked', pos: Math.round(syncer.pos(Date.now()) + userOffset), at: Math.round(Date.now() + serverOffset), off: userOffset });
    try {
      let r = await sendChecked(syncMsg());
      if (!r.cues || r.cues !== track.spa.length) { msg.textContent = 'La tele no tenía los subtítulos; reenviando…'; await sendCues(); r = await sendChecked(syncMsg()); }
      if (r.held !== undefined) { tvHeld = r.held; tvEpoch = r.epoch; } // manual time refers to "now": nothing to subtract
      lastSent = Date.now();
      if (r.state === undefined) { msg.className = 'ok'; msg.textContent = '✔ Enviado a la tele (empieza en ' + fmt(ms) + ').'; return; }
      if (!r.overlayAlive) { msg.className = 'err'; msg.textContent = '❌ La tele recibió la orden pero la app no está dibujando. Abre «Subtítulos TV» en la tele y pulsa Iniciar.'; return; }
      if (r.state !== 'locked') { msg.className = 'err'; msg.textContent = '❌ La tele no ha arrancado (estado ' + r.state + ').'; return; }
      if (r.media && r.media.kind === 'held' && r.media.autoPause) { msg.className = 'ok'; msg.textContent = '✔ Listo en ' + fmt(r.pos) + '. ' + r.media.app + ' está en pausa: los subtítulos arrancan cuando le des a reproducir.'; showTv(r); return; }
      msg.className = 'ok'; msg.textContent = '✔ La tele va en ' + fmt(r.pos) + ' y sigue sola aunque bloquees el móvil.'; showTv(r);
    } catch (e) { msg.className = 'err'; msg.textContent = '❌ No llego a la tele: ' + e.message + '. Comprueba que la app está abierta en la tele y recarga esta página.'; rlog('manual send failed ' + e.message); }
  };
  $('manualT').addEventListener('keydown', e => { if (e.key === 'Enter') $('manualBtn').click(); });
  $('listenBtn').onclick = () => listening ? stopListening() : startListening();
  // v0.4.2: the controls work even when the phone page was reloaded and only the TV has the track (no syncer here).
  // Then the TV owns the position: we read it from /api/status and send it back with the change.
  const tvPosNow = () => { const s = tvLast; if (!s || s.pos === undefined) return null;
    const frozen = s.state !== 'locked' || s.hiddenByAd || s.hiddenByMedia || (s.media && s.media.autoPause && s.media.kind === 'held');
    return Math.round(s.pos + (frozen ? 0 : Date.now() - tvSeenAt)); };
  let tvPausedPos = null; // position kept while paused without a syncer
  const isPaused = () => !!(syncer && syncer.paused) || !!(tvLast && tvLast.state === 'paused');
  function showPause() {
    const on = isPaused(); setBtn($('pauseBtn'), on ? '▶' : '⏸', on ? 'Seguir' : 'Pausa'); $('pauseBtn').classList.toggle('on', on);
  }
  async function tvSync(state, pos, manual) {
    const msg = { type: 'sync', manual: !!manual, state, pos: Math.round(pos), at: Math.round(Date.now() + serverOffset), off: userOffset };
    const t0 = Date.now();
    try { const r = await sendChecked(msg); if (r && r.state !== undefined) { tvLast = r; tvSeenAt = (t0 + Date.now()) / 2; if (r.held !== undefined) { tvHeld = r.held; tvEpoch = r.epoch; } showTv(r); } }
    catch (e) { $('tvnow').className = 'err'; $('tvnow').textContent = '❌ No llego a la tele: ' + e.message; }
    lastSent = Date.now(); showPause(); showNow();
  }
  $('pauseBtn').onclick = async () => {
    if (tvOff()) return offNote();
    const now = Date.now();
    if (syncer && syncer.state === 'locked' || syncer && syncer.paused) {
      if (!syncer.paused) { syncer.setPaused(true, now); rlog('pause at ' + fmt(syncer.pos(now) + userOffset)); pushSync(); }
      else if (listening) { syncer.setPaused(false, now); pushSync(false, true); } // mic re-confirms the position
      else { const p = syncer.pos(now); syncer.paused = false; syncer.manualLock(p, now); rlog('resume at ' + fmt(p + userOffset)); await tvSync(tvHidden ? 'hidden' : 'locked', p + userOffset, true); }
      showPause(); render(); return;
    }
    // no track on this page (reloaded) or not synced here: act on the TV's own clock
    if (!tvLast || !tvLast.cues) { $('tvnow').className = 'err'; $('tvnow').textContent = 'La tele no tiene subtítulos cargados: búscalos en «🔎 Subtítulos».'; return; }
    if (tvLast.state === 'paused') { const p = tvPausedPos != null ? tvPausedPos : tvLast.pos; tvPausedPos = null; rlog('tv resume at ' + fmt(p)); await tvSync(tvHidden ? 'hidden' : 'locked', p, true); }
    else if (tvLast.state === 'locked' || tvLast.state === 'hidden') { const p = tvPosNow(); tvPausedPos = p; rlog('tv pause at ' + fmt(p)); await tvSync('paused', p, true); }
    else { $('tvnow').className = 'err'; $('tvnow').textContent = 'La tele aún no está sincronizada: pon el tiempo en «Empezar en este tiempo» (⚙️ Ajustes).'; }
  };
  $('hideBtn').onclick = () => { if (tvOff()) return offNote(); tvHidden = !tvHidden; $('hideBtn').textContent = tvHidden ? '👁 Mostrar' : '🙈 Ocultar';
    if (syncer) pushSync(); else if (tvLast && (tvLast.state === 'locked' || tvLast.state === 'hidden')) tvSync(tvHidden ? 'hidden' : 'locked', tvPosNow(), false); };
  const adj = d => { if (tvOff()) return offNote(); userOffset += d; localStorage.setItem('offset', userOffset); $('offsetTxt').textContent = offTxt();
    if (syncer) { pushSync(); return; }
    const s = tvLast; if (!s || !['locked', 'hidden', 'paused'].includes(s.state)) return; // reloaded page: shift the TV's own clock
    if (s.state === 'paused' && tvPausedPos != null) tvPausedPos += d;
    tvSync(s.state, tvPosNow() + d, false); };
  // data-adj = ms added to the position. "−X s" (Salen tarde) shows subtitles X s earlier = position forward (+);
  // "+X s" (Salen pronto) shows them later = position back (−). Same convention as the original ±0,25 s buttons.
  document.querySelectorAll('button[data-adj]').forEach(b => { b.onclick = () => adj(+b.dataset.adj); });
  const style = d => { fontSize = Math.max(20, Math.min(80, fontSize + d)); localStorage.setItem('fontSize', fontSize); send({ type: 'style', size: fontSize }); };
  $('smaller').onclick = () => style(-4); $('bigger').onclick = () => style(4);
  // (v0.4: the experimental "Pausar en anuncios" probe toggle is gone from the page; the TV code stays dormant.)
  const sendMediaOpts = () => send({ type: 'media', autoPause: $('autoPause').checked, autoSync: $('autoSync').checked }).then(() => status());
  $('autoPause').onchange = sendMediaOpts; $('autoSync').onchange = sendMediaOpts;
  // v0.6.1: after a page reload, restore the track the TV is showing so Resincronizar works
  try { const d = JSON.parse(localStorage.getItem('lastTrack') || 'null'); if (d && d.spa) { useTrack(d, true); track.restored = true; rlog('track restored ' + d.title); } } catch (e) {}
  $('testBtn').onclick = () => tvOff() ? offNote() : send({ type: 'text', text: 'Prueba: así se verán los subtítulos en la tele.', ms: 5000 });
})();
