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

// ===== 묶음(pack1) 시험 (v1.9.0) =====
const packOf = (entries) => { const man = Buffer.from(JSON.stringify({ entries: entries.map(e => ({ name: e.name, size: e.buf.length, sha256: e.sha ?? sha(e.buf), ...(e.parent_id ? { parent_id: e.parent_id } : {}) })) }), 'utf8');
  const h = Buffer.alloc(8); h.write('NLP1', 0, 'latin1'); h.writeUInt32BE(man.length, 4); return Buffer.concat([h, man, ...entries.map(e => e.buf)]); };
const packChunks = (id, pack, extra = {}, name = 'b.pack') => { const specs = [{ name, size: pack.length, sha256: sha(pack) }]; const out = [];
  for (let o = 0; o < pack.length; o += CH) out.push({ job_id: id, files: specs, file_name: name, offset: o, content_base64: pack.subarray(o, Math.min(o + CH, pack.length)).toString('base64'), bundle: 'pack1', ...extra }); return out; };
const inFolder = (p) => [...store.values()].filter(x => x.parent === p && !x.isFolder && x.size != null);
const listCalls = (p) => calls.filter(x => x === 'GET /v1/drive/folders/' + p + '/resources').length;
import { spawn } from 'node:child_process';
const c9 = await connect();
const tl = (await c9.listTools()).tools.find(t => t.name === 'job_put_chunk');
ok(/bundle/.test(JSON.stringify(tl.inputSchema)), '[B0] job_put_chunk 스키마에 bundle 옵션이 보인다');

console.log('[B1] 파일 50개(약 90KB) · 폴더 3곳 · 섞은 순서·동시·중복 조각 → 호출 수는 조각 수');
const E1 = Array.from({ length: 50 }, (_, i) => ({ name: `NT-${String(1000 + i)}_시험.png`, buf: crypto.randomBytes(80000 + i * 500), parent_id: ['CAT1', 'CAT2', 'CAT3'][i % 3] }));
const P1 = packOf(E1); let k1 = packChunks('bj1', P1, { parent_id: 'F0', wait_ms: 20000 }); const nChunks = k1.length; k1 = shuffle([...k1, k1[0]]);
const upBefore = [...store.values()].length, callsBefore = calls.length;
const r1 = await Promise.allSettled(k1.map(a => call(c9, 'job_put_chunk', a)));
ok(r1.every(r => r.status === 'fulfilled'), `묶음 ${(P1.length / 1e6).toFixed(2)}MB를 job_put_chunk ${k1.length}번(중복 1)으로 보냄 — 파일 50개인데 호출은 ${nChunks}번`);
const fin1 = r1.map(r => r.value).find(v => v.completed_by_this_call);
ok(fin1 && fin1.final === true && fin1.state === 'done', '마지막 조각 호출이 마무리 결과(done)까지 받았다 (state=' + (fin1 && fin1.state) + ')');
ok(fin1 && fin1.entries && fin1.entries.length === 50 && fin1.entries.every(e => e.uploaded && e.verified && !e.error), '50개 모두 uploaded·verified, 오류 0');
ok(['CAT1', 'CAT2', 'CAT3'].every((f, j) => inFolder(f).length === E1.filter((_, i) => i % 3 === j).length) && E1.every(e => inFolder(e.parent_id).some(x => x.name === e.name && x.size === e.buf.length)), '파일이 각자 목적 폴더에 크기까지 맞게 도착(이름·크기 50/50)');
ok(['CAT1', 'CAT2', 'CAT3'].every(f => listCalls(f) <= 3), 'PC→MYBOX 폴더 목록 읽기는 폴더마다 3번 이하(파일마다 읽지 않음): ' + ['CAT1', 'CAT2', 'CAT3'].map(listCalls).join('/'));
ok(inFolder('F0').length === 0, '일감 기본 폴더(F0)에는 아무것도 올리지 않았다');
const uploads1 = calls.slice(callsBefore).filter(x => x === 'POST /v1/drive/files').length; ok(uploads1 === 50, '올리기 요청은 정확히 50번(중복 조각이 두 번 올리게 하지 않음): ' + uploads1);
const tdir1 = path.join(JOBS, '_trash', fs.readdirSync(path.join(JOBS, '_trash')).find(n => n.startsWith('bj1_'))); ok(fs.existsSync(path.join(tdir1, 'b.pack')) && sha(fs.readFileSync(path.join(tdir1, 'b.pack'))) === sha(P1) && !fs.existsSync(path.join(tdir1, 'entries')), '성공한 일감: _trash에 묶음 파일(증거, 원래와 같은 해시)만 남고 풀어 둔 사본은 정리됨');
const st1 = await call(c9, 'job_status', { job_id: 'bj1' }); ok(st1.state === 'done' && st1.entries.length === 50, 'job_status로도 파일별 결과를 읽을 수 있다');
const again = await call(c9, 'job_put_chunk', k1[0]); ok(again.accepted === false && [...store.values()].length === upBefore + 50, '끝난 일감에 같은 조각을 다시 보내면 무시되고 파일이 늘지 않는다(응답 유실 뒤 재전송 안전)');

