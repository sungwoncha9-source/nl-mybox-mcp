// 1.9.3 시험: 일반 HTTPS 문(/api/v1) — MCP 문과 같은 반영 핵심·같은 지킴이·같은 인증을 쓰는지
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os'; import crypto from 'node:crypto'; import { spawn } from 'node:child_process';
const HTTPB = process.argv[2]; const JOBS = fs.mkdtempSync(path.join(os.tmpdir(), 'rj-'));
let pass = 0, fail = 0; const LOG = []; const ok = (c, m) => { (c ? pass++ : fail++); const l = (c ? '  OK   ' : '  FAIL ') + m; console.log(l); LOG.push(l); };
const T = { ROOT: null, OUT: 'ROOT', OUTF: 'OUT', ALLOW: 'ROOT', SUB: 'ALLOW', F1: 'SUB', F2: 'ALLOW' }; const files = {}; const calls = [];
const srv = http.createServer((req, res) => { const ch = []; req.on('data', d => ch.push(d)); req.on('end', () => {
  const u = new URL(req.url, 'http://x'); calls.push(req.method + ' ' + u.pathname); const body = Buffer.concat(ch);
  const json = (o, s = 200) => { res.statusCode = s; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); }; let m;
  if (req.method === 'GET' && (m = u.pathname.match(/^\/v1\/drive\/resources\/([^/]+)$/))) { const id = m[1]; if (!(id in T)) return json({ e: 'nf' }, 404); return json({ resourceId: id, parentId: T[id] }); }
  if (req.method === 'GET' && (m = u.pathname.match(/^\/v1\/drive\/folders\/([^/]+)\/resources$/))) return json({ resources: Object.keys(T).filter(k => T[k] === m[1]).map(k => ({ resourceId: k, name: files[k]?.name || k, size: files[k]?.size })), responseMetaData: {} });
  if (req.method === 'POST' && u.pathname === '/v1/drive/folders') { const b = JSON.parse(body); const id = 'NEW' + crypto.randomUUID().slice(0, 6); T[id] = b.parentId; return json({ resourceId: id }); }
  if (req.method === 'POST' && u.pathname === '/v1/drive/files') { const b = JSON.parse(body); const id = 'UP' + crypto.randomUUID().slice(0, 6); files[id] = { name: b.fileName, parent: b.parentId }; return json({ uploadUrl: 'http://127.0.0.1:' + srv.address().port + '/upload/' + id }); }
  if (req.method === 'POST' && u.pathname.startsWith('/upload/')) { const id = u.pathname.split('/')[2]; const s = body.indexOf('\r\n\r\n') + 4, e = body.lastIndexOf('\r\n--'); files[id].size = e - s; T[id] = files[id].parent; res.end('ok'); return; }
  if (req.method === 'POST' && (m = u.pathname.match(/^\/v1\/drive\/resources\/([^/]+)\/(copy|move)$/))) { const b = JSON.parse(body); if (m[2] === 'move') T[m[1]] = b.parentId; else T[m[1] + '_c' + crypto.randomUUID().slice(0, 4)] = b.parentId; return json({ ok: true, resourceId: m[1] }); }
  json({ e: 'nf ' + u.pathname }, 404);
}); });
await new Promise(r => srv.listen(0, '127.0.0.1', r)); const BASE = 'http://127.0.0.1:' + srv.address().port + '/v1';
const TOKEN = crypto.randomBytes(24).toString('hex'); const ALL6 = 'job_put_chunk,job_status,dms_list,files_copy,files_move,files_create_folder';
const start = (env = {}) => new Promise(resolve => { const p = spawn('node', [HTTPB], { env: { ...process.env, NL_TRANSPORT: 'http', NL_HTTP_TOKEN: TOKEN, NL_HTTP_PORT: '0', MYBOX_ACCESS_TOKEN: 'dummy', MYBOX_BASE_URL: BASE, NL_JOBS_DIR: JOBS, NL_JOB_ALLOWED_PARENTS: 'tree:ALLOW', NL_HTTP_TOOLS: ALL6, NL_HTTP_ORIGINS: 'https://app.example', ...env } });
  let err = ''; p.stderr.on('data', d => { err += d; const mm = err.match(/listening on http:\/\/[^:]+:(\d+)\/mcp/); if (mm) resolve({ p, port: +mm[1] }); }); p.on('exit', c => resolve({ exited: c, err })); });
