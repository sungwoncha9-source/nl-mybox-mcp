#!/usr/bin/env node
'use strict';
// 노드랩 파일 이동기 MCP v1.5 — PC에서 실행. 도구 7개: file_stat, send_file, receive_file, delete_path, receive_bytes, capture_screen, annotate_image
// 변경점(v1.4 대비): capture_screen에 window(창 제목·프로그램 이름으로 창 하나만 찍기, 가려진 창은 PrintWindow, 최소화는 restore일 때만 복원)와 info_only+windows(열린 창 목록) 추가. 기존 동작 그대로.
// 변경점(v1.3 대비): annotate_image에 panel(코멘트란) 추가 — 캔버스를 넓혀 제목·번호 코멘트를 적음. number 번호 자동 매김 보정. 나머지 동작 그대로.
// 변경점(v1.2 대비): capture_screen(PC 화면을 PNG 파일로, 기본 꺼짐 MOVER_ENABLE_CAPTURE=1), annotate_image(그림·글자 얹기, 자르기). 나머지 5개 도구는 동작 그대로.
// 변경점(v1.1 대비): receive_bytes 추가(화면이 보낸 파일 바이트를 허용 폴더에 씀, 나눠 보내기·sha256 확인 지원). 나머지 4개 도구는 동작 그대로.
// 변경점(v1.0 대비, v1.1): delete_path 추가(기본은 휴지통 폴더로 이동, permanent:true일 때만 영구 삭제).
// 의존성 없음(Node 18+). 클로드는 "주소(URL)와 PC 경로"만 말하고, 파일 바이트는 이 프로그램이 직접 옮긴다.
const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;
const net = require('net');
const crypto = require('crypto');

const VERSION = '1.5.0';
const DEFAULT_HOSTS = ['figma.com', 'figma-alpha-api.s3.us-west-2.amazonaws.com', 'amazonaws.com',
  'adobe.io', 'adobe.com', 'adobelogin.com', 'cloudfront.net', 'behance.net'];

const TRASH_NAME = '_trash';

function makeConfig(env = process.env) {
  const dirs = (env.MOVER_ALLOWED_DIRS || (process.platform === 'win32' ? 'D:\\nodelab_work' : process.cwd()))
    .split(path.delimiter === ';' ? ';' : /[;:]/).map(s => s.trim()).filter(Boolean);
  const realDirs = dirs.map(d => { try { return fs.realpathSync(d); } catch { return path.resolve(d); } });
  // 보호 경로: 감시 프로그램(agent)과 이동기 자신(file-mover)은 지우지 못한다. 추가는 MOVER_PROTECTED(;구분, 허용 폴더 기준 상대 또는 절대경로)
  const extra = (env.MOVER_PROTECTED || '').split(';').map(s => s.trim()).filter(Boolean);
  const prot = [];
  for (const d of realDirs) {
    prot.push(path.join(d, 'agent'), path.join(d, 'file-mover'), path.join(d, TRASH_NAME));
    for (const e of extra) prot.push(path.isAbsolute(e) ? path.resolve(e) : path.join(d, e));
  }
  return {
    dirs: realDirs,
    protectedPaths: prot,
    hosts: (env.MOVER_ALLOWED_HOSTS ? env.MOVER_ALLOWED_HOSTS.split(',') : DEFAULT_HOSTS).map(s => s.trim().toLowerCase()).filter(Boolean),
    maxBytes: Number(env.MOVER_MAX_BYTES || 104857600), // 100MB
    allowHttp: env.MOVER_ALLOW_HTTP === '1',       // 시험용
    allowPrivate: env.MOVER_ALLOW_PRIVATE === '1', // 시험용
    timeoutMs: Number(env.MOVER_TIMEOUT_MS || 120000),
    captureEnabled: env.MOVER_ENABLE_CAPTURE === '1', // 화면 캡처는 기본 꺼짐(화면에 보이는 모든 것이 찍히므로)
  };
}

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.psd': 'image/vnd.adobe.photoshop', '.mp4': 'video/mp4',
  '.json': 'application/json', '.txt': 'text/plain', '.html': 'text/html' };
const EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'image/svg+xml': '.svg', 'application/pdf': '.pdf' };

const redact = u => { try { const x = new URL(u); return x.host + x.pathname; } catch { return '(bad url)'; } }; // 쿼리(토큰) 제외
const log = (...a) => process.stderr.write('[file-mover] ' + a.join(' ') + '\n');