console.log('[B2] 이미 같은 이름이 있으면 올리지 않는다(중복·덮어쓰기 0)');
store.set('EXIST1', { name: 'NT-2000_있음.png', parent: 'CAT1', size: 777 });
const E2 = [{ name: 'NT-2000_있음.png', buf: crypto.randomBytes(30000), parent_id: 'CAT1' }, { name: 'NT-2001_새것.png', buf: crypto.randomBytes(30000), parent_id: 'CAT1' }];
const r2 = await call(c9, 'job_put_chunk', { ...packChunks('bj2', packOf(E2), { parent_id: 'F0', wait_ms: 10000 })[0] });
ok(r2.final && r2.state === 'failed' && /entries/.test(r2.error), '하나라도 못 올리면 일감은 failed로 알린다');
const e2 = Object.fromEntries(r2.entries.map(e => [e.name, e]));
ok(/^exists/.test(e2['NT-2000_있음.png'].error) && !e2['NT-2000_있음.png'].uploaded, '이미 있는 파일은 exists로 표시하고 올리지 않았다');
ok(e2['NT-2001_새것.png'].uploaded && e2['NT-2001_새것.png'].verified, '나머지 파일은 계속 올라가 확인됐다');
ok(inFolder('CAT1').filter(x => x.name === 'NT-2000_있음.png').length === 1 && store.get('EXIST1').size === 777, '옛 파일은 그대로(크기 777)이고 같은 이름이 둘로 늘지 않았다');

