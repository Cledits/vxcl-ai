let idToken = null;
let gisReady = false;
let pendingUrl = null;

const $ = (id) => document.getElementById(id);

const themeBtn = $('theme-btn');
if (themeBtn) {
  themeBtn.addEventListener('click', () => {
    const cur = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', cur);
    try { localStorage.setItem('vxcl_theme', cur); } catch (_) {}
  });
}

function decodeJwt(token) {
  try {
    const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Uint8Array.from(atob(part), (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (_) {
    return null;
  }
}

function showAccount(profile) {
  $('avatar').textContent = (profile.name || 'V').trim().charAt(0).toUpperCase();
  $('acc-name').textContent = profile.name || 'Hesabım';
  $('acc-email').textContent = profile.email || '';
  $('account').classList.remove('hidden');
  $('nav-login').classList.add('hidden');
}

try {
  let raw = localStorage.getItem('vxcl_auth');
  if (!raw) {
    raw = sessionStorage.getItem('vxcl_auth');
    if (raw) {
      localStorage.setItem('vxcl_auth', raw);
      sessionStorage.removeItem('vxcl_auth');
    }
  }
  const saved = JSON.parse(raw || 'null');
  if (saved && saved.t) {
    idToken = saved.t;
    showAccount(saved.profile || { name: 'Hesabım', email: '' });
  }
} catch (_) {}

fetch('/api/config')
  .then((r) => r.json())
  .then((cfg) => {
    if (cfg.clientId) {
      whenGis(() => {
        google.accounts.id.initialize({
          client_id: cfg.clientId,
          callback: onCredential,
        });
        gisReady = true;
      });
      return;
    }
    if (cfg.devMode) {
      $('gate-status').textContent = 'google anahtarı henüz yok — geçici giriş modu';
      const b = document.createElement('button');
      b.className = 'dev-login';
      b.textContent = 'Google ile giriş (geçici mod)';
      b.addEventListener('click', () => onCredential({ credential: 'dev' }));
      $('gbtn').appendChild(b);
      return;
    }
    $('gate-status').textContent = 'GOOGLE_CLIENT_ID eksik — giriş şu an yapılamıyor';
  })
  .catch(() => {
    $('gate-status').textContent = 'sunucuya ulaşılamıyor';
  });

function whenGis(cb) {
  if (window.google && google.accounts && google.accounts.id) cb();
  else setTimeout(() => whenGis(cb), 100);
}

function onCredential(response) {
  idToken = response.credential;
  let profile;
  if (idToken === 'dev') {
    profile = { name: 'Geçici Kullanıcı', email: 'geçici mod' };
  } else {
    const p = decodeJwt(idToken) || {};
    profile = { name: p.name || p.email || 'Hesabım', email: p.email || '' };
  }
  try {
    localStorage.setItem('vxcl_auth', JSON.stringify({ t: idToken, profile }));
  } catch (_) {}
  showAccount(profile);
  closeModal();
  const status = $('scan-status');
  status.className = 'status info';
  status.textContent = 'giriş yapıldı — analiz için linki yapıştır';
  if (pendingUrl) {
    $('url').value = pendingUrl;
    pendingUrl = null;
    runAnalysis();
  }
}

function openLogin() {
  $('login-modal').classList.remove('hidden');
  if (gisReady) {
    $('gbtn').innerHTML = '';
    google.accounts.id.renderButton($('gbtn'), {
      theme: 'outline',
      size: 'large',
      width: 240,
      text: 'signin_with',
    });
  }
}

function closeModal() {
  $('login-modal').classList.add('hidden');
}

$('nav-login').addEventListener('click', openLogin);
$('modal-close').addEventListener('click', closeModal);
$('logout').addEventListener('click', () => {
  idToken = null;
  try {
    localStorage.removeItem('vxcl_auth');
    sessionStorage.removeItem('vxcl_auth');
  } catch (_) {}
  $('account').classList.add('hidden');
  $('nav-login').classList.remove('hidden');
  const status = $('scan-status');
  status.className = 'status info';
  status.textContent = 'çıkış yapıldı';
});
$('login-modal').addEventListener('click', (e) => {
  if (e.target === $('login-modal')) closeModal();
});

$('scan-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const url = $('url').value.trim();
  if (!url) return;
  if (!idToken) {
    pendingUrl = url;
    const status = $('scan-status');
    status.className = 'status';
    status.textContent = '';
    openLogin();
    return;
  }
  runAnalysis();
});

async function runAnalysis() {
  const btn = $('scan-btn');
  const status = $('scan-status');
  btn.disabled = true;
  btn.textContent = 'Taranıyor...';
  status.className = 'status info';
  status.textContent = '';
  $('results').classList.add('hidden');

  try {
    const r = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken, url: $('url').value }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'Analiz başarısız.');
    render(j);
  } catch (err) {
    status.className = 'status';
    status.textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Analiz Et';
  }
}