// ---------- 경로 안전 ----------
const norm = p => process.platform === 'win32' ? p.toLowerCase() : p;
function realOfExistingAncestor(p) {
  let cur = path.resolve(p); const rest = [];
  while (!fs.existsSync(cur)) { rest.unshift(path.basename(cur)); const up = path.dirname(cur); if (up === cur) break; cur = up; }
  return path.join(fs.realpathSync(cur), ...rest);
}
function insideAllowed(p, cfg) {
  const real = realOfExistingAncestor(p);
  const ok = cfg.dirs.some(d => { const a = norm(real), b = norm(d); return a === b || a.startsWith(b + path.sep); });
  if (!ok) throw new Error('허용 폴더 밖입니다: ' + p + ' (허용: ' + cfg.dirs.join(', ') + ')');
  return real;
}
function sanitizeName(n) {
  n = String(n || '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/^\.+/, '').trim().slice(0, 150);
  return n || 'download';
}

// ---------- 주소 안전 ----------
const hostOk = (h, cfg) => cfg.hosts.some(p => h === p || h.endsWith('.' + p));
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) { const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168); }
  const l = ip.toLowerCase();
  return l === '::1' || l === '::' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80') || l.startsWith('::ffff:127.') || l.startsWith('::ffff:10.') || l.startsWith('::ffff:192.168.');
}
async function checkUrl(s, cfg) {
  let u; try { u = new URL(s); } catch { throw new Error('주소 형식이 틀립니다'); }
  if (!(u.protocol === 'https:' || (cfg.allowHttp && u.protocol === 'http:'))) throw new Error('https 주소만 허용됩니다');
  const h = u.hostname.toLowerCase();
  if (!hostOk(h, cfg)) throw new Error('허용 목록에 없는 사이트입니다: ' + h);
  if (!cfg.allowPrivate) {
    const ips = net.isIP(h) ? [h] : (await dns.lookup(h, { all: true })).map(r => r.address);
    if (ips.some(isPrivateIp)) throw new Error('내부망 주소는 차단됩니다: ' + h);
  }
  return u;
}
async function fetchChecked(urlStr, init, cfg) {
  let url = urlStr, method = init.method;
  for (let hop = 0; hop < 6; hop++) {
    const u = await checkUrl(url, cfg);
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), cfg.timeoutMs);
    let res;
    try { res = await fetch(u, { ...init, method, redirect: 'manual', signal: ctl.signal }); }
    finally { clearTimeout(t); }
    if ([301, 302, 303, 307, 308].includes(res.status) && res.headers.get('location')) {
      if (method !== 'GET' && ![307, 308].includes(res.status)) throw new Error('업로드 응답이 리다이렉트(' + res.status + ')라 중단');
      url = new URL(res.headers.get('location'), u).toString();
      try { await res.body?.cancel(); } catch {}
      continue;
    }
    return res;
  }
  throw new Error('리다이렉트가 너무 많습니다');
}

// ---------- 도구 ----------
async function fileStat({ path: p }, cfg) {
  const real = insideAllowed(p, cfg);
  const st = fs.statSync(real);
  if (!st.isFile()) throw new Error('파일이 아닙니다');
  return { path: real, size: st.size, mime: MIME[path.extname(real).toLowerCase()] || 'application/octet-stream', modified: st.mtime.toISOString() };
}

async function sendFile(a, cfg) {
  const real = insideAllowed(a.path, cfg);
  const st = fs.statSync(real);
  if (!st.isFile()) throw new Error('파일이 아닙니다');
  const offset = Number(a.offset || 0);
  const length = a.length === undefined ? st.size - offset : Number(a.length);
  if (!(offset >= 0 && length > 0 && offset + length <= st.size)) throw new Error('offset/length 범위가 파일 크기를 벗어납니다');
  if (length > cfg.maxBytes) throw new Error('크기 한도 초과: ' + length + ' > ' + cfg.maxBytes);
  const buf = Buffer.alloc(length);
  const fd = fs.openSync(real, 'r'); try { fs.readSync(fd, buf, 0, length, offset); } finally { fs.closeSync(fd); }
  const ctype = a.content_type || MIME[path.extname(real).toLowerCase()] || 'application/octet-stream';
  const mode = a.mode || 'multipart';
  const method = (a.method || (mode === 'raw' ? 'PUT' : 'POST')).toUpperCase();
  if (!['PUT', 'POST'].includes(method)) throw new Error('method는 PUT/POST만');
  const headers = {};
  for (const [k, v] of Object.entries(a.headers || {})) { // 서명 URL용 보조 헤더만 허용, 인증 헤더 금지
    if (/^(content-type|content-md5|x-[a-z0-9-]+)$/i.test(k)) headers[k] = String(v);
    else throw new Error('허용되지 않는 헤더: ' + k);
  }
  let body;
  if (mode === 'multipart') {
    const fd2 = new FormData();
    fd2.append(a.field || 'file', new Blob([buf], { type: ctype }), sanitizeName(path.basename(real)));
    body = fd2;
  } else if (mode === 'raw') { body = buf; if (!Object.keys(headers).some(k => k.toLowerCase() === 'content-type')) headers['Content-Type'] = ctype; }
  else throw new Error('mode는 multipart 또는 raw');
  log('send', mode, method, redact(a.url), length + 'B');
  const res = await fetchChecked(a.url, { method, body, headers }, cfg);
  const text = (await res.text()).slice(0, 2000);
  return { ok: res.ok, status: res.status, bytes_sent: length, etag: res.headers.get('etag'), response: text };
}

