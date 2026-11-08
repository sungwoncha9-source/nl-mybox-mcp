// b1/claimlog 시험: 진단 로그가 (1) 꺼짐 기본값에서 아무것도 안 남기고 (2) 켜면 가명·존재 여부만 남기며 (3) 출입증·원래 sub/azp 값이 새지 않는지.
// 사용: node test/claimlog.mjs <http 번들>   (가짜 인증 서버·가짜 MYBOX만 씀)
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os'; import { spawn } from 'node:child_process';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
const HTTPB = process.argv[2]; const JOBS = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-'));
let pass = 0, fail = 0; const ok = (c, m) => { (c ? pass++ : fail++); console.log((c ? '  OK   ' : '  FAIL ') + m); };
const T = { ROOT: null, ALLOW: 'ROOT' };
const mb = http.createServer((q, s) => { s.setHeader('content-type', 'application/json'); s.end('{}'); }); await new Promise(r => mb.listen(0, '127.0.0.1', r)); const MB = 'http://127.0.0.1:' + mb.address().port + '/v1';
const { publicKey, privateKey } = await generateKeyPair('RS256'); const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
const as = http.createServer((q, s) => { if (q.url === '/.well-known/jwks.json') { s.setHeader('content-type', 'application/json'); return s.end(JSON.stringify({ keys: [jwk] })); } s.statusCode = 404; s.end(); });
await new Promise(r => as.listen(0, '127.0.0.1', r)); const ISS = 'http://127.0.0.1:' + as.address().port + '/'; const AUD = 'http://127.0.0.1/mcp';
const SUB = 'auth0|SECRETSUBVALUE123', AZP = 'APPCLIENTIDSECRET456', CID = 'CONNCLIENTSECRET789';
const sign = (claims = {}) => new SignJWT({ scope: 'openid', ...claims }).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setSubject(SUB).setIssuer(ISS).setAudience(AUD).setIssuedAt().setExpirationTime('10m').sign(privateKey);
const start = (env) => new Promise(resolve => { const p = spawn('node', [HTTPB], { env: { ...process.env, NL_TRANSPORT: 'http', NL_AUTH: 'oauth', NL_HTTP_PORT: '0', NL_PUBLIC_URL: 'http://127.0.0.1', NL_OAUTH_ISSUER: ISS, NL_OAUTH_AUDIENCE: AUD, NL_OAUTH_ALLOWED_SUBS: SUB, MYBOX_ACCESS_TOKEN: 'dummy', MYBOX_BASE_URL: MB, NL_JOBS_DIR: JOBS, NL_JOB_ALLOWED_PARENTS: 'tree:ALLOW', ...env } });
  let err = ''; const o = { p, get err() { return err; } }; p.stderr.on('data', d => { err += d; const m = err.match(/listening on http:\/\/[^:]+:(\d+)\/mcp/); if (m && !o.port) { o.port = +m[1]; resolve(o); } }); });
const post = (port, body, tok, sid) => new Promise(resolve => { const data = Buffer.from(JSON.stringify(body)); const r = http.request({ host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'content-length': data.length, authorization: 'Bearer ' + tok, ...(sid ? { 'mcp-session-id': sid } : {}) } }, res => { const c = []; res.on('data', d => c.push(d)); res.on('end', () => resolve({ status: res.statusCode, h: res.headers, raw: Buffer.concat(c).toString() })); }); r.write(data); r.end(); });
const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } };
const wait = ms => new Promise(r => setTimeout(r, ms));
const lines = (s) => s.err.split('\n').filter(l => l.startsWith('CLAIMLOG {')).map(l => JSON.parse(l.slice(9)));

console.log('[C1] 기본(꺼짐)'); { const s = await start({}); const t = await sign({ azp: AZP }); const r = await post(s.port, init, t); await wait(200);
  ok(r.status === 200, '[C1a] 정상 호출 200'); ok(lines(s).length === 0 && !/CLAIMLOG/.test(s.err), '[C1b] 꺼져 있으면 CLAIMLOG 줄 0'); s.p.kill(); }
console.log('[C2] 켬 + 키 짧음 → 무작위 키로 켜짐(w1/deploy-b1)'); { const s = await start({ NL_CLAIMLOG: '1', NL_CLAIMLOG_KEY: 'short' }); const t = await sign({ azp: AZP }); await post(s.port, init, t); await wait(200);
  ok(lines(s).length >= 1 && /무작위 키/.test(s.err), '[C2a] 키가 짧으면 무작위 키로 켜짐 + 안내'); ok(!s.err.includes('short'), '[C2b] 짧은 키 값 로그에 없음'); s.p.kill(); }
console.log('[C3] 켬'); { const KEY = 'k'.repeat(24); const s = await start({ NL_CLAIMLOG: '1', NL_CLAIMLOG_KEY: KEY });
  const tA = await sign({ azp: AZP }); const tB = await sign({ client_id: CID, gty: 'authorization_code' }); const tC = await sign({});
  const rA = await post(s.port, init, tA); const sid = rA.h['mcp-session-id'];
  await post(s.port, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'job_status', arguments: { job_id: 'none' } } }, tA, sid);
  await post(s.port, init, tB); await post(s.port, init, tC);
  const bad = await post(s.port, init, 'x'.repeat(60)); await wait(300);
  const L = lines(s); ok(L.length === 4, '[C3a] 검증 통과 4건만 기록, 엉터리 출입증은 기록 0 (' + L.length + ')'); ok(bad.status === 401, '[C3b] 엉터리 출입증은 401');
  ok(L[0].azp && L[0].azp.length === 12 && L[0].client_id === null, '[C3c] azp 있는 호출: azp 가명 있음, client_id 없음');
  ok(L[2].client_id && L[2].azp === null && L[2].gty === 'authorization_code', '[C3d] client_id만 있는 호출 구분');
  ok(L[3].azp === null && L[3].client_id === null, '[C3e] 둘 다 없는 호출 구분');
  ok(L[0].sub === L[1].sub && L[0].sub === L[2].sub && L[0].sub.length === 12, '[C3f] 같은 사용자는 같은 sub 가명');
  ok(L[1].mcp === 'tools/call' && L[1].tool === 'job_status', '[C3g] 도구 이름 기록');
  ok(L.every(x => x.aud_ok === true && x.scope_n >= 1), '[C3h] aud 일치·scope 개수 기록');
  const all = s.err; for (const [n, v] of [['sub', SUB], ['azp', AZP], ['client_id', CID], ['출입증 A', tA], ['출입증 B', tB], ['키', KEY], ['Bearer', 'Bearer ']]) ok(!all.includes(v), '[C3i] 로그에 ' + n + ' 원값 없음');
  s.p.kill(); }
console.log('\n통과 ' + pass + ' / 실패 ' + fail); as.close(); mb.close(); process.exit(fail ? 1 : 0);
