// 1.12.0 그림 읽기(files_read_image)·내려받기 지킴이 시험 (가짜 MYBOX + 가짜 파일 서버, 쓰기 0건). 사용: node test/readimage.mjs <http번들>
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os'; import crypto from 'node:crypto'; import { spawn } from 'node:child_process';
const HTTPB = process.argv[2];
const JOBS = fs.mkdtempSync(path.join(os.tmpdir(), 'ri-'));
let pass = 0, fail = 0; const ok = (c, m) => { (c ? pass++ : fail++); console.log((c ? '  OK   ' : '  FAIL ') + m); };
// ROOT ┬ OUT ─ OUTF ; ALLOW ┬ SUB ─ F1 ; ALLOW ─ F2(PNG) F3(큰 파일 meta) F4(meta 거짓말) F5(글자) F6(외부주소) F7(리다이렉트 안) F8(리다이렉트 밖) F9(500) F10(느림) F11(WEBP)
const T = { ROOT: null, OUT: 'ROOT', OUTF: 'OUT', ALLOW: 'ROOT', SUB: 'ALLOW', F1: 'SUB', F2: 'ALLOW', F3: 'ALLOW', F4: 'ALLOW', F5: 'ALLOW', F6: 'ALLOW', F7: 'ALLOW', F8: 'ALLOW', F9: 'ALLOW', F10: 'ALLOW', F11: 'ALLOW', F12: 'ALLOW' };
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(5000)]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(3000)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([1, 2, 3, 4]), Buffer.from('WEBP'), crypto.randomBytes(500)]);
const BIG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), crypto.randomBytes(20000)]);   // 상한(10000) 초과
const meta = { F3: { size: 99999999 }, F4: { size: 100 }, F2: { size: PNG.length } };
const calls = []; let fileHits = 0; let fileSrvPort = 0; const urlSeen = [];
const fsrv = http.createServer((req, res) => { fileHits++; const u = req.url;
  if (u === '/png') { res.setHeader('content-length', PNG.length); return res.end(PNG); }
  if (u === '/jpg') return res.end(JPG);
  if (u === '/webp') return res.end(WEBP);
  if (u === '/big') return res.end(BIG);
  if (u === '/chunked') { res.write(Buffer.from([0xff, 0xd8, 0xff])); for (let i = 0; i < 5; i++) res.write(crypto.randomBytes(4000)); return res.end(); }   // 길이 없이 조각으로 보냄(합계 20003B)
  if (u === '/text') return res.end('hello not an image');
  if (u === '/redir-in') { res.statusCode = 302; res.setHeader('location', '/png'); return res.end(); }
  if (u === '/redir-out') { res.statusCode = 302; res.setHeader('location', 'http://169.254.169.254/x'); return res.end(); }
  if (u === '/err') { res.statusCode = 500; return res.end('x'); }
  if (u === '/slow') { return; }   // 응답하지 않음
  res.statusCode = 404; res.end(); });
