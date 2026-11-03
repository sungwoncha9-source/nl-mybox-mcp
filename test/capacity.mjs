import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import crypto from 'node:crypto'; import os from 'node:os';

const BUNDLE = process.argv[2];
const JOBS = fs.mkdtempSync(path.join(os.tmpdir(), 'jobs-'));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  OK  ' + m); } else { fail++; console.log('  FAIL ' + m); } };

// ---- 가짜 MYBOX ----
const store = new Map(); const calls = []; let uploadDelay = 0; const folderCalls = []; // 가짜 MYBOX의 올리기 지연(느린 네트워크 흉내)
const srv = http.createServer((req, res) => {
  const chunks = []; req.on('data', d => chunks.push(d)); req.on('end', () => {
    const body = Buffer.concat(chunks); const url = new URL(req.url, 'http://x'); calls.push(req.method + ' ' + url.pathname);
    const json = (o) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
    if (req.method === 'POST' && url.pathname === '/v1/drive/folders') { const b = JSON.parse(body); const id = 'FD' + crypto.randomUUID().slice(0, 8);
      folderCalls.push(b); store.set(id, { name: b.folderName, parent: b.parentId || 'root', size: 0, isFolder: true }); return json({ resourceId: id, name: b.folderName }); }
    if (req.method === 'POST' && url.pathname === '/v1/drive/files') { const b = JSON.parse(body); const id = crypto.randomUUID();
      store.set(id, { name: b.fileName, parent: b.parentId || 'root', declared: b.fileSize, size: null });
      return json({ uploadUrl: 'http://127.0.0.1:' + srv.address().port + '/upload/' + id }); }
    if (req.method === 'POST' && url.pathname.startsWith('/upload/')) { const id = url.pathname.split('/')[2];
      const finish = () => { if (/^fail/.test(store.get(id).name)) { res.statusCode = 500; return res.end('boom'); }
        const s = body.indexOf('\r\n\r\n') + 4, e = body.lastIndexOf('\r\n--'); const nm = store.get(id).name; let data = Buffer.from(body.subarray(s, e)); if (/^samesize/.test(nm)) data[0] ^= 0xff; store.get(id).data = data; store.get(id).size = /^short/.test(nm) ? e - s - 1 : e - s; res.statusCode = 200; res.end('ok'); };
      return uploadDelay ? setTimeout(finish, uploadDelay) : finish(); }
    const dm = url.pathname.match(/^\/v1\/drive\/files\/([^/]+)\/download$/);
    if (req.method === 'GET' && dm) return json({ downloadUrl: 'http://127.0.0.1:' + srv.address().port + '/dl/' + dm[1] });
    if (req.method === 'GET' && url.pathname.startsWith('/dl/')) { const f = store.get(url.pathname.split('/')[2]); res.setHeader('content-type', 'application/octet-stream'); return res.end(f && f.data || Buffer.alloc(0)); }
    const rm = url.pathname.match(/^\/v1\/drive\/resources\/([^/]+)$/);
    if (req.method === 'GET' && rm) { const f = store.get(rm[1]); return json({ resourceId: rm[1], parentId: f ? f.parent : null, name: f ? f.name : null }); }
    const m = url.pathname.match(/^\/v1\/drive\/(?:folders\/([^/]+)\/)?resources$/);
    if (req.method === 'GET' && m) { const parent = m[1] || 'root';
      return json({ resources: [...store.entries()].filter(([, x]) => x.parent === parent && x.size != null).map(([id, x]) => ({ resourceId: id, name: x.name, size: x.size })), responseMetaData: {} }); }
    res.statusCode = 404; res.end('nf');
  });
});
await new Promise(r => srv.listen(0, '127.0.0.1', r));

const connect = async (extra = {}) => { const c = new Client({ name: 't', version: '1' });
  await c.connect(new StdioClientTransport({ command: 'node', args: [BUNDLE], env: { ...process.env, MYBOX_ACCESS_TOKEN: 'dummy', MYBOX_BASE_URL: 'http://127.0.0.1:' + srv.address().port + '/v1', NL_JOBS_DIR: JOBS, ...extra } })); return c; };
const call = async (c, name, args) => { const r = await c.callTool({ name, arguments: args }); const t = r.content?.[0]?.text; if (r.isError) { const e = new Error(t); e.isErr = true; throw e; } return JSON.parse(t); };
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const CH = 600 * 1024;
const mkChunks = (id, files, extra = {}) => { const specs = files.map(f => ({ name: f.name, size: f.buf.length, sha256: sha(f.buf) })); const out = [];
  for (const f of files) for (let o = 0; o < f.buf.length; o += CH) out.push({ job_id: id, files: specs, file_name: f.name, offset: o, content_base64: f.buf.subarray(o, Math.min(o + CH, f.buf.length)).toString('base64'), ...extra });
  return out; };
