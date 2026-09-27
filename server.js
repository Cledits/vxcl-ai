require('dotenv').config();
const express = require('express');
const path = require('path');
const { exec } = require('child_process');
const { OAuth2Client } = require('google-auth-library');

const app = express();
const PORT = process.env.PORT || 3000;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const DEV_SKIP_AUTH = process.env.DEV_SKIP_AUTH === '1';
const oauth = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;

const YT = { clientName: 'WEB', clientVersion: '2.20250101.00.00' };

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/config', (req, res) => {
  res.json({
    clientId: GOOGLE_CLIENT_ID,
    devMode: DEV_SKIP_AUTH,
    ready: Boolean(GOOGLE_CLIENT_ID),
  });
});

app.post('/api/analyze', async (req, res) => {
  try {
    const { idToken, url } = req.body || {};
    if (!idToken) return res.status(401).json({ error: 'Once google ile giris yap.' });
    if (!DEV_SKIP_AUTH) {
      if (!oauth) return res.status(500).json({ error: 'GOOGLE_CLIENT_ID ayarli degil.' });
      await verify(idToken);
    }

    const videoId = extractVideoId(url);
    if (!videoId) return res.status(400).json({ error: 'Gecerli bir YouTube linki degil.' });

    const analysis = await analyze(videoId);
    res.json(analysis);
  } catch (err) {
    res.status(400).json({ error: (err && err.message) || 'Analiz basarisiz oldu.' });
  }
});

async function verify(idToken) {
  const ticket = await oauth.verifyIdToken({ idToken, audience: GOOGLE_CLIENT_ID });
  const payload = ticket.getPayload();
  if (!payload || !payload.email) throw new Error('Giris dogrulanamadi.');
  return payload;
}

function extractVideoId(raw) {
  if (!raw) return null;
  const t = String(raw).trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(t)) return t;
  let u;
  try {
    u = new URL(t.startsWith('http') ? t : 'https://' + t);
  } catch (_) {
    return null;
  }
  const host = u.hostname.replace(/^www\./, '').replace(/^m\./, '');
  if (host === 'youtu.be') {
    const id = u.pathname.slice(1).split('/')[0];
    return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
  }
  if (host.endsWith('youtube.com') || host === 'music.youtube.com') {
    const v = u.searchParams.get('v');
    if (v && /^[A-Za-z0-9_-]{11}$/.test(v)) return v;
    const m = u.pathname.match(/\/(shorts|embed|live|v)\/([A-Za-z0-9_-]{11})/);
    if (m) return m[2];
  }
  return null;
}

async function innertube(ep, body) {
  const r = await fetch('https://www.youtube.com/youtubei/v1/' + ep, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'https://www.youtube.com',
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error('YouTube istegi basarisiz oldu (' + r.status + ').');
  return r.json();
}

function collect(obj, name, out = [], depth = 0) {
  if (depth > 80 || !obj || typeof obj !== 'object') return out;
  for (const [k, v] of Object.entries(obj)) {
    if (k === name) out.push(v);
    collect(v, name, out, depth + 1);
  }
  return out;
}

function keyedObjects(obj, map = new Map(), depth = 0) {
  if (depth > 80 || !obj || typeof obj !== 'object') return map;
  if (typeof obj.key === 'string') map.set(obj.key, obj);
  for (const v of Object.values(obj)) keyedObjects(v, map, depth + 1);
  return map;
}

function parseCompact(s) {
  if (s == null) return null;
  const m = String(s).replace(/\s/g, '').match(/([0-9][0-9.,]*)/);
  if (!m) return null;
  let n = parseFloat(m[1].replace(/,/g, ''));
  if (isNaN(n)) return null;
  if (/[K]/i.test(String(s))) n *= 1e3;
  else if (/M/i.test(String(s))) n *= 1e6;
  else if (/B/i.test(String(s))) n *= 1e9;
  return Math.round(n);
}

function parseIsoDuration(iso) {
  const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(iso || '');
  if (!m) return 0;
  return (Number(m[1]) || 0) * 3600 + (Number(m[2]) || 0) * 60 + (Number(m[3]) || 0);
}

function humanDuration(sec) {
  if (!sec) return '0 sn';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h) return `${h} sa ${m} dk`;
  if (m) return s ? `${m} dk ${s} sn` : `${m} dk`;
  return `${s} sn`;
}