const req = (port, method, p, body, headers = {}) => new Promise(resolve => { const data = body === undefined ? undefined : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json', ...(data ? { 'content-length': data.length } : {}), ...headers } }, res => { const c = []; res.on('data', d => c.push(d)); res.on('end', () => { let j = null; try { j = JSON.parse(Buffer.concat(c)); } catch (_) {} resolve({ status: res.statusCode, json: j, h: res.headers }); }); });
  if (data) r.write(data); r.end(); });
const writes = () => calls.filter(x => x.startsWith('POST')).length;
const S = await start(); const P = S.port;
console.log('[R1] 인증·출처 (MCP 문과 같은 관문)');
ok((await req(P, 'GET', '/api/v1/folders/ALLOW/resources', undefined, { authorization: '' })).status === 401, '[R1a] 토큰 없으면 401');
ok((await req(P, 'GET', '/api/v1/folders/ALLOW/resources', undefined, { authorization: 'Bearer ' + 'x'.repeat(48) })).status === 401, '[R1b] 틀린 토큰 401');
ok((await req(P, 'GET', '/api/v1/folders/ALLOW/resources', undefined, { origin: 'https://evil.example' })).status === 403, '[R1c] 허용 안 된 출처 403');
const r1d = await req(P, 'GET', '/api/v1/folders/ALLOW/resources', undefined, { origin: 'https://app.example' });
ok(r1d.status === 200 && r1d.h['access-control-allow-origin'] === 'https://app.example', '[R1d] 허용한 출처는 200 + CORS 허용(독립 웹앱 브라우저에서 직접 호출 가능)');
ok((await req(P, 'GET', '/api/v1/nope')).status === 404, '[R1e] 없는 경로 404');
console.log('[R2] 같은 지킴이');
ok((await req(P, 'GET', '/api/v1/folders/SUB/resources')).status === 200, '[R2a] 허용 하위 목록 200');
let w = writes(); ok((await req(P, 'GET', '/api/v1/folders/OUT/resources')).status === 403 && writes() === w, '[R2b] 밖 목록 403');
ok((await req(P, 'POST', '/api/v1/folders', { folderName: 'r1', parentId: 'SUB' })).status === 200, '[R2c] 허용 하위에 폴더 만들기 200');
w = writes(); ok((await req(P, 'POST', '/api/v1/folders', { folderName: 'r2', parentId: 'OUT' })).status === 403 && writes() === w, '[R2d] 밖에 폴더 만들기 403, MYBOX 쓰기 0');
w = writes(); ok((await req(P, 'POST', '/api/v1/folders', { folderName: 'r3' })).status === 403 && writes() === w, '[R2e] 상위 생략 403');
ok((await req(P, 'POST', '/api/v1/resources/F1/copy', { parentId: 'ALLOW' })).status === 200, '[R2f] 허용 안 복사 200');
w = writes(); ok((await req(P, 'POST', '/api/v1/resources/F1/copy', { parentId: 'OUT' })).status === 403 && writes() === w, '[R2g] 밖으로 복사 403');
w = writes(); ok((await req(P, 'POST', '/api/v1/resources/OUTF/move', { parentId: 'SUB' })).status === 403 && writes() === w, '[R2h] 밖 파일 끌어오기 403');
w = writes(); ok((await req(P, 'POST', '/api/v1/resources/ALLOW/move', { parentId: 'OUT' })).status === 403 && writes() === w, '[R2i] 허용 뿌리 옮기기 403');
w = writes(); ok((await req(P, 'POST', '/api/v1/resources/F1%2F..%2F..%2FOUTF/copy', { parentId: 'ALLOW' })).status === 403 && writes() === w, '[R2j] URL 인코딩 경로 조작 403');
w = writes(); ok((await req(P, 'POST', '/api/v1/resources/F1/move', { parentId: 'SUB', resourceId: 'OUTF', extra: 1 })).status === 200 && T.OUTF === 'OUT', '[R2k] 본문에 끼운 다른 resourceId는 무시(경로의 ID만 씀)');
ok((await req(P, 'POST', '/api/v1/folders', '{bad json')).status === 400, '[R2l] 깨진 JSON 400');
console.log('[R3] 일감(반영) — 문 하나로 올리기·대조까지');
const buf = crypto.randomBytes(5000); const sha = crypto.createHash('sha256').update(buf).digest('hex');
const ja = (id, pid) => ({ job_id: id, files: [{ name: 'r.png', size: buf.length, sha256: sha }], file_name: 'r.png', offset: 0, content_base64: buf.toString('base64'), parent_id: pid, wait_ms: 10000 });
const t0 = Date.now(); const j1 = await req(P, 'POST', '/api/v1/jobs/chunk', ja('rjob1', 'SUB')); const ms = Date.now() - t0;
ok(j1.status === 200 && j1.json.state === 'done' && j1.json.final === true, '[R3a] REST 일감 한 번에 done·final (' + ms + 'ms, 가짜 MYBOX)');
ok(Object.values(files).some(f => f.name === 'r.png' && f.size === 5000 && f.parent === 'SUB'), '[R3b] 가짜 MYBOX에 같은 크기로 도착');
const j1b = await req(P, 'POST', '/api/v1/jobs/chunk', ja('rjob1', 'SUB')); ok(j1b.status === 200 && j1b.json.state === 'done' && Object.values(files).filter(f => f.name === 'r.png').length === 1, '[R3c] 같은 일감 다시 보내도 중복 올리기 0');
ok((await req(P, 'GET', '/api/v1/jobs/rjob1')).json.state === 'done', '[R3d] 일감 상태 읽기');
w = writes(); ok((await req(P, 'POST', '/api/v1/jobs/chunk', ja('rjob2', 'OUT'))).status === 403 && writes() === w, '[R3e] 밖 폴더 일감 403');
ok((await req(P, 'GET', '/api/v1/jobs/..%2F_results')).status === 400, '[R3f] 일감 ID 조작 400');
console.log('[R4] 두 문이 같은 결과');
const c = new Client({ name: 'r', version: '1' }); await c.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:' + P + '/mcp'), { requestInit: { headers: { authorization: 'Bearer ' + TOKEN } } }));
const viaMcp = JSON.parse((await c.callTool({ name: 'dms_list', arguments: { resourceId: 'SUB' } })).content[0].text); const viaRest = (await req(P, 'GET', '/api/v1/folders/SUB/resources')).json;
ok(JSON.stringify(viaMcp) === JSON.stringify(viaRest), '[R4a] 같은 목록을 MCP와 REST로 읽으면 같은 JSON');
const mcpJob = JSON.parse((await c.callTool({ name: 'job_status', arguments: { job_id: 'rjob1' } })).content[0].text); ok(JSON.stringify(mcpJob) === JSON.stringify((await req(P, 'GET', '/api/v1/jobs/rjob1')).json), '[R4b] 일감 상태도 두 문에서 같음');
await c.close(); S.p.kill();
console.log('[R5] 닫은 기능은 REST로도 안 열림');
const S2 = await start({ NL_HTTP_TOOLS: 'job_put_chunk,job_status' });
w = writes(); const r5 = await req(S2.port, 'POST', '/api/v1/resources/F1/copy', { parentId: 'ALLOW' }); ok(r5.status === 403 && /not open/.test(r5.json.error) && writes() === w, '[R5a] 복사를 열지 않으면 REST 복사 403');
ok((await req(S2.port, 'GET', '/api/v1/folders/SUB/resources')).status === 403, '[R5b] 목록을 열지 않으면 REST 목록 403'); S2.p.kill();
console.log(`통과 ${pass} / 실패 ${fail}`);
fs.writeFileSync('./rest_log.txt', LOG.join('\n') + `\n통과 ${pass} / 실패 ${fail}\nMYBOX 호출 ${calls.length}건\n` + calls.join('\n'));
srv.close(); process.exit(fail ? 1 : 0);
