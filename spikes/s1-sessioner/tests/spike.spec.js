'use strict';
const { test, expect, request } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

// SAME-SITE-modellen (ADR 0002): allt under lvh.me
const APP_SHELL = 'https://app.lvh.me:8443';
const APP_CONTENT = 'https://app--c.lvh.me:8443';
const BYGG = 'https://bygg.lvh.me:8443';
const EXT = 'https://evil.127.0.0.1.nip.io:9443';
// cross-site-kontroll: framare på ANNAN registrerbar domän
const XSITE_FRAMER = 'https://bygg.localtest.me:8443';

const RESULTS = path.join(__dirname, '..', 'results', 'matrix.jsonl');
function record(browser, id, fraga, utfall, detalj) {
  fs.appendFileSync(RESULTS, JSON.stringify({ browser, id, fraga, utfall, detalj }) + '\n');
}

async function extHits(token) {
  const ctx = await request.newContext({ ignoreHTTPSErrors: true });
  const r = await ctx.get(`${EXT}/_hits?t=${token}`);
  const rows = await r.json();
  await ctx.dispose();
  return rows.map((h) => h.m);
}
async function echoLog(token) {
  const ctx = await request.newContext({ ignoreHTTPSErrors: true });
  const r = await ctx.get(`${BYGG}/_api/echo-log?t=${token}`);
  const rows = await r.json();
  await ctx.dispose();
  return rows;
}

// Matcha på ORIGIN-prefix, inte substring (xframe-URL:en innehåller värden i query).
function contentFrame(page, host) {
  return page.frames().find((f) => f.url().startsWith('https://' + host + ':') || f.url().startsWith('https://' + host + '/'));
}
async function getFrame(page, host, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const f = contentFrame(page, host);
    if (f) return f;
    await page.waitForTimeout(100);
  }
  return null;
}
async function waitReport(frame) {
  await frame.waitForFunction(() => window.__report && window.__report.api !== null, null, { timeout: 8000 });
  return frame.evaluate(() => window.__report);
}

// ===========================================================================
// S1 – sessioner
// ===========================================================================
test('S1.1 biljettflöde login -> appvärd med __Host-kaka', async ({ page, context, browserName }) => {
  await page.goto(APP_SHELL + '/', { waitUntil: 'networkidle' });
  const onShell = page.url().startsWith(APP_SHELL);
  const who = await page.evaluate(async () => (await fetch('/_api/whoami', { credentials: 'same-origin' })).json());
  const cookies = await context.cookies();
  const hostCookie = cookies.find((c) => c.name === '__Host-app_sess');
  const ok = onShell && who.hasCookie === true && !!hostCookie;
  record(browserName, 'S1.1', 'login→appvärd, __Host-kaka sätts & skickas', ok ? 'fungerar' : 'avviker',
    `url=${page.url()} whoami.hasCookie=${who.hasCookie} __Host-app_sess=${!!hostCookie}`);
  expect(who.hasCookie).toBe(true);
});

test('S1.2 innehålls-iframe (same-site, cross-origin) skickar egen __Host-kaka (Lax)', async ({ page, browserName }) => {
  await page.goto(APP_SHELL + '/', { waitUntil: 'networkidle' });
  const f = await getFrame(page, 'app--c.lvh.me');
  expect(f, 'innehålls-iframe ska finnas').toBeTruthy();
  const rep = await waitReport(f);
  const ok = rep.api && rep.api.hasCookie === true;
  record(browserName, 'S1.2', 'iframe __Host-content_sess (Lax) skickas i same-origin-fetch', ok ? 'fungerar' : 'avviker',
    `api.hasCookie=${rep.api && rep.api.hasCookie} sec=${JSON.stringify(rep.api && rep.api.sec)}`);
  expect(rep.api.hasCookie).toBe(true);
});

test('S1.3 förhandsvisning p-<id> inramad av bygg fungerar likadant (same-site)', async ({ page, browserName }) => {
  await page.goto(BYGG + '/', { waitUntil: 'networkidle' });
  const f = await getFrame(page, 'p-demo.lvh.me');
  expect(f).toBeTruthy();
  const rep = await waitReport(f);
  const ok = rep.api && rep.api.hasCookie === true;
  record(browserName, 'S1.3', 'preview-kaka i same-site iframe på byggdomänen', ok ? 'fungerar' : 'avviker',
    `api.hasCookie=${rep.api && rep.api.hasCookie}`);
  expect(rep.api.hasCookie).toBe(true);
});

