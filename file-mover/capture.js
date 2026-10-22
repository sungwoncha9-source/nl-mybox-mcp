'use strict';
// 화면 캡처 모듈 (file-mover v1.3~1.5). Windows PowerShell(System.Drawing)로 찍는다. 별도 설치 없음.
// 이 파일에서 계산하는 부분(영역 계산)은 순수 함수라 어느 PC에서나 시험된다. 실제 캡처(runPs)만 Windows에서 돈다.
const fs = require('fs'), path = require('path');
const { spawn } = require('child_process');

const SCRIPT_PATH = path.join(__dirname, 'capture.ps1');

// mode: 'info' | 'shot' | 'win_list' | 'win_shot'. env: CAP_* 값들. 돌려주는 값: 마지막 줄의 JSON
function runPs(mode, extraEnv, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'win32' && !process.env.MOVER_POWERSHELL) return reject(new Error('화면 캡처는 Windows에서만 됩니다'));
    let script;
    try { script = fs.readFileSync(SCRIPT_PATH, 'utf8'); } catch (e) { return reject(new Error('capture.ps1을 읽지 못했습니다: ' + e.message)); }
    const enc = Buffer.from(script, 'utf16le').toString('base64');
    const exe = process.env.MOVER_POWERSHELL || 'powershell.exe';
    const p = spawn(exe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc],
      { env: { ...process.env, ...extraEnv, CAP_MODE: mode }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '', done = false;
    const t = setTimeout(() => { if (!done) { done = true; try { p.kill(); } catch {} reject(new Error('화면 캡처가 ' + timeoutMs / 1000 + '초 안에 끝나지 않았습니다')); } }, timeoutMs);
    p.stdout.setEncoding('utf8'); p.stdout.on('data', d => out += d);
    p.stderr.on('data', d => err += d);
    p.on('error', e => { if (!done) { done = true; clearTimeout(t); reject(new Error('PowerShell을 실행하지 못했습니다: ' + e.message)); } });
    p.on('close', code => {
      if (done) return; done = true; clearTimeout(t);
      const line = out.trim().split(/\r?\n/).filter(Boolean).pop() || '';
      if (code !== 0) return reject(new Error('화면 캡처 실패(코드 ' + code + '): ' + (cleanErr(err) || line).slice(0, 400) + ' — 화면이 잠겨 있거나 꺼져 있으면 찍을 수 없습니다'));
      try { resolve(JSON.parse(line)); } catch { reject(new Error('화면 캡처 결과를 읽지 못했습니다: ' + line.slice(0, 200))); }
    });
  });
}

