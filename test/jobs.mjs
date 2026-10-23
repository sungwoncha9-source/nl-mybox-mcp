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
        const s = body.indexOf('\r\n\r\n') + 4, e = body.lastIndexOf('\r\n--'); store.get(id).size = e - s; res.statusCode = 200; res.end('ok'); };
      return uploadDelay ? setTimeout(finish, uploadDelay) : finish(); }
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
let e2 = null; try { await call(c, 'job_put_chunk', { ...mkChunks('job2', [{ name: 'x.bin', buf: f2[0].buf }], { dry_run: false, parent_id: 'F1' })[0] }); } catch (e) { e2 = e; }
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
ok(fs.existsSync(path.join(JOBS, 'job6')), '1.7.0: job_status는 읽기만 하므로 조회만으로는 폴더를 옮기지 않는다');
const r6 = await call(c3, 'job_put_chunk', ch6[2]);   // 다음 조각 호출이 정리를 한다
ok(!fs.existsSync(path.join(JOBS, 'job6')) && fs.readdirSync(path.join(JOBS, '_trash')).some(n => n.startsWith('job6_expired_')), 'job6 작업 폴더가 _trash로 옮겨졌다(삭제 아님)');
ok(fs.existsSync(path.join(JOBS, 'job7')), 'job7 작업 폴더는 그대로');
ok(r6.accepted === false && /새 job_id/.test(r6.note || ''), '만료된 job6에 조각을 또 보내면 거절하고 새 job_id를 안내');
await sleep(2300);
const s7b = await call(c3, 'job_status', { job_id: 'job7' });
ok(s7b.state === 'failed', 'job7도 조용해진 뒤 만료');
await c3.close();

// 5) 1.7.0: 같은 호출 안에서 최종 결과 받기(wait_ms), parent_id 필수, job_status 읽기 전용 표시
console.log('[5] wait_ms — 완성한 호출이 마무리 결과까지 기다려 답한다');
const c4 = await connect();
const jt = (await c4.listTools()).tools;
const js = jt.find(t => t.name === 'job_status');
ok(js && js.annotations && js.annotations.readOnlyHint === true, 'job_status에 읽기 전용 표시(readOnlyHint) — 앱 확인창 대상에서 빠지게');
const pool = async (list, n, fn) => { const res = new Array(list.length); let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < list.length) { const k = i++; try { res[k] = { ok: true, v: await fn(list[k]) }; } catch (e) { res[k] = { ok: false, e }; } } })); return res; };
uploadDelay = 400;   // 파일마다 0.4초 걸리는 느린 MYBOX
const f8 = Array.from({ length: 5 }, (_, i) => ({ name: 'p' + i + '.jpg', buf: crypto.randomBytes(300000 + i * 250000) }));
const ch8 = shuffle(mkChunks('job8', f8, { parent_id: 'F8', wait_ms: 20000 }));
const t8 = Date.now(); const r8 = await pool(ch8, 8, a => call(c4, 'job_put_chunk', a)); const el8 = Date.now() - t8;
ok(r8.every(r => r.ok), `조각 ${ch8.length}개를 8개씩 동시에 보내 모두 성공 응답`);
const fin8 = r8.filter(r => r.v.completed_by_this_call);
ok(fin8.length === 1, '일감을 완성한 호출은 정확히 1개 (실제 ' + fin8.length + ')');
const v8 = fin8[0] && fin8[0].v;
ok(v8 && v8.final === true && v8.state === 'done' && v8.wait_timed_out === false, '그 호출의 응답 자체가 최종 결과: state done, final true (실제 ' + (v8 && v8.state) + ')');
ok(v8 && v8.files.every(f => f.uploaded && f.verified), '응답 안에서 모든 파일 uploaded·verified(대조 일치)');
ok(v8 && v8.waited_ms >= 5 * 400 * 0.8, '실제로 마무리 시간만큼 기다렸다 (waited ' + (v8 && v8.waited_ms) + ' ms, 전체 ' + el8 + ' ms)');
ok(r8.filter(r => !r.v.completed_by_this_call).every(r => r.v.final === false || r.v.accepted === false), '다른 조각 응답은 최종 결과를 주장하지 않는다');