test('S1.4 KONTROLL: cross-site framing (annan domän ramar appinnehåll) partitionerar kakan', async ({ page, browserName }) => {
  // 1) etablera innehålls-kaka same-site (top=lvh.me)
  await page.goto(APP_SHELL + '/', { waitUntil: 'networkidle' });
  await waitReport(await getFrame(page, 'app--c.lvh.me'));
  // 2) rama in samma innehåll från en ANNAN registrerbar domän (top=localtest.me => cross-site)
  const src = `${APP_CONTENT}/?guard=off&target=${encodeURIComponent(EXT)}&token=xsite-${Date.now()}`;
  await page.goto(`${XSITE_FRAMER}/xframe?src=${encodeURIComponent(src)}`, { waitUntil: 'networkidle' });
  const f = await getFrame(page, 'app--c.lvh.me');
  const rep = await waitReport(f);
  const leaked = rep.api && rep.api.hasCookie === true;
  record(browserName, 'S1.4', 'cross-site iframe ser INTE första-parts-kakan (partitionering)',
    leaked ? 'AVVIKER-läcker' : 'blockeras-korrekt',
    `cross-site api.hasCookie=${rep.api && rep.api.hasCookie} sec=${JSON.stringify(rep.api && rep.api.sec)}`);
});

test('S1.5 innehåll kan inte läsa skalets kaka & document.cookie döljer __Host (HttpOnly)', async ({ page, browserName }) => {
  await page.goto(APP_SHELL + '/', { waitUntil: 'networkidle' });
  const f = await getFrame(page, 'app--c.lvh.me');
  const rep = await waitReport(f);
  await page.waitForFunction(() => window.__shell && window.__shell.crossOriginReadThrew !== null, null, { timeout: 5000 }).catch(() => {});
  const shell = await page.evaluate(() => window.__shell);
  const httpOnlyOk = !/__Host-/.test(rep.cookieVisible || '');
  const sopOk = shell && shell.crossOriginReadThrew === true;
  record(browserName, 'S1.5', 'HttpOnly döljer kaka i document.cookie + SOP blockerar cross-origin DOM',
    httpOnlyOk && sopOk ? 'blockeras-korrekt' : 'AVVIKER',
    `content.document.cookie="${rep.cookieVisible}" shell.crossOriginReadThrew=${shell && shell.crossOriginReadThrew}`);
  expect(httpOnlyOk).toBe(true);
});

// ===========================================================================
// (a) Cookie tossing: Domain=<basdomän>-kakor & försök att förfalska __Host-
// ===========================================================================
test('A. cookie tossing: Domain-kaka når bygg, __Host- kan inte förfalskas', async ({ page, browserName }) => {
  // ladda app-skalet så innehållet (app--c) kör tossing-koden
  await page.goto(APP_SHELL + '/', { waitUntil: 'networkidle' });
  const f = await getFrame(page, 'app--c.lvh.me');
  const rep = await waitReport(f);
  const toss = rep.tossing;
  // navigera top-level till bygg och se vilka kakor servern SER
  const meResp = await page.goto(`${BYGG}/_api/echo?t=toss-${browserName}&case=topnav-after-toss`, { waitUntil: 'domcontentloaded' });
  const seen = await meResp.json();
  const names = seen.seen.cookieNames;
  const domainReached = names.includes('toss_domain');
  const forgedHostReached = names.includes('__Host-app_sess'); // ska ALDRIG vara sann på bygg
  record(browserName, 'A.1-domain', 'app kan plantera Domain=<basdomän>-kaka som NÅR bygg (cookie tossing)',
    domainReached ? 'JA-risk-bekräftad' : 'nej',
    `bygg ser=${JSON.stringify(names)}`);
  record(browserName, 'A.2-hostwithdomain', 'webbläsaren VÄGRAR __Host- med Domain= (kan ej sättas)',
    toss.forgeHostWithDomain === false ? 'blockeras-korrekt' : 'AVVIKER',
    `document.cookie fick __Host-app_sess=FORGED? ${toss.forgeHostWithDomain}`);
  record(browserName, 'A.3-hostcross', 'förfalskad __Host- når INTE annan värd (bygg)',
    forgedHostReached ? 'AVVIKER-läcker' : 'blockeras-korrekt',
    `bygg ser __Host-app_sess=${forgedHostReached}; app--c satte host-only egen? ${toss.forgeHostOwn}`);
  expect(forgedHostReached).toBe(false);
  expect(toss.forgeHostWithDomain).toBe(false);
});

