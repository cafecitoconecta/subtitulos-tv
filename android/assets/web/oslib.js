// Browser-side OpenSubtitles search/download/align (used when the TV app is the server).
// Network goes through the TV's /os proxy (CORS + gzip handled there).
(function () {
  const K = new URLSearchParams(location.search).get('k') || '';
  const OS_BASE = 'https://rest.opensubtitles.org/search';
  const prox = u => fetch('/os?k=' + encodeURIComponent(K) + '&u=' + encodeURIComponent(u)).then(r => { if (!r.ok) throw new Error('OpenSubtitles ' + r.status); return r.arrayBuffer(); });
  async function osSearch(params) {
    const segs = params.filter(([, v]) => v !== undefined && v !== '' && v !== null)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([k, v]) => `${k}-${encodeURIComponent(String(v).toLowerCase())}`);
    const d = JSON.parse(new TextDecoder().decode(await prox(`${OS_BASE}/${segs.join('/')}`)));
    return Array.isArray(d) ? d : [];
  }
  function decodeText(buf, hint) {
    const b = new Uint8Array(buf);
    if (b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF) return new TextDecoder('utf-8').decode(b.subarray(3));
    if (b[0] === 0xFF && b[1] === 0xFE) return new TextDecoder('utf-16le').decode(b.subarray(2));
    try { return new TextDecoder('utf-8', { fatal: true }).decode(b); } catch (e) {}
    try { return new TextDecoder((hint || 'windows-1252').toLowerCase()).decode(b); } catch (e) { return new TextDecoder('windows-1252').decode(b); }
  }
  const downloadSub = async (link, enc) => decodeText(await prox(link), enc);
  function tsToMs(t) {
    const m = t.trim().match(/(\d+):(\d+):(\d+)[,.](\d+)/);
    if (!m) return null;
    return ((+m[1] * 60 + +m[2]) * 60 + +m[3]) * 1000 + +m[4].padEnd(3, '0').slice(0, 3);
  }
  const AD_RE = /opensubtitles|osdb\.link|subtitles by|sync(ed)? (and|&) correct|addic7ed|getray|www\.|\b[\w-]+\.(com|org|net|app|io|tv|me|link|es)\b|subt[ií]tulos por|traducci[oó]n|subtitles\?|subt[ií]tulos\?/i;
  function parseSrt(text) {
    const cues = [];
    for (const b of text.replace(/\r/g, '').split(/\n\s*\n/)) {
      const lines = b.split('\n').filter(l => l.trim() !== '');
      const i = lines.findIndex(l => l.includes('-->'));
      if (i < 0) continue;
      const [a, z] = lines[i].split('-->');
      const s = tsToMs(a), e = tsToMs(z || '');
      if (s == null || e == null) continue;
      const t = lines.slice(i + 1).join('\n').replace(/<[^>]+>/g, '').replace(/\{[^}]*\}/g, '').trim();
      if (!t || AD_RE.test(t)) continue;
      cues.push({ s, e: Math.max(e, s + 300), t });
    }
    return cues.sort((x, y) => x.s - y.s);
  }
  function alignTo(src, ref) {
    if (!src.length || !ref.length) return { cues: src, offset: 0, scale: 1, score: 0 };
    const rs = ref.map(c => c.s);
    const near = (t, tol) => {
      let lo = 0, hi = rs.length - 1;
      while (lo < hi) { const m = (lo + hi) >> 1; if (rs[m] < t) lo = m + 1; else hi = m; }
      return Math.min(Math.abs(rs[lo] - t), lo > 0 ? Math.abs(rs[lo - 1] - t) : Infinity) <= tol;
    };
    let best = { score: -1, offset: 0, scale: 1 };
    for (const scale of [1, 25 / 23.976, 23.976 / 25, 25 / 24, 24 / 25]) {
      const votes = new Map(); const N = Math.min(src.length, 400);
      for (let i = 0; i < N; i++) { const ss = src[i].s * scale; for (const r of rs) { const off = Math.round((r - ss) / 100) * 100; if (Math.abs(off) <= 600000) votes.set(off, (votes.get(off) || 0) + 1); } }
      for (const [off0] of [...votes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8))
        for (let f = -300; f <= 300; f += 50) { const off = off0 + f; let sc = 0; for (const c of src) if (near(c.s * scale + off, 120)) sc++; if (sc > best.score) best = { score: sc, offset: off, scale }; }
    }
    return { cues: src.map(c => ({ s: Math.round(c.s * best.scale + best.offset), e: Math.round(c.e * best.scale + best.offset), t: c.t })), offset: best.offset, scale: best.scale, score: best.score / src.length };
  }
  const relKey = s => (s.MovieReleaseName || s.SubFileName || '').toLowerCase();
  function pickBest(list, hint) {
    hint = (hint || '').toLowerCase();
    return list.filter(s => s.SubFormat === 'srt' && s.SubBad !== '1' && s.SubAutoTranslation !== '1' && s.SubForeignPartsOnly !== '1').map(s => {
      const n = relKey(s); let sc = Math.log10(1 + +s.SubDownloadsCnt);
      if (/amzn|amazon/.test(hint) && /amzn|amazon/.test(n)) sc += 2;
      if (/hmax|hbo|max\b/.test(hint) && /hmax|hbo/.test(n)) sc += 2;
      if (/web/.test(n)) sc += 0.5;
      if (s.SubHearingImpaired === '1') sc -= 0.3;
      if (s.SubFromTrusted === '1') sc += 0.3;
      if (s.SubSumCD !== '1') sc -= 5;
      return { s, sc };
    }).sort((a, b) => b.sc - a.sc).map(x => x.s);
  }
  async function search(q) {
    const params = [['query', q.get('q')], ['sublanguageid', 'spa']];
    if (q.get('season')) params.push(['season', q.get('season')]);
    if (q.get('episode')) params.push(['episode', q.get('episode')]);
    const by = new Map();
    for (const s of await osSearch(params)) {
      if (!by.has(s.IDMovieImdb)) by.set(s.IDMovieImdb, { imdb: s.IDMovieImdb, name: s.MovieName, year: s.MovieYear, kind: s.MovieKind, season: s.SeriesSeason, episode: s.SeriesEpisode, count: 0, downloads: 0 });
      const g = by.get(s.IDMovieImdb); g.count++; g.downloads += +s.SubDownloadsCnt;
    }
    return { results: [...by.values()].sort((a, b) => b.downloads - a.downloads).slice(0, 15) };
  }
  async function tracks(q) {
    const imdb = q.get('imdb'), orig = q.get('orig') || 'eng', service = q.get('service') || '';
    const [spaList, origList] = await Promise.all([osSearch([['imdbid', imdb], ['sublanguageid', 'spa']]), orig === 'spa' ? [] : osSearch([['imdbid', imdb], ['sublanguageid', orig]])]);
    const spaBest = pickBest(spaList, service);
    if (!spaBest.length) throw new Error(typeof tr === 'function' ? tr('No hay subtítulos en español para ese título') : 'No hay subtítulos en español para ese título');
    const sp = spaBest[0], ob = pickBest(origList, service);
    const op = ob.find(s => relKey(s) === relKey(sp)) || ob[0];
    const spa = parseSrt(await downloadSub(sp.SubDownloadLink, sp.SubEncoding));
    const origC = op ? parseSrt(await downloadSub(op.SubDownloadLink, op.SubEncoding)) : [];
    const al = origC.length ? alignTo(spa, origC) : { cues: spa, offset: 0, scale: 1, score: 1 };
    return { title: sp.MovieName, imdb, spaRelease: sp.MovieReleaseName || sp.SubFileName, origRelease: op ? (op.MovieReleaseName || op.SubFileName) : null,
      align: { offset: al.offset, scale: al.scale, score: +al.score.toFixed(2) }, spa: al.cues, orig: origC, spaAlternatives: spaBest.slice(1, 6).map(s => s.MovieReleaseName || s.SubFileName) };
  }
  function upload(d) {
    const spa = parseSrt(d.spa || ''), orig = d.orig ? parseSrt(d.orig) : [];
    const al = orig.length ? alignTo(spa, orig) : { cues: spa, offset: 0, scale: 1, score: 1 };
    return { title: d.title || 'Archivo subido', spa: al.cues, orig, align: { offset: al.offset, scale: al.scale, score: +al.score.toFixed(2) } };
  }
  window.OSLIB = {
    route(p, opt) {
      const u = new URL(p, location.href), q = u.searchParams;
      if (u.pathname === '/api/search') return search(q);
      if (u.pathname === '/api/tracks') return tracks(q);
      if (u.pathname === '/api/upload') return Promise.resolve(upload(JSON.parse(opt.body)));
    },
  };
})();