const STOPWORDS = new Set([
  've','ile','bir','bu','su','da','de','ki','mi','ne','var','yok','ama','fakat','gibi','icin','olarak',
  'en','cok','az','daha','artik','simdi','sonra','once','bile','sadece','hepsi','her','hangi','nasıl','nasil','neden',
  'the','and','for','you','your','that','with','this','are','was','not','have','from','they','what','can','all',
  'yani','ise','diye','are','the','of','to','in','is','it','on','be','at','by','an','or','was','were','been',
]);

function tokenize(text) {
  const m = String(text || '').toLowerCase().match(/[\p{L}\p{N}]+/gu);
  return m ? m.filter((w) => w.length > 2 && !STOPWORDS.has(w)) : [];
}

function freqWords(texts, n) {
  const count = new Map();
  for (const t of texts) for (const w of tokenize(t)) count.set(w, (count.get(w) || 0) + 1);
  return [...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}

async function fetchComments(videoId) {
  const next = await innertube('next', { context: { client: YT }, videoId });
  const vd = next.responseContext && next.responseContext.visitorData;
  const panel = (next.engagementPanels || []).find(
    (p) => p.engagementPanelSectionListRenderer &&
      p.engagementPanelSectionListRenderer.panelIdentifier === 'engagement-panel-comments-section'
  );
  if (!panel) return { comments: [], topCommentWords: [] };
  const cont = collect(panel, 'continuationCommand')[0];
  if (!cont || !cont.token) return { comments: [], topCommentWords: [] };

  const cj = await innertube('next', {
    context: { client: Object.assign({}, YT, vd ? { visitorData: vd } : {}) },
    continuation: cont.token,
  });

  const store = keyedObjects(cj);
  const threads = collect(cj, 'commentThreadRenderer');
  const comments = [];

  for (const t of threads) {
    const vmRaw = t.commentViewModel || {};
    const vm = vmRaw.commentViewModel || vmRaw;
    const keys = ['commentKey', 'toolbarStateKey', 'commentSurfaceKey', 'sharedKey', 'sharedSurfaceKey', 'toolbarSurfaceKey']
      .map((k) => vm[k])
      .filter(Boolean);

    let text = null;
    let author = '';
    let published = '';
    let likes = null;

    for (const k of keys) {
      const o = store.get(k);
      if (!o) continue;
      if (!text && o.properties && o.properties.content && o.properties.content.content) {
        text = o.properties.content.content;
        author = o.properties.author ? o.properties.author.displayName || '' : '';
        published = o.properties.publishedTime || '';
      }
      if (likes === null && o.likeCountNotliked != null) likes = parseCompact(o.likeCountNotliked);
      if (likes === null && o.likeCountLiked != null) likes = parseCompact(o.likeCountLiked);
    }

    if (!text) continue;

    let replies = 0;
    const rep = collect(t, 'viewReplies')[0];
    if (rep && rep.buttonRenderer && rep.buttonRenderer.text) {
      replies = parseCompact((rep.buttonRenderer.text.runs || []).map((r) => r.text).join('')) || 0;
    }

    comments.push({ text, author, published, likes, replies });
  }

  return { comments: comments.slice(0, 20), topCommentWords: freqWords(comments.map((c) => c.text), 5).map((e) => e[0]) };
}

const INVIDIOUS = [
  'https://inv.nadeko.net',
  'https://yewtu.be',
  'https://invidious.nerdvpn.de',
  'https://iv.melmac.space',
  'https://invidious.f5.si',
];

async function innertubePlayer(videoId) {
  const attempts = [
    { context: { client: { clientName: 'WEB', clientVersion: '2.20250101.00.00' } }, videoId, contentCheckOk: true, racyCheckOk: true },
    { context: { client: { clientName: 'WEB_EMBEDDED_PLAYER', clientVersion: '1.20250101.00.00', hl: 'en', gl: 'US' }, thirdParty: { embedUrl: 'https://www.youtube.com/' } }, videoId, contentCheckOk: true, racyCheckOk: true },
    { context: { client: { clientName: 'ANDROID', clientVersion: '19.44.38', androidSdkVersion: 30, hl: 'en', gl: 'US' } }, videoId, contentCheckOk: true, racyCheckOk: true },
    { context: { client: { clientName: 'IOS', clientVersion: '19.45.0', deviceMake: 'Apple', deviceModel: 'iPhone16,2', hl: 'en', gl: 'US' } }, videoId, contentCheckOk: true, racyCheckOk: true },
  ];
  let lastReason = '';
  for (const body of attempts) {
    try {
      const p = await innertube('player', body);
      if (p.videoDetails && p.videoDetails.videoId) return p;
      const s = p.playabilityStatus || {};
      lastReason = s.reason || (s.messages && s.messages[0]) || lastReason;
    } catch (_) {}
  }
  throw new Error(lastReason ? 'youtube dogrulamasi: ' + lastReason : 'youtube player yanit vermedi');
}

async function fetchInnertube(videoId) {
  const player = await innertubePlayer(videoId);
  const vd = player.videoDetails;
  const mf = (player.microformat && player.microformat.playerMicroformatRenderer) || {};

  let comments = [];
  let commentWords = [];
  try {
    const c = await fetchComments(videoId);
    comments = c.comments;
    commentWords = c.topCommentWords;
  } catch (_) {}

  let likes = null;
  let subscribers = null;
  try {
    const next = await innertube('next', { context: { client: YT }, videoId });
    for (const btn of collect(next, 'buttonViewModel')) {
      if (btn.iconName === 'LIKE' && btn.title && likes === null) likes = parseCompact(btn.title);
      if (btn.iconName === 'LIKE' && /subscrib/i.test(btn.title || '')) break;
    }
    const sub = collect(next, 'subscriberCountText')[0];
    if (sub) subscribers = parseCompact(sub.simpleText || (sub.runs || []).map((r) => r.text).join(''));
  } catch (_) {}

  const thumbs = (vd.thumbnail && vd.thumbnail.thumbnails) || [];
  return {
    title: vd.title || '',
    channelTitle: vd.author || '',
    channelId: vd.channelId || '',
    description: vd.shortDescription || '',
    tags: vd.keywords || [],
    thumbnail: thumbs.length ? thumbs[thumbs.length - 1].url : null,
    published: mf.publishDate ? new Date(mf.publishDate) : new Date(),
    views: Number(vd.viewCount) || 0,
    likes,
    subscribers,
    durationSec: Number(vd.lengthSeconds) || 0,
    comments,
    commentWords,
  };
}

async function fetchInvidious(videoId) {
  let lastErr = '';
  for (const inst of INVIDIOUS) {
    try {
      const r = await fetch(inst + '/api/v1/videos/' + videoId, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) throw new Error('http ' + r.status);
      const v = await r.json();
      if (v.error) throw new Error(String(v.error));
      if (!v.title) throw new Error('bos yanit');

      let comments = [];
      try {
        const cr = await fetch(inst + '/api/v1/comments/' + videoId + '?sort_by=top', { signal: AbortSignal.timeout(8000) });
        if (cr.ok) {
          const arr = await cr.json();
          if (Array.isArray(arr)) {
            comments = arr
              .filter((c) => (c.content || c.comment))
              .slice(0, 20)
              .map((c) => ({
                text: c.content || c.comment || '',
                author: c.author || '',
                published: c.publishedText || '',
                likes: typeof c.likeCount === 'number' ? c.likeCount : null,
                replies: typeof c.replyCount === 'number' ? c.replyCount : 0,
              }));
          }
        }
      } catch (_) {}

      const pubTs = typeof v.published === 'number' ? new Date(v.published * 1000) : new Date(v.published || Date.now());
      return {
        title: v.title || '',
        channelTitle: v.author || '',
        channelId: v.authorId || '',
        description: v.description || '',
        tags: v.keywords || [],
        thumbnail: 'https://i.ytimg.com/vi/' + videoId + '/maxresdefault.jpg',
        published: isNaN(pubTs.getTime()) ? new Date() : pubTs,
        views: Number(v.viewCount) || 0,
        likes: typeof v.likeCount === 'number' ? v.likeCount : null,
        subscribers: typeof v.subCount === 'number' ? v.subCount : null,
        durationSec: Number(v.lengthSeconds) || 0,
        comments,
        commentWords: freqWords(comments.map((c) => c.text), 5).map((e) => e[0]),
      };
    } catch (e) {
      lastErr = String((e && e.message) || e);
    }
  }
  throw new Error('video okunamadi: ' + (lastErr || 'tum yedek sunucular cevap vermedi'));
}

function extractJsonObject(text, marker) {
  const idx = text.indexOf(marker);
  if (idx < 0) return null;
  const start = text.indexOf('{', idx + marker.length);
  if (start < 0) return null;
  const between = text.slice(idx + marker.length, start);
  if (/[^{}\s=:]/.test(between)) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch (_) {
          return null;
        }
      }
    }
  }
  return null;
}

