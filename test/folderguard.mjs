// 1.9.3 지킴이 시험: 바깥 공개 모드에서 목록·폴더 만들기·복사·이동의 허용 범위와 우회 시도
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os'; import crypto from 'node:crypto'; import { spawn } from 'node:child_process';
const HTTPB = process.argv[2], STDIOB = process.argv[3], ORIG_STDIO = process.argv[4];
const JOBS = fs.mkdtempSync(path.join(os.tmpdir(), 'gj-'));
let pass = 0, fail = 0; const LOG = [];
const ok = (c, m) => { (c ? pass++ : fail++); const l = (c ? '  OK   ' : '  FAIL ') + m; console.log(l); LOG.push(l); };
// 가짜 MYBOX 나무: ROOT ┬ OUT(밖) ─ OUTF(파일) ─ OUTSUB
//                        └ ALLOW(허용 나무 뿌리) ┬ SUB ─ F1(파일)
//                                                └ F2(파일)
//                        PSEUDO: 상위를 물으면 400 (드라이브 뿌리 너머 흉내)
const T = { ROOT: null, OUT: 'ROOT', OUTF: 'OUT', OUTSUB: 'OUT', ALLOW: 'ROOT', SUB: 'ALLOW', F1: 'SUB', F2: 'ALLOW', PSEUDOK: 'PSEUDO' };
const isFolder = { ROOT: 1, OUT: 1, OUTSUB: 1, ALLOW: 1, SUB: 1 };
const calls = [];
const srv = http.createServer((req, res) => { const ch = []; req.on('data', d => ch.push(d)); req.on('end', () => {
  const u = new URL(req.url, 'http://x'); calls.push(req.method + ' ' + u.pathname);
  const json = (o, s = 200) => { res.statusCode = s; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
  let m;
  if (req.method === 'GET' && (m = u.pathname.match(/^\/v1\/drive\/resources\/([^/]+)$/))) { const id = decodeURIComponent(m[1]);
    if (id === 'PSEUDO') return json({ error: 'bad' }, 400); if (!(id in T)) return json({ error: 'nf' }, 404); return json({ resourceId: id, parentId: T[id] }); }
  if (req.method === 'GET' && (m = u.pathname.match(/^\/v1\/drive\/folders\/([^/]+)\/resources$/))) return json({ resources: Object.keys(T).filter(k => T[k] === m[1]).map(k => ({ resourceId: k, name: k })), responseMetaData: {} });
  if (req.method === 'POST' && u.pathname === '/v1/drive/folders') { const b = JSON.parse(Buffer.concat(ch)); const id = 'NEW' + crypto.randomUUID().slice(0, 6); T[id] = b.parentId || 'ROOT'; isFolder[id] = 1; return json({ resourceId: id }); }
  if (req.method === 'POST' && (m = u.pathname.match(/^\/v1\/drive\/resources\/([^/]+)\/(copy|move)$/))) { const b = JSON.parse(Buffer.concat(ch)); const id = m[1];
    if (m[2] === 'move') T[id] = b.parentId; else T[id + '_copy' + crypto.randomUUID().slice(0, 4)] = b.parentId; return json({ ok: true, resourceId: id }); }
  json({ error: 'nf ' + u.pathname }, 404);
}); });
await new Promise(r => srv.listen(0, '127.0.0.1', r)); const BASE = 'http://127.0.0.1:' + srv.address().port + '/v1';
const TOKEN = crypto.randomBytes(24).toString('hex');
const ALL6 = 'job_put_chunk,job_status,dms_list,files_copy,files_move,files_create_folder';
const startHttp = (env = {}) => new Promise((resolve) => { const p = spawn('node', [HTTPB], { env: { ...process.env, NL_TRANSPORT: 'http', NL_HTTP_TOKEN: TOKEN, NL_HTTP_PORT: '0', MYBOX_ACCESS_TOKEN: 'dummy', MYBOX_BASE_URL: BASE, NL_JOBS_DIR: JOBS, NL_JOB_ALLOWED_PARENTS: 'tree:ALLOW', NL_HTTP_TOOLS: ALL6, ...env } });
  let err = ''; p.stderr.on('data', d => { err += d; const mm = err.match(/listening on http:\/\/[^:]+:(\d+)\/mcp/); if (mm) resolve({ p, port: +mm[1] }); }); p.on('exit', code => resolve({ exited: code, err })); setTimeout(() => resolve({ timeout: true, err }), 8000); });
const httpClient = async (port) => { const c = new Client({ name: 'g', version: '1' }); await c.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:' + port + '/mcp'), { requestInit: { headers: { authorization: 'Bearer ' + TOKEN } } })); return c; };
const stdioClient = async (bundle, env = {}) => { const c = new Client({ name: 's', version: '1' }); await c.connect(new StdioClientTransport({ command: 'node', args: [bundle], env: { ...process.env, MYBOX_ACCESS_TOKEN: 'dummy', MYBOX_BASE_URL: BASE, NL_JOBS_DIR: JOBS, ...env } })); return c; };
const tryCall = async (c, name, args) => { try { const r = await c.callTool({ name, arguments: args }); return { err: !!r.isError, text: r.content?.[0]?.text || '' }; } catch (e) { return { err: true, text: 'THROW ' + e.message }; } };
const writes = () => calls.filter(x => x.startsWith('POST')).length;
const expectDeny = async (c, name, args, label) => { const w = writes(); const r = await tryCall(c, name, args); ok(r.err && writes() === w, label + ' → 거절, MYBOX 쓰기 0 [' + r.text.slice(0, 70).replace(/\n/g, ' ') + ']'); };
const expectOk = async (c, name, args, label) => { const r = await tryCall(c, name, args); ok(!r.err, label + ' → 성공' + (r.err ? ' [' + r.text.slice(0, 80) + ']' : '')); };

console.log('[G0] 시작 조건 (바깥 공개 모드는 닫힌 쪽이 기본)');
const g0a = await startHttp({ NL_JOB_ALLOWED_PARENTS: '' }); ok(g0a.exited === 3, '[G0a] 허용 목록이 비면 시작하지 않음');
const g0b = await startHttp({ NL_HTTP_TOOLS: ALL6 + ',files_delete' }); ok(g0b.exited === 3 && /files_delete/.test(g0b.err), '[G0b] 지킴이 없는 도구(files_delete)를 열려 하면 시작하지 않음');
const g0c = await startHttp({ NL_HTTP_TOOLS: ALL6 + ',files_trash_clean' }); ok(g0c.exited === 3, '[G0c] 휴지통 비우기를 열려 하면 시작하지 않음');
const g0d = await startHttp({ NL_JOB_ALLOWED_PARENTS: 'tree:A/../B' }); ok(g0d.exited === 3, '[G0d] 허용 목록 ID에 경로 문자가 있으면 시작하지 않음');
const S = await startHttp(); const c = await httpClient(S.port);
const listed = (await c.listTools()).tools.map(t => t.name).sort();
ok(JSON.stringify(listed) === JSON.stringify(ALL6.split(',').sort()), '[G0e] HTTP로 보이는 도구는 6개뿐: ' + listed.join(','));

console.log('[G1] 조회'); 
await expectOk(c, 'dms_list', { resourceId: 'ALLOW' }, '[G1a] 허용 뿌리 목록');
await expectOk(c, 'dms_list', { resourceId: 'SUB' }, '[G1b] 허용 하위 목록');
await expectDeny(c, 'dms_list', { resourceId: 'OUT' }, '[G1c] 밖 폴더 목록');
await expectDeny(c, 'dms_list', { resourceId: 'ROOT' }, '[G1d] 드라이브 뿌리 목록');
await expectDeny(c, 'dms_list', { resourceId: 'PSEUDOK' }, '[G1e] 상위를 읽다 400이 나는 폴더(뿌리 너머) 목록');

console.log('[G2] 폴더 만들기');
await expectOk(c, 'files_create_folder', { folderName: 'n1', parentId: 'SUB' }, '[G2a] 허용 하위에 만들기');
await expectDeny(c, 'files_create_folder', { folderName: 'n2', parentId: 'OUT' }, '[G2b] 밖에 만들기');
await expectDeny(c, 'files_create_folder', { folderName: 'n3' }, '[G2c] 상위 폴더 생략(=드라이브 뿌리)');
await expectDeny(c, 'files_create_folder', { folderName: 'n4', parentId: 'SUB/../../OUT' }, '[G2d] 상위 ID에 ../ 조작');

console.log('[G3] 복사');
await expectOk(c, 'files_copy', { resourceId: 'F1', parentId: 'ALLOW' }, '[G3a] 허용 안 파일 → 허용 안');
await expectDeny(c, 'files_copy', { resourceId: 'F1', parentId: 'OUT' }, '[G3b] 허용 안 파일 → 밖 (빼내기)');
await expectDeny(c, 'files_copy', { resourceId: 'OUTF', parentId: 'ALLOW' }, '[G3c] 밖 파일 → 허용 안 (끌어오기)');
await expectDeny(c, 'files_copy', { resourceId: 'F1' }, '[G3d] 목적지 생략(=뿌리)');
await expectDeny(c, 'files_copy', { resourceId: 'ALLOW', parentId: 'SUB' }, '[G3e] 허용 뿌리 자체 복사');
await expectDeny(c, 'files_copy', { resourceId: 'F1/../../OUTF/copy?x=', parentId: 'ALLOW' }, '[G3f] 원본 ID 경로 조작');
await expectDeny(c, 'files_copy', { resourceId: 'NOPE', parentId: 'ALLOW' }, '[G3g] 없는 원본 ID(404)');

console.log('[G4] 이동');
await expectOk(c, 'files_move', { resourceId: 'F2', parentId: 'SUB' }, '[G4a] 허용 안 파일 → 허용 하위');
ok(T.F2 === 'SUB', '[G4a′] 가짜 MYBOX에서 F2가 SUB로 옮겨짐');
await expectDeny(c, 'files_move', { resourceId: 'F1', parentId: 'OUT' }, '[G4b] 허용 안 파일 → 밖');
await expectDeny(c, 'files_move', { resourceId: 'OUTF', parentId: 'SUB' }, '[G4c] 밖 파일 → 허용 안');
await expectDeny(c, 'files_move', { resourceId: 'ALLOW', parentId: 'OUT' }, '[G4d] 허용 뿌리 자체를 밖으로');
await expectDeny(c, 'files_move', { resourceId: 'SUB', parentId: 'OUTSUB' }, '[G4e] 허용 하위 폴더를 통째로 밖으로');
await expectDeny(c, 'files_move', { resourceId: 'F1', parentId: 'SUB%2F..%2FOUT' }, '[G4f] 목적지 ID 인코딩 조작');
await expectDeny(c, 'files_move', { resourceId: 'F1 ', parentId: 'SUB' }, '[G4g] 원본 ID 뒤 공백');
await expectDeny(c, 'files_move', { resourceId: 'F1', parentId: 'x'.repeat(301) }, '[G4h] 300자 넘는 ID');
ok(T.F1 === 'SUB' && T.ALLOW === 'ROOT' && T.SUB === 'ALLOW' && T.OUTF === 'OUT', '[G4i] 거절된 뒤 가짜 MYBOX 나무가 그대로');

console.log('[G5] 열지 않은 도구 우회');
for (const t of ['files_delete', 'files_rename', 'files_trash_clean', 'dms_root', 'search_files_resources', 'files_upload_from_path', 'files_download_to_path'])
  await expectDeny(c, t, { resourceId: 'F1', name: 'x', filePath: '/etc/passwd', destDir: '/tmp', q: 'a' }, '[G5] ' + t + ' 호출');

console.log('[G6] 일감 도구');
const buf = Buffer.from('hello-guard'); const s = crypto.createHash('sha256').update(buf).digest('hex');
const ja = (id, pid) => ({ job_id: id, files: [{ name: 'g.png', size: buf.length, sha256: s }], file_name: 'g.png', offset: 0, content_base64: buf.toString('base64'), parent_id: pid });
await expectDeny(c, 'job_put_chunk', ja('gjob1', 'OUT'), '[G6a] 밖 폴더로 일감');
await expectDeny(c, 'job_put_chunk', ja('../../etc', 'SUB'), '[G6b] 일감 ID 경로 조작');
const st = await tryCall(c, 'job_status', { job_id: '../_results/x' }); ok(st.err, '[G6c] job_status ID 경로 조작 거절');
await c.close(); S.p.kill();

console.log('[G7] PC 경로(stdio, 지킴이 꺼짐)는 동작이 같다');
for (const [lab, b] of [['수정판', STDIOB], ['원본', ORIG_STDIO]]) {
  const sc = await stdioClient(b); const r = await tryCall(sc, 'files_copy', { resourceId: 'OUTF', parentId: 'OUT' });
  const r2 = await tryCall(sc, 'dms_list', { resourceId: 'OUT' });
  ok(!r.err && !r2.err, '[G7] ' + lab + ' stdio: 밖 폴더 복사·목록이 지금처럼 됨(PC Claude 세션 읽기용 동작 보존)'); await sc.close(); }
const gs = await stdioClient(STDIOB, { NL_TOOL_GUARD: '1', NL_JOB_ALLOWED_PARENTS: 'tree:ALLOW' });
await expectDeny(gs, 'files_copy', { resourceId: 'OUTF', parentId: 'ALLOW' }, '[G7c] stdio라도 NL_TOOL_GUARD=1이면 지킴이 켜짐'); await gs.close();

console.log(`통과 ${pass} / 실패 ${fail}`);
fs.writeFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'guard_log.txt'), LOG.join('\n') + `\n통과 ${pass} / 실패 ${fail}\nMYBOX 호출 ${calls.length}건\n` + calls.join('\n'));
srv.close(); process.exit(fail ? 1 : 0);