const fdir2 = path.join(JOBS, 'bj2'); ok(fs.existsSync(path.join(fdir2, 'entries')), '실패한 일감(B2)은 풀어 둔 사본까지 그대로 남겨 둔다(원인 확인용)');
console.log('[B3] 깨진 묶음');
const E3 = [{ name: 'g1.png', buf: crypto.randomBytes(20000), parent_id: 'CAT1' }, { name: 'g2.png', buf: crypto.randomBytes(20000), parent_id: 'CAT1' }];
const P3 = packOf(E3); const flip = Buffer.from(P3); flip[flip.length - 5] ^= 0xff;
const sp3 = [{ name: 'b.pack', size: P3.length, sha256: sha(P3) }];
let eT = null; try { await call(c9, 'job_put_chunk', { job_id: 'bj3', files: sp3, file_name: 'b.pack', offset: 0, content_base64: flip.toString('base64'), bundle: 'pack1', parent_id: 'F0' }); } catch (e) { eT = e; }
ok(eT && /sha256 불일치/.test(eT.message), '[B3a] 전송 중 바이트가 깨지면 묶음 전체 sha256 불일치로 거절');
const bad4 = packOf([{ ...E3[0], sha: sha(Buffer.from('x')) }, E3[1]]);
const r4 = await call(c9, 'job_put_chunk', { ...packChunks('bj4', bad4, { parent_id: 'F0', wait_ms: 10000 })[0] });
const m4 = Object.fromEntries(r4.entries.map(e => [e.name, e]));
ok(/sha256 불일치/.test(m4['g1.png'].error) && !m4['g1.png'].uploaded && m4['g2.png'].uploaded && m4['g2.png'].verified, '[B3b] 목록의 파일 sha256이 틀린 파일만 건너뛰고 나머지는 올라간다');
ok(inFolder('CAT1').filter(x => x.name === 'g1.png').length === 0, '[B3b] 틀린 파일은 MYBOX에 올라가지 않았다');
const junk = Buffer.concat([Buffer.from('ZZZZ'), crypto.randomBytes(5000)]);
const r5 = await call(c9, 'job_put_chunk', { ...packChunks('bj5', junk, { parent_id: 'F0', wait_ms: 10000 })[0] });
ok(r5.final && r5.state === 'failed' && /NLP1|묶음/.test(r5.error) && inFolder('F0').length === 0, '[B3c] 묶음 형식이 아니면 failed, 아무것도 올리지 않음');
const trav = packOf([{ name: 'ok.png', buf: crypto.randomBytes(100), parent_id: 'CAT1' }]).toString('latin1').replace('ok.png', '../x.p'); 
const r6 = await call(c9, 'job_put_chunk', { ...packChunks('bj6', Buffer.from(trav, 'latin1'), { parent_id: 'F0', wait_ms: 10000 })[0] });
ok(r6.final && r6.state === 'failed' && inFolder('CAT1').every(x => x.name !== '../x.p'), '[B3d] 이름에 경로 문자가 있으면 거절(폴더 밖으로 쓰지 못함)');

console.log('[B4] 옵션 오류');
let e7 = null; try { await call(c9, 'job_put_chunk', { ...packChunks('bj7', packOf(E3), { parent_id: 'F0' })[0], files: [{ name: 'a.pack', size: 5, sha256: 'a'.repeat(64) }, { name: 'b.pack', size: 5, sha256: 'b'.repeat(64) }] }); } catch (e) { e7 = e; }
ok(e7 && /하나/.test(e7.message), '[B4a] bundle인데 files가 둘이면 거절');
let e8 = null; try { await call(c9, 'job_put_chunk', { ...packChunks('bj8', packOf(E3), { parent_id: 'F0' })[0], bundle: 'zip' }); } catch (e) { e8 = e; }
ok(!!e8, '[B4b] 모르는 bundle 값은 거절');
let e9 = null; const ck9 = packChunks('bj9', packOf(E3), { parent_id: 'F0', dry_run: true })[0]; await call(c9, 'job_put_chunk', ck9); try { await call(c9, 'job_put_chunk', { ...ck9, bundle: undefined }); } catch (e) { e9 = e; }
ok(e9 && /job_mismatch/.test(e9.message), '[B4c] 같은 job_id에 bundle 유무가 다르면 job_mismatch');

console.log('[B5] dry_run·subfolder');
const cb = calls.length;
const r10 = await call(c9, 'job_put_chunk', { ...packChunks('bj10', packOf(E3.map(e => ({ ...e, name: 'd_' + e.name }))), { parent_id: 'F0', dry_run: true, wait_ms: 10000 })[0] });
ok(r10.state === 'dry_run_done' && calls.length === cb && r10.entries.every(e => e.uploaded === null), '[B5a] dry_run은 풀어 보고 대조만 하고 MYBOX를 부르지 않는다');
const E11 = [{ name: 's1.png', buf: crypto.randomBytes(9000) }, { name: 's2.png', buf: crypto.randomBytes(9000), parent_id: 'CAT2' }];
const r11 = await call(c9, 'job_put_chunk', { ...packChunks('bj11', packOf(E11), { parent_id: 'F7', subfolder: 'PK_1', wait_ms: 10000 })[0] });
ok(r11.state === 'done' && r11.folder_id && inFolder(r11.folder_id).some(x => x.name === 's1.png') && inFolder('CAT2').some(x => x.name === 's2.png'), '[B5b] parent_id 없는 파일은 새 하위 폴더로, 있는 파일은 지정 폴더로');

