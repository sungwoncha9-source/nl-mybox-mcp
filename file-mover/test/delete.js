'use strict';
// delete_path 시험 — 임시 폴더에서만 돌고, 끝나면 지운다. 실행: node test/delete.js
const fs = require('fs'), os = require('os'), path = require('path');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mover-del-'));
const ROOT = path.join(base, 'root'), OUTSIDE = path.join(base, 'outside');
fs.mkdirSync(ROOT); fs.mkdirSync(OUTSIDE);
for (const d of ['agent', 'file-mover', 'keep/inner']) fs.mkdirSync(path.join(ROOT, d), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'agent', 'config.json'), '{}');
fs.writeFileSync(path.join(OUTSIDE, 'secret.txt'), 'SECRET');
process.env.MOVER_ALLOWED_DIRS = ROOT;
process.env.MOVER_PROTECTED = 'keep/inner';
const m = require('../server.js');
const cfg = m.makeConfig();

const rows = [];
const rec = (name, ok, detail) => rows.push({ name, ok: !!ok, detail: String(detail || '').replace(/\s+/g, ' ').slice(0, 110) });
const call = async (args) => {
  const r = await m.handle({ id: 1, method: 'tools/call', params: { name: 'delete_path', arguments: args } }, cfg);
  const text = r.content[0].text; let json; try { json = JSON.parse(text); } catch {}
  return { err: !!r.isError, text, json };
};
const w = (rel, s = 'data') => { const p = path.join(ROOT, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); return p; };
const ex = p => fs.existsSync(p);
const trash = () => { try { return fs.readdirSync(path.join(ROOT, '_trash')); } catch { return []; } };

(async () => {
  const f1 = w('t/한글 파일 & 공백.txt', 'hello');
  let r = await call({ path: f1 });
  rec('기본 삭제 → 휴지통 이동, 원본 사라짐', !r.err && r.json.action === 'trashed' && !ex(f1) && fs.readFileSync(r.json.to, 'utf8') === 'hello', r.text);
  const log = fs.readFileSync(path.join(ROOT, '_trash', 'delete_log.jsonl'), 'utf8');
  rec('삭제 기록 한 줄', log.trim().split('\n').length === 1 && log.includes('trashed'), log);

  const a1 = w('t/same.txt', 'A'), r1 = await call({ path: a1 });
  const a2 = w('t/same.txt', 'B'), r2 = await call({ path: a2 });
  rec('같은 이름 두 번 삭제 → 휴지통에서 덮어쓰지 않음', r1.json.to !== r2.json.to && fs.readFileSync(r1.json.to, 'utf8') === 'A' && fs.readFileSync(r2.json.to, 'utf8') === 'B', '');

  w('dir1/a.txt', '1'); w('dir1/sub/b.txt', '22');
  r = await call({ path: path.join(ROOT, 'dir1') });
  rec('비어 있지 않은 폴더는 recurse 없으면 거절', r.err && ex(path.join(ROOT, 'dir1', 'a.txt')), r.text);
  r = await call({ path: path.join(ROOT, 'dir1'), recurse: true });
  rec('recurse:true → 폴더째 휴지통, 내용 보존', !r.err && r.json.bytes === 3 && ex(path.join(r.json.to, 'sub', 'b.txt')) && !ex(path.join(ROOT, 'dir1')), r.text);
  fs.mkdirSync(path.join(ROOT, 'emptydir'));
  r = await call({ path: path.join(ROOT, 'emptydir') });
  rec('빈 폴더는 recurse 없이 삭제', !r.err && !ex(path.join(ROOT, 'emptydir')), r.text);

  const f2 = w('t/perm.txt', 'bye');
  r = await call({ path: f2, permanent: true });
  rec('permanent:true → 완전 삭제', !r.err && r.json.action === 'deleted' && !ex(f2) && !trash().some(n => n.endsWith('perm.txt')), r.text);
  const inTrash = path.join(ROOT, '_trash', trash().find(n => n.endsWith('same.txt')));
  r = await call({ path: inTrash });
  rec('휴지통 안의 항목은 영구 삭제', !r.err && r.json.action === 'deleted' && !ex(inTrash), r.text);

  const denied = async (name, p, extra = {}) => { const x = await call({ path: p, ...extra }); rec(name, x.err, x.text); };
  await denied('허용 루트 자체 거절', ROOT);
  await denied('agent 폴더 거절', path.join(ROOT, 'agent'), { recurse: true, permanent: true });
  await denied('agent 안 파일 거절', path.join(ROOT, 'agent', 'config.json'));
  await denied('file-mover 폴더 거절', path.join(ROOT, 'file-mover'), { recurse: true });
  await denied('_trash 폴더 자체 거절', path.join(ROOT, '_trash'), { recurse: true, permanent: true });
  await denied('보호 경로를 포함한 상위 폴더 거절', path.join(ROOT, 'keep'), { recurse: true });
  await denied('보호 경로(MOVER_PROTECTED) 거절', path.join(ROOT, 'keep', 'inner'));
  await denied('허용 폴더 밖 거절', path.join(OUTSIDE, 'secret.txt'));
  await denied('.. 탈출 거절', path.join(ROOT, 't', '..', '..', 'outside', 'secret.txt'));
  await denied('없는 경로 오류', path.join(ROOT, 'nope.txt'));
  await denied('path 없음 오류', '');
  rec('거절 뒤 밖의 파일 그대로', ex(path.join(OUTSIDE, 'secret.txt')), '');
  if (process.platform !== 'win32') {
    fs.symlinkSync(OUTSIDE, path.join(ROOT, 'link_out'));
    await denied('밖을 가리키는 링크 거절', path.join(ROOT, 'link_out'));
    rec('링크 거절 뒤 밖의 파일 그대로', ex(path.join(OUTSIDE, 'secret.txt')), '');
    fs.unlinkSync(path.join(ROOT, 'link_out'));
  }

  let fail = 0;
  for (const x of rows) { if (!x.ok) fail++; console.log((x.ok ? 'PASS ' : 'FAIL ') + x.name + (x.ok ? '' : '   <= ' + x.detail)); }
  console.log((rows.length - fail) + ' passed' + (fail ? ', ' + fail + ' FAILED' : ''));
  fs.rmSync(base, { recursive: true, force: true });
  process.exitCode = fail ? 1 : 0;
})().catch(e => { console.error(e); fs.rmSync(base, { recursive: true, force: true }); process.exit(3); });