// PowerShell은 오류를 "#< CLIXML <Objs><S S="Error">…</S></Objs>" 꼴로 stderr에 낸다. 그 안의 오류 글자만 꺼낸다.
function cleanErr(err) {
  if (!/#< CLIXML/.test(err)) return err.trim();
  const msgs = [...err.matchAll(/<S S="Error">([\s\S]*?)<\/S>/g)].map(m => m[1].replace(/_x000D__x000A_/g, ' ').replace(/_x[0-9A-Fa-f]{4}_/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&').trim()).filter(Boolean);
  const rest = err.replace(/#< CLIXML\r?\n?/, '').replace(/<Objs[\s\S]*?<\/Objs>/g, '').trim();
  return (msgs.join(' ') + ' ' + rest).trim();
}

const toArr = v => Array.isArray(v) ? v : (v ? [v] : []);

// info: {virtual:{x,y,w,h}, displays:[{index,x,y,w,h,primary}]}, a: {display, region:{x,y,w,h,units}}
// region 좌표는 고른 화면(display) 왼쪽 위를 0으로 본다. units 기본은 비율(0~1).
function planRegion(info, a) {
  const displays = toArr(info.displays);
  let area, label;
  const d = a.display === undefined || a.display === null || a.display === '' ? 'all' : a.display;
  if (d === 'all') { area = info.virtual; label = 'all'; }
  else {
    const n = Number(d);
    area = displays.find(s => s.index === n);
    if (!Number.isInteger(n) || !area) throw new Error('없는 모니터 번호입니다: ' + d + ' (있는 번호: ' + displays.map(s => s.index).join(', ') + ')');
    label = String(n);
  }
  if (!area || !(area.w > 0) || !(area.h > 0)) throw new Error('화면 크기를 알 수 없습니다');
  let x = area.x, y = area.y, w = area.w, h = area.h;
  if (a.region !== undefined) {
    const r = a.region;
    if (!r || typeof r !== 'object') throw new Error('region은 {x,y,w,h} 여야 합니다');
    const px = r.units === 'px';
    const g = (v, k) => { const n = Number(v); if (v === undefined || v === null || v === '' || !Number.isFinite(n)) throw new Error('region.' + k + ' 값이 숫자가 아닙니다'); return n; };
    const rx = g(r.x, 'x'), ry = g(r.y, 'y'), rw = g(r.w, 'w'), rh = g(r.h, 'h');
    if (rw <= 0 || rh <= 0) throw new Error('region의 w, h는 0보다 커야 합니다');
    const fx = px ? rx : rx * area.w, fy = px ? ry : ry * area.h, fw = px ? rw : rw * area.w, fh = px ? rh : rh * area.h;
    const x0 = Math.max(0, Math.round(fx)), y0 = Math.max(0, Math.round(fy));
    const x1 = Math.min(area.w, Math.round(fx + fw)), y1 = Math.min(area.h, Math.round(fy + fh));
    if (x1 - x0 < 1 || y1 - y0 < 1) throw new Error('region이 화면 밖입니다');
    x = area.x + x0; y = area.y + y0; w = x1 - x0; h = y1 - y0;
  }
  return { x, y, w, h, display: label, area: { x: area.x, y: area.y, w: area.w, h: area.h } };
}

// ---------- 창 지정 캡처 (v1.5) ----------
// 오류는 "[코드] 설명" 꼴. 코드: window_spec, window_not_found, window_ambiguous, window_minimized, window_cloaked,
// window_empty, window_blank, window_gone, region_outside
function werr(code, msg, extra) { return Object.assign(new Error('[' + code + '] ' + msg), { code, ...(extra || {}) }); }
const clip = (s, n) => { s = String(s || ''); const a = Array.from(s); return a.length > n ? a.slice(0, n - 1).join('') + '…' : s; };
const normProc = s => String(s || '').trim().toLowerCase().replace(/\.exe$/, '');

// 창 지정 인자 검사. 틀리면 찍기 전에 오류.
function checkWindowSpec(w) {
  if (!w || typeof w !== 'object' || Array.isArray(w)) throw werr('window_spec', 'window는 {title 또는 process, ...} 여야 합니다');
  const has = v => typeof v === 'string' && v.trim() !== '';
  if (!has(w.title) && !has(w.process)) throw werr('window_spec', 'window에는 title(창 제목 일부) 또는 process(프로그램 이름) 중 하나가 필요합니다');
  if (w.title !== undefined && typeof w.title !== 'string') throw werr('window_spec', 'window.title은 글자여야 합니다');
  if (w.process !== undefined && typeof w.process !== 'string') throw werr('window_spec', 'window.process는 글자여야 합니다');
  if (w.match !== undefined && !['contains', 'exact'].includes(w.match)) throw werr('window_spec', 'window.match는 contains 또는 exact 입니다');
  if (w.pick !== undefined && !['error', 'topmost', 'largest'].includes(w.pick)) throw werr('window_spec', 'window.pick은 error, topmost, largest 중 하나입니다');
  if (w.index !== undefined && !(Number.isInteger(w.index) && w.index >= 1)) throw werr('window_spec', 'window.index는 1 이상의 정수입니다');
  if (w.method !== undefined && !['auto', 'print', 'screen'].includes(w.method)) throw werr('window_spec', 'window.method는 auto, print, screen 중 하나입니다');
  for (const k of ['restore', 'restore_back', 'activate', 'client_only']) if (w[k] !== undefined && typeof w[k] !== 'boolean') throw werr('window_spec', 'window.' + k + '는 true/false 입니다');
  if (w.settle_ms !== undefined && !(Number.isInteger(w.settle_ms) && w.settle_ms >= 0 && w.settle_ms <= 5000)) throw werr('window_spec', 'window.settle_ms는 0~5000 입니다');
  return w;
}

// 목록(앞에 있는 창부터)에서 조건에 맞는 창 하나를 고른다. 못 찾거나 여럿이면 코드 달린 오류.
function planWindow(list, w) {
  checkWindowSpec(w);
  list = toArr(list);
  const exact = w.match === 'exact';
  const t = (w.title || '').trim().toLowerCase(), p = normProc(w.process);
  let m = list.filter(x => {
    if (t) { const xt = String(x.title || '').toLowerCase(); if (exact ? xt !== t : !xt.includes(t)) return false; }
    if (p && normProc(x.process) !== p) return false;
    return true;
  });
  // 다른 가상 데스크톱의 창이 섞여 있으면 보이는 쪽을 우선(없으면 그대로 두어 window_cloaked 로 알림)
  if (m.some(x => !x.cloaked)) m = m.filter(x => !x.cloaked);
  if (!m.length) throw werr('window_not_found', '조건에 맞는 창이 없습니다. info_only:true 와 windows:true 로 지금 열린 창 목록을 확인하세요', { count: 0 });
  const cand = m.map((x, i) => ({ index: i + 1, title: clip(x.title, 80), process: x.process, w: x.w, h: x.h, minimized: !!x.minimized }));
  let pick;
  if (w.index !== undefined) {
    if (w.index > m.length) throw werr('window_not_found', 'index ' + w.index + ' 가 없습니다(일치하는 창 ' + m.length + '개)', { count: m.length, candidates: cand });
    pick = m[w.index - 1];
  } else if (m.length === 1 || w.pick === 'topmost') pick = m[0];
  else if (w.pick === 'largest') pick = m.reduce((a, b) => (b.w * b.h > a.w * a.h ? b : a));
  else throw werr('window_ambiguous', '조건에 맞는 창이 ' + m.length + '개입니다. window.index(1~' + m.length + ') 또는 window.pick(topmost|largest)으로 하나를 고르세요. 후보: ' +
    cand.slice(0, 10).map(c => c.index + ') ' + c.process + ' "' + c.title + '" ' + c.w + 'x' + c.h + (c.minimized ? ' 최소화' : '')).join(' | '), { count: m.length, candidates: cand.slice(0, 10) });
  if (pick.cloaked) throw werr('window_cloaked', '그 창은 다른 가상 데스크톱에 있어 찍을 수 없습니다. 해당 데스크톱으로 옮겨 오거나 그곳으로 전환하세요');
  if (pick.minimized && w.restore !== true) throw werr('window_minimized', '그 창은 최소화되어 있습니다. window.restore:true 를 주면 잠깐 펼쳐 찍고 다시 최소화합니다(restore_back:false면 펼친 채로 둠)');
  return { win: pick, matched: m.length };
}

// 창 안 영역 검사 → PowerShell 에 넘길 환경변수. region 없으면 {}.
function planWindowRegion(region) {
  if (region === undefined) return {};
  if (!region || typeof region !== 'object') throw new Error('region은 {x,y,w,h} 여야 합니다');
  const g = (v, k) => { const n = Number(v); if (v === undefined || v === null || v === '' || !Number.isFinite(n)) throw new Error('region.' + k + ' 값이 숫자가 아닙니다'); return n; };
  const rx = g(region.x, 'x'), ry = g(region.y, 'y'), rw = g(region.w, 'w'), rh = g(region.h, 'h');
  if (rw <= 0 || rh <= 0) throw new Error('region의 w, h는 0보다 커야 합니다');
  return { CAP_RX: String(rx), CAP_RY: String(ry), CAP_RW: String(rw), CAP_RH: String(rh), CAP_RUNITS: region.units === 'px' ? 'px' : 'ratio' };
}

// 목록 응답용(제목 포함) — windows:true 일 때만 쓴다
function windowsForReport(list) {
  return toArr(list).map((x, i) => ({ n: i + 1, title: clip(x.title, 80), process: x.process, pid: x.pid, x: x.x, y: x.y, w: x.w, h: x.h,
    minimized: !!x.minimized, cloaked: !!x.cloaked, foreground: !!x.foreground }));
}

// PowerShell 이 돌려준 {ok:false, code, message} 를 코드 달린 오류로
function psFail(r) { return werr(r.code || 'window_failed', r.message || '창 캡처 실패', r.area_w ? { area: { w: r.area_w, h: r.area_h } } : {}); }

module.exports = { runPs, planRegion, toArr, cleanErr, SCRIPT_PATH, werr, checkWindowSpec, planWindow, planWindowRegion, windowsForReport, psFail };