console.log('[5b] wait_ms가 짧으면 거짓 완료 없이 finalizing을 돌려준다');
uploadDelay = 800;
const f9 = [{ name: 'q.jpg', buf: crypto.randomBytes(400000) }, { name: 'r.jpg', buf: crypto.randomBytes(400000) }];
const ch9 = mkChunks('job9', f9, { parent_id: 'F9', wait_ms: 300 });
let last9; for (const a of ch9) last9 = await call(c4, 'job_put_chunk', a);
ok(last9.completed_by_this_call && last9.final === false && last9.state === 'finalizing' && last9.wait_timed_out === true, '시간 안에 안 끝나면 final:false·finalizing·wait_timed_out:true (완료라고 하지 않음)');
const dup9 = await call(c4, 'job_put_chunk', { ...ch9[0], wait_ms: 20000 });
ok(dup9.accepted === false && dup9.final === true && dup9.state === 'done', '마무리 중에 같은 조각을 다시 보내면(wait_ms) 같은 마무리를 기다려 최종 결과를 받는다 (멱등)');
const s9 = await call(c4, 'job_status', { job_id: 'job9' }); ok(s9.state === 'done' && s9.final === true, 'job_status로 읽어도 done');

console.log('[5c] 실패도 같은 호출 안에서 받는다');
uploadDelay = 0;
const f10 = [{ name: 'fail.jpg', buf: crypto.randomBytes(200000) }];
const r10 = await call(c4, 'job_put_chunk', { ...mkChunks('job10', f10, { parent_id: 'F10', wait_ms: 10000 })[0] });
ok(r10.final === true && r10.state === 'failed' && !!r10.error, 'MYBOX 올리기 실패 → 응답이 failed + error (' + String(r10.error).slice(0, 40) + ')');
ok(fs.existsSync(path.join(JOBS, 'job10')), '실패하면 PC 사본은 지우지 않고 남긴다');

console.log('[5d] 입력 검사');
let e11 = null; try { await call(c4, 'job_put_chunk', mkChunks('job11', [{ name: 'n.jpg', buf: crypto.randomBytes(1000) }])[0]); } catch (e) { e11 = e; }
ok(e11 && /parent_id/.test(e11.message), 'dry_run이 아닌데 parent_id가 없으면 거절(루트로 올리지 않음)');
const r11 = await call(c4, 'job_put_chunk', mkChunks('job11b', [{ name: 'n.jpg', buf: crypto.randomBytes(1000) }], { dry_run: true, wait_ms: 5000 })[0]);
ok(r11.final === true && r11.state === 'dry_run_done', 'dry_run은 parent_id 없이 되고, 완성 호출이 dry_run_done을 바로 받는다');
let e12 = null; try { await call(c4, 'job_put_chunk', mkChunks('job12', [{ name: 'n.jpg', buf: crypto.randomBytes(1000) }], { dry_run: true, wait_ms: 999999 })[0]); } catch (e) { e12 = e; }
ok(e12 && /wait_ms/.test(e12.message), 'wait_ms 범위 밖(120000 초과) 거절');
const before13 = fs.readdirSync(path.join(JOBS, '_results')).length;
await call(c4, 'job_status', { job_id: 'job8' }); await call(c4, 'job_status', { job_id: 'nojob' });
ok(fs.readdirSync(path.join(JOBS, '_results')).length === before13, 'job_status는 결과 폴더에 아무것도 쓰지 않는다(없는 일감 조회 포함)');

