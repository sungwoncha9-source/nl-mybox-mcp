// 판정기(judge) 시험: 정상은 PASS, 일부러 망가뜨린 입력·실행은 FAIL 이어야 하고, 허위 성공(망가졌는데 pass)은 0건이어야 한다.
// 단위(순수 함수) + 실행(진짜 s3/start.mjs 를 임시 폴더 복사본으로 띄움). 가짜 MYBOX·합성 데이터만. 실제 MYBOX·토큰·외부 접속 없음.
// 사용: node s3/judge_test.mjs        (종료 코드 0 = 모든 기대가 맞음)
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { spawn } from 'node:child_process'; import { fileURLToPath } from 'node:url';
import { judge, CHECKS } from './selftest.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url)); const ROOT = path.resolve(HERE, '..');
const rows = []; let bad = 0;
const expect = (id, what, ok, detail) => { rows.push({ id, what, ok, detail }); if (!ok) bad++; console.log((ok ? 'OK   ' : 'BAD  ') + id + ' ' + what + (detail ? ' :: ' + detail : '')); };

// ---------- 단위: 정상 입력은 PASS ----------
const good = () => ({
  baseline: { ...Object.fromEntries(CHECKS.map(k => [k, { pass: false }])), c4_race_after_accept: { state: 'done', resolved: true, uploads: 1, pass: false } },
  fixed: { ...Object.fromEntries(CHECKS.map(k => [k, { pass: true }])), c4_race_after_accept: { state: 'failed', resolved: true, uploads: 0, pass: true },
    p1_cost_per_job: { depth2_SUB: { status: 200 }, depth6_D5: { status: 200 } }, r1_restart: { status_after_restart: 200, new_job_after_restart: 'done' } },
  guard: { refuses_real_token: true, refuses_base_url: true, refuses_oauth_copy: true, clean_env_ok: true, nonloopback_throws: true }
});
{ const v = judge(good()); expect('U0', '정상 입력 → PASS', v.verdict === 'PASS' && v.reasons.length === 0, JSON.stringify(v)); }

// ---------- 단위: 하나씩 망가뜨리면 모두 FAIL ----------
const mut = [];
for (const k of CHECKS) mut.push([`fixed.${k}.pass=false`, o => { o.fixed[k].pass = false; }]);
mut.push(['J4 fixed.c4 작업 미종결(accepted)·업로드 0·옛 방식 pass=true', o => { o.fixed.c4_race_after_accept = { state: 'accepted', resolved: false, uploads: 0, pass: true }; }]);
mut.push(['fixed.c4 상태 done·업로드 0·pass=true', o => { o.fixed.c4_race_after_accept = { state: 'done', resolved: true, uploads: 0, pass: true }; }]);
mut.push(['fixed.c4 상태 failed·업로드 1·pass=true', o => { o.fixed.c4_race_after_accept = { state: 'failed', resolved: true, uploads: 1, pass: true }; }]);
mut.push(['fixed.c4 상태 없음(undefined)·업로드 0·pass=true', o => { o.fixed.c4_race_after_accept = { uploads: 0, pass: true }; }]);
mut.push(['fixed.error 기록', o => { o.fixed.error = 'Error: boom\n at x'; }]);
mut.push(['fixed 항목 하나 누락(c2)', o => { delete o.fixed.c2_deny_then_allow; }]);
mut.push(['fixed 통째 누락', o => { delete o.fixed; }]);
mut.push(['fixed.p1 누락', o => { delete o.fixed.p1_cost_per_job; }]);
mut.push(['fixed.p1 depth6 상태 500', o => { o.fixed.p1_cost_per_job.depth6_D5.status = 500; }]);
mut.push(['fixed.r1 누락', o => { delete o.fixed.r1_restart; }]);
mut.push(['fixed.r1 재시작 뒤 조회 404', o => { o.fixed.r1_restart.status_after_restart = 404; }]);
mut.push(['fixed.r1 새 일감 상태 없음', o => { o.fixed.r1_restart.new_job_after_restart = undefined; }]);
for (const k of CHECKS) mut.push([`J6 baseline.${k} 가 통과(대조 실패)`, o => { o.baseline[k].pass = true; }]);
mut.push(['J6 baseline 전부 통과', o => { for (const k of CHECKS) o.baseline[k].pass = true; }]);
mut.push(['baseline.error 기록', o => { o.baseline.error = 'Error: x'; }]);
mut.push(['baseline 통째 누락', o => { delete o.baseline; }]);
for (const g of ['refuses_real_token', 'refuses_base_url', 'refuses_oauth_copy', 'clean_env_ok', 'nonloopback_throws']) mut.push([`guard.${g}=false`, o => { o.guard[g] = false; }]);
mut.push(['guard 통째 누락', o => { delete o.guard; }]);
let n = 0;
for (const [name, f] of mut) { const o = good(); f(o); const v = judge(o); expect('U' + (++n), name + ' → FAIL', v.verdict === 'FAIL' && v.reasons.length > 0, v.reasons[0]); }
expect('U' + (++n), 'judge(undefined) → FAIL', judge(undefined).verdict === 'FAIL');
expect('U' + (++n), 'judge({}) → FAIL', judge({}).verdict === 'FAIL');