function esc(t) {
  const d = document.createElement('div');
  d.textContent = t == null ? '' : String(t);
  return d.innerHTML;
}

function fmt(n) {
  return n == null ? '—' : Number(n).toLocaleString('tr-TR');
}

function render(data) {
  const s = data.stats;
  $('scan-status').textContent = '';

  if (s.thumbnail) {
    $('thumb').src = s.thumbnail;
    $('thumb').style.display = '';
  } else {
    $('thumb').style.display = 'none';
  }
  $('v-title').textContent = s.title;
  $('v-meta').textContent = `${s.channelTitle} • ${s.publishedText}${s.nicheLabel ? ' • ' + s.nicheLabel : ''}`;

  const cards = [
    ['İzlenme', fmt(s.views)],
    ['Beğeni', fmt(s.likes)],
    ['Beğeni Oranı', s.likeRate != null ? '%' + s.likeRate.toFixed(2) : '—'],
    ['Abone', fmt(s.subscribers)],
    ['Süre', s.durationText],
    ['Günlük İzlenme', fmt(s.viewsPerDay)],
    ['Topluluk Yanıtı', fmt(s.totalReplies)],
    ['Yayından Sonra', s.daysOld + ' gün'],
  ];
  $('stats').innerHTML = cards
    .map(([k, v]) => `<div class="stat"><div class="stat-v">${esc(v)}</div><div class="stat-k">${esc(k)}</div></div>`)
    .join('');

  $('reasons').innerHTML = (data.reasons || []).map((i) => `<li>${esc(i)}</li>`).join('');
  $('insights').innerHTML = data.insights.map((i) => `<li>${esc(i)}</li>`).join('');

  const moments = s.topMoments || [];
  if (moments.length) {
    $('moments-card').classList.remove('hidden');
    $('moments').innerHTML = moments
      .map(
        (m) => `
        <div class="moment">
          <span class="moment-t">${esc(m.t)}</span>
          <div class="moment-body">
            <div class="moment-meta">${fmt(m.count)} yorumda geçti${m.likes ? ' · ' + fmt(m.likes) + ' beğeni' : ''}</div>
            <div class="moment-text">${esc((m.sample || '').slice(0, 140))}</div>
          </div>
        </div>`)
      .join('');
  } else {
    $('moments-card').classList.add('hidden');
  }

  const cm = s.comments || [];
  if (cm.length) {
    $('comments').innerHTML = cm
      .slice(0, 5)
      .map((c) => `
        <div class="comment">
          <div class="comment-head">
            <span class="comment-author">${esc(c.author || 'anonim')}</span>
            <span class="comment-meta">${c.likes != null ? esc(fmt(c.likes)) + ' beğeni' : ''}${c.replies ? ' · ' + esc(fmt(c.replies)) + ' yanıt' : ''}${c.published ? ' · ' + esc(c.published) : ''}</span>
          </div>
          <div class="comment-text">${esc(c.text)}</div>
        </div>`)
      .join('');
  } else {
    $('comments').innerHTML = '<div class="muted">yorumlar kapalı veya çekilemedi</div>';
  }

  $('prompt').textContent = data.prompt;

  $('results').classList.remove('hidden');
  $('results').scrollIntoView({ behavior: 'smooth' });
}

$('copy-btn').addEventListener('click', async () => {
  const text = $('prompt').textContent;
  try {
    await navigator.clipboard.writeText(text);
    $('copy-btn').textContent = 'Kopyalandı';
  } catch (_) {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    $('copy-btn').textContent = 'Kopyalandı';
  }
  setTimeout(() => ($('copy-btn').textContent = 'Kopyala'), 1500);
});