async function fetchWatchPage(videoId) {
  const r = await fetch('https://www.youtube.com/watch?v=' + videoId + '&hl=en&gl=US', {
    headers: {
      'Accept-Language': 'en-US,en;q=0.9',
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error('watch http ' + r.status);
  const html = await r.text();

  const pr = extractJsonObject(html, 'ytInitialPlayerResponse');
  const vd = pr && pr.videoDetails;
  if (!vd || !vd.videoId) {
    throw new Error(/not a bot/i.test(html) ? 'youtube bot dogrulamasi' : 'watch sayfasi okunamadi');
  }
  const mf = (pr.microformat && pr.microformat.playerMicroformatRenderer) || {};

  let likes = null;
  let subscribers = null;
  try {
    const next = await innertube('next', { context: { client: YT }, videoId });
    for (const btn of collect(next, 'buttonViewModel')) {
      if (btn.iconName === 'LIKE' && btn.title && likes === null) likes = parseCompact(btn.title);
    }
    const sub = collect(next, 'subscriberCountText')[0];
    if (sub) subscribers = parseCompact(sub.simpleText || (sub.runs || []).map((rr) => rr.text).join(''));
  } catch (_) {}

  let comments = [];
  let commentWords = [];
  try {
    const c = await fetchComments(videoId);
    comments = c.comments;
    commentWords = c.topCommentWords;
  } catch (_) {}

  const thumbs = (vd.thumbnail && vd.thumbnail.thumbnails) || [];
  return {
    title: vd.title || '',
    channelTitle: vd.author || '',
    channelId: vd.channelId || '',
    description: vd.shortDescription || '',
    tags: vd.keywords || [],
    thumbnail: thumbs.length ? thumbs[thumbs.length - 1].url : 'https://i.ytimg.com/vi/' + videoId + '/maxresdefault.jpg',
    published: mf.publishDate ? new Date(mf.publishDate) : new Date(),
    views: Number(vd.viewCount) || 0,
    likes,
    subscribers,
    durationSec: Number(vd.lengthSeconds) || 0,
    comments,
    commentWords,
  };
}

async function analyze(videoId) {
  let src;
  try {
    src = await fetchInnertube(videoId);
  } catch (e1) {
    try {
      src = await fetchWatchPage(videoId);
    } catch (e2) {
      try {
        src = await fetchInvidious(videoId);
      } catch (e3) {
        throw new Error('video okunamadi (' + ((e2 && e2.message) || 'watch fail') + ' / ' + ((e3 && e3.message) || 'yedek fail') + ')');
      }
    }
  }

  const published = src.published && !isNaN(src.published.getTime()) ? src.published : new Date();
  const daysOld = Math.max(1, (Date.now() - published.getTime()) / 86400000);
  const views = src.views || 0;
  const likes = src.likes;
  const subscribers = src.subscribers;
  const durationSec = src.durationSec || 0;
  const comments = src.comments || [];

  const stats = {
    videoId,
    title: src.title,
    channelTitle: src.channelTitle,
    channelId: src.channelId,
    description: src.description || '',
    tags: src.tags || [],
    publishedText: published.toLocaleDateString('tr-TR', { day: '2-digit', month: 'long', year: 'numeric' }),
    thumbnail: src.thumbnail,
    views,
    likes,
    subscribers,
    likeRate: likes !== null && views ? (likes / views) * 100 : null,
    viewsPerDay: Math.round(views / daysOld),
    daysOld: Math.round(daysOld),
    durationSec,
    durationText: humanDuration(durationSec),
    isShort: durationSec > 0 && durationSec <= 60,
    comments,
    commentWords: src.commentWords || [],
    totalReplies: comments.reduce((a, c) => a + (c.replies || 0), 0),
  };

  return {
    stats,
    reasons: buildReasons(stats),
    insights: buildInsights(stats),
    prompt: buildPrompt(stats),
  };
}

function buildReasons(s) {
  const r = [];

  if (s.likeRate !== null && s.likeRate >= 3) {
    r.push(`Yüksek beğeni oranı (%${s.likeRate.toFixed(1)}) — izleyici videoyu onayladı, algoritma öneriyi sürdürdü.`);
  } else if (s.likeRate !== null && s.likeRate >= 1.3) {
    r.push(`Sağlam beğeni oranı (%${s.likeRate.toFixed(1)}) — sıradan videoların üstünde onay sinyali verdi.`);
  }

  if (s.subscribers) {
    const ratio = s.views / s.subscribers;
    if (ratio >= 3) {
      r.push(`İzlenme, abone sayısının ${ratio.toFixed(1)} katı — video kendi kitlesinin dışına çıkıp keşfet/öneri akışına düşmüş.`);
    } else if (ratio < 0.5 && s.subscribers > 1000) {
      r.push(`İzlenme abone kitlesinin bile altında kalmış — asıl büyüme abone gelmediği için duraklıyor.`);
    }
  }

  if (s.viewsPerDay >= 5000) {
    r.push(`Günlük ${fmtNum(s.viewsPerDay)} izlenme temposu — algoritma videoyu hâlâ aktif olarak öneriyor.`);
  }

  const kw = pickKeywords(s);
  if (kw.length >= 3) {
    r.push(`Konu talep görüyor: "${kw.slice(0, 3).join('", "')}" kelimeleri düzenli aranıyor, video bu talebi karşılıyor.`);
  }

  if (s.isShort) {
    r.push(`Shorts formatı (${s.durationText}) — kısa döngü, izlenme sayısını hızla şişiren bir yapı.`);
  } else if (s.durationSec >= 420 && s.durationSec <= 1080) {
    r.push(`${s.durationText}'lik süre ideal bandda — kalıcılığı yüksek tutup izlenmeyi rahatça biriktiriyor.`);
  }

  if (/\d/.test(s.title) || s.title.includes('?')) {
    r.push('Başlıkta merak tetikleyicisi var (sayı veya soru) — tıklama oranı bu yüzden yüksek.');
  }

  if (s.totalReplies >= 500) {
    r.push(`Yorumlarda ${fmtNum(s.totalReplies)} yanıt — video tartışma doğurmuş, algoritma etkileşimi öne çıkarıyor.`);
  }

  if (s.daysOld <= 14 && s.viewsPerDay >= 1000) {
    r.push(`Yayından yalnızca ${s.daysOld} gün geçmiş — ilk 48 saat ivmesi hâlâ etkisini gösteriyor.`);
  }

  if (!r.length) {
    r.push('Klasik formül: doğru konu + doğru başlık + sabırlı yayın temposu birleşmiş.');
  }

  return r.slice(0, 5);
}

function buildInsights(s) {
  const out = [];

  if (s.likeRate !== null) {
    if (s.likeRate >= 4) {
      out.push(`Beğeni oranı %${s.likeRate.toFixed(1)} — çok güçlü. İzleyici beğeni vermeyi ihmal etmemiş, algoritma bu sinyali seviyor.`);
    } else if (s.likeRate >= 1.5) {
      out.push(`Beğeni oranı %${s.likeRate.toFixed(1)} — ortalamanın üstünde. Beğeni çağrısı eksik olsaydı çok daha yukarılarda olurdu.`);
    } else {
      out.push(`Beğeni oranı %${s.likeRate.toFixed(1)} — düşük. İzlenme var ama "beğen" hissi zayıf; açılışta güçlü bir tepki tetikleyicisi işe yarardı.`);
    }
  } else {
    out.push('Bu videoda beğeni sayısı gizli — gizli beğeni, algoritmanın etkileşim sinyalini zayıflatır, açık beğeni her zaman avantaj.');
  }

  if (s.comments.length) {
    const best = s.comments.reduce((a, c) => ((c.likes || 0) > (a.likes || 0) ? c : a), s.comments[0]);
    out.push(`İlk 20 yorumun toplamı ${s.totalReplies} yanıt almış; en güçlü yorum ${best.likes != null ? fmtNum(best.likes) + ' beğeni' : 'yüksek etkileşim'} ile "${clip(best.text, 60)}" — izleyici bu temaya tepki vermiş.`);
  } else {
    out.push('Yorumlara erişilemedi (yorumlar kapalı olabilir) — yorum trafiği algoritma için en güçlü ikinci sinyal, yorum açık kalsın.');
  }

  if (s.commentWords.length) {
    out.push(`Yorumlarda en çok geçen kelimeler: ${s.commentWords.join(', ')} — izleyici tam olarak bu konuya odaklanmış, yeni videoda bu kelimeyi merkeze al.`);
  }

  if (s.subscribers) {
    const ratio = s.views / s.subscribers;
    if (ratio >= 3) {
      out.push(`İzlenme / abone oranı ${ratio.toFixed(1)}x — video abone kitlesinin çok ötesine taşmış. Keşfet/öneri akışından ciddi traffic almış.`);
    } else if (ratio < 0.5) {
      out.push(`İzlenme / abone oranı ${ratio.toFixed(2)}x — video kendi abone kitlesini bile çekememiş. Başlık/thumbnail burada sorunlu olabilir.`);
    } else {
      out.push(`İzlenme / abone oranı ${ratio.toFixed(1)}x — kanalın normal performansında kalmış, viral taşma olmamış.`);
    }
  } else if (s.viewsPerDay > 10000) {
    out.push(`Günlük ${fmtNum(s.viewsPerDay)} izlenme — algoritma bu videoyu aktif olarak öneriyor.`);
  }

  const tw = tokenize(s.title);
  if (tw.length >= 4 && tw.length <= 9) {
    out.push(`Başlık ${tw.length} kelimelik — ideal uzunluk. Ne çok kısa (anlamsız) ne çok uzun (kesilir).`);
  } else if (tw.length > 14) {
    out.push(`Başlık ${tw.length} kelime — uzun. Arama sonuçlarında sonu kesilir, en önemli kelimeyi öne al.`);
  }

  if (/\d/.test(s.title)) out.push('Başlıkta sayı var — sayılar tıklanma oranını ölçülebilir şekilde artırır (listeler, süreler, miktarlar).');
  if (s.title.includes('?') || /^(nasıl|neden|niye|ne|kim|how|why|what)/i.test(s.title)) {
    out.push('Başlık soru/merak formatında — boşluk bırakıyor, izleyici cevabı görmek için tıklıyor.');
  }

  if (s.isShort) {
    out.push(`Format: Shorts (${s.durationText}). 60 saniyenin altında — döngü (loop) kritik. Son kare ilk kelimeye bağlanırsa izlenme oranı katlanır.`);
  } else if (s.durationSec > 480) {
    out.push(`Format: uzun video (${s.durationText}). Süre uzunsa kalıcılık (retention) her şeydir; ilk 30 saniyede vaadi hemen ver.`);
  } else {
    out.push(`Format: standart video (${s.durationText}). Bu süre hem mid-roll reklam hem tam izlenme döngüsü için uygun.`);
  }

  if (s.tags.length >= 10) {
    out.push(`${s.tags.length} etiket — SEO dolu. Arama ve benzer video önerilerinde iyi kapsama sağlamış.`);
  } else if (s.tags.length > 0) {
    out.push(`Sadece ${s.tags.length} etiket — az. 15-20 etiketle uzun kuyruk aramalardan ekstra trafik alınabilir.`);
  } else {
    out.push('Etiket yok — arama trafiğinden sıfır pay alıyor. Bu bir hediye: rakip etiketlerini kopyalayabilirsin.');
  }

  if (s.description.length >= 500) {
    out.push(`Açıklama ${s.description.length} karakter — SEO için dolu. Arama motorları açıklamayı indeksliyor.`);
  } else if (s.description.length > 0) {
    out.push(`Açıklama kısa (${s.description.length} karakter). 500+ karakterlik açıklama arama görünürlüğünü belirgin artırır.`);
  }

  out.push(`Yayın tarihi: ${s.publishedText}. İlk 48 saat performansı videonun kaderini belirler — paylaşımı ilk gün yoğun kanallarına yap.`);

  return out;
}

function fmtNum(n) {
  return Number(n).toLocaleString('tr-TR');
}

function clip(t, n) {
  const s = String(t || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function pickKeywords(s) {
  const set = new Set();
  for (const w of [...tokenize(s.title), ...s.tags.map((t) => String(t).toLowerCase())]) {
    if (w.length > 2) set.add(w);
  }
  return [...set].slice(0, 8);
}

function buildPrompt(s) {
  const kw = pickKeywords(s);
  const niche = kw.slice(0, 3).join(', ') || s.title;
  const formatLine = s.isShort ? `dikey Shorts (9:16), ${s.durationText}` : `yatay standart (16:9), ${s.durationText}`;
  const hookIdea = kw.length
    ? `ilk 3 saniyede "${kw.slice(0, 3).join(' ')}" vaadini görsel bir şokla ver`
    : 'ilk 3 saniyede ters köşe bir görsel ver';
  const reasons = buildReasons(s);

  return [
    `Aşağıdaki görevi harfiyen uygula. Çıktıyı doğrudan kullanılabilecek bir video prodüksiyon brief'i olarak ver.`,
    ``,
    `REFERANS VİDEO`,
    `"${s.title}" — ${fmtNum(s.views)} izlenme${s.likes !== null ? `, ${fmtNum(s.likes)} beğeni${s.likeRate !== null ? ` (%${s.likeRate.toFixed(1)})` : ''}` : ''}.`,
    `Neden bu kadar izlendi:`,
    ...reasons.map((x, i) => `  ${i + 1}. ${x}`),
    ``,
    `GÖREV`,
    `Bu videonun başarısının formülünü analiz et; sonra aynı formülü taşıyan ama BİREBİR KOPYASI OLMAYAN, özgün ve benzeyen yeni bir video tasarla.`,
    ``,
    `KOPYA YASAĞI`,
    `- senaryo, sahne, başlık veya kurgunun birebir kopyasını ASLA üretme`,
    `- aynı konu etrafında özgün açılım yap: benzer his, farklı içerik`,
    `- referans videonun tuttuğu formülü (kanca, ritim, uzunluk, SEO) uygula, kendine ait hikâyeyle harmanla`,
    ``,
    `1) KONU VE NİŞ`,
    `- anahtar kelimeler: ${kw.join(' / ')}`,
    `- niş: ${niche}`,
    `- referans kanal tonu: ${s.channelTitle}`,
    ``,
    `2) FORMAT`,
    `- ${formatLine}`,
    `- hedef: %${s.likeRate !== null ? Math.max(1, s.likeRate * 0.8).toFixed(1) : '3'} üzeri beğeni oranı`,
    ``,
    `3) AÇILIŞ KANCASI (ilk 3 saniye)`,
    `- ${hookIdea}`,
    `- seyirciye ilk saniyede "bunu kaçıramam" hissi ver, soru değil iddia kullan`,
    ``,
    `4) İÇERİK YAPISI`,
    `- 0-3 sn: hook — vaadi görsel olarak göster`,
    `- 3-15 sn: kanıt/gerçekçi sonuç, neden izlemeli`,
    `- orta bölüm: her 15 saniyede bir mini doruk noktası (bilgi, twist veya duygu)`,
    `- son 10 sn: açık uçlu bitiriş + beğeni/yorum tetikleyici soru`,
    ``,
    `5) SEO`,
    `- başlık: ${kw.slice(0, 4).join(' ')} formatında, 60 karakteri geçme${/\d/.test(s.title) ? ', başlıkta sayı kullan' : ''}`,
    `- açıklama: ilk iki satırda anahtar kelimeler, 500+ karakter`,
    `- etiketler: ${kw.concat(s.tags.slice(0, 8)).slice(0, 15).join(', ')}`,
    ``,
    `6) ETKİLEŞİM STRATEJİSİ`,
    `- videoyu bitiren soru: yorumlarda tartışmaya açacak bir soru bırak${s.commentWords[0] ? ` ("${s.commentWords[0]}" temalı)` : ''}`,
    `- tartışma hedefi: ilk 20 yorumda toplam 100+ yanıt`,
    `- beğeni çağrısını doruk noktasının hemen sonrasına koy, en sonda değil`,
    `- ilk 48 saatte: 3 farklı platformda paylaş (shorts feed, story, ilgili topluluk)`,
    ``,
    `7) BAŞARI KRİTERLERİ`,
    `- ilk 48 saatte ${fmtNum(s.viewsPerDay)} günlük izlenme tempoyu yakala`,
    `- izlenme/abone oranı ${s.subscribers ? (s.views / s.subscribers).toFixed(1) + 'x' : '3x'} hedefini geç`,
    `- yorumlarda en az 100 yanıtlık tartışma`,
  ].join('\n');
}

app.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`video-puf calisiyor: ${url}`);
  if (!GOOGLE_CLIENT_ID) {
    console.log(DEV_SKIP_AUTH
      ? 'DEV mod: google girisi su an atlanabilir, .env icine GOOGLE_CLIENT_ID ekleyince gercek giris acilir.'
      : 'UYARI: GOOGLE_CLIENT_ID eksik, giris calismaz.');
  }
  if (process.platform === 'win32' && process.env.NO_AUTO_OPEN !== '1') {
    setTimeout(() => {
      try {
        exec(`start "" "${url}"`);
      } catch (_) {}
    }, 900);
  }
});