console.log('[B6] 올리기 도중 일부 실패 → 실패한 것만 새 일감으로 다시');
const E12 = [{ name: 'ok1.png', buf: crypto.randomBytes(8000), parent_id: 'CAT3' }, { name: 'fail_x.png', buf: crypto.randomBytes(8000), parent_id: 'CAT3' }, { name: 'ok2.png', buf: crypto.randomBytes(8000), parent_id: 'CAT3' }];
const r12 = await call(c9, 'job_put_chunk', { ...packChunks('bj12', packOf(E12), { parent_id: 'F0', wait_ms: 10000 })[0] });
const m12 = Object.fromEntries(r12.entries.map(e => [e.name, e]));
ok(r12.state === 'failed' && m12['ok1.png'].verified && m12['ok2.png'].verified && !m12['fail_x.png'].uploaded && !!m12['fail_x.png'].error, '[B6a] 실패한 파일만 오류, 앞뒤 파일은 올라가 확인됨');
const before3 = inFolder('CAT3').filter(x => /^ok[12]/.test(x.name)).length;
const E12b = [{ name: 'retry_x.png', buf: E12[1].buf, parent_id: 'CAT3' }];
const r12b = await call(c9, 'job_put_chunk', { ...packChunks('bj12b', packOf(E12b), { parent_id: 'F0', wait_ms: 10000 })[0] });
ok(r12b.state === 'done' && inFolder('CAT3').filter(x => /^ok[12]/.test(x.name)).length === before3 && before3 === 2, '[B6b] 실패분만 새 일감으로 다시 보내면 성공하고, 먼저 올라간 파일은 늘거나 바뀌지 않았다');

console.log('[B7] 큰 묶음(파일 300개 × 10KB, 여러 조각 동시)');
const E13 = Array.from({ length: 300 }, (_, i) => ({ name: `Z${i}.png`, buf: crypto.randomBytes(10000), parent_id: 'CAT' + (1 + i % 3) + 'z' }));
const P13 = packOf(E13); const k13 = shuffle(packChunks('bj13', P13, { parent_id: 'F0', wait_ms: 20000 }));
const r13 = await Promise.all(k13.map(a => call(c9, 'job_put_chunk', a))); const f13 = r13.find(v => v.completed_by_this_call);
ok(f13 && f13.state === 'done' && f13.entries.length === 300 && f13.entries.every(e => e.verified), `[B7] 파일 300개가 호출 ${k13.length}번으로 끝나고 전부 verified`);
console.log('[B8] 올린 뒤 MYBOX의 크기가 다르면 verified가 아니다');
const E14 = [{ name: 'short_a.png', buf: crypto.randomBytes(7000), parent_id: 'CAT1' }, { name: 'fine_a.png', buf: crypto.randomBytes(7000), parent_id: 'CAT1' }];
const r14 = await call(c9, 'job_put_chunk', { ...packChunks('bj14', packOf(E14), { parent_id: 'F0', wait_ms: 10000 })[0] });
const m14 = Object.fromEntries(r14.entries.map(e => [e.name, e]));
ok(r14.state === 'failed' && m14['short_a.png'].uploaded && m14['short_a.png'].verified === false && /크기가 다릅니다/.test(m14['short_a.png'].error) && m14['fine_a.png'].verified === true, '[B8] 크기가 다르게 올라간 파일은 verified:false + 크기 오류, 정상 파일은 verified:true');
console.log('[C1] 같은 이름 · 다른 폴더 (보고서 X1) — 이름이 아니라 (폴더, 이름)으로 구분');
const SA = crypto.randomBytes(6000), SB = crypto.randomBytes(7000);
const r20 = await call(c9, 'job_put_chunk', { ...packChunks('cj1', packOf([{ name: 'same.png', buf: SA, parent_id: 'CATA' }, { name: 'same.png', buf: SB, parent_id: 'CATB' }]), { parent_id: 'F0', wait_ms: 10000 })[0] });
ok(r20.state === 'done' && r20.entries.length === 2 && r20.entries.every(e => e.verified), '[C1a] 다른 폴더의 같은 이름 두 파일이 모두 올라가 확인됨');
const stA = inFolder('CATA').find(x => x.name === 'same.png'), stB = inFolder('CATB').find(x => x.name === 'same.png');
ok(stA && stB && sha(store.get([...store.entries()].find(([, x]) => x === stA)[0]).data) === sha(SA) && sha(store.get([...store.entries()].find(([, x]) => x === stB)[0]).data) === sha(SB), '[C1b] 각 폴더의 파일 내용이 각자 원래 바이트와 같다(서로 바뀌지 않음)');
let eD = null; const rD = await call(c9, 'job_put_chunk', { ...packChunks('cj1b', packOf([{ name: 'dup.png', buf: SA, parent_id: 'CATA' }, { name: 'DUP.png', buf: SB, parent_id: 'CATA' }]), { parent_id: 'F0', wait_ms: 10000 })[0] });
ok(rD.state === 'failed' && /겹칩니다/.test(rD.error) && inFolder('CATA').filter(x => /^dup\.png$/i.test(x.name)).length === 0, '[C1c] 같은 폴더의 같은 이름(대소문자 무시)은 계속 거절, 아무것도 올리지 않음');

