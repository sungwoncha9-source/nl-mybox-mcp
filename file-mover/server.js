#!/usr/bin/env node
'use strict';
// 노드랩 파일 이동기 MCP — PC에서 실행. 도구 3개: file_stat, send_file, receive_file
// 의존성 없음(Node 18+). 클로드는 "주소(URL)와 PC 경로"만 말하고, 파일 바이트는 이 프로그램이 직접 옮긴다.
const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;
const net = require('net');

const DEFAULT_HOSTS = ['figma.com', 'figma-alpha-api.s3.us-west-2.amazonaws.com', 'amazonaws.com',
  'adobe.io', 'adobe.com', 'adobelogin.com', 'cloudfront.net', 'behance.net'];

function makeConfig(env = process.env) {
  const dirs = (env.MOVER_ALLOWED_DIRS || (process.platform === 'win32' ? 'D:\\nodelab_work' : process.cwd()))
    .split(path.delimiter === ';' ? ';' : /[;:]/).map(s => s.trim()).filter(Boolean);
  return {
    dirs: dirs.map(d => { try { return fs.realpathSync(d); } catch { return path.resolve(d); } }),
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
];
const IMPL = { file_stat: fileStat, send_file: sendFile, receive_file: receiveFile };

async function handle(msg, cfg) {
  const { id, method, params } = msg;
  if (method === 'initialize') return { protocolVersion: params?.protocolVersion || '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'nodelab-file-mover', version: '1.0.0' } };
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
  log('start dirs=' + cfg.dirs.join('|') + ' hosts=' + cfg.hosts.length);
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', async d => {
    buf += d; let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      try { const r = await handle(msg, cfg); if (msg.id !== undefined && r !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: r }) + '\n'); }
      catch (e) { if (msg.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: e.code || -32603, message: e.message } }) + '\n'); }
    }
  });
}
if (require.main === module) main();
module.exports = { makeConfig, fileStat, sendFile, receiveFile, checkUrl, handle };