// ---------- 실행: 진짜 start.mjs 를 임시 복사본에서 ----------
function mk(tag, { fixedFile, baselineFile }) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'jt-' + tag + '-')); fs.mkdirSync(path.join(d, 's3'));
  for (const f of ['start.mjs', 'selftest.mjs', 'fake-mybox.mjs']) fs.copyFileSync(path.join(HERE, f), path.join(d, 's3', f));
  fs.copyFileSync(baselineFile, path.join(d, 's3', 'baseline-http.mjs'));
  if (fixedFile) fs.copyFileSync(fixedFile, path.join(d, 'mybox-mcp-http.mjs'));
  return d;
}
let port = 39100;
function run(dir, extraEnv = {}, ms = 120000) {
  return new Promise((resolve, reject) => {
    const env = { PATH: process.env.PATH, HOME: process.env.HOME || '/tmp', PORT: String(port++), ...extraEnv };
    const p = spawn('node', [path.join(dir, 's3', 'start.mjs')], { env }); let so = '', se = ''; let done = false;
    const fin = r => { if (done) return; done = true; clearTimeout(t); try { p.kill(); } catch {} resolve(r); };
    const t = setTimeout(() => { if (!done) { done = true; try { p.kill(); } catch {} reject(new Error('timeout')); } }, ms);
    p.stdout.on('data', d => { so += d; const m = so.match(/SELFTEST_RESULT (.*)\n/); if (m) fin({ code: null, result: JSON.parse(m[1]), so, se }); });
    p.stderr.on('data', d => { se += d; });
    p.on('exit', c => setTimeout(() => fin({ code: c, result: null, so, se }), 200));
  });
}
const BASE = path.join(HERE, 'baseline-http.mjs'); const FIX = path.join(ROOT, 'mybox-mcp-http.mjs');
const ok = r => r.result && r.result.status === 'selftest-pass';
// J1 정상
{ const r = await run(mk('normal', { fixedFile: FIX, baselineFile: BASE })); expect('E1', 'J1 정상 실행 → status selftest-pass, verdict PASS', ok(r) && r.result.verdict === 'PASS', r.result && (r.result.status + ' ' + JSON.stringify(r.result.reasons))); }
// J2/J0 수정 자리에 기준 번들
{ const r = await run(mk('j0', { fixedFile: BASE, baselineFile: BASE })); const s = r.result && r.result.status;
  expect('E2', 'J2 수정 자리에 기준 번들 주입 → selftest-fail (허위 selftest-done/pass 아님)', s === 'selftest-fail' && r.result.verdict === 'FAIL', s + ' ' + (r.result && r.result.reasons && r.result.reasons[0])); }
// J3 수정 번들 파일 없음(시작 불가)
{ const r = await run(mk('j3', { fixedFile: null, baselineFile: BASE })); const s = r.result && r.result.status;
  expect('E3', 'J3 수정 번들 시작 불가 → 합격 표시가 아님(selftest-error)', s === 'selftest-error' || (s && s !== 'selftest-pass' && s !== 'selftest-done'), String(s)); }
// J6 기준 자리에 수정 번들(대조 실패)
{ const r = await run(mk('j6', { fixedFile: FIX, baselineFile: FIX })); const s = r.result && r.result.status;
  expect('E4', 'J6 기준 자리에 수정 번들(결함을 못 잡는 시험) → selftest-fail', s === 'selftest-fail' && r.result.reasons.some(x => /baseline/.test(x)), s + ' ' + (r.result && r.result.reasons && r.result.reasons[0])); }
// J7 시작 가드: 실제 토큰·주소·OAuth 설정이 섞이면 시작 거부(종료 코드 3), 시험 결과 없음
for (const [name, env] of [['MYBOX_ACCESS_TOKEN', { MYBOX_ACCESS_TOKEN: 'x' }], ['MYBOX_BASE_URL', { MYBOX_BASE_URL: 'https://example.invalid/v1' }], ['NL_OAUTH_ISSUER', { NL_OAUTH_ISSUER: 'x' }]]) {
  const r = await run(mk('g', { fixedFile: FIX, baselineFile: BASE }), env, 30000); expect('E5-' + name, `J7 시작 가드 ${name} → 종료 코드 3, 시험 안 돎`, r.code === 3 && r.result === null, 'code=' + r.code);
}
console.log('\n요약: ' + rows.filter(r => r.ok).length + '/' + rows.length + ' 기대 일치, 불일치 ' + bad);
process.exit(bad ? 1 : 0);