console.log('[C2] 크기는 같은데 바이트가 다른 경우 — size_verified와 content_verified를 나눈다');
const E21 = [{ name: 'samesize_a.png', buf: crypto.randomBytes(9000), parent_id: 'CAT1' }, { name: 'good_a.png', buf: crypto.randomBytes(9000), parent_id: 'CAT1' }];
const r21 = await call(c9, 'job_put_chunk', { ...packChunks('cj2', packOf(E21), { parent_id: 'F0', wait_ms: 10000 })[0] });
const m21 = Object.fromEntries(r21.entries.map(e => [e.name, e]));
ok(r21.state === 'done' && m21['samesize_a.png'].verified === true && m21['samesize_a.png'].size_verified === true && m21['samesize_a.png'].content_verified === null, '[C2a] 기본(크기만 대조)은 같은 크기 다른 바이트를 못 잡는다 → content_verified:null로 "내용은 확인 안 함"이 보인다');
const E22 = [{ name: 'samesize_b.png', buf: crypto.randomBytes(9000), parent_id: 'CAT1' }, { name: 'good_b.png', buf: crypto.randomBytes(9000), parent_id: 'CAT1' }];
const r22 = await call(c9, 'job_put_chunk', { ...packChunks('cj3', packOf(E22), { parent_id: 'F0', wait_ms: 10000, verify_content: true })[0] });
const m22 = Object.fromEntries(r22.entries.map(e => [e.name, e]));
ok(r22.state === 'failed' && m22['samesize_b.png'].size_verified === true && m22['samesize_b.png'].content_verified === false && m22['samesize_b.png'].verified === false && /내용\(sha256\)이 다릅니다/.test(m22['samesize_b.png'].error), '[C2b] verify_content면 내려받아 비교해 같은 크기 다른 바이트를 검출(verified:false)');
ok(m22['good_b.png'].size_verified === true && m22['good_b.png'].content_verified === true && m22['good_b.png'].verified === true, '[C2c] 정상 파일은 size_verified·content_verified 모두 true');
let eV = null; try { await call(c9, 'job_put_chunk', { ...mkChunks('cj4', [{ name: 'q.jpg', buf: crypto.randomBytes(100) }], { parent_id: 'F0', verify_content: true })[0] }); } catch (e) { eV = e; }
ok(eV && /bundle/.test(eV.message), '[C2d] bundle이 아닌 일감에 verify_content를 주면 거절');

