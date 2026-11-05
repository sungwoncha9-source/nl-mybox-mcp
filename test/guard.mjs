// 1.9.3 영구 삭제 차단 가드 시험 — 가짜 MYBOX만 쓴다(실제 MYBOX 호출 없음).
// 사용: node test/guard.mjs <번들> [--expect-central]   (--expect-central: 도구 쪽 거부를 뺀 변형 번들로 중앙 가드만 시험)
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os';

const BUNDLE = process.argv[2];
const JOBS = fs.mkdtempSync(path.join(os.tmpdir(), 'jobs-'));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  OK  ' + m); } else { fail++; console.log('  FAIL ' + m); } };

// ---- 가짜 MYBOX: 모든 요청을 기록하고, 영구 삭제가 실제로 일어났는지 따로 센다 ----
const calls = [];                       // 'METHOD /path'
const files = new Map([['F1', { name: 'a.txt' }], ['F2', { name: 'b.txt' }], ['F3', { name: 'c.txt' }]]);
const trash = new Map();
let permanent = 0, autoDeleteDays = 0;  // 영구 삭제 요청이 백엔드에서 처리된 횟수 / 자동 삭제 주기
const srv = http.createServer((req, res) => {
  const chunks = []; req.on('data', d => chunks.push(d)); req.on('end', () => {
    const url = new URL(req.url, 'http://x'); const key = req.method + ' ' + url.pathname; calls.push(key);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString() || '{}') : {};
    const json = (o) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
    let m;
    if (req.method === 'DELETE' && url.pathname === '/v1/drive/trash') { permanent += trash.size; trash.clear(); return json({ ok: true }); }
    if (req.method === 'DELETE' && (m = url.pathname.match(/^\/v1\/drive\/trash\/([^/]+)$/))) { if (trash.delete(m[1])) permanent++; return json({ ok: true }); }
    if (req.method === 'PATCH' && url.pathname === '/v1/drive/storage') { autoDeleteDays = body.trashAutoDeleteDays; return json({ ok: true }); }
    if (req.method === 'GET' && url.pathname === '/v1/drive/storage') return json({ used: 1, trashAutoDeleteDays: autoDeleteDays });
    if (req.method === 'DELETE' && (m = url.pathname.match(/^\/v1\/drive\/resources\/([^/]+)$/))) { // 일반 삭제 = 휴지통 이동
      const f = files.get(m[1]); if (!f) { res.statusCode = 404; return res.end('nf'); } files.delete(m[1]); trash.set(m[1], f); return json({ ok: true }); }
    if (req.method === 'GET' && url.pathname === '/v1/drive/trash') return json({ resources: [...trash].map(([id, f]) => ({ resourceId: id, name: f.name })) });
    if (req.method === 'POST' && (m = url.pathname.match(/^\/v1\/drive\/trash\/([^/]+)\/restore$/))) { const f = trash.get(m[1]); if (!f) { res.statusCode = 404; return res.end('nf'); } trash.delete(m[1]); files.set(m[1], f); return json({ ok: true }); }
    if (req.method === 'GET' && url.pathname === '/v1/drive/resources') return json({ resources: [...files].map(([id, f]) => ({ resourceId: id, name: f.name })) });
    res.statusCode = 404; res.end('nf');
  });
});
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const c = new Client({ name: 't', version: '1' });
await c.connect(new StdioClientTransport({ command: 'node', args: [BUNDLE], env: { ...process.env, MYBOX_ACCESS_TOKEN: 'dummy', MYBOX_BASE_URL: 'http://127.0.0.1:' + srv.address().port + '/v1', NL_JOBS_DIR: JOBS } }));
const raw = async (name, args) => { const r = await c.callTool({ name, arguments: args }); return { isError: !!r.isError, text: r.content?.[0]?.text || '' }; };
const central = process.argv.includes('--expect-central');