async function receiveFile(a, cfg) {
  const dir = insideAllowed(a.dest_dir, cfg);
  fs.mkdirSync(dir, { recursive: true });
  const max = Math.min(Number(a.max_bytes || cfg.maxBytes), cfg.maxBytes);
  log('receive', redact(a.url));
  const res = await fetchChecked(a.url, { method: 'GET' }, cfg);
  if (!res.ok) throw new Error('내려받기 실패: HTTP ' + res.status);
  const ctype = (res.headers.get('content-type') || '').split(';')[0].trim();
  let name = a.filename;
  if (!name) { const cd = res.headers.get('content-disposition') || '';
    const m = /filename\*=UTF-8''([^;]+)/i.exec(cd) || /filename="?([^";]+)"?/i.exec(cd);
    if (m) { try { name = decodeURIComponent(m[1]); } catch { name = m[1]; } }
    else { try { name = decodeURIComponent(path.basename(new URL(a.url).pathname)); } catch { name = ''; } } }
  name = sanitizeName(name);
  if (!path.extname(name) && EXT[ctype]) name += EXT[ctype];
  let target = path.join(dir, name);
  if (!a.overwrite) { const ext = path.extname(name), base = path.basename(name, ext); let i = 1;
    while (fs.existsSync(target)) target = path.join(dir, base + '_' + (i++) + ext); }
  insideAllowed(target, cfg);
  const part = target + '.part'; const out = fs.openSync(part, 'w'); let n = 0;
  try {
    for await (const chunk of res.body) { n += chunk.length; if (n > max) throw new Error('크기 한도 초과(' + max + 'B)'); fs.writeSync(out, chunk); }
    fs.closeSync(out); fs.renameSync(part, target);
  } catch (e) { try { fs.closeSync(out); } catch {} try { fs.unlinkSync(part); } catch {} throw e; }
  return { saved_path: target, bytes: n, content_type: ctype };
}

// ---------- 삭제 (v1.1 추가) ----------
const stamp = () => { const d = new Date(), z = n => String(n).padStart(2, '0');
  return d.getFullYear() + z(d.getMonth() + 1) + z(d.getDate()) + '-' + z(d.getHours()) + z(d.getMinutes()) + z(d.getSeconds()); };
function rootOf(real, cfg) { return cfg.dirs.find(d => { const a = norm(real), b = norm(d); return a === b || a.startsWith(b + path.sep); }); }
function dirSize(p) { let n = 0; for (const e of fs.readdirSync(p, { withFileTypes: true })) { const q = path.join(p, e.name);
  try { n += e.isDirectory() ? dirSize(q) : fs.lstatSync(q).size; } catch {} } return n; }
function countEntries(p) { let n = 0; for (const e of fs.readdirSync(p, { withFileTypes: true })) { n++; if (e.isDirectory()) n += countEntries(path.join(p, e.name)); } return n; }

