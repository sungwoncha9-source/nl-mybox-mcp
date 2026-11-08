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
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const bad = guardEnv(process.env);
  if (bad.length) { console.error('S3 시작 거부: ' + bad.join(' / ')); process.exit(3); }
  const fake = await startFake(); const results = { startedAt: new Date().toISOString(), node: process.version, status: 'running', note: '합성 데이터만. 실제 MYBOX·토큰 없음.' };
  const PORT = +process.env.PORT || 3000;
  http.createServer((q, r) => { r.setHeader('content-type', 'application/json; charset=utf-8'); r.end(JSON.stringify(q.url.startsWith('/selftest.json') ? results : { service: 'S3 시험(합성)', see: '/selftest.json' }, null, 1)); }).listen(PORT, '0.0.0.0', () => console.log('S3 status on :' + PORT));
  const root = path.resolve(HERE, '..');
  try { results.checks = await runSelfTest({ fakePort: fake.port, bundles: { baseline: path.join(HERE, 'baseline-http.mjs'), fixed: path.join(root, 'mybox-mcp-http.mjs') }, tmp: fs.mkdtempSync(path.join(os.tmpdir(), 's3-')), log: (...a) => console.log(...a), childEnv, guardEnv }); const v = judge(results.checks); results.verdict = v.verdict; results.reasons = v.reasons; results.status = v.verdict === 'PASS' ? 'selftest-pass' : 'selftest-fail'; }
  catch (e) { results.status = 'selftest-error'; results.error = String(e && e.stack || e).slice(0, 2000); console.error(results.error); }
  console.log('SELFTEST_RESULT ' + JSON.stringify(results));
}