// ===========================================================================
// (b) SameSite ger inget skydd mellan subdomäner – mät Origin/Sec-Fetch-Site
// ===========================================================================
test('B. SameSite skyddar EJ same-site: bygg-kakor skickas; mät Origin/Sec-Fetch-Site', async ({ page, browserName }) => {
  const T = `b-${browserName}-${Date.now()}`;
  // 1) sätt byggkakor (Lax + Strict, host-only) genom att besöka bygg
  await page.goto(`${BYGG}/_api/setcookies`, { waitUntil: 'domcontentloaded' });
  // 2) fetch(credentials:include) app--c -> bygg (skript-initierad, från driver)
  await page.goto(`${APP_CONTENT}/driver`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(async ({ bygg, t }) => {
    try { await fetch(`${bygg}/_api/echo?t=${t}&case=fetch-include`, { credentials: 'include' }); } catch (e) {}
  }, { bygg: BYGG, t: T });
  // 3) SKRIPT-initierad top-level navigation app--c -> bygg (GET)
  await Promise.all([
    page.waitForURL('**/_api/echo**', { timeout: 8000 }).catch(() => {}),
    page.evaluate(({ bygg, t }) => { location.href = `${bygg}/_api/echo?t=${t}&case=topnav`; }, { bygg: BYGG, t: T }),
  ]);
  // 4) form POST app--c -> bygg (skript-initierad, navigerar bort => egen driver-laddning)
  await page.goto(`${APP_CONTENT}/driver`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(({ bygg, t }) => {
    const f = document.createElement('form'); f.method = 'POST'; f.action = `${bygg}/_api/echo?t=${t}&case=form-post`;
    document.body.appendChild(f); f.submit();
  }, { bygg: BYGG, t: T });
  await page.waitForTimeout(400);
  const rows = await echoLog(T);
  const byCase = Object.fromEntries(rows.map((r) => [r.case, r]));
  for (const c of ['fetch-include', 'topnav', 'form-post']) {
    const r = byCase[c];
    if (!r) { record(browserName, 'B.' + c, `bygg-kakor + Origin/Sec-Fetch-Site vid ${c}`, 'ej-mätt', 'ingen rad (ev. CSP/preflight)'); continue; }
    const lax = r.cookieNames.includes('bygg_lax');
    const strict = r.cookieNames.includes('bygg_strict');
    record(browserName, 'B.' + c, `bygg-kakor skickas vid ${c}? (SameSite skyddar ej same-site)`,
      lax && strict ? 'BÅDA-skickas' : (lax || strict ? 'delvis' : 'inga'),
      `lax=${lax} strict=${strict} Origin=${r.origin} Sec-Fetch-Site=${r.secSite} names=${JSON.stringify(r.cookieNames)}`);
  }
});

// ===========================================================================
// (c) Kakbombning (431/400) och Clear-Site-Data: "cookies"
// ===========================================================================
test('C. kakbombning ger 431 och Clear-Site-Data rensar', async ({ page, browserName }) => {
  await page.goto(`${APP_CONTENT}/driver`, { waitUntil: 'domcontentloaded' });
  // plantera stora Domain=lvh.me-kakor
  const len = await page.evaluate(() => window.__bomb(20, 3800));
  // begär bygg – förvänta 431 (huvuden för stora), 400, eller reset/timeout (=DoS-symptomet)
  let status = 0, errored = null;
  try { const r = await page.goto(`${BYGG}/_api/echo?t=bomb-${browserName}&case=bomb`, { waitUntil: 'commit', timeout: 6000 }); status = r.status(); }
  catch (e) { errored = String(e).split('\n')[0]; }
  record(browserName, 'C.1-bomb', 'kakbombning (20×3800B Domain-kakor) => bygg svarar 431/400 eller reset/timeout',
    (status === 431 || status === 400 || errored) ? 'bekräftad' : `svar=${status}`,
    `docCookieLen≈${len} status=${status} err=${errored}`);
  // OBS: när jaren väl är bombad går den inte att rensa via ett vanligt anrop –
  // rensningsanropet bär SAMMA översstora kakor och avvisas. Clear-Site-Data mäts
  // därför i ett eget, icke-bombat fall (C.2 nedan).
});

test('C.2 Clear-Site-Data: "cookies" rensar planterade Domain-kakor (icke-bombat fall)', async ({ page, browserName }) => {
  await page.goto(`${APP_CONTENT}/driver`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { document.cookie = 'csd1=v; Domain=lvh.me; Path=/; Secure'; document.cookie = 'csd2=v; Domain=lvh.me; Path=/; Secure'; });
  const before = await (await page.goto(`${BYGG}/_api/echo?t=csd-before-${browserName}`, { waitUntil: 'domcontentloaded' })).json();
  await page.goto(`${BYGG}/_api/clear`, { waitUntil: 'domcontentloaded' }); // svarar Clear-Site-Data: "cookies"
  const after = await (await page.goto(`${BYGG}/_api/echo?t=csd-after-${browserName}`, { waitUntil: 'domcontentloaded' })).json();
  const gone = !after.seen.cookieNames.includes('csd1') && !after.seen.cookieNames.includes('csd2');
  record(browserName, 'C.2-clear', 'Clear-Site-Data: "cookies" från bygg rensar planterade Domain-kakor',
    gone ? 'rensat' : 'kvarstår',
    `före=${JSON.stringify(before.seen.cookieNames)} efter=${JSON.stringify(after.seen.cookieNames)}`);
});

// ===========================================================================
// S4 – webbläsarexfiltrering
// ===========================================================================
test('S4.6+7 exfiltrering från sandlådad iframe (frame-src + CSP + sandbox)', async ({ page, browserName }) => {
  await page.goto(APP_SHELL + '/', { waitUntil: 'networkidle' });
  const f = await getFrame(page, 'app--c.lvh.me');
  const rep0 = await waitReport(f);
  const token = rep0.token;
  await f.evaluate(() => window.__runExfil()).catch(() => {});
  await f.waitForFunction(() => window.__report && window.__report.exfilDone, null, { timeout: 5000 }).catch(() => {});
  const rep = await f.evaluate(() => window.__report).catch(() => rep0);
  await page.waitForTimeout(2500);
  const reached = token ? await extHits(token) : [];
  const methods = ['fetch', 'img', 'beacon', 'form', 'winopen', 'atop', 'toploc', 'selfnav', 'ws'];
  for (const m of methods) {
    const arrived = reached.includes(m);
    record(browserName, 'S4.' + m, `läckväg "${m}" når extern server?`, arrived ? 'AVVIKER-läcker' : 'blockeras-korrekt',
      `extern mottog=${arrived}`);
  }
  if (rep) {
    record(browserName, 'S4.rtc', 'RTCPeerConnection-konstruktor/ICE kör (connect-src styr ej STUN)',
      rep.attempts.rtc && rep.attempts.rtc.ran ? 'kör' : 'blockeras',
      `ran=${rep.attempts.rtc && rep.attempts.rtc.ran} iceRan=${rep.attempts.rtc && rep.attempts.rtc.iceRan}`);
  }
  record(browserName, 'S4.6-selfnav', 'VIKTIGAST: skalets frame-src stoppar iframe-självnavigering till extern origin',
    reached.includes('selfnav') ? 'AVVIKER-läcker' : 'blockeras-korrekt', `extern mottog selfnav=${reached.includes('selfnav')}`);
  expect(reached).not.toContain('selfnav');
});

test('S4.8 direktbesök på innehållsvärd nekas via Sec-Fetch (+ huvudenas pålitlighet)', async ({ page, browserName }) => {
  const resp = await page.goto(APP_CONTENT + '/', { waitUntil: 'domcontentloaded' });
  const status = resp.status();
  const blocked = status === 403;
  const meResp = await page.goto(APP_CONTENT + '/_api/me', { waitUntil: 'domcontentloaded' });
  const me = await meResp.json();
  const secSent = me.sec && me.sec.dest !== null;
  record(browserName, 'S4.8-guard', 'direktbesök nekas (403) när Sec-Fetch-Dest≠iframe', blocked ? 'blockeras-korrekt' : 'AVVIKER',
    `status=${status}`);
  record(browserName, 'S4.8-sec', 'skickar motorn Sec-Fetch-Dest/Site vid toppnivå-doc?', secSent ? 'ja-pålitligt' : 'NEJ-opålitligt',
    `sec=${JSON.stringify(me.sec)}`);
  expect(blocked).toBe(true);
});