console.log('[6] 1.8.0 subfolder — 새 폴더를 만들어 거기에만 올린다');
uploadDelay = 0;
// 옛 파일이 같은 이름으로 이미 있는 폴더(F6)를 흉내: 크기가 같은 옛 파일
const same = crypto.randomBytes(300000);
store.set('OLD1', { name: 'dup.jpg', parent: 'F6', size: same.length });
const f13 = [{ name: 'dup.jpg', buf: same }, { name: 'z.jpg', buf: crypto.randomBytes(700000) }];
const r13 = []; for (const a of shuffle(mkChunks('job13', f13, { parent_id: 'F6', subfolder: 'S_1', wait_ms: 20000 }))) r13.push(await call(c4, 'job_put_chunk', a));
const v13 = r13.find(r => r.completed_by_this_call);
ok(v13 && v13.state === 'done' && v13.final === true, 'subfolder 일감이 같은 호출 안에서 done');
ok(v13 && v13.subfolder === 'S_1' && /^FD/.test(v13.folder_id || ''), '응답에 subfolder 이름과 새 폴더 ID(folder_id)가 있다 (' + (v13 && v13.folder_id) + ')');
const made = [...store.entries()].find(([id, x]) => x.isFolder && x.name === 'S_1' && x.parent === 'F6');
ok(!!made && made[0] === (v13 && v13.folder_id), '상위 폴더 F6 아래에 새 폴더 S_1이 만들어졌다');
const inNew = [...store.values()].filter(x => x.parent === (made && made[0]) && !x.isFolder);
ok(inNew.length === 2 && f13.every(f => inNew.find(x => x.name === f.name && x.size === f.buf.length)), '파일 2개가 새 폴더 안에 같은 크기로 올라갔다');
ok([...store.values()].filter(x => x.parent === 'F6' && x.name === 'dup.jpg').length === 1, '상위 폴더의 옛 dup.jpg는 그대로이고 새로 섞이지 않았다');
ok(v13 && v13.files.every(f => f.uploaded && f.verified), '대조는 새 폴더 안의 파일로 했다(옛 파일과 크기가 같아도 새 폴더에서 찾음)');
const calls0 = folderCalls.length;
const r14 = []; for (const a of mkChunks('job14', [{ name: 'y.jpg', buf: crypto.randomBytes(50000) }], { parent_id: 'F6', subfolder: 'S_1', wait_ms: 20000 })) r14.push(await call(c4, 'job_put_chunk', a));
ok(r14[0].final === true && r14[0].state === 'failed' && /이미 있습니다/.test(r14[0].error || ''), '같은 이름 폴더가 이미 있으면 실패(섞어 올리지 않음)');
ok(folderCalls.length === calls0 && [...store.values()].filter(x => x.name === 'y.jpg').length === 0, '그때 폴더도 새로 만들지 않았고 파일도 올리지 않았다');
const callsDry = folderCalls.length;
const r15 = await call(c4, 'job_put_chunk', mkChunks('job15', [{ name: 'd.jpg', buf: crypto.randomBytes(20000) }], { parent_id: 'F6', subfolder: 'S_dry', dry_run: true, wait_ms: 5000 })[0]);
ok(r15.state === 'dry_run_done' && r15.folder_id === null && folderCalls.length === callsDry, 'dry_run이면 폴더를 만들지 않는다');
for (const bad of ['a/b', '../x', 'x.part', '.h']) { let e = null; try { await call(c4, 'job_put_chunk', mkChunks('job16', [{ name: 'q.jpg', buf: crypto.randomBytes(1000) }], { parent_id: 'F6', subfolder: bad, dry_run: true })[0]); } catch (er) { e = er; } ok(!!e, '나쁜 subfolder 이름 거절: ' + bad); }
let e17 = null; try { await call(c4, 'job_put_chunk', mkChunks('job17', [{ name: 'q.jpg', buf: crypto.randomBytes(1000) }], { subfolder: 'S_2', dry_run: true })[0]); } catch (er) { e17 = er; }
ok(e17 && /parent_id/.test(e17.message), 'parent_id 없이 subfolder만 주면 거절');
let e18 = null; const k18 = mkChunks('job18', [{ name: 'q.jpg', buf: crypto.randomBytes(1300000) }], { parent_id: 'F6', subfolder: 'A', dry_run: true });
await call(c4, 'job_put_chunk', k18[0]); try { await call(c4, 'job_put_chunk', { ...k18[1], subfolder: 'B' }); } catch (er) { e18 = er; }
ok(e18 && /job_mismatch/.test(e18.message), '같은 job_id에 subfolder가 다르면 job_mismatch');
await c4.close(); srv.close();
console.log(`\n통과 ${pass} / 실패 ${fail}`); fs.rmSync(JOBS, { recursive: true, force: true }); process.exit(fail ? 1 : 0);
