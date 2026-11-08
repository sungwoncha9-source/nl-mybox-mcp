// b2_read_probe 시험: 가짜 MYBOX에서 읽기 3단계가 통과하고, GET 외 호출 0, 토큰이 출력에 안 나오는지.
import http from 'node:http'; import { spawn } from 'node:child_process'; import crypto from 'node:crypto';
let pass = 0, fail = 0; const ok = (c, m) => { (c ? pass++ : fail++); console.log((c ? '  OK   ' : '  FAIL ') + m); };
const methods = []; const authsOnDl = []; const DATA = Buffer.from('hello-probe'); let corrupt = false, n = 0;
const s = http.createServer((q, r) => { methods.push(q.method); const u = new URL(q.url, 'http://x'); const j = (o, c = 200) => { r.statusCode = c; r.setHeader('content-type', 'application/json'); r.end(JSON.stringify(o)); };
  if (u.pathname === '/v1/drive/storage') return j({ totalSize: 1, usedSize: 0 });
  if (u.pathname === '/v1/drive/folders/FOLD/resources') return j({ resources: [{ resourceId: 'BIG', name: 'a', size: 9e9 }, { resourceId: 'F1', name: 'b', size: DATA.length }] });
  if (u.pathname === '/v1/drive/files/F1/download') return j({ downloadUrl: 'http://127.0.0.1:' + s.address().port + '/dl' });
  if (u.pathname === '/dl') { authsOnDl.push(q.headers.authorization || ''); n++; return r.end(corrupt && n % 2 === 0 ? Buffer.from('HELLO-probe') : DATA); }
  j({}, 404); });
await new Promise(r => s.listen(0, '127.0.0.1', r)); const BASE = 'http://127.0.0.1:' + s.address().port + '/v1'; const TOK = 'SECRETTOKEN' + 'x'.repeat(20);
const run = (env) => new Promise(res => { const p = spawn('node', ['tools/b2_read_probe.mjs'], { env: { ...process.env, MYBOX_BASE_URL: BASE, MYBOX_ACCESS_TOKEN: TOK, ...env } }); let stdout = '', stderr = ''; p.stdout.on('data', d => stdout += d); p.stderr.on('data', d => stderr += d); p.on('close', status => res({ status, stdout, stderr })); }); // 같은 프로세스의 가짜 서버가 응답해야 하므로 비동기로 실행
let o = await run({ B2_FOLDER_ID: 'FOLD' }); ok(/①통과 ②통과 ③통과/.test(o.stdout), '[P1] 3단계 통과'); ok(methods.every(m => m === 'GET'), '[P2] GET 외 호출 0 (' + [...new Set(methods)] + ')');
ok(!o.stdout.includes(TOK) && !o.stderr.includes(TOK), '[P3] 토큰이 출력에 없음'); ok(authsOnDl.every(a => a === ''), '[P4] 서명 주소에는 Authorization을 보내지 않음');
ok(/1MB 이하|크기 11B/.test(o.stdout) && /일치/.test(o.stdout), '[P5] 1MB 초과 파일(BIG)은 건너뛰고 작은 파일 대조: ' + (o.stdout.match(/③[^\n]*/) || [''])[0].slice(0, 120));
corrupt = true; n = 0; o = await run({ B2_FOLDER_ID: 'FOLD' }); ok(/③불합격/.test(o.stdout), '[P6] 두 번 받은 내용이 다르면 불합격으로 잡음');
o = await run({}); ok(o.status === 2 && /B2_FOLDER_ID/.test(o.stdout), '[P7] 폴더 지정이 없으면 루트를 열지 않고 중지'); o = await run({ MYBOX_ACCESS_TOKEN: '' }); ok(o.status === 2, '[P8] 토큰이 없으면 중지');
console.log('\n통과 ' + pass + ' / 실패 ' + fail); s.close(); process.exit(fail ? 1 : 0);
