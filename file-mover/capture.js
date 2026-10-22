'use strict';
// 화면 캡처 모듈 (file-mover v1.3). Windows PowerShell(System.Drawing)로 찍는다. 별도 설치 없음.
// 이 파일에서 계산하는 부분(영역 계산)은 순수 함수라 어느 PC에서나 시험된다. 실제 캡처(runPs)만 Windows에서 돈다.
const fs = require('fs'), path = require('path');
const { spawn } = require('child_process');

const SCRIPT_PATH = path.join(__dirname, 'capture.ps1');

// mode: 'info' | 'shot'. env: CAP_* 값들. 돌려주는 값: 마지막 줄의 JSON
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
    p.stdout.on('data', d => out += d);
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

module.exports = { runPs, planRegion, toArr, cleanErr, SCRIPT_PATH };