console.log('[C3] 올릴 수 있는 폴더 허용 목록(NL_JOB_ALLOWED_PARENTS)');
store.set('ROOTX', { name: 'rootx', parent: 'root', size: 0, isFolder: true }); store.set('SUB1', { name: 'sub1', parent: 'ROOTX', size: 0, isFolder: true }); store.set('SUB2', { name: 'sub2', parent: 'SUB1', size: 0, isFolder: true });
const cAL = await connect({ NL_JOB_ALLOWED_PARENTS: 'CATOK,tree:ROOTX' });
const E30 = [{ name: 'al1.png', buf: crypto.randomBytes(3000), parent_id: 'CATOK' }, { name: 'al2.png', buf: crypto.randomBytes(3000), parent_id: 'SUB2' }, { name: 'al3.png', buf: crypto.randomBytes(3000), parent_id: 'EVIL' }];
const r30 = await call(cAL, 'job_put_chunk', { ...packChunks('cj5', packOf(E30), { parent_id: 'CATOK', wait_ms: 10000 })[0] });
const m30 = Object.fromEntries(r30.entries.map(e => [e.name, e]));
ok(m30['al1.png'].verified && m30['al2.png'].verified, '[C3a] 허용 목록의 폴더(정확히 일치 / tree: 하위의 하위)로는 올라간다');
ok(!m30['al3.png'].uploaded && /not_allowed/.test(m30['al3.png'].error) && inFolder('EVIL').length === 0, '[C3b] 허용 밖 폴더(EVIL)로 가는 파일만 거절되고 MYBOX에는 아무것도 올라가지 않았다');
let eN = null; try { await call(cAL, 'job_put_chunk', { ...packChunks('cj6', packOf([{ name: 'z.png', buf: crypto.randomBytes(100) }]), { parent_id: 'EVIL2' })[0] }); } catch (e) { eN = e; }
ok(eN && /not_allowed/.test(eN.message), '[C3c] 일감의 기본 폴더가 허용 밖이면 첫 조각에서 거절');
await cAL.close();

console.log('[C4] 올리기 동시성 — MYBOX 올리기 요청 수는 같고 기다리는 시간만 줄어드는지');
const E40 = (tag) => Array.from({ length: 12 }, (_, i) => ({ name: tag + i + '.png', buf: crypto.randomBytes(4000), parent_id: 'CAT4' + tag }));
uploadDelay = 120;
const tm = {}; for (const [tag, cc] of [['p', 1], ['q', 3]]) { const before = calls.filter(x => x === 'POST /v1/drive/files').length; const t0 = Date.now();
  const r = await call(c9, 'job_put_chunk', { ...packChunks('cj7' + tag, packOf(E40(tag)), { parent_id: 'F0', wait_ms: 30000, upload_concurrency: cc })[0] });
  tm[tag] = { ms: Date.now() - t0, ok: r.state === 'done' && r.entries.every(e => e.verified), n: calls.filter(x => x === 'POST /v1/drive/files').length - before }; }
uploadDelay = 0;
ok(tm.p.ok && tm.q.ok && tm.p.n === 12 && tm.q.n === 12, '[C4a] 동시 1과 3 모두 12개 전부 verified, 올리기 요청은 각각 정확히 12번(' + tm.p.n + '/' + tm.q.n + ')');
ok(tm.q.ms < tm.p.ms * 0.6, '[C4b] 올리기가 느릴 때(120ms) 동시 3이 동시 1보다 빠르다: ' + tm.p.ms + 'ms → ' + tm.q.ms + 'ms');
let eC = null; try { await call(c9, 'job_put_chunk', { ...packChunks('cj8', packOf(E40('r')), { parent_id: 'F0', upload_concurrency: 9 })[0] }); } catch (e) { eC = e; }
ok(!!eC, '[C4c] upload_concurrency가 4를 넘으면 거절');

