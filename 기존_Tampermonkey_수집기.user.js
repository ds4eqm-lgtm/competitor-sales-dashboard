// ==UserScript==
// @name         커머스 인사이트 수집기
// @namespace    competitor-stock-tracker
// @version      4.2
// @description  상품페이지가 스스로 불러오는 옵션별 재고 데이터를 읽어서 옵션 단위로 판매추정을 깃허브에 자동 기록
// @match        https://smartstore.naver.com/*/products/*
// @match        https://brand.naver.com/*/products/*
// @match        https://yongki9156.github.io/competitor-stock/*
// @grant        GM_xmlhttpRequest
// @grant        window.close
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_listValues
// @grant        GM_deleteValue
// @connect      api.github.com
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  // ---------------- 여기 세줄만 본인 값으로 바꾸기 ----------------
  const GITHUB_TOKEN = "REPLACE_WITH_NEW_GITHUB_TOKEN";
  const GITHUB_OWNER = "ds4eqm-lgtm";
  const GITHUB_REPO = "commerce-insight";
  // ---------------------------------------------------------------

  const DAY_START_HOUR = 7;  // 하루 시작 (07:00 ~ 다음날 07:00)
  const SPLIT_HOUR = 17;     // 2타임(07~17) / 1타임(17~다음날 07) 나누는 시각
  const LONG_GAP_HOURS = 16; // 기록 사이가 이보다 길게 비면 기간불명으로 따로 표시
  const HISTORY_KEEP_DAYS = 14; // 시간별 기록 보관 기간 (일별 판매량은 latest.json에 영구 보관)

  // 대시보드 페이지에서는 '판매로 인정' 저장만 대신 해줌 (이 스크립트가 깔린 컴퓨터만 인정 가능)
  const isDashboard = window.location.hostname === `${GITHUB_OWNER}.github.io`;
  const urlMatch = window.location.pathname.match(/^\/([^/]+)\/products\/(\d+)/);
  if (!urlMatch && !isDashboard) return;
  const storeSlug = urlMatch ? urlMatch[1] : '';
  const productNo = urlMatch ? urlMatch[2] : '';
  const API_PATTERN = new RegExp(`/v2/channels/([^/]+)/products/${productNo}`);

  let handled = false;   // 재고 데이터를 받아서 처리 시작했는지
  let finished = false;  // 업로드까지 끝났는지

  // ---------------- 자동조회로 열린 탭이면 작업 끝나고 탭 닫기 ----------------
  // 자동조회 bat이 주소 끝에 #autotrack 을 붙여서 연다. 직접 연 탭은 절대 안 닫음
  let autoMode = false;
  try {
    if (window.location.hash === '#autotrack') sessionStorage.setItem('autotrack', '1');
    autoMode = sessionStorage.getItem('autotrack') === '1';
  } catch (e) {
    autoMode = window.location.hash === '#autotrack';
  }

  function closeAutoTab() {
    if (!autoMode) return;
    try { sessionStorage.removeItem('autotrack'); } catch (e) { /* 무시 */ }
    setTimeout(() => window.close(), 1500);
  }

  if (autoMode) {
    // 60초가 지나도 재고 데이터를 못 받으면 한 번만 새로고침해서 재시도
    setTimeout(() => {
      if (handled) return;
      let retried = false;
      try { retried = sessionStorage.getItem('autotrack_retry') === '1'; } catch (e) { /* 무시 */ }
      if (!retried) {
        console.log('[판매량추적] 60초 동안 데이터 없음, 새로고침 재시도');
        try { sessionStorage.setItem('autotrack_retry', '1'); } catch (e) { /* 무시 */ }
        window.location.reload();
      } else {
        console.log('[판매량추적] 재시도해도 데이터 없음, 탭 닫기');
        closeAutoTab();
      }
    }, 60000);
    // 혹시 멈춰도 3분 뒤에는 닫기 (자동조회 탭은 깃허브에 직접 안 올리고 저장만 해서 보통 몇 초면 끝남)
    setTimeout(() => { if (!finished) closeAutoTab(); }, 180000);
  }

  // ---------------- 날짜 계산 ----------------
  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

  function toDate(key) {
    const [d, t = '00:00'] = key.split('T');
    const [y, m, day] = d.split('-').map(Number);
    const [hh, mm] = t.split(':').map(Number);
    return new Date(y, m - 1, day, hh || 0, mm || 0);
  }

  // 하루 = 그날 07:00 ~ 다음날 07:00
  // 2타임 = 07:00 ~ 17:00, 1타임 = 17:00 ~ 다음날 07:00
  // 판매(재고 감소)는 '감소가 시작된 기록 시각'이 속한 타임에 넣음
  // 예) 밤에 컴퓨터가 꺼져서 18:00 다음 기록이 아침 09:00이면, 그 사이 줄어든 양은 전날 1타임(야간)
  function bizDayOf(dt) {
    const d = new Date(dt);
    if (d.getHours() < DAY_START_HOUR) d.setDate(d.getDate() - 1);
    return ymd(d);
  }

  function dayWindow(day) {
    const start = toDate(day);
    start.setHours(DAY_START_HOUR, 0, 0, 0);
    const split = new Date(start);
    split.setHours(SPLIT_HOUR, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    return { start, split, end };
  }

  // 하루 판매량 계산
  // s: 판매 / u: 기록이 너무 오래 비어 언제 팔렸는지 모르는 양 / x, ev: 수동변경 의심 / k: 그날 마지막 재고
  // t1, t2: 1타임, 2타임 각각의 s, u, x, ev
  function computeDay(rec, day, flags, now) {
    flags = flags || {};
    const { start, split, end } = dayWindow(day);
    const es = Object.keys(rec).map((t) => ({ t, dt: toDate(t), v: rec[t] })).sort((a, b) => a.dt - b.dt);
    const mk = () => ({ s: 0, u: 0, x: 0, ev: [], up: 0, upEv: [], uEv: [] });
    const all = mk();
    const t1 = mk();
    const t2 = mk();
    let k = null;
    let any = false;
    let base = false;
    for (let i = 0; i < es.length; i++) {
      const e = es[i];
      if (e.dt < start) { base = true; continue; }
      if (e.dt >= end || (now && e.dt > now)) break;
      any = true;
      k = e.v;
      const nx = es[i + 1];
      if (!nx || (now && nx.dt > now)) continue;
      const d = e.v - nx.v;
      const per = e.dt < split ? t2 : t1;
      if (d < 0) {
        // 재고가 늘면 판매 아님. 크게 늘었으면 따로 기록만 해 둠
        if (-d >= DETECT.BIG_RISE) [per, all].forEach((p) => { p.up += -d; p.upEv.push([nx.t, -d, e.v, nx.v]); });
        continue;
      }
      if (d === 0) continue;
      const f = flags[nx.t];
      const gapH = (nx.dt - e.dt) / 3600000;
      [per, all].forEach((p) => {
        if (f) { p.x += d; p.ev.push([nx.t, d, f.why.join(', ')]); }
        else if (gapH > LONG_GAP_HOURS) { p.u += d; p.uEv.push([e.t, nx.t, d]); }
        else p.s += d;
      });
    }
    if (!any) return null;
    return Object.assign(all, { k, base, t1, t2 });
  }

  // ---------------- 수동 재고변경 감지 설정 (대시보드와 탬퍼몽키 스크립트 값을 똑같이 맞출 것) ----------------
  const DETECT = {
    BIG_DROP: 1000, // 한 번(보통 1시간) 사이에 이 수량 이상 줄면 사람이 재고를 직접 고친 것으로 의심
    BIG_RISE: 1000, // 한 번에 이 수량 이상 늘면 '재고 대량 증가'로 표시 (입고 또는 사람이 숫자를 늘린 것, 판매량에는 영향 없음)
  };

  // 전체 기록에서 수동변경 의심 감소를 찾음
  // 결과: { 옵션키: { 시간키: { d: 감소량, why: [이유...] } } }
  function detectSuspicious(history) {
    const out = {};
    Object.keys(history).forEach((key) => {
      const rec = history[key] || {};
      const ts = Object.keys(rec).sort();
      for (let i = 1; i < ts.length; i++) {
        const d = rec[ts[i - 1]] - rec[ts[i]];
        if (d >= DETECT.BIG_DROP) {
          (out[key] = out[key] || {})[ts[i]] = {
            d,
            why: [`${rec[ts[i - 1]].toLocaleString()}개에서 ${rec[ts[i]].toLocaleString()}개로 한 번에 ${d.toLocaleString()}개 줄어듦 (${DETECT.BIG_DROP.toLocaleString()}개 이상)`],
          };
        }
      }
    });
    return out;
  }

  // 구간 판매량 계산
  // s: 판매로 본 수량 / u: 기록이 비어 언제 팔렸는지 모르는 감소량 / k: 구간 마지막 재고
  // x: 수동변경 의심 수량 / ev: 의심 목록 [[시간키, 수량, 이유]]
  function computeWindow(rec, start, end, flags) {
    flags = flags || {};
    const entries = Object.keys(rec)
      .map((k) => ({ t: k, dt: toDate(k), v: rec[k] }))
      .sort((a, b) => a.dt - b.dt);
    const before = entries.filter((e) => e.dt <= start).pop();
    const within = entries.filter((e) => e.dt > start && e.dt <= end);
    if (!within.length) return null;

    const baselineInside = before && before.dt.getTime() === start.getTime();
    const chain = baselineInside ? [before, ...within] : within;

    let s = 0;
    let x = 0;
    const ev = [];
    const take = (e, diff) => {
      const f = flags[e.t];
      if (f) { x += diff; ev.push([e.t, diff, f.why.join(', ')]); return true; }
      return false;
    };
    for (let i = 1; i < chain.length; i++) {
      const diff = chain[i - 1].v - chain[i].v;
      if (diff > 0 && !take(chain[i], diff)) s += diff;
    }
    let u = 0;
    let from = null;
    if (before && !baselineInside) {
      const diff = before.v - within[0].v;
      if (diff > 0 && !take(within[0], diff)) { u = diff; from = before.dt; }
    }
    return { s, u, k: within[within.length - 1].v, x, ev, base: !!before, from, to: within[0].dt };
  }

  // 마감이 끝난 날들의 일별 판매량 계산
  function computeFinishedDays(rec, now, flags) {
    const keys = Object.keys(rec).sort();
    if (!keys.length) return {};
    const out = {};
    const today = bizDayOf(now);
    const d = toDate(bizDayOf(toDate(keys[0])));
    for (let guard = 0; guard < 400; guard++) {
      const day = ymd(d);
      if (day >= today) break;
      const r = computeDay(rec, day, flags, now);
      if (r) out[day] = r;
      d.setDate(d.getDate() + 1);
    }
    return out;
  }

  // ---------------- 재고 데이터 읽기 ----------------
  function extractOptions(data) {
    const results = [];
    const list = data.optionCombinations || data.standardCombinations || [];

    list.forEach((o) => {
      if (o.stockQuantity != null) {
        const parts = Object.keys(o)
          .filter((k) => /^optionName\d+$/.test(k))
          .sort()
          .map((k) => o[k])
          .filter(Boolean);
        const name = parts.length ? parts.join(' / ') : String(o.id);
        results.push({ id: String(o.id), name, stock: o.stockQuantity });
      }
    });

    if (!results.length) {
      (data.simpleOptions || []).forEach((o) => {
        if (o.stockQuantity != null) {
          results.push({
            id: String(o.id || o.optionName1 || 'default'),
            name: o.optionName1 || o.name || '기본옵션',
            stock: o.stockQuantity,
          });
        }
      });
    }

    if (!results.length && data.stockQuantity != null) {
      results.push({ id: 'default', name: '기본', stock: data.stockQuantity });
    }

    return results;
  }

  function extractProductName(data) {
    return data.name || data.productName || document.title || `상품 ${productNo}`;
  }

  function extractStoreName(data) {
    return (data.channel && data.channel.channelName) || storeSlug;
  }

  // ---------------- 깃허브 읽기/쓰기 ----------------
  function ghRequest(method, path, body, accept) {
    // GET 은 브라우저 캐시 때문에 옛날 내용을 받는 일이 없도록 매번 다른 주소로 요청
    const bust = method === 'GET' ? `?t=${Date.now()}${Math.random().toString(36).slice(2, 6)}` : '';
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method,
        url: `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${path}${bust}`,
        headers: {
          Authorization: `token ${GITHUB_TOKEN}`,
          Accept: accept || 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache',
        },
        nocache: true,
        data: body ? JSON.stringify(body) : undefined,
        timeout: 180000, // 파일이 커서 넉넉히 3분
        onload: (res) => resolve(res),
        onerror: (err) => reject(err),
        ontimeout: () => reject(new Error('timeout')),
      });
    });
  }

  async function getJsonFile(path) {
    const res = await ghRequest('GET', path);
    if (res.status === 200) {
      const json = JSON.parse(res.responseText);
      let text;
      if (json.encoding === 'base64' && json.content) {
        text = decodeURIComponent(escape(atob(json.content.replace(/\n/g, ''))));
      } else {
        // 파일이 1MB를 넘으면 content 가 비어서 오므로 원본으로 다시 받기
        const raw = await ghRequest('GET', path, null, 'application/vnd.github.raw+json');
        if (raw.status !== 200) throw new Error(`GET raw ${path} 실패 status ${raw.status}`);
        text = raw.responseText;
      }
      return { content: JSON.parse(text), sha: json.sha };
    }
    if (res.status === 404) {
      return { content: {}, sha: null };
    }
    const err = new Error(`GET ${path} 실패 status ${res.status}`);
    err.status = res.status;
    throw err;
  }

  // 파일 크기를 줄이려고 줄바꿈/들여쓰기 없이 저장 (대시보드는 똑같이 읽음)
  function encodeContent(obj) {
    return btoa(unescape(encodeURIComponent(JSON.stringify(obj))));
  }

  // 일별 보관값에서 0이나 빈 목록은 빼고 저장 (latest.json 크기 줄이기)
  function compactDay(r) {
    const out = {};
    ['s', 'u', 'k', 'x', 'up'].forEach((f) => { if (r[f]) out[f] = r[f]; });
    if (r.k === 0) out.k = 0;
    if (r.ev && r.ev.length) out.ev = r.ev;
    if (r.upEv && r.upEv.length) out.upEv = r.upEv;
    if (r.t1) out.t1 = compactDay(r.t1);
    if (r.t2) out.t2 = compactDay(r.t2);
    return out;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // 여러 탭이 동시에 같은 파일을 고치면 충돌이 나므로 성공할 때까지 다시 읽고 다시 씀
  async function updateJsonFile(path, mutateFn, message) {
    const MAX_ATTEMPTS = 20;
    let lastError = '';
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        const { content, sha } = await getJsonFile(path);
        const updated = mutateFn(content);
        const res = await ghRequest('PUT', path, {
          message,
          content: encodeContent(updated),
          sha: sha || undefined,
        });
        if (res.status === 200 || res.status === 201) return;
        lastError = `status ${res.status} ${String(res.responseText).slice(0, 200)}`;
        // 토큰 문제는 재시도해도 소용없음
        if (res.status === 401 || res.status === 403) throw new Error(`PUT ${path} 권한 오류 ${lastError}`);
      } catch (e) {
        if (String(e.message || '').includes('권한 오류')) throw e;
        if (e.status === 401 || e.status === 403) throw e;
        lastError = e.message || String(e);
      }
      console.log(`[판매량추적] ${path} 저장 재시도 ${attempt + 1} (${lastError})`);
      await sleep(Math.min(6000, 500 * 2 ** attempt) + Math.random() * 1500);
    }
    throw new Error(`PUT ${path} 재시도 초과 (${lastError})`);
  }

  // ---------------- 메인 처리 ----------------
  // ---------------- 여러 상품을 한 번에 깃허브에 올리기 ----------------
  // entry = { channelId, productNo, storeName, productName, nowKey, today, options: [{id, name, stock}] }
  async function uploadEntries(entries) {
    if (!entries.length) return;
    const now = new Date();
    const cutoff = new Date(now);
    cutoff.setDate(cutoff.getDate() - HISTORY_KEEP_DAYS);
    const cutoffStr = ymd(cutoff);
    const dailyMap = {};
    const keyOf = (en, opt) => `${en.channelId}_${en.productNo}_${opt.id}`;
    const label = entries.length === 1 ? entries[0].storeName : `${entries.length}개 상품`;
    const stamp = entries[0].nowKey;

    await updateJsonFile(
      'data/history.json',
      (history) => {
        entries.forEach((en) => en.options.forEach((opt) => {
          const key = keyOf(en, opt);
          const rec = history[key] || {};
          rec[en.nowKey] = opt.stock;
          history[key] = rec;
        }));
        // 새 기록까지 넣은 상태에서 수동변경 의심 구간 찾기
        const flags = detectSuspicious(history);
        entries.forEach((en) => en.options.forEach((opt) => {
          const key = keyOf(en, opt);
          const rec = history[key];
          // 오래된 기록을 지우기 전에 일별 판매량부터 계산해 둠
          dailyMap[key] = computeFinishedDays(rec, now, flags[key] || {});
          Object.keys(rec).forEach((t) => { if (t < cutoffStr) delete rec[t]; });
        }));
        return history;
      },
      `판매량 업데이트 ${label} ${stamp}`
    );

    await updateJsonFile(
      'data/latest.json',
      (latest) => {
        entries.forEach((en) => en.options.forEach((opt) => {
          const key = keyOf(en, opt);
          const old = latest[key] || {};
          const daily = Object.assign({}, old.daily || {});
          Object.entries(dailyMap[key] || {}).forEach(([day, r]) => {
            // 기준 기록이 남아 있는 날은 새로 계산한 값으로, 아니면 기존 보관값 유지
            if (r.base || !daily[day] || !daily[day].t1) daily[day] = compactDay(r);
          });
          latest[key] = {
            store: en.storeName,
            product: en.productNo,
            productName: en.productName,
            optionName: opt.name,
            date: en.today,
            stock: opt.stock,
            daily,
          };
        }));
        return latest;
      },
      `판매량 업데이트 ${label} ${stamp.slice(0, 10)}`
    );
  }

  // ---------------- 상품 페이지 처리 ----------------
  async function handleStockData(channelId, data) {
    if (handled) return;
    const options = extractOptions(data);
    if (!options.length) {
      console.log('[판매량추적] 옵션 정보를 찾지 못함');
      return;
    }
    handled = true;
    try { sessionStorage.removeItem('autotrack_retry'); } catch (e) { /* 무시 */ }

    if (document.readyState === 'loading') {
      await new Promise((r) => document.addEventListener('DOMContentLoaded', r));
    }

    const now = new Date();
    const today = ymd(now);
    const entry = {
      channelId,
      productNo,
      storeName: extractStoreName(data),
      productName: extractProductName(data),
      nowKey: `${today}T${pad(now.getHours())}:00`,
      today,
      options,
    };

    if (autoMode) {
      // 자동조회 탭: 깃허브에 바로 안 올리고 탬퍼몽키 저장소에만 넣고 바로 닫음
      // 모든 탭이 끝나면 bat이 여는 정리용 페이지(#flush)가 한꺼번에 올림 → 탭이 서로 기다리지 않음
      GM_setValue(`pending_${productNo}_${entry.nowKey}`, entry);
      console.log(`[판매량추적] ${entry.storeName} 저장 대기열에 넣음 - 옵션 ${options.length}개`);
      finished = true;
      closeAutoTab();
      return;
    }

    // 직접 연 탭은 예전처럼 바로 올림
    try {
      await uploadEntries([entry]);
      console.log(`[판매량추적] ${entry.storeName} / ${entry.productName} 완료 - 옵션 ${options.length}개`);
    } catch (e) {
      console.log('[판매량추적] 깃허브 업로드 실패', e);
    }
    finished = true;
  }

  // ---------------- 정리용 페이지: 대기열에 쌓인 상품을 한꺼번에 깃허브에 올림 ----------------
  const pendingKeys = () => GM_listValues().filter((k) => k.startsWith('pending_'));

  async function flushPending() {
    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;top:12px;right:12px;z-index:99999;background:#111;color:#fff;padding:12px 16px;border-radius:8px;font:14px sans-serif;';
    const say = (t) => { box.textContent = '[판매량추적] ' + t; console.log('[판매량추적] ' + t); };
    const attach = () => document.body && !box.parentNode && document.body.appendChild(box);
    if (document.readyState === 'loading') await new Promise((r) => document.addEventListener('DOMContentLoaded', r));
    attach();

    // 늦게 끝난 탭도 기다림: 20초 동안 새로 들어온 게 없으면 시작 (최대 4분)
    let last = -1;
    let stableSince = Date.now();
    const startAt = Date.now();
    while (Date.now() - startAt < 240000) {
      const n = pendingKeys().length;
      if (n !== last) { last = n; stableSince = Date.now(); }
      say(`조회 결과 모으는 중... ${n}개 상품`);
      if (Date.now() - stableSince > 20000) break;
      await sleep(2000);
    }

    const keys = pendingKeys();
    const entries = keys.map((k) => GM_getValue(k)).filter(Boolean);
    if (!entries.length) {
      say('올릴 결과 없음');
    } else {
      say(`${entries.length}개 상품을 깃허브에 올리는 중...`);
      let ok = false;
      for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
        try {
          await uploadEntries(entries);
          ok = true;
        } catch (e) {
          say(`업로드 실패 ${attempt}/3: ${(e && e.message) || e}`);
          if (attempt < 3) await sleep(30000);
        }
      }
      if (ok) {
        keys.forEach((k) => GM_deleteValue(k));
        say(`${entries.length}개 상품 업로드 완료`);
      } else {
        // 실패하면 결과는 지우지 않고 남겨둠 → 다음 정각 조회 때 같이 올라감. 확인할 수 있게 창을 10분 열어둠
        box.style.background = '#b91c1c';
        say('업로드 실패. 결과는 보관해 두었다가 다음 조회 때 다시 올려요. 이 화면을 캡처해서 보내주세요.');
        setTimeout(() => window.close(), 600000);
        return;
      }
    }
    setTimeout(() => window.close(), 5000);
  }

  // ---------------- 대시보드 연결 (판매 인정 내역을 깃허브 data/approved.json 에 저장) ----------------
  if (isDashboard && window.location.hash === '#flush') {
    flushPending();
    return;
  }

  if (isDashboard) {
    const reply = (msg) => window.postMessage(Object.assign({ from: 'cs-tracker' }, msg), '*');
    window.addEventListener('message', async (ev) => {
      const m = ev.data;
      if (!m || m.from !== 'cs-dashboard') return;
      if (m.type === 'ping') { reply({ type: 'pong', token: GITHUB_TOKEN }); return; }
      if (m.type === 'saveCategories') {
        try {
          const changes = m.changes || {};
          let result = {};
          await updateJsonFile(
            'data/categories.json',
            (obj) => { result = Object.assign(obj, changes); return result; },
            '업체 분류 변경'
          );
          reply({ type: 'categoriesSaved', ok: true, categories: result });
        } catch (e) {
          reply({ type: 'categoriesSaved', ok: false, error: String((e && e.message) || e) });
        }
        return;
      }
      if (m.type === 'approve') {
        try {
          let result = {};
          const ids = m.ids || [];
          await updateJsonFile(
            'data/approved.json',
            (obj) => {
              ids.forEach((id) => {
                if (m.on) obj[id] = ymd(new Date());
                else delete obj[id];
              });
              result = obj;
              return obj;
            },
            `판매 인정 ${m.on ? '추가' : '취소'} ${ids.length}건`
          );
          reply({ type: 'approved', ok: true, approved: result });
        } catch (e) {
          reply({ type: 'approved', ok: false, error: String((e && e.message) || e) });
        }
      }
    });
    reply({ type: 'pong' });
    return;
  }

  const originalFetch = window.fetch;
  window.fetch = function (...args) {
    const req = args[0];
    const url = typeof req === 'string' ? req : req && req.url;
    const promise = originalFetch.apply(this, args);
    if (url && API_PATTERN.test(url)) {
      promise
        .then((res) => res.clone().json())
        .then((data) => {
          const m = url.match(API_PATTERN);
          handleStockData(m[1], data);
        })
        .catch(() => {});
    }
    return promise;
  };

  const OrigXHR = window.XMLHttpRequest;
  const origOpen = OrigXHR.prototype.open;
  const origSend = OrigXHR.prototype.send;
  OrigXHR.prototype.open = function (method, url, ...rest) {
    this._trackedUrl = url;
    return origOpen.call(this, method, url, ...rest);
  };
  OrigXHR.prototype.send = function (...args) {
    this.addEventListener('load', function () {
      if (this._trackedUrl && API_PATTERN.test(this._trackedUrl)) {
        try {
          const data = JSON.parse(this.responseText);
          const m = this._trackedUrl.match(API_PATTERN);
          handleStockData(m[1], data);
        } catch (e) {
          /* ignore */
        }
      }
    });
    return origSend.apply(this, args);
  };
})();
