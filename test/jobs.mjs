import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import crypto from 'node:crypto'; import os from 'node:os';

const BUNDLE = process.argv[2];
const JOBS = fs.mkdtempSync(path.join(os.tmpdir(), 'jobs-'));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  OK  ' + m); } else { fail++; console.log('  FAIL ' + m); } };

// ---- 가짜 MYBOX ----
const store = new Map(); const calls = [];
const srv = http.createServer((req, res) => {
  const chunks = []; req.on('data', d => chunks.push(d)); req.on('end', () => {
    const body = Buffer.concat(chunks); const url = new URL(req.url, 'http://x'); calls.push(req.method + ' ' + url.pathname);
    const json = (o) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
    if (req.method === 'POST' && url.pathname === '/v1/drive/files') { const b = JSON.parse(body); const id = crypto.randomUUID();
      store.set(id, { name: b.fileName, parent: b.parentId || 'root', declared: b.fileSize, size: null });
      return json({ uploadUrl: 'http://127.0.0.1:' + srv.address().port + '/upload/' + id }); }
    if (req.method === 'POST' && url.pathname.startsWith('/upload/')) { const id = url.pathname.split('/')[2];
      const s = body.indexOf('\r\n\r\n') + 4, e = body.lastIndexOf('\r\n--'); store.get(id).size = e - s; res.statusCode = 200; return res.end('ok'); }
    const m = url.pathname.match(/^\/v1\/drive\/(?:folders\/([^/]+)\/)?resources$/);
    if (req.method === 'GET' && m) { const parent = m[1] || 'root';
      return json({ resources: [...store.values()].filter(x => x.parent === parent && x.size != null).map(x => ({ name: x.name, size: x.size })), responseMetaData: {} }); }
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

const c = await connect();
const tools = (await c.listTools()).tools.map(t => t.name);
console.log('도구 수', tools.length);
ok(tools.includes('job_put_chunk') && tools.includes('job_status') && tools.includes('files_upload_from_path'), '기존 도구 + job 도구 2개가 보인다');

// 1) 섞은 순서 + 동시 전송 + 중복 조각 → 올리기 → 대조 → _trash
console.log('[1] 3개 파일, 섞어서 동시 전송');
const files = [{ name: 'a.png', buf: crypto.randomBytes(1900000) }, { name: 'b 한글.png', buf: crypto.randomBytes(700000) }, { name: 'c.bin', buf: crypto.randomBytes(5000000) }];
let ch = mkChunks('job1', files, { parent_id: 'F1', is_overwrite: false }); ch = shuffle([...ch, ch[0], ch[3]]);
const rs = await Promise.allSettled(ch.map(a => call(c, 'job_put_chunk', a)));
ok(rs.every(r => r.status === 'fulfilled'), `조각 ${ch.length}개(중복 2개 포함) 모두 성공 응답`);
const st = await waitState(c, 'job1', ['done', 'failed']);
ok(st.state === 'done', '마무리 상태 done (실제: ' + st.state + (st.error ? ' / ' + st.error : '') + ')');
ok(st.files.every(f => f.done && f.uploaded && f.verified), '모든 파일 done·uploaded·verified');
const up = [...store.values()].filter(x => x.parent === 'F1');
ok(up.length === 3 && files.every(f => up.find(x => x.name === f.name && x.size === f.buf.length)), 'MYBOX(가짜)에 3개가 같은 크기로 도착');
ok(!fs.existsSync(path.join(JOBS, 'job1')) && fs.readdirSync(path.join(JOBS, '_trash')).some(n => n.startsWith('job1_')), '작업 폴더가 _trash로 옮겨졌다(삭제 아님)');
const tdir = path.join(JOBS, '_trash', fs.readdirSync(path.join(JOBS, '_trash')).find(n => n.startsWith('job1_')));
ok(files.every(f => sha(fs.readFileSync(path.join(tdir, f.name))) === sha(f.buf)), '_trash 안 파일의 sha256이 원본과 같다');

// 2) 깨진 조각, 불일치, 나쁜 이름, 범위 밖
console.log('[2] 오류 경로');
const f2 = [{ name: 'x.bin', buf: crypto.randomBytes(900000) }];
let bad = mkChunks('job2', f2, { dry_run: true }); bad[1] = { ...bad[1], content_base64: crypto.randomBytes(bad[1].content_base64.length / 4 * 3 - 0 | 0).toString('base64').slice(0, bad[1].content_base64.length) };
let e1 = null; const r0 = await call(c, 'job_put_chunk', bad[0]); try { await call(c, 'job_put_chunk', bad[1]); } catch (e) { e1 = e; }
ok(e1 && /sha256 불일치/.test(e1.message), '깨진 조각 → sha256 불일치 오류');
const s2 = await call(c, 'job_status', { job_id: 'job2' }); ok(s2.files[0].received === 0 && !s2.files[0].done, '불일치 뒤 그 파일은 처음 상태로 돌아감');
for (const a of mkChunks('job2', f2, { dry_run: true })) await call(c, 'job_put_chunk', a);
const s2b = await waitState(c, 'job2', ['dry_run_done', 'failed']); ok(s2b.state === 'dry_run_done', '처음부터 다시 보내면 dry_run_done (MYBOX 호출 없음)');
const before = calls.length;
let e2 = null; try { await call(c, 'job_put_chunk', { ...mkChunks('job2', [{ name: 'x.bin', buf: f2[0].buf }], { dry_run: false })[0] }); } catch (e) { e2 = e; }
ok(e2 && /job_mismatch/.test(e2.message), '같은 job_id에 옵션이 다르면 job_mismatch');
for (const n of ['../evil.bin', 'a/b.bin', 'x.part', 'state.json', '.hidden']) { let e = null; try { await call(c, 'job_put_chunk', { job_id: 'job3', files: [{ name: n, size: 3, sha256: sha(Buffer.from('abc')) }], file_name: n, offset: 0, content_base64: Buffer.from('abc').toString('base64') }); } catch (er) { e = er; } ok(!!e, '나쁜 이름 거절: ' + n); }
let e3 = null; try { await call(c, 'job_put_chunk', { job_id: 'job4', files: [{ name: 'o.bin', size: 3, sha256: sha(Buffer.from('abc')) }], file_name: 'o.bin', offset: 2, content_base64: Buffer.from('abc').toString('base64') }); } catch (e) { e3 = e; }
ok(!!e3, 'offset+크기가 파일 크기를 넘으면 거절');
ok(calls.length === before, 'dry_run 일감은 MYBOX를 한 번도 부르지 않았다');

// 3) 프로세스가 중간에 꺼졌다가 다시 떠도 이어 받는다
console.log('[3] 중간 재시작');
const f5 = [{ name: 'r.bin', buf: crypto.randomBytes(3000000) }]; const ch5 = shuffle(mkChunks('job5', f5, { dry_run: true }));
for (const a of ch5.slice(0, 3)) await call(c, 'job_put_chunk', a);
await c.close();
const c2 = await connect();
const mid = await call(c2, 'job_status', { job_id: 'job5' }); ok(!mid.files[0].done && mid.files[0].received > 0, '다시 뜬 뒤 진행 기록이 남아 있다 (받은 ' + mid.files[0].received + ' B)');
for (const a of ch5.slice(3)) await call(c2, 'job_put_chunk', a);
const s5 = await waitState(c2, 'job5', ['dry_run_done', 'failed']); ok(s5.state === 'dry_run_done' && s5.files[0].done, '나머지 조각만 보내 완료');
// 4) 멈춘 일감 만료
console.log('[4] 멈춘 일감 만료 (NL_JOB_IDLE_SEC=2)');
await c2.close();
const c3 = await connect({ NL_JOB_IDLE_SEC: '2' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const f6 = [{ name: 's.bin', buf: crypto.randomBytes(2400000) }], ch6 = mkChunks('job6', f6, { dry_run: true });
const f7 = [{ name: 'k.bin', buf: crypto.randomBytes(2400000) }], ch7 = mkChunks('job7', f7, { dry_run: true });
await call(c3, 'job_put_chunk', ch6[0]); await call(c3, 'job_put_chunk', ch6[1]); await call(c3, 'job_put_chunk', ch7[0]);
await sleep(1200); await call(c3, 'job_put_chunk', ch7[1]);   // job7만 활동
await sleep(1200);
const s6a = await call(c3, 'job_status', { job_id: 'job6' }), s7a = await call(c3, 'job_status', { job_id: 'job7' });
ok(s6a.state === 'failed' && /timeout/.test(s6a.error || ''), 'job6: 2초 넘게 조용하면 failed(timeout)');
ok(s7a.state === 'receiving', 'job7: 방금 조각이 와서 아직 receiving (활동하면 만료가 미뤄진다)');
ok(!fs.existsSync(path.join(JOBS, 'job6')) && fs.readdirSync(path.join(JOBS, '_trash')).some(n => n.startsWith('job6_expired_')), 'job6 작업 폴더가 _trash로 옮겨졌다(삭제 아님)');
ok(fs.existsSync(path.join(JOBS, 'job7')), 'job7 작업 폴더는 그대로');
const r6 = await call(c3, 'job_put_chunk', ch6[2]);
ok(r6.accepted === false && /새 job_id/.test(r6.note || ''), '만료된 job6에 조각을 또 보내면 거절하고 새 job_id를 안내');
await sleep(2300);
const s7b = await call(c3, 'job_status', { job_id: 'job7' });
ok(s7b.state === 'failed', 'job7도 조용해진 뒤 만료');
await c3.close(); srv.close();
console.log(`\n통과 ${pass} / 실패 ${fail}`); fs.rmSync(JOBS, { recursive: true, force: true }); process.exit(fail ? 1 : 0);
