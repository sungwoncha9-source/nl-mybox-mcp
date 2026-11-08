// S3 시작 파일: 가짜 MYBOX(루프백) + MCP HTTP 서버(기준/수정 두 번들)를 같은 컨테이너에서 띄우고 자체 시험을 돌린다.
// fail-closed: 실제 MYBOX 주소·토큰이 섞이면 시작하지 않는다. 자식 프로세스 환경은 허용 목록으로만 만든다(S1 비밀값이 와도 전달 안 됨).
import http from 'node:http'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { startFake } from './fake-mybox.mjs'; import { runSelfTest, judge } from './selftest.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url));
export function guardEnv(env) {
  const bad = [];
  if (env.MYBOX_ACCESS_TOKEN) bad.push('MYBOX_ACCESS_TOKEN 이 설정됨(S3에는 어떤 토큰도 두지 않는다)');
  if (env.MYBOX_BASE_URL) bad.push('MYBOX_BASE_URL 이 설정됨(S3는 스스로 루프백 주소를 정한다)');
  if (env.NL_OAUTH_ISSUER || env.NL_OAUTH_ALLOWED_SUBS) bad.push('OAuth 설정이 섞임(S1 설정 복제 의심)');
  return bad;
}
export function childEnv(base, fakeUrl, extra) {
  const e = { PATH: base.PATH || '/usr/bin:/bin', HOME: base.HOME || '/tmp', NL_TRANSPORT: 'http', NL_HTTP_HOST: '127.0.0.1', MYBOX_ACCESS_TOKEN: 'fake-token', MYBOX_BASE_URL: fakeUrl, ...extra };
  if (!/^http:\/\/127\.0\.0\.1:\d+\//.test(e.MYBOX_BASE_URL)) throw new Error('MYBOX_BASE_URL 이 루프백이 아님: 시작 거부');
  return e;
}
// 메모리 관측(판정에는 넣지 않는 관측값): 컨테이너(cgroup) 최고치가 있으면 그것을, 없으면 표본 최고치와 프로세스별 최고(VmHWM)를 남긴다.
export function memProbe() {
  const rd = f => { try { return fs.readFileSync(f, 'utf8').trim(); } catch { return null; } };
  const num = v => (v == null || v === 'max' || !/^\d+$/.test(v)) ? null : +v;
  const cur = () => num(rd('/sys/fs/cgroup/memory.current')) ?? num(rd('/sys/fs/cgroup/memory/memory.usage_in_bytes'));
  const lim0 = num(rd('/sys/fs/cgroup/memory.max')) ?? num(rd('/sys/fs/cgroup/memory/memory.limit_in_bytes')); const limit = lim0 != null && lim0 < 2 ** 50 ? lim0 : null;   // 제한 없음(아주 큰 값)은 null
  let sampleMax = cur() || 0, samples = 0;
  const t = setInterval(() => { const c = cur(); if (c != null) { samples++; if (c > sampleMax) sampleMax = c; } }, 200); t.unref();
  return () => { clearInterval(t); const MB = b => b == null ? null : Math.round(b / 1048576 * 10) / 10;
    const peak = num(rd('/sys/fs/cgroup/memory.peak')) ?? num(rd('/sys/fs/cgroup/memory/memory.max_usage_in_bytes'));
    return { cgroup_peak_mb: MB(peak), cgroup_sample_max_mb: MB(sampleMax || null), samples, cgroup_limit_mb: MB(limit), start_proc_max_rss_mb: MB(process.resourceUsage().maxRSS * 1024), note: 'cgroup_peak 는 컨테이너 전체 최고치(커널 기록). 없으면 200ms 표본 최고치만(최고점을 놓칠 수 있음). 판정에는 넣지 않음.' }; };
}
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const bad = guardEnv(process.env);
  if (bad.length) { console.error('S3 시작 거부: ' + bad.join(' / ')); process.exit(3); }
  const memStop = memProbe(); const fake = await startFake(); const results = { startedAt: new Date().toISOString(), node: process.version, status: 'running', note: '합성 데이터만. 실제 MYBOX·토큰 없음.' };
  const PORT = +process.env.PORT || 3000;
  http.createServer((q, r) => { r.setHeader('content-type', 'application/json; charset=utf-8'); r.end(JSON.stringify(q.url.startsWith('/selftest.json') ? results : { service: 'S3 시험(합성)', see: '/selftest.json' }, null, 1)); }).listen(PORT, '0.0.0.0', () => console.log('S3 status on :' + PORT));
  const root = path.resolve(HERE, '..');
  try { results.checks = await runSelfTest({ fakePort: fake.port, bundles: { baseline: path.join(HERE, 'baseline-http.mjs'), fixed: path.join(root, 'mybox-mcp-http.mjs') }, tmp: fs.mkdtempSync(path.join(os.tmpdir(), 's3-')), log: (...a) => console.log(...a), childEnv, guardEnv }); const v = judge(results.checks); results.verdict = v.verdict; results.reasons = v.reasons; results.status = v.verdict === 'PASS' ? 'selftest-pass' : 'selftest-fail'; }
  catch (e) { results.status = 'selftest-error'; results.error = String(e && e.stack || e).slice(0, 2000); console.error(results.error); }
  results.mem = memStop(); console.log('SELFTEST_MEM ' + JSON.stringify(results.mem));
  console.log('SELFTEST_RESULT ' + JSON.stringify(results));
}