console.log('[1] 영구 삭제 도구 3개 — 거부 응답 + 백엔드에 요청 0건');
// 시험 대상: 휴지통에 F2, F3를 미리 넣어 둔다(일반 삭제로)
await raw('files_delete', { resourceId: 'F2' }); await raw('files_delete', { resourceId: 'F3' });
ok(trash.size === 2 && files.size === 1, '준비: 일반 삭제 2건이 휴지통으로 갔다(휴지통 2 / 파일 1)');
const before = calls.length;
const cases = [
  ['files_trash_clean', {}],
  ['files_trash_clean_resourceId', { resourceId: 'F2' }],
  ['dms_trash_routine', { trashAutoDeleteDays: 5 }],
  ['dms_trash_routine', { trashAutoDeleteDays: 0 }],
  ['dms_trash_routine', { trashAutoDeleteDays: 50 }]
];
for (const [name, args] of cases) {
  const n0 = calls.length; const r = await raw(name, args);
  ok(r.isError, `(가) ${name} ${JSON.stringify(args)} → 오류(거부) 응답`);
  ok(/금지|DENIED|denied/.test(r.text), `    거부 이유가 응답에 있다`);
  ok(calls.length === n0, `(나) ${name} ${JSON.stringify(args)} → 백엔드 요청 0건`);
}
ok(calls.length === before, `(나) 다섯 번 호출 뒤 백엔드 요청 누계 0건 (전 ${before} / 후 ${calls.length})`);
ok(permanent === 0, '(나) 백엔드에서 영구 삭제가 처리된 횟수 0');
ok(trash.size === 2, '휴지통 항목 2건 그대로');
ok(autoDeleteDays === 0, '휴지통 자동 삭제 주기 그대로(0)');
ok(!calls.some(k => /^DELETE \/v1\/drive\/trash/.test(k)) && !calls.some(k => /^PATCH \/v1\/drive\/storage/.test(k)), '백엔드 기록에 DELETE /drive/trash*·PATCH /drive/storage 없음');

console.log('[2] 일반 삭제(휴지통행)·복원은 가드 뒤에도 정상');
const d = await raw('files_delete', { resourceId: 'F1' });
ok(!d.isError && trash.has('F1') && !files.has('F1') && permanent === 0, '일반 삭제 → 휴지통으로 이동(영구 삭제 아님)');
const tl = await raw('dms_trash_list', {});
ok(!tl.isError && /a\.txt/.test(tl.text) && /b\.txt/.test(tl.text), '휴지통 목록 조회 정상');
const rs = await raw('files_trash_restore', { resourceId: 'F1' });
ok(!rs.isError && files.has('F1') && !trash.has('F1'), '복원 → 원래 위치로 돌아옴');
const st = await raw('dms_storage', {});
ok(!st.isError && /used/.test(st.text), '읽기 도구(dms_storage) 정상');
const rt = await raw('dms_root', {});
ok(!rt.isError && /a\.txt/.test(rt.text), '읽기 도구(dms_root) 정상');
ok(permanent === 0, '시험 전체에서 영구 삭제 0건');

console.log('[3] 도구 목록');
const names = (await c.listTools()).tools.map(t => t.name);
ok(['files_trash_clean', 'files_trash_clean_resourceId', 'dms_trash_routine'].every(n => names.includes(n)), '차단 도구 3개는 목록에 남아 있다(호출하면 이유를 알려 줌)');
ok(['files_delete', 'files_trash_restore', 'dms_trash_list'].every(n => names.includes(n)), '일반 삭제·복원·휴지통 목록 도구 그대로');
const desc = (await c.listTools()).tools.find(t => t.name === 'files_trash_clean').description;
ok(/차단/.test(desc), '차단 도구 설명에 [차단됨] 표시');

await c.close(); srv.close();
console.log(`\n통과 ${pass} / 실패 ${fail}` + (central ? ' (중앙 가드 단독 시험)' : ''));
process.exit(fail ? 1 : 0);