console.log('[C5] 디스크 여유 부족 — 받기 전에 거절하고 아무것도 만들지 않는다');
const cDF = await connect({ NL_MIN_FREE_MB: '900000000' });
let eF = null; try { await call(cDF, 'job_put_chunk', { ...packChunks('cj9', packOf(E40('s')), { parent_id: 'F0' })[0] }); } catch (e) { eF = e; }
ok(eF && /disk_full/.test(eF.message) && !fs.existsSync(path.join(JOBS, 'cj9')), '[C5a] 남은 공간이 모자라면 disk_full로 거절하고 작업 폴더를 만들지 않는다');
const stF = await call(cDF, 'job_status', { job_id: 'cj9' }); ok(stF.state === 'unknown', '[C5b] 거절된 일감은 기록이 남지 않아 같은 job_id로 다시 보낼 수 있다');
await cDF.close();
console.log('[E] 독립 검증자 반례 (1.9.1 → 1.9.2): 실효 목적 폴더 중복 · 원격 이름 정규화');
const cntIn = (f, re) => inFolder(f).filter(x => re.test(x.name)).length;
const fcBefore = folderCalls.length;
const rX = await call(c9, 'job_put_chunk', { ...packChunks('ej1', packOf([{ name: 'alias_test.png', buf: crypto.randomBytes(2000), parent_id: 'CATD' }, { name: 'alias_test.png', buf: crypto.randomBytes(2100) }]), { parent_id: 'CATD', wait_ms: 10000 })[0] });
ok(rX.state === 'failed' && /중복|겹칩/.test(rX.error || '') && cntIn('CATD', /^alias_test\.png$/) === 0, '[E1] X: parent_id를 명시한 항목과 생략한 항목이 실제로 같은 폴더·같은 이름이면 업로드 전에 차단 — 같은 이름 파일 ' + cntIn('CATD', /^alias_test\.png$/) + '개 생성(기대 0)');
const rX2 = await call(c9, 'job_put_chunk', { ...packChunks('ej2', packOf([{ name: 'Alias2.png', buf: crypto.randomBytes(2000), parent_id: 'CATD' }, { name: 'alias2.PNG', buf: crypto.randomBytes(2100) }]), { parent_id: 'CATD', wait_ms: 10000 })[0] });
ok(rX2.state === 'failed' && cntIn('CATD', /^alias2\.png$/i) === 0, '[E2] X(대소문자 변형): 실효 폴더가 같고 이름이 대소문자만 달라도 업로드 전에 차단 (생성 ' + cntIn('CATD', /^alias2\.png$/i) + '개)');
const rX3 = await call(c9, 'job_put_chunk', { ...packChunks('ej3', packOf([{ name: 'alias3.png', buf: crypto.randomBytes(2000), parent_id: 'CATD' }, { name: 'alias3.png', buf: crypto.randomBytes(2100) }]), { parent_id: 'F0', subfolder: 'E_SUB3', wait_ms: 10000 })[0] });
ok(rX3.state === 'done' && cntIn('CATD', /^alias3\.png$/) === 1 && rX3.entries.every(e => e.verified), '[E3] 대조군: 생략한 항목이 새 하위 폴더로 가면 실효 폴더가 달라 둘 다 정상 업로드');
store.set('CASEX', { name: 'CASE.PNG', parent: 'CATCASE', size: 5 });
const rY = await call(c9, 'job_put_chunk', { ...packChunks('ej4', packOf([{ name: 'case.png', buf: crypto.randomBytes(3000), parent_id: 'CATCASE' }]), { parent_id: 'F0', wait_ms: 10000 })[0] });
ok(rY.state === 'failed' && /^exists/.test(rY.entries[0].error || '') && inFolder('CATCASE').length === 1, '[E4] Y: 원격에 CASE.PNG가 있으면 case.png는 exists로 막힌다 (CATCASE 안 파일 ' + inFolder('CATCASE').length + '개, 기대 1)');
const rY2 = await call(c9, 'job_put_chunk', { ...packChunks('ej5', packOf([{ name: 'case.png', buf: crypto.randomBytes(3000), parent_id: 'CATCASE' }]), { parent_id: 'F0', wait_ms: 10000, is_overwrite: true })[0] });
ok(rY2.state === 'failed' && /case_conflict/.test(rY2.entries[0].error || '') && inFolder('CATCASE').length === 1, '[E5] Y(덮어쓰기 허용): 이름이 대소문자만 다른 기존 파일이 있으면 어느 파일을 덮는지 모호하므로 case_conflict로 막는다');
const nfd = '한글도안.png'.normalize('NFD'), nfc = '한글도안.png'.normalize('NFC');
store.set('NFDX', { name: nfd, parent: 'CATNF', size: 7 });
const rY3 = await call(c9, 'job_put_chunk', { ...packChunks('ej6', packOf([{ name: nfc, buf: crypto.randomBytes(3000), parent_id: 'CATNF' }]), { parent_id: 'F0', wait_ms: 10000 })[0] });
ok(rY3.state === 'failed' && /^exists/.test(rY3.entries[0].error || '') && inFolder('CATNF').length === 1, '[E6] Y(한글 NFC/NFD): 눈에 같은 이름은 정규화 형태가 달라도 같은 이름으로 본다');
const rY4 = await call(c9, 'job_put_chunk', { ...packChunks('ej7', packOf([{ name: 'case_other.png', buf: crypto.randomBytes(3000), parent_id: 'CATCASE' }]), { parent_id: 'F0', wait_ms: 10000 })[0] });
ok(rY4.state === 'done' && rY4.entries[0].verified && inFolder('CATCASE').length === 2, '[E7] 대조군: 이름이 다른 새 파일은 정상 업로드·크기 대조 통과');
const rY5 = await call(c9, 'job_put_chunk', { ...packChunks('ej8', packOf([{ name: 'NewName.PNG', buf: crypto.randomBytes(3000), parent_id: 'CATCASE2' }]), { parent_id: 'F0', wait_ms: 10000 })[0] });
ok(rY5.state === 'done' && rY5.entries[0].verified && rY5.entries[0].size_verified, '[E8] 대조군: 올린 파일 이름이 대문자여도 사후 크기 대조가 정상 통과(정규화 키로 찾음)');
console.log('[F] 허용 폴더 목록이 비어 있을 때의 시작 경고');
const stderrOf = (env) => new Promise((resolve) => { const p = spawn('node', [BUNDLE], { env: { ...process.env, MYBOX_ACCESS_TOKEN: 'dummy', MYBOX_BASE_URL: 'http://127.0.0.1:1/v1', NL_JOBS_DIR: JOBS, ...env } }); let e = ''; p.stderr.on('data', d => { e += d; }); setTimeout(() => { p.kill(); resolve(e); }, 1200); });
ok(/NL_JOB_ALLOWED_PARENTS가 비어 있어/.test(await stderrOf({ NL_JOB_ALLOWED_PARENTS: '' })), '[F1] 허용 목록이 비어 있으면 시작 때 경고를 stderr에 남긴다');
ok(!/NL_JOB_ALLOWED_PARENTS가 비어 있어/.test(await stderrOf({ NL_JOB_ALLOWED_PARENTS: 'tree:ROOTX' })), '[F2] 허용 목록이 있으면 경고하지 않는다');
await c9.close(); srv.close();
console.log(`\n통과 ${pass} / 실패 ${fail}`); fs.rmSync(JOBS, { recursive: true, force: true }); process.exit(fail ? 1 : 0);
