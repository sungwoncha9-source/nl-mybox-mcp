// 1.10.1: 내려받기 폴더 검사 + 작업 번호 접두어 시험 (가짜 MYBOX). 사용: node test/download_prefix.mjs <http번들> <stdio번들>
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os'; import crypto from 'node:crypto'; import { spawn } from 'node:child_process';
const [HTTPB, STDIOB] = process.argv.slice(2);
const JOBS = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-'));
let pass = 0, fail = 0; const ok = (c, m) => { (c ? pass++ : fail++); console.log((c ? '  OK   ' : '  FAIL ') + m); };
const T = { ROOT: null, OUT: 'ROOT', OUTF: 'OUT', ALLOW: 'ROOT', SUB: 'ALLOW', F1: 'SUB', F2: 'ALLOW' };
const calls = [];
const srv = http.createServer((req, res) => { const u = new URL(req.url, 'http://x'); calls.push(req.method + ' ' + u.pathname); let m;
  const json = (o, s = 200) => { res.statusCode = s; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
  if ((m = u.pathname.match(/^\/v1\/drive\/resources\/([^/]+)$/))) { const id = m[1]; return id in T ? json({ resourceId: id, parentId: T[id] }) : json({}, 404); }
  if ((m = u.pathname.match(/^\/v1\/drive\/files\/([^/]+)\/download$/))) return json({ url: 'https://dl.example/' + m[1] });
  json({}, 404); });
await new Promise(r => srv.listen(0, '127.0.0.1', r)); const BASE = 'http://127.0.0.1:' + srv.address().port + '/v1';
const TOKEN = crypto.randomBytes(24).toString('hex');
const ALL = 'job_put_chunk,job_status,dms_list,files_copy,files_move,files_create_folder,files_download';
const start = (env = {}) => new Promise((resolve) => { const p = spawn('node', [HTTPB], { env: { ...process.env, NL_TRANSPORT: 'http', NL_HTTP_TOKEN: TOKEN, NL_HTTP_PORT: '0', MYBOX_ACCESS_TOKEN: 'dummy', MYBOX_BASE_URL: BASE, NL_JOBS_DIR: JOBS, NL_JOB_ALLOWED_PARENTS: 'tree:ALLOW', NL_HTTP_TOOLS: ALL, ...env } });
  let err = ''; p.stderr.on('data', d => { err += d; const mm = err.match(/listening on http:\/\/[^:]+:(\d+)\/mcp/); if (mm) resolve({ p, port: +mm[1] }); }); p.on('exit', code => resolve({ exited: code })); setTimeout(() => resolve({ timeout: true }), 8000); });
const cli = async (port) => { const c = new Client({ name: 'g', version: '1' }); await c.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:' + port + '/mcp'), { requestInit: { headers: { authorization: 'Bearer ' + TOKEN } } })); return c; };
const call = async (c, name, args) => { try { const r = await c.callTool({ name, arguments: args }); return { err: !!r.isError, text: r.content?.[0]?.text || '' }; } catch (e) { return { err: true, text: 'THROW ' + e.message }; } };
const dlCalls = () => calls.filter(x => x.includes('/download')).length;
const rest = async (port, m, p) => { const r = await fetch('http://127.0.0.1:' + port + p, { method: m, headers: { authorization: 'Bearer ' + TOKEN } }); return r.status; };

let s = await start({ NL_JOB_PREFIX: 'pm-' }); let c = await cli(s.port);
const tl = (await c.listTools()).tools.map(t => t.name);
ok(tl.includes('files_download'), '도구 목록에 files_download');
let n = dlCalls(); let r = await call(c, 'files_download', { resourceId: 'F1' }); ok(!r.err && dlCalls() === n + 1, '허용 나무 안 파일(F1) 내려받기 성공');
r = await call(c, 'files_download', { resourceId: 'F2' }); ok(!r.err, '허용 폴더 바로 아래 파일(F2) 성공');
n = dlCalls(); r = await call(c, 'files_download', { resourceId: 'OUTF' }); ok(r.err && /not_allowed/.test(r.text) && dlCalls() === n, '밖 파일(OUTF) 거절, MYBOX 내려받기 호출 0');
n = dlCalls(); r = await call(c, 'files_download', { resourceId: 'ALLOW' }); ok(r.err && dlCalls() === n, '허용 폴더 자체 거절');
n = dlCalls(); r = await call(c, 'files_download', { resourceId: '../etc' }); ok(r.err && dlCalls() === n, '경로 조작 모양 ID 거절');
ok(await rest(s.port, 'GET', '/api/v1/resources/F1/download') === 200, 'REST 내려받기 허용 안 200');
ok(await rest(s.port, 'GET', '/api/v1/resources/OUTF/download') === 403, 'REST 내려받기 밖 403');
r = await call(c, 'job_status', { job_id: 'cs-1' }); ok(r.err && /not_allowed/.test(r.text), "접두어 밖 job_status('cs-1') 거절");
r = await call(c, 'job_status', { job_id: 'pm-1' }); ok(!r.err && /unknown/.test(r.text), "접두어 안 job_status('pm-1') 통과(unknown)");
r = await call(c, 'job_put_chunk', { job_id: 'cs-2', files: [{ name: 'a', size: 1, sha256: 'a'.repeat(64) }], file_name: 'a', offset: 0, content_base64: 'AA==', dry_run: true });
ok(r.err && /not_allowed/.test(r.text), '접두어 밖 job_put_chunk 거절');
ok(await rest(s.port, 'GET', '/api/v1/jobs/cs-1') === 403, 'REST 접두어 밖 403');
await c.close(); s.p.kill();
s = await start({}); c = await cli(s.port);
r = await call(c, 'job_status', { job_id: 'cs-1' }); ok(!r.err && /unknown/.test(r.text), '접두어 설정 없으면 이전과 같음(cs-1 통과)');
await c.close(); s.p.kill();
for (const bad of ['search_files_resources', 'search_folders_resources', 'files_download,files_upload']) { const e = await start({ NL_HTTP_TOOLS: bad }); ok(e.exited === 3, '지킴이 없는 도구(' + bad + ') HTTP 열기 → 시작 거부(3)'); }
// stdio(PC) 번들: 지킴이 꺼짐, 이전과 같음
const sc = new Client({ name: 's', version: '1' }); await sc.connect(new StdioClientTransport({ command: 'node', args: [STDIOB], env: { ...process.env, MYBOX_ACCESS_TOKEN: 'dummy', MYBOX_BASE_URL: BASE, NL_JOBS_DIR: JOBS, NL_JOB_PREFIX: '' } }));
r = await call(sc, 'files_download', { resourceId: 'OUTF' }); ok(!r.err, 'PC(stdio) 번들은 지킴이 없이 이전처럼 동작');
await sc.close(); srv.close();
console.log(`\n${pass} pass / ${fail} fail`); process.exit(fail ? 1 : 0);
