// 1.11.0 S4 읽기 전용 시험: 읽기 도구 3개의 허용 범위 · 검색 결과 걸러내기 · 쓰기 도구 닫힘 (가짜 MYBOX, 쓰기 0건)
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os'; import crypto from 'node:crypto'; import { spawn } from 'node:child_process';
const HTTPB = process.argv[2];
const JOBS = fs.mkdtempSync(path.join(os.tmpdir(), 'ro-'));
let pass = 0, fail = 0;
const ok = (c, m) => { (c ? pass++ : fail++); console.log((c ? '  OK   ' : '  FAIL ') + m); };
// ROOT ┬ OUT ─ OUTF(파일, 밖) ; ALLOW ┬ SUB ─ F1(파일) ; ALLOW ─ F2(파일) ; PSEUDOK(상위 조회가 400)
const T = { ROOT: null, OUT: 'ROOT', OUTF: 'OUT', ALLOW: 'ROOT', SUB: 'ALLOW', F1: 'SUB', F2: 'ALLOW', PSEUDOK: 'PSEUDO' };
const FILES = ['OUTF', 'F1', 'F2', 'PSEUDOK'], FOLDERS = ['OUT', 'ALLOW', 'SUB'];
const calls = [];
const srv = http.createServer((req, res) => { const ch = []; req.on('data', d => ch.push(d)); req.on('end', () => {
  const u = new URL(req.url, 'http://x'); calls.push(req.method + ' ' + u.pathname);
  const json = (o, s = 200) => { res.statusCode = s; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
  let m;
  if (req.method === 'GET' && (m = u.pathname.match(/^\/v1\/drive\/resources\/([^/]+)$/))) { const id = decodeURIComponent(m[1]);
    if (id === 'PSEUDO') return json({ error: 'bad' }, 400); if (!(id in T)) return json({ error: 'nf' }, 404); return json({ resourceId: id, parentId: T[id], name: id }); }
  if (req.method === 'GET' && (m = u.pathname.match(/^\/v1\/drive\/folders\/([^/]+)\/resources$/))) return json({ resources: Object.keys(T).filter(k => T[k] === m[1]).map(k => ({ resourceId: k, name: k })), responseMetaData: {} });
  if (req.method === 'GET' && u.pathname === '/v1/search/resources/files') return json({ resources: [...FILES.map(id => ({ resourceId: id, name: id, parentId: T[id] })), { resourceId: 'NOPARENT', name: 'x' }], responseMetaData: { nextCursor: 'c1' } });
  if (req.method === 'GET' && u.pathname === '/v1/search/resources/folders') return json({ resources: FOLDERS.map(id => ({ resourceId: id, name: id, parentId: T[id] })), responseMetaData: {} });
  json({ error: 'nf ' + u.pathname }, 404);
}); });
await new Promise(r => srv.listen(0, '127.0.0.1', r)); const BASE = 'http://127.0.0.1:' + srv.address().port + '/v1';
const TOKEN = crypto.randomBytes(24).toString('hex');
const READ = 'job_status,dms_list,dms_resourceId,search_files_resources,search_folders_resources';
const startHttp = (env = {}) => new Promise((resolve) => { const p = spawn('node', [HTTPB], { env: { ...process.env, NL_TRANSPORT: 'http', NL_HTTP_TOKEN: TOKEN, NL_HTTP_PORT: '0', MYBOX_ACCESS_TOKEN: 'dummy', MYBOX_BASE_URL: BASE, NL_JOBS_DIR: JOBS, NL_JOB_ALLOWED_PARENTS: 'tree:ALLOW', NL_HTTP_TOOLS: READ, ...env } });
  let err = ''; p.stderr.on('data', d => { err += d; const mm = err.match(/listening on http:\/\/[^:]+:(\d+)\/mcp/); if (mm) resolve({ p, port: +mm[1] }); }); p.on('exit', code => resolve({ exited: code, err })); setTimeout(() => resolve({ timeout: true, err }), 8000); });
const client = async (port) => { const c = new Client({ name: 'g', version: '1' }); await c.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:' + port + '/mcp'), { requestInit: { headers: { authorization: 'Bearer ' + TOKEN } } })); return c; };
const call = async (c, name, args) => { try { const r = await c.callTool({ name, arguments: args }); return { err: !!r.isError, text: r.content?.[0]?.text || '' }; } catch (e) { return { err: true, text: 'THROW ' + e.message }; } };
const writes = () => calls.filter(x => !x.startsWith('GET')).length;

const s = await startHttp(); ok(!!s.p, '읽기 도구 5개로 서버 시작');
const c = await client(s.port);
const names = (await c.listTools()).tools.map(t => t.name).sort();
ok(JSON.stringify(names) === JSON.stringify(READ.split(',').sort()), '열린 도구 = 읽기 5개 뿐 [' + names.join(',') + ']');
ok(!names.some(n => /copy|move|rename|delete|create|upload|download|put_chunk|trash/.test(n)), '쓰기·내려받기 도구 없음');
let r = await call(c, 'dms_resourceId', { resourceId: 'F1' }); ok(!r.err, 'dms_resourceId 허용 안 파일 → 성공');
r = await call(c, 'dms_resourceId', { resourceId: 'ALLOW' }); ok(!r.err, 'dms_resourceId 허용 뿌리 자체 → 성공');
r = await call(c, 'dms_resourceId', { resourceId: 'OUTF' }); ok(r.err, 'dms_resourceId 밖 파일 → 거절 [' + r.text.slice(0, 60) + ']');
r = await call(c, 'dms_resourceId', { resourceId: 'OUT' }); ok(r.err, 'dms_resourceId 밖 폴더 → 거절');
r = await call(c, 'dms_resourceId', { resourceId: '../../etc' }); ok(r.err, 'dms_resourceId 이상한 ID → 거절');
r = await call(c, 'dms_resourceId', { resourceId: 'PSEUDOK' }); ok(r.err, 'dms_resourceId 상위 조회 실패 → 거절(fail-closed)');
r = await call(c, 'search_files_resources', { q: 'x' }); let j = r.err ? {} : JSON.parse(r.text);
const ids = (j.resources || []).map(x => x.resourceId).sort();
ok(!r.err && JSON.stringify(ids) === JSON.stringify(['F1', 'F2']), '파일 검색: 허용 안 F1·F2만 [' + ids.join(',') + ']');
ok(j.filteredOut === 3, '파일 검색: 빠진 개수 3(밖 1·상위 조회 실패 1·상위 ID 없음 1) = ' + j.filteredOut);
ok(!r.text.includes('OUTF') && !r.text.includes('NOPARENT') && !r.text.includes('PSEUDOK'), '파일 검색: 밖 항목 이름이 응답에 없음');
r = await call(c, 'search_folders_resources', { q: 'x' }); j = r.err ? {} : JSON.parse(r.text);
ok(!r.err && JSON.stringify((j.resources || []).map(x => x.resourceId)) === JSON.stringify(['SUB']), '폴더 검색: SUB만(허용 뿌리 자체와 밖은 빠짐) [' + (j.resources || []).map(x => x.resourceId) + ']');
r = await call(c, 'dms_list', { resourceId: 'SUB' }); ok(!r.err, 'dms_list 허용 안 → 성공');
r = await call(c, 'dms_list', { resourceId: 'OUT' }); ok(r.err, 'dms_list 밖 → 거절');
r = await call(c, 'files_copy', { resourceId: 'F1', parentId: 'ALLOW' }); ok(r.err, 'files_copy 닫혀 있음');
r = await call(c, 'files_download', { resourceId: 'F1' }); ok(r.err, 'files_download 닫혀 있음');
ok(writes() === 0, 'MYBOX로 간 쓰기 요청 0건 (전체 호출 ' + calls.length + ')');
c.close?.(); s.p.kill();
const bad = await startHttp({ NL_HTTP_TOOLS: 'dms_list,files_upload' }); ok(bad.exited === 3, '지킴이 목록 밖 도구(files_upload)를 열면 시작 거부(종료 코드 3) [' + bad.exited + ']');
const w = await startHttp({ NL_HTTP_TOOLS: 'dms_list,files_trash_clean' }); ok(w.exited === 3, '영구 삭제 도구를 열면 시작 거부 [' + w.exited + ']');
console.log(`\n통과 ${pass} / 실패 ${fail}`); srv.close(); process.exit(fail ? 1 : 0);
