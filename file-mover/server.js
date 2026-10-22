#!/usr/bin/env node
'use strict';
// 노드랩 파일 이동기 MCP v1.2 — PC에서 실행. 도구 5개: file_stat, send_file, receive_file, delete_path, receive_bytes
// 변경점(v1.1 대비): receive_bytes 추가(화면이 보낸 파일 바이트를 허용 폴더에 씀, 나눠 보내기·sha256 확인 지원). 나머지 4개 도구는 동작 그대로.
// 변경점(v1.0 대비, v1.1): delete_path 추가(기본은 휴지통 폴더로 이동, permanent:true일 때만 영구 삭제).
// 의존성 없음(Node 18+). 클로드는 "주소(URL)와 PC 경로"만 말하고, 파일 바이트는 이 프로그램이 직접 옮긴다.
const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;
const net = require('net');
const crypto = require('crypto');

const VERSION = '1.2.0';
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
];
const IMPL = { file_stat: fileStat, send_file: sendFile, receive_file: receiveFile, delete_path: deletePath, receive_bytes: receiveBytes };

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
module.exports = { makeConfig, fileStat, sendFile, receiveFile, deletePath, receiveBytes, checkUrl, handle };