async function deletePath(a, cfg) {
  if (!a || !a.path) throw new Error('path가 필요합니다');
  const real = insideAllowed(a.path, cfg);
  const root = rootOf(real, cfg);
  if (norm(real) === norm(root)) throw new Error('허용 루트 폴더 자체는 지울 수 없습니다: ' + real);
  for (const p of cfg.protectedPaths) {
    const r = norm(real), q = norm(p);
    const isTrash = path.basename(p) === TRASH_NAME;
    if (r === q) throw new Error('보호된 경로입니다: ' + p);
    if (r.startsWith(q + path.sep) && !isTrash) throw new Error('보호된 경로 안입니다: ' + p); // 휴지통 안의 항목은 지울 수 있다
    if (q.startsWith(r + path.sep)) throw new Error('보호된 경로를 포함하고 있어 지울 수 없습니다: ' + p);
  }
  if (!fs.existsSync(real)) throw new Error('없는 경로입니다: ' + real);
  const st = fs.lstatSync(real);
  const isDir = st.isDirectory();
  const recurse = a.recurse === true;
  if (isDir && !recurse && fs.readdirSync(real).length > 0) throw new Error('비어 있지 않은 폴더입니다. 폴더째 지우려면 recurse:true가 필요합니다');
  const trashDir = path.join(root, TRASH_NAME);
  const inTrash = norm(real).startsWith(norm(trashDir) + path.sep);
  const permanent = a.permanent === true || inTrash; // 휴지통 안의 것은 다시 휴지통으로 보낼 수 없으므로 영구 삭제
  const info = { kind: isDir ? 'folder' : 'file', from: real, bytes: isDir ? dirSize(real) : st.size, entries: isDir ? countEntries(real) : undefined };
  fs.mkdirSync(trashDir, { recursive: true });
  let result;
  if (permanent) {
    fs.rmSync(real, { recursive: isDir, force: false });
    result = { action: 'deleted', ...info };
  } else {
    let to = path.join(trashDir, stamp() + '_' + sanitizeName(path.basename(real))), i = 1;
    while (fs.existsSync(to)) to = path.join(trashDir, stamp() + '_' + (i++) + '_' + sanitizeName(path.basename(real)));
    fs.renameSync(real, to);
    result = { action: 'trashed', ...info, to };
  }
  if (fs.existsSync(real)) throw new Error('삭제 확인 실패: 아직 남아 있습니다: ' + real); // 결과 확인 후에만 성공 보고
  try { fs.appendFileSync(path.join(trashDir, 'delete_log.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...result }) + '\n'); } catch {}
  log('delete', result.action, real);
  return result;
}

// ---------- 바이트 받아 쓰기 (v1.2 추가) ----------
// 화면(아티팩트)이 MCP로 파일을 보내면 base64 글자로 도착한다. 이 도구가 그것을 허용 폴더에 파일로 쓴다.
// 한 번에 다 보내거나(offset 없음), 큰 파일은 순서대로 나눠 보낸다(offset + total_bytes).
const B64 = /^[A-Za-z0-9+/]*={0,2}$/;
function assertWritable(real, cfg) { // 보호 경로(agent, file-mover, _trash 등) 안에는 쓰지 못한다
  for (const p of cfg.protectedPaths) {
    const r = norm(real), q = norm(p);
    if (r === q || r.startsWith(q + path.sep)) throw new Error('보호된 경로에는 쓸 수 없습니다: ' + p);
  }
}
async function receiveBytes(a, cfg) {
  if (!a || typeof a.dest_dir !== 'string' || !a.dest_dir.trim()) throw new Error('dest_dir가 필요합니다');
  if (typeof a.filename !== 'string' || !a.filename.trim()) throw new Error('filename이 필요합니다');
  if (typeof a.content_base64 !== 'string') throw new Error('content_base64가 필요합니다');
  const b64 = a.content_base64;
  if (b64.length % 4 !== 0 || !B64.test(b64)) throw new Error('content_base64가 올바른 base64 글자가 아닙니다');
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  const len = b64.length / 4 * 3 - pad;
  if (len > cfg.maxBytes) throw new Error('크기 한도 초과: ' + len + ' > ' + cfg.maxBytes);
  const dir = insideAllowed(a.dest_dir, cfg);
  assertWritable(dir, cfg);
  const name = sanitizeName(a.filename);
  if (/\.part$/i.test(name)) throw new Error('.part로 끝나는 이름은 쓸 수 없습니다: ' + name);
  const chunked = a.offset !== undefined || a.total_bytes !== undefined;
  let offset = 0, total = len;
  if (chunked) {
    offset = Number(a.offset); total = Number(a.total_bytes);
    if (!Number.isInteger(offset) || offset < 0) throw new Error('offset은 0 이상의 정수여야 합니다');
    if (!Number.isInteger(total) || total <= 0) throw new Error('나눠 보낼 때는 total_bytes(전체 크기)가 필요합니다');
    if (total > cfg.maxBytes) throw new Error('크기 한도 초과: ' + total + ' > ' + cfg.maxBytes);
    if (offset + len > total) throw new Error('offset+크기가 total_bytes를 넘습니다');
  }
  if (a.sha256 !== undefined && !/^[0-9a-f]{64}$/i.test(String(a.sha256))) throw new Error('sha256은 16진수 64글자여야 합니다');
  fs.mkdirSync(dir, { recursive: true });
  const part = path.join(dir, name + '.part');
  insideAllowed(part, cfg);
  const buf = Buffer.from(b64, 'base64');
  if (chunked && offset > 0) {
    const have = fs.existsSync(part) ? fs.statSync(part).size : -1;
    if (have !== offset) throw new Error('순서가 맞지 않습니다: 지금까지 받은 크기 ' + have + ', 보낸 offset ' + offset + ' (처음부터 다시 보내려면 offset 0)');
  }
  const fd = fs.openSync(part, offset > 0 ? 'a' : 'w');
  try { fs.writeSync(fd, buf, 0, buf.length); } catch (e) { try { fs.closeSync(fd); } catch {} try { fs.unlinkSync(part); } catch {} throw e; }
  fs.closeSync(fd);
  const received = offset + buf.length;
  if (chunked && received < total) return { done: false, received, total_bytes: total, part_path: part };
  // 다 모였다: 크기·sha256 확인 뒤 제 이름으로
  const abort = msg => { try { fs.unlinkSync(part); } catch {} throw new Error(msg); };
  const size = fs.statSync(part).size;
  if (size !== total) abort('받은 크기가 맞지 않습니다: ' + size + ' != ' + total);
  const sha = crypto.createHash('sha256').update(fs.readFileSync(part)).digest('hex');
  if (a.sha256 && sha !== String(a.sha256).toLowerCase()) abort('sha256이 다릅니다(전송 중 깨짐): 받은 ' + sha + ' / 기대 ' + String(a.sha256).toLowerCase());
  let target = path.join(dir, name);
  if (!a.overwrite) { const ext = path.extname(name), base = path.basename(name, ext); let i = 1;
    while (fs.existsSync(target)) target = path.join(dir, base + '_' + (i++) + ext); }
  try { insideAllowed(target, cfg); assertWritable(target, cfg);
    if (fs.existsSync(target) && fs.statSync(target).isDirectory()) throw new Error('같은 이름의 폴더가 있습니다: ' + target); }
  catch (e) { abort(e.message); }
  fs.renameSync(part, target);
  log('receive_bytes', target, size + 'B');
  return { done: true, saved_path: target, bytes: size, sha256: sha, renamed: path.basename(target) !== name };
}

// ---------- 화면 캡처·그림 얹기 (v1.3 추가) ----------
const capture = require('./capture.js');
const stampName = () => { const d = new Date(), z = n => String(n).padStart(2, '0');
  return d.getFullYear() + z(d.getMonth() + 1) + z(d.getDate()) + '-' + z(d.getHours()) + z(d.getMinutes()) + z(d.getSeconds()); };
function uniqueTarget(dir, name, overwrite) {
  let target = path.join(dir, name);
  if (!overwrite) { const ext = path.extname(name), base = path.basename(name, ext); let i = 1;
    while (fs.existsSync(target)) target = path.join(dir, base + '_' + (i++) + ext); }
  return target;
}
function pngName(n, fallback) {
  let name = sanitizeName(n || fallback);
  if (!/\.png$/i.test(name)) name = name.replace(/\.(jpe?g|bmp|gif|webp)$/i, '') + '.png';
  if (/\.part$/i.test(name)) throw new Error('.part로 끝나는 이름은 쓸 수 없습니다');
  return name;
}

async function captureScreen(a, cfg) {
  if (!cfg.captureEnabled) throw new Error('화면 캡처가 꺼져 있습니다. 이 PC의 file-mover 설정 env에 MOVER_ENABLE_CAPTURE=1 을 넣고 다시 시작해야 합니다 (화면에 보이는 모든 것이 찍히므로 기본은 꺼 둡니다)');
  a = a || {};
  const dir = insideAllowed(a.dest_dir || path.join(cfg.dirs[0], 'capture'), cfg);
  assertWritable(dir, cfg);
  let delay = a.delay_ms === undefined ? 0 : Number(a.delay_ms);
  if (!Number.isFinite(delay) || delay < 0 || delay > 10000) throw new Error('delay_ms는 0~10000 입니다');
  if (a.windows !== undefined && typeof a.windows !== 'boolean') throw new Error('windows는 true/false 입니다');
  if (a.window !== undefined) {
    capture.checkWindowSpec(a.window);
    if (a.display !== undefined && a.display !== null && a.display !== '') throw new Error('[window_spec] window와 display는 함께 쓸 수 없습니다');
    if (a.info_only !== true) return captureWindow(a, cfg, dir, delay);
  }
  const info = await capture.runPs('info', {});
  const displays = capture.toArr(info.displays);
  if (a.info_only === true) {
    const r = { displays, virtual: info.virtual };
    if (a.windows === true) r.windows = capture.windowsForReport(((await capture.runPs('win_list', {})) || {}).windows);   // 창 제목은 windows:true 로 물었을 때만 내보낸다
    return r;
  }
  const plan = capture.planRegion(info, a);   // 영역 계산은 찍기 전에 끝낸다(틀린 입력이면 아무것도 찍지 않음)
  const name = pngName(a.filename, 'capture_' + stampName() + '.png');
  fs.mkdirSync(dir, { recursive: true });
  const target = uniqueTarget(dir, name, a.overwrite === true);
  insideAllowed(target, cfg); assertWritable(target, cfg);
  if (fs.existsSync(target) && fs.statSync(target).isDirectory()) throw new Error('같은 이름의 폴더가 있습니다: ' + target);
  const part = target + '.part';
  if (delay) await new Promise(r => setTimeout(r, delay));
  try {
    await capture.runPs('shot', { CAP_X: String(plan.x), CAP_Y: String(plan.y), CAP_W: String(plan.w), CAP_H: String(plan.h), CAP_OUT: part });
    const buf = fs.readFileSync(part);
    const im = require('./annotate.js').imageInfo(buf);
    if (im.type !== 'png') throw new Error('캡처 결과가 PNG가 아닙니다');
    if (im.w !== plan.w || im.h !== plan.h) log('capture size differs', im.w + 'x' + im.h, 'plan', plan.w + 'x' + plan.h);
    fs.renameSync(part, target);
    const result = { saved_path: target, width: im.w, height: im.h, bytes: buf.length, display: plan.display, region_px: { x: plan.x, y: plan.y, w: plan.w, h: plan.h }, area_px: plan.area, displays };
    try { fs.appendFileSync(path.join(dir, 'capture_log.jsonl'), JSON.stringify({ at: new Date().toISOString(), file: path.basename(target), display: plan.display, region_px: result.region_px }) + '\n'); } catch {}
    log('capture', target, im.w + 'x' + im.h);
    return result;
  } catch (e) { try { fs.unlinkSync(part); } catch {} throw e; }
}

async function captureWindow(a, cfg, dir, delay) {
  const w = a.window;
  if (delay) await new Promise(r => setTimeout(r, delay));
  const listed = await capture.runPs('win_list', {});
  const { win, matched } = capture.planWindow(listed.windows, w);   // 못 찾음·여럿·최소화·다른 데스크톱은 여기서 찍기 전에 오류
  const regionEnv = capture.planWindowRegion(a.region);
  const procSlug = sanitizeName(String(win.process || 'window')).replace(/\.[^.]*$/, '') || 'window';
  const name = pngName(a.filename, 'window_' + procSlug + '_' + stampName() + '.png');
  fs.mkdirSync(dir, { recursive: true });
  const target = uniqueTarget(dir, name, a.overwrite === true);
  insideAllowed(target, cfg); assertWritable(target, cfg);
  if (fs.existsSync(target) && fs.statSync(target).isDirectory()) throw new Error('같은 이름의 폴더가 있습니다: ' + target);
  const part = target + '.part';
  try {
    const env = { CAP_HWND: String(win.hwnd), CAP_OUT: part, CAP_METHOD: w.method || 'auto', CAP_RESTORE: w.restore === true ? '1' : '0',
      CAP_BACK: w.restore_back === false ? '0' : '1', CAP_ACTIVATE: w.activate === true ? '1' : '0', CAP_CLIENT: w.client_only === true ? '1' : '0',
      CAP_SETTLE: String(w.settle_ms === undefined ? 500 : w.settle_ms), ...regionEnv };
    const r = await capture.runPs('win_shot', env, 45000);
    if (!r || r.ok !== true) throw capture.psFail(r || {});
    const buf = fs.readFileSync(part);
    const im = require('./annotate.js').imageInfo(buf);
    if (im.type !== 'png') throw new Error('캡처 결과가 PNG가 아닙니다');
    fs.renameSync(part, target);
    const warnings = capture.toArr(r.warnings);
    if (matched > 1) warnings.push('matched_' + matched + '_windows');
    const result = { saved_path: target, width: im.w, height: im.h, bytes: buf.length, window: { title: win.title, process: win.process, pid: win.pid },
      method_used: r.method, fallback: r.fallback === true, occluded_ratio: r.occluded_ratio === undefined ? null : r.occluded_ratio,
      restored: r.restored === true, activated: r.activated === true, region_px: r.region, area_px: { w: r.area_w, h: r.area_h }, warnings };
    try { fs.appendFileSync(path.join(dir, 'capture_log.jsonl'), JSON.stringify({ at: new Date().toISOString(), file: path.basename(target), window_process: win.process, method: r.method, region_px: r.region }) + '\n'); } catch {}   // 로그에는 창 제목을 남기지 않는다
    log('capture window', target, im.w + 'x' + im.h, win.process);
    return result;
  } catch (e) { try { fs.unlinkSync(part); } catch {} throw e; }
}

async function annotateImage(a, cfg) {
  if (!a || typeof a.path !== 'string' || !a.path.trim()) throw new Error('path(원본 이미지)가 필요합니다');
  const real = insideAllowed(a.path, cfg);
  const st = fs.statSync(real);
  if (!st.isFile()) throw new Error('파일이 아닙니다');
  if (st.size > cfg.maxBytes) throw new Error('크기 한도 초과: ' + st.size + ' > ' + cfg.maxBytes);
  const outDir = insideAllowed(a.out_dir || path.dirname(real), cfg);
  assertWritable(outDir, cfg);
  const base = path.basename(real, path.extname(real));
  const name = pngName(a.out_filename, base + '_annotated.png');
  const spec = { items: a.items, units: a.units, crop: a.crop, max_width: a.max_width, panel: a.panel };
  const r = require('./annotate.js').annotate(fs.readFileSync(real), spec); // 입력 검사·그리기를 먼저 끝내고 그 뒤에만 파일을 만든다
  fs.mkdirSync(outDir, { recursive: true });
  const target = uniqueTarget(outDir, name, a.overwrite === true);
  insideAllowed(target, cfg); assertWritable(target, cfg);
  if (norm(target) === norm(real)) throw new Error('원본 파일은 덮어쓰지 않습니다. out_filename을 다르게 주세요');
  if (fs.existsSync(target) && fs.statSync(target).isDirectory()) throw new Error('같은 이름의 폴더가 있습니다: ' + target);
  const part = target + '.part';
  try { fs.writeFileSync(part, r.png); fs.renameSync(part, target); } catch (e) { try { fs.unlinkSync(part); } catch {} throw e; }
  log('annotate', target, r.width + 'x' + r.height, r.count + ' items');
  return { saved_path: target, width: r.width, height: r.height, bytes: r.png.length, items: r.count, source: { path: real, width: r.source.w, height: r.source.h }, warnings: r.warnings };
}

// ---------- MCP(stdio) ----------
const TOOLS = [
  { name: 'file_stat', description: '허용 폴더 안 PC 파일의 크기·형식을 알려준다. (어도비 업로드 시작 시 file_size/media_type 확인용)',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'send_file', description: 'PC 파일(또는 그 일부 구간)을 업로드 주소로 보낸다. 피그마 upload_assets의 submitUrl → mode=multipart(필드 file). 어도비 asset_initialize_file_upload의 블록 주소 → mode=raw, method=PUT, offset/length로 블록 크기만큼 나눠 보낸다.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, url: { type: 'string' }, mode: { type: 'string', enum: ['multipart', 'raw'] },
      method: { type: 'string', enum: ['PUT', 'POST'] }, field: { type: 'string' }, content_type: { type: 'string' }, offset: { type: 'integer' }, length: { type: 'integer' },
      headers: { type: 'object' } }, required: ['path', 'url'] } },
  { name: 'receive_file', description: '다운로드 주소(피그마 내보내기 URL, 어도비 결과 URL 등)의 파일을 PC 허용 폴더에 저장한다.',
    inputSchema: { type: 'object', properties: { url: { type: 'string' }, dest_dir: { type: 'string' }, filename: { type: 'string' },
      overwrite: { type: 'boolean' }, max_bytes: { type: 'integer' } }, required: ['url', 'dest_dir'] } },
  { name: 'delete_path', description: '허용 폴더 안의 파일·폴더를 지운다. 기본은 같은 허용 루트의 _trash 폴더로 옮기는 안전 삭제(복구 가능, _trash\\delete_log.jsonl에 기록). 폴더째 지우려면 recurse:true, 완전히 지우려면 permanent:true(휴지통 안의 것은 항상 영구 삭제). 허용 루트 자체, agent·file-mover·_trash 폴더는 지울 수 없다.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, recurse: { type: 'boolean' }, permanent: { type: 'boolean' } }, required: ['path'] } },
  { name: 'receive_bytes', description: '호출자가 base64 글자(content_base64)로 보낸 파일 바이트를 허용 폴더에 파일로 쓴다(화면·아티팩트가 PC에 파일을 직접 넘길 때). 같은 이름이 있으면 _1,_2를 붙여 보존(overwrite:true면 덮어씀). 큰 파일은 순서대로 나눠 보낸다: offset(0부터, 이어 받은 크기와 같아야 함)과 total_bytes(전체 크기)를 매번 같이 보내고, 마지막 조각이 오면 done:true와 saved_path·sha256을 돌려준다. sha256을 주면 전송 중 깨짐을 확인. agent·file-mover·_trash 안에는 쓸 수 없다.',
    inputSchema: { type: 'object', properties: { dest_dir: { type: 'string' }, filename: { type: 'string' }, content_base64: { type: 'string' },
      overwrite: { type: 'boolean' }, offset: { type: 'integer' }, total_bytes: { type: 'integer' }, sha256: { type: 'string' } }, required: ['dest_dir', 'filename', 'content_base64'] } },
  { name: 'capture_screen', description: 'PC 화면(전체·모니터 하나·일부 영역)을 PNG 파일로 허용 폴더에 저장한다. 브라우저를 거치지 않는 OS 화면 캡처(Windows). 기본은 꺼져 있고 env MOVER_ENABLE_CAPTURE=1일 때만 작동. 인자: dest_dir(기본 <첫 허용 폴더>\\capture), filename(기본 capture_날짜시각.png), display("all"=모든 모니터 또는 모니터 번호 1~), region{x,y,w,h,units}(고른 화면 왼쪽 위가 0, units 기본 "ratio"=0~1 비율, "px"=픽셀), delay_ms(찍기 전에 기다림, 최대 10000), info_only:true면 찍지 않고 모니터 목록만 돌려줌. 같은 이름이 있으면 _1,_2. 찍은 뒤 saved_path를 nodelab-fs read_media_file로 열어 보면 눈으로 확인할 수 있다. 찍을 때마다 dest_dir\\capture_log.jsonl에 기록. ' +
    '창 하나만 찍기(v1.5): window{title(창 제목 일부, 대소문자 무시), process(프로그램 이름, 예 whale), match(contains 기본|exact), index(여러 개일 때 번호), pick(error 기본|topmost|largest), method(auto 기본=PrintWindow로 가려져도 찍고 실패하면 화면 복사|print|screen), restore(최소화된 창을 잠깐 펼쳐 찍기, 기본 false), restore_back(찍은 뒤 다시 최소화, 기본 true), activate(앞으로 가져오기, 기본 false), client_only(제목줄·테두리 제외), settle_ms}. display와 함께 쓸 수 없고 region은 그 창 안 기준. 실패 코드: [window_not_found] [window_ambiguous](후보 목록을 돌려줌) [window_minimized] [window_cloaked](다른 가상 데스크톱) [window_blank] [window_empty] [region_outside]. 열린 창 제목 목록은 info_only:true + windows:true 로만 나온다(로그에는 제목을 남기지 않음). 브라우저 창은 화면 배율이 다른 모니터에서 크기가 달라 보일 수 있다.',
    inputSchema: { type: 'object', properties: { dest_dir: { type: 'string' }, filename: { type: 'string' }, display: { type: ['string', 'integer'] },
      region: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' }, units: { type: 'string', enum: ['ratio', 'px'] } }, required: ['x', 'y', 'w', 'h'] },
      delay_ms: { type: 'integer' }, overwrite: { type: 'boolean' }, info_only: { type: 'boolean' }, windows: { type: 'boolean' },
      window: { type: 'object', properties: { title: { type: 'string' }, process: { type: 'string' }, match: { type: 'string', enum: ['contains', 'exact'] }, index: { type: 'integer' },
        pick: { type: 'string', enum: ['error', 'topmost', 'largest'] }, method: { type: 'string', enum: ['auto', 'print', 'screen'] }, restore: { type: 'boolean' }, restore_back: { type: 'boolean' },
        activate: { type: 'boolean' }, client_only: { type: 'boolean' }, settle_ms: { type: 'integer' } } } } } },
  { name: 'annotate_image', description: '허용 폴더 안 PNG/JPG 위에 그림·글자를 얹어 새 PNG로 저장한다(원본은 그대로). items 배열에 아래 종류를 순서대로 쌓는다. 좌표 기본은 이미지 가로·세로 대비 비율(0~1), units:"px"면 픽셀. 색은 #e11d48, red, rgba(...). ' +
    'rect{x,y,w,h,color,width,fill,radius} · ellipse{x,y,w,h,color,width,fill} · line{x1,y1,x2,y2} · arrow{x1,y1,x2,y2}(끝에 화살촉) · text{x,y,text,size,color,bg,align,bold}(x,y는 글자 상자 왼쪽 위, \\n으로 줄바꿈, size 1 이하는 이미지 높이 비율, bg를 주면 글자 뒤 색 상자) · number{x,y,n,size,color}(번호 동그라미) · freehand{points:[[x,y],...],color,width} · highlight{x,y,w,h,color,opacity}(형광펜) · mask{x,y,w,h,color}(가리기, 기본 검정). ' +
    '공통: width(선 굵기), opacity(0~1). crop{x,y,w,h}로 일부만 잘라 내고, max_width로 줄여 저장. out_dir·out_filename 기본은 원본 옆 <이름>_annotated.png, 같은 이름이 있으면 _1,_2(overwrite:true여도 원본은 덮어쓰지 않음). 결과의 warnings에 이미지 밖에 놓인 항목이 나온다. ' +
    'panel{side,size,title,text,items:[{n,text,color}],color,text_color,title_color,font_size}: 캔버스를 넓혀 코멘트란을 붙인다. side는 right(기본)·left·top·bottom, size는 란의 폭(left/right, 가로 대비 비율 기본 0.35 또는 px)이나 높이(top/bottom, 기본은 글에 맞춰 자동). title은 제목 한 줄, text는 설명 글, items는 번호 코멘트 목록(n을 안 주면 1,2,3… 자동, 이미지 위 number 동그라미의 번호와 짝). 글은 란 폭에 맞춰 자동 줄바꿈하고, 글이 길면 캔버스를 늘린다. 좌표는 코멘트란을 뺀 원래 이미지 기준이라 panel을 붙여도 그대로 쓴다. number의 n을 안 주면 number끼리 1,2,3… 순서로 매긴다. 저장 뒤 saved_path를 read_media_file로 열어 확인할 것.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, items: { type: 'array', items: { type: 'object' } }, units: { type: 'string', enum: ['ratio', 'px'] },
      crop: { type: 'object' }, panel: { type: 'object' }, max_width: { type: 'integer' }, out_dir: { type: 'string' }, out_filename: { type: 'string' }, overwrite: { type: 'boolean' } }, required: ['path'] } },
];
const IMPL = { file_stat: fileStat, send_file: sendFile, receive_file: receiveFile, delete_path: deletePath, receive_bytes: receiveBytes, capture_screen: captureScreen, annotate_image: annotateImage };