const waitState = async (c, id, want) => { for (let i = 0; i < 100; i++) { const s = await call(c, 'job_status', { job_id: id }); if (want.includes(s.state)) return s; await new Promise(r => setTimeout(r, 50)); } return await call(c, 'job_status', { job_id: id }); };


// ===== 용량 기준 시험 (v1.9.1): 호출 수 · MYBOX 요청 수 · 소요 시간 · 서버 최대 메모리 · 작업 폴더 디스크 =====
import { spawn } from 'node:child_process';
const packOf = (entries) => { const man = Buffer.from(JSON.stringify({ entries: entries.map(e => ({ name: e.name, size: e.buf.length, sha256: e.sha ?? sha(e.buf), ...(e.parent_id ? { parent_id: e.parent_id } : {}) })) }), 'utf8'); const h = Buffer.alloc(8); h.write('NLP1', 0, 'latin1'); h.writeUInt32BE(man.length, 4); return Buffer.concat([h, man, ...entries.map(e => e.buf)]); };
const CHB = 700 * 1024;
const chunksOf = (id, pack, extra = {}) => { const specs = [{ name: 'b.pack', size: pack.length, sha256: sha(pack) }]; const out = []; for (let o = 0; o < pack.length; o += CHB) out.push({ job_id: id, files: specs, file_name: 'b.pack', offset: o, content_base64: pack.subarray(o, Math.min(o + CHB, pack.length)).toString('base64'), bundle: 'pack1', ...extra }); return out; };
const du = (d) => { let n = 0; try { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); n += e.isDirectory() ? du(p) : fs.statSync(p).size; } } catch { } return n; };
let tr = null;
const conn = async (extra = {}) => { const c = new Client({ name: 't', version: '1' }); tr = new StdioClientTransport({ command: 'node', args: [BUNDLE], env: { ...process.env, MYBOX_ACCESS_TOKEN: 'dummy', MYBOX_BASE_URL: 'http://127.0.0.1:' + srv.address().port + '/v1', NL_JOBS_DIR: JOBS, ...extra } }); await c.connect(tr); return c; };
const rssPeak = (pid) => { try { const t = fs.readFileSync('/proc/' + pid + '/status', 'utf8'); return Number((t.match(/VmHWM:\s+(\d+)/) || [])[1] || 0) / 1024; } catch { return 0; } };
const pool = async (items, n, fn) => { const out = new Array(items.length); let i = 0; await Promise.all(Array.from({ length: n }, async () => { for (;;) { const k = i++; if (k >= items.length) return; out[k] = await fn(items[k], k); } })); return out; };
const rows = [];
async function scenario(label, nFiles, fileBytes, extra = {}) {
  const c = await conn(); const pid = tr.pid;
  const ents = Array.from({ length: nFiles }, (_, i) => ({ name: `S${rows.length}_B${i}.png`, buf: crypto.randomBytes(fileBytes), parent_id: "CAT" + (i % 3) }));
  const pack = packOf(ents), ch = chunksOf('bn' + rows.length, pack, { parent_id: 'F0', wait_ms: 120000, ...extra });
  const mybox0 = calls.length; const t0 = Date.now(); let maxDisk = 0; const dsk = setInterval(() => { maxDisk = Math.max(maxDisk, du(JOBS)); }, 100);
  const rs = await pool(ch, 8, a => call(c, 'job_put_chunk', a)); const tSend = Date.now() - t0;
  const fin = rs.find(r => r.completed_by_this_call); clearInterval(dsk);
  const myboxReq = calls.slice(mybox0).filter(x => x.startsWith('POST /v1/drive/files') || x.startsWith('GET /v1/drive/folders')).length;
  rows.push({ label, files: nFiles, perFile: fileBytes, packMB: +(pack.length / 1048576).toFixed(2), chunkCalls: ch.length, b64MB: +(ch.reduce((a, x) => a + x.content_base64.length, 0) / 1048576).toFixed(2), uploads: calls.slice(mybox0).filter(x => x === 'POST /v1/drive/files').length, myboxReq, ms: Date.now() - t0, rssMB: Math.round(rssPeak(pid)), diskMB: +(maxDisk / 1048576).toFixed(1), ok: !!fin && fin.state === 'done' && fin.entries.every(e => e.verified), state: fin ? fin.state : 'no-final', err: fin && fin.error ? fin.error.slice(0, 70) : '' });
  await c.close();
  for (const e of ents) e.buf = null;
}
await scenario('50×84KB', 50, 84742);
await scenario('50×600KB', 50, 600 * 1024);
await scenario('50×2MB', 50, 2 * 1024 * 1024);
await scenario('3×66MB(묶음 약199MiB 직전)', 3, 66 * 1024 * 1024 - 1000 + 0);
// 200MiB 경계: 묶음 크기가 maxFile(200MiB) 이하인 최대치와 바로 위
{ const c = await conn(); const big = Buffer.alloc(201 * 1024 * 1024, 1); const spec = [{ name: 'big.pack', size: big.length, sha256: 'a'.repeat(64) }];
  let e = null; try { await call(c, 'job_put_chunk', { job_id: 'bn_big', files: spec, file_name: 'big.pack', offset: 0, content_base64: Buffer.alloc(1000).toString('base64'), bundle: 'pack1', parent_id: 'F0' }); } catch (er) { e = er; }
  rows.push({ label: '201MiB 묶음(경계 초과)', rejected: !!e, why: e && e.message.slice(0, 60) }); await c.close(); }