await new Promise(r => fsrv.listen(0, '127.0.0.1', r)); fileSrvPort = fsrv.address().port; const FBASE = 'http://127.0.0.1:' + fileSrvPort;
const DL = { F1: '/jpg', F2: '/png', F3: '/png', F4: '/big', F5: '/text', F7: '/redir-in', F8: '/redir-out', F9: '/err', F10: '/slow', F11: '/webp', F12: '/chunked', OUTF: '/png' };
const srv = http.createServer((req, res) => { const u = new URL(req.url, 'http://x'); calls.push(req.method + ' ' + u.pathname); let m;
  const json = (o, s = 200) => { res.statusCode = s; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
  if ((m = u.pathname.match(/^\/v1\/drive\/resources\/([^/]+)$/))) { const id = m[1]; return id in T ? json({ resourceId: id, parentId: T[id], name: id + '.png', ...(meta[id] || {}) }) : json({}, 404); }
  if ((m = u.pathname.match(/^\/v1\/drive\/files\/([^/]+)\/download$/))) { const id = m[1]; const url = id === 'F6' ? 'http://evil.example/png' : FBASE + (DL[id] || '/png'); urlSeen.push(url); return json({ downloadUrl: url, expiresIn: 600 }); }
  json({}, 404); });
await new Promise(r => srv.listen(0, '127.0.0.1', r)); const BASE = 'http://127.0.0.1:' + srv.address().port + '/v1';
const TOKEN = crypto.randomBytes(24).toString('hex');
const TOOLS = 'job_status,dms_list,dms_resourceId,search_files_resources,search_folders_resources,files_download,files_read_image';
const start = (env = {}) => new Promise((resolve) => { const p = spawn('node', [HTTPB], { env: { ...process.env, NL_TRANSPORT: 'http', NL_HTTP_TOKEN: TOKEN, NL_HTTP_PORT: '0', MYBOX_ACCESS_TOKEN: 'dummy', MYBOX_BASE_URL: BASE, NL_JOBS_DIR: JOBS, NL_JOB_ALLOWED_PARENTS: 'tree:ALLOW', NL_HTTP_TOOLS: TOOLS, NL_READ_MAX_BYTES: '10000', NL_READ_URL_PREFIXES: FBASE + '/', NL_READ_TIMEOUT_MS: '600', ...env } });
  let err = ''; p.stderr.on('data', d => { err += d; const mm = err.match(/listening on http:\/\/[^:]+:(\d+)\/mcp/); if (mm) resolve({ p, port: +mm[1], getErr: () => err }); }); p.on('exit', code => resolve({ exited: code, err })); setTimeout(() => resolve({ timeout: true }), 8000); });
const cli = async (port) => { const c = new Client({ name: 'g', version: '1' }); await c.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:' + port + '/mcp'), { requestInit: { headers: { authorization: 'Bearer ' + TOKEN } } })); return c; };
const call = async (c, name, args) => { try { const r = await c.callTool({ name, arguments: args }); return { err: !!r.isError, content: r.content || [], text: r.content?.[0]?.text || '' }; } catch (e) { return { err: true, content: [], text: 'THROW ' + e.message }; } };
const rest = async (port, p) => (await fetch('http://127.0.0.1:' + port + p, { headers: { authorization: 'Bearer ' + TOKEN } })).status;
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

const s = await start(); ok(!!s.p, '서버 시작(읽기 7개 + 그림 읽기)');
const c = await cli(s.port);
const names = (await c.listTools()).tools.map(t => t.name);
ok(names.includes('files_read_image') && names.includes('files_download'), '도구 목록에 files_read_image·files_download');
let r = await call(c, 'files_read_image', { resourceId: 'F1' });
let img = r.content.find(x => x.type === 'image');
ok(!r.err && img && img.mimeType === 'image/jpeg' && sha(Buffer.from(img.data, 'base64')) === sha(JPG), '허용 안 JPG: 그림 내용·종류 일치(내용 해시 같음)');
r = await call(c, 'files_read_image', { resourceId: 'F2' }); img = r.content.find(x => x.type === 'image');
ok(!r.err && img && img.mimeType === 'image/png' && sha(Buffer.from(img.data, 'base64')) === sha(PNG), '허용 폴더 바로 아래 PNG 성공');
r = await call(c, 'files_read_image', { resourceId: 'F11' }); img = r.content.find(x => x.type === 'image');
ok(!r.err && img && img.mimeType === 'image/webp', 'WEBP 종류 판정');
ok(!JSON.stringify(r.content.filter(x => x.type === 'text')).includes('downloadUrl') && !r.text.includes('127.0.0.1'), '응답 글자에 임시 주소가 없음');
let h = fileHits; r = await call(c, 'files_read_image', { resourceId: 'OUTF' }); ok(r.err && /not_allowed/.test(r.text) && fileHits === h, '밖 파일 거절, 파일 서버 요청 0');
h = fileHits; r = await call(c, 'files_read_image', { resourceId: 'ALLOW' }); ok(r.err && fileHits === h, '허용 폴더 자체 거절');
h = fileHits; r = await call(c, 'files_read_image', { resourceId: '../etc' }); ok(r.err && fileHits === h, '이상한 ID 거절');
h = fileHits; r = await call(c, 'files_read_image', { resourceId: 'F3' }); ok(r.err && /too_large/.test(r.text) && fileHits === h, '속성 크기가 상한 초과 → 받기 전에 거절, 파일 서버 요청 0');
r = await call(c, 'files_read_image', { resourceId: 'F4' }); ok(r.err && /too_large/.test(r.text), '속성은 작은데 실제로 큰 파일 → 받는 도중 끊음');
r = await call(c, 'files_read_image', { resourceId: 'F12' }); ok(r.err && /too_large/.test(r.text) && !r.content.some(x => x.type === 'image'), '길이를 알리지 않고 조각으로 보내는 큰 파일 → 받는 도중 합계로 끊음');
r = await call(c, 'files_read_image', { resourceId: 'F5' }); ok(r.err && /not_image/.test(r.text) && !r.content.some(x => x.type === 'image'), '그림이 아닌 내용 거절');
h = fileHits; r = await call(c, 'files_read_image', { resourceId: 'F6' }); ok(r.err && /url_not_allowed/.test(r.text) && fileHits === h, '정해진 접두어 밖 주소 → 요청 안 나감');
ok(/"host":"evil.example"/.test(r.text) && !/\/png/.test(r.text), '진단: 호스트 이름만 알리고 경로는 안 알림');
r = await call(c, 'files_read_image', { resourceId: 'F7' }); img = r.content.find(x => x.type === 'image'); ok(!r.err && img && sha(Buffer.from(img.data, 'base64')) === sha(PNG), '접두어 안으로의 리다이렉트는 따라감');
r = await call(c, 'files_read_image', { resourceId: 'F8' }); ok(r.err && /redirect_not_allowed/.test(r.text), '접두어 밖으로의 리다이렉트 거절');
ok(/"host":"[^"/]+"/.test(r.text) && !/[?\/]/.test(JSON.parse(r.text).host || ''), '진단: 넘어간 곳의 호스트 이름만 알림');
r = await call(c, 'files_read_image', { resourceId: 'F9' }); ok(r.err && /download_http_500/.test(r.text), '파일 서버 오류 500 → 오류로 알림');
const t0 = Date.now(); r = await call(c, 'files_read_image', { resourceId: 'F10' }); ok(r.err && /timeout|abort/.test(r.text) && Date.now() - t0 < 5000, '응답 없는 서버 → 시간 초과로 끊음(' + (Date.now() - t0) + 'ms)');
r = await call(c, 'files_download', { resourceId: 'F1' }); ok(!r.err && /downloadUrl/.test(r.text), 'files_download 허용 안 → 주소 돌려줌');
r = await call(c, 'files_download', { resourceId: 'OUTF' }); ok(r.err && /not_allowed/.test(r.text), 'files_download 밖 → 거절');
ok(await rest(s.port, '/api/v1/resources/F1/download') === 200 && await rest(s.port, '/api/v1/resources/OUTF/download') === 403, 'REST 내려받기: 허용 안 200 / 밖 403');
ok(calls.every(x => x.startsWith('GET')), 'MYBOX로 간 쓰기 요청 0건 (전체 호출 ' + calls.length + ')');
ok(!s.getErr().includes('atoken') && !s.getErr().includes('/jpg'), '서버 로그에 임시 주소 없음');
await c.close(); s.p.kill();
// 이 도구를 열지 않으면 목록에도 없다
const s2 = await start({ NL_HTTP_TOOLS: 'job_status,dms_list' }); const c2 = await cli(s2.port);
const n2 = (await c2.listTools()).tools.map(t => t.name); ok(!n2.includes('files_read_image') && !n2.includes('files_download'), '열지 않은 설정에서는 두 도구 모두 없음');
r = await call(c2, 'files_read_image', { resourceId: 'F1' }); ok(r.err, '열지 않은 설정에서 호출하면 실패');
await c2.close(); s2.p.kill();
const bad = await start({ NL_HTTP_TOOLS: 'files_read_image,files_trash_clean' }); ok(bad.exited === 3, '영구 삭제 도구를 같이 열면 시작 거부(3)');
const bad2 = await start({ NL_HTTP_TOOLS: 'files_read_image,files_upload' }); ok(bad2.exited === 3, '지킴이 없는 쓰기 도구를 같이 열면 시작 거부(3)');
fsrv.close(); srv.close();
console.log(`\n${pass} pass / ${fail} fail`); process.exit(fail ? 1 : 0);