async function handle(msg, cfg) {
  const { id, method, params } = msg;
  if (method === 'initialize') return { protocolVersion: params?.protocolVersion || '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'nodelab-file-mover', version: VERSION } };
  if (method === 'ping') return {};
  if (method === 'tools/list') return { tools: TOOLS };
  if (method === 'tools/call') {
    const fn = IMPL[params?.name];
    if (!fn) return { isError: true, content: [{ type: 'text', text: '알 수 없는 도구' }] };
    try { return { content: [{ type: 'text', text: JSON.stringify(await fn(params.arguments || {}, cfg), null, 2) }] }; }
    catch (e) { return { isError: true, content: [{ type: 'text', text: '실패: ' + e.message }] }; }
  }
  if (id === undefined) return undefined; // 알림
  throw Object.assign(new Error('Method not found: ' + method), { code: -32601 });
}

function main() {
  const cfg = makeConfig();
  log('start v' + VERSION + ' dirs='+ cfg.dirs.join('|') + ' hosts=' + cfg.hosts.length);
  // 입력은 바이트 조각으로 모았다가 줄바꿈이 올 때만 글자로 바꾼다(21MB짜리 한 줄이 와도 느려지지 않게). 한글이 조각 사이에서 잘려도 안전.
  let parts = [];
  process.stdin.on('data', async d => {
    const lines = []; let start = 0, i;
    while ((i = d.indexOf(10, start)) >= 0) {
      parts.push(d.subarray(start, i)); lines.push(Buffer.concat(parts).toString('utf8').trim()); parts = []; start = i + 1;
    }
    if (start < d.length) parts.push(d.subarray(start));
    for (const line of lines) {
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      try { const r = await handle(msg, cfg); if (msg.id !== undefined && r !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: r }) + '\n'); }
      catch (e) { if (msg.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: e.code || -32603, message: e.message } }) + '\n'); }
    }
  });
}
if (require.main === module) main();
module.exports = { makeConfig, fileStat, sendFile, receiveFile, deletePath, receiveBytes, captureScreen, annotateImage, checkUrl, handle };