console.table(rows.map(r => r.rejected !== undefined ? r : ({ 시나리오: r.label, 파일: r.files, 묶음MB: r.packMB, 'MCP 호출': r.chunkCalls, 'base64 MB': r.b64MB, 'MYBOX 올리기': r.uploads, 'MYBOX 요청(올리기+목록)': r.myboxReq, 'ms(전송~완료)': r.ms, '서버 최대 RSS MB': r.rssMB, '작업폴더 최대 MB': r.diskMB, 결과: r.ok ? 'OK' : r.state + ' ' + r.err })));
ok(rows.slice(0, 3).every(r => r.ok && r.uploads === r.files), '[D1] 50×84KB/600KB/2MB 모두 done·전부 verified·올리기 요청 정확히 50번');
ok(rows[3].ok, '[D2] 묶음 약 198MiB(파일 3개)도 done·verified (state=' + rows[3].state + ' ' + rows[3].err + ')');
ok(rows[4].rejected, '[D3] 201MiB 묶음은 첫 조각에서 거절');
ok(rows[3].rssMB < 300, '[D4] 198MiB 묶음 처리 중 서버 최대 메모리가 묶음 크기(198MiB)보다 작다(스트리밍): ' + rows[3].rssMB + 'MB');

// 부분 전송 도중 서버 프로세스를 강제 종료한 뒤 재시작해 이어 받기
console.log('[D5] 전송 도중 서버 강제 종료 → 재시작 → 이어서 보내기');
{ const ents = Array.from({ length: 20 }, (_, i) => ({ name: `K${i}.png`, buf: crypto.randomBytes(1000000), parent_id: 'CATK' })); const pack = packOf(ents); const ch = chunksOf('bk1', pack, { parent_id: 'F0', wait_ms: 60000 });
  let c = await conn(); const half = ch.slice(0, Math.floor(ch.length / 2)); await pool(half, 4, a => call(c, 'job_put_chunk', a));
  const s1 = await call(c, 'job_status', { job_id: 'bk1' }); process.kill(tr.pid, 'SIGKILL'); await new Promise(r => setTimeout(r, 300)); try { await c.close(); } catch { }
  c = await conn(); const s2 = await call(c, 'job_status', { job_id: 'bk1' });
  ok(s2.state === 'receiving' && s2.files[0].received === s1.files[0].received, '[D5a] 재시작 뒤에도 받은 위치가 남아 있다(' + s1.files[0].received + ' → ' + s2.files[0].received + ' B)');
  const up0 = calls.filter(x => x === 'POST /v1/drive/files').length; const rs = await pool(ch, 6, a => call(c, 'job_put_chunk', a)); const fin = rs.find(r => r.completed_by_this_call);
  ok(fin && fin.state === 'done' && fin.entries.every(e => e.verified), '[D5b] 처음부터 다시 보내도(받은 조각은 무시) 끝까지 마무리되고 전부 verified');
  ok(calls.filter(x => x === 'POST /v1/drive/files').length - up0 === 20 && inFolderK() === 20, '[D5c] MYBOX에는 정확히 20개만 올라갔다(중복 0)'); await c.close(); }
function inFolderK() { return [...store.values()].filter(x => x.parent === 'CATK' && !x.isFolder && x.size != null).length; }
srv.close();
console.log(`\n통과 ${pass} / 실패 ${fail}`); fs.rmSync(JOBS, { recursive: true, force: true }); process.exit(fail ? 1 : 0);
