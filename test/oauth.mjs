// 1.10.0 시험: OAuth 출입증 검사 + 연결마다 세션 — 가짜 인증 서버(JWKS)와 가짜 MYBOX만 쓴다(실제 Auth0·MYBOX 호출 없음).
// 사용: node test/oauth.mjs <http 번들>
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os'; import crypto from 'node:crypto'; import { spawn } from 'node:child_process';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
const HTTPB = process.argv[2]; const JOBS = fs.mkdtempSync(path.join(os.tmpdir(), 'oj-'));
let pass = 0, fail = 0; const LOG = []; const ok = (c, m) => { (c ? pass++ : fail++); const l = (c ? '  OK   ' : '  FAIL ') + m; console.log(l); LOG.push(l); };

// ---- 가짜 MYBOX (호출 수를 센다) ----
const T = { ROOT: null, OUT: 'ROOT', ALLOW: 'ROOT', SUB: 'ALLOW', F1: 'SUB' }; const calls = [];
const mb = http.createServer((req, res) => { const ch = []; req.on('data', d => ch.push(d)); req.on('end', () => {
  const u = new URL(req.url, 'http://x'); calls.push(req.method + ' ' + u.pathname); let m;
  const json = (o, s = 200) => { res.statusCode = s; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
  if (req.method === 'GET' && (m = u.pathname.match(/^\/v1\/drive\/resources\/([^/]+)$/))) return (m[1] in T) ? json({ resourceId: m[1], parentId: T[m[1]] }) : json({}, 404);
  if (req.method === 'GET' && (m = u.pathname.match(/^\/v1\/drive\/folders\/([^/]+)\/resources$/))) return json({ resources: Object.keys(T).filter(k => T[k] === m[1]).map(k => ({ resourceId: k, name: k })), responseMetaData: {} });
  json({ e: 'nf' }, 404); }); });
await new Promise(r => mb.listen(0, '127.0.0.1', r)); const MB = 'http://127.0.0.1:' + mb.address().port + '/v1';

// ---- 가짜 인증 서버: JWKS만 내놓는다. 출입증은 시험이 직접 서명한다 ----
const { publicKey, privateKey } = await generateKeyPair('RS256'); const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
const other = await generateKeyPair('RS256');
let jwksHits = 0;
const as = http.createServer((req, res) => { if (req.url === '/.well-known/jwks.json') { jwksHits++; res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ keys: [jwk] })); } res.statusCode = 404; res.end(); });
await new Promise(r => as.listen(0, '127.0.0.1', r)); const ISS = 'http://127.0.0.1:' + as.address().port + '/';
const PUB = 'http://127.0.0.1:1'; // 공개 주소(이름만 쓰임). 시작 뒤 실제 포트로 바꿔 쓴다
const BOSS = 'google-oauth2|boss', STRANGER = 'google-oauth2|stranger', BOSS2 = 'auth0|boss-second';
const ALL6 = 'job_put_chunk,job_status,dms_list,files_copy,files_move,files_create_folder';
const sign = async ({ sub = BOSS, aud, iss = ISS, exp = '10m', key = privateKey, kid = 'k1', alg = 'RS256' } = {}) =>
  new SignJWT({ scope: 'openid' }).setProtectedHeader({ alg, kid }).setSubject(sub).setIssuer(iss).setAudience(aud).setIssuedAt().setExpirationTime(exp).sign(key);

const start = (env = {}) => new Promise(resolve => { const p = spawn('node', [HTTPB], { env: { ...process.env, NL_TRANSPORT: 'http', NL_AUTH: 'oauth', NL_HTTP_PORT: '0',
  NL_PUBLIC_URL: 'http://127.0.0.1', NL_OAUTH_ISSUER: ISS, NL_OAUTH_AUDIENCE: 'http://127.0.0.1/mcp', NL_OAUTH_ALLOWED_SUBS: BOSS + ',' + BOSS2,
  MYBOX_ACCESS_TOKEN: 'dummy', MYBOX_BASE_URL: MB, NL_JOBS_DIR: JOBS, NL_JOB_ALLOWED_PARENTS: 'tree:ALLOW', NL_HTTP_TOOLS: ALL6, ...env } });
  let err = ''; p.stderr.on('data', d => { err += d; const mm = err.match(/listening on http:\/\/[^:]+:(\d+)\/mcp/); if (mm) resolve({ p, port: +mm[1], err }); }); p.on('exit', c => resolve({ exited: c, err })); });
const req = (port, method, p, body, headers = {}) => new Promise(resolve => { const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(data ? { 'content-length': data.length } : {}), ...headers } }, res => { const c = []; res.on('data', d => c.push(d)); res.on('end', () => { const raw = Buffer.concat(c).toString(); let j = null; try { j = JSON.parse(raw); } catch (_) {} resolve({ status: res.statusCode, json: j, raw, h: res.headers }); }); });
  if (data) r.write(data); r.end(); });
const initBody = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } };
const bearer = (t) => ({ authorization: 'Bearer ' + t });
const AUD = 'http://127.0.0.1/mcp';

console.log('[O1] 시작 거부');
for (const [env, name] of [[{ NL_OAUTH_ALLOWED_SUBS: '' }, '허용 사용자 목록이 비면'], [{ NL_OAUTH_ISSUER: '' }, '발급자 주소가 없으면'],
  [{ NL_PUBLIC_URL: 'http://mybox.example.com' }, '공개 주소가 https가 아니면'], [{ NL_HTTP_TOOLS: 'job_put_chunk,files_delete' }, '지킴이 없는 도구(files_delete)를 열려 하면']]) {
  const s = await start(env); ok(s.exited !== undefined && s.exited !== 0, '[O1] ' + name + ' 시작하지 않음 (exit ' + s.exited + ')'); }

const S = await start(); const P = S.port; ok(!!P, '[O0] 정상 설정으로 시작');
console.log('[O2] 안내 주소');
const md = await req(P, 'GET', '/.well-known/oauth-protected-resource/mcp');
ok(md.status === 200 && md.json.resource === AUD && md.json.authorization_servers[0] === ISS, '[O2a] 메타데이터가 인증 없이 읽히고 resource·발급자가 맞음');
const n0 = await req(P, 'POST', '/mcp', initBody);
ok(n0.status === 401 && /resource_metadata="http:\/\/127\.0\.0\.1\/\.well-known\/oauth-protected-resource\/mcp"/.test(n0.h['www-authenticate'] || ''), '[O2b] 출입증 없으면 401 + 안내 주소 (' + n0.h['www-authenticate'] + ')');

console.log('[O3] 출입증 거부 — 모두 MYBOX 호출 0');
const c0 = calls.length;
const none = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url') + '.' + Buffer.from(JSON.stringify({ sub: BOSS, iss: ISS, aud: AUD, exp: Math.floor(Date.now() / 1000) + 600 })).toString('base64url') + '.';
const bad = [
  ['엉터리 출입증', 'x'.repeat(60), 401], ['만료된 출입증', await sign({ aud: AUD, exp: Math.floor(Date.now() / 1000) - 120 }), 401],
  ['대상(aud)이 다른 출입증', await sign({ aud: 'https://other-api.example/' }), 401], ['발급자가 다른 출입증', await sign({ aud: AUD, iss: 'https://evil.example/' }), 401],
  ['다른 열쇠로 서명', await sign({ aud: AUD, key: other.privateKey }), 401], ['alg:none 위조', none, 401],
  ['고정 토큰을 출입증 자리에', crypto.randomBytes(24).toString('hex'), 401], ['허용 안 된 사용자', await sign({ aud: AUD, sub: STRANGER }), 403]];
for (const [name, tok, want] of bad) { const r = await req(P, 'POST', '/mcp', initBody, bearer(tok)); ok(r.status === want && !r.h['mcp-session-id'], '[O3] ' + name + ' → ' + r.status + (r.h['www-authenticate'] ? ' (' + (r.h['www-authenticate'].match(/error="([^"]+)"/) || [, '-'])[1] + ')' : '')); }
ok(calls.length === c0, '[O3z] 거부된 요청 동안 MYBOX 호출 ' + (calls.length - c0) + '건');

console.log('[O4] 허용·다중 연결');
const tokA = await sign({ aud: AUD }), tokB = await sign({ aud: AUD, sub: BOSS2 });
const mk = async (tok) => { const c = new Client({ name: 'c', version: '1' }); const t = new StreamableHTTPClientTransport(new URL('http://127.0.0.1:' + P + '/mcp'), { requestInit: { headers: bearer(tok) } }); await c.connect(t); return { c, t }; };
const A = await mk(tokA); const tools = (await A.c.listTools()).tools.map(t => t.name).sort();
ok(tools.join(',') === ALL6.split(',').sort().join(','), '[O4a] 정상 출입증으로 연결, 도구 6개만 보임 (' + tools.length + '개; PC 경로 도구 없음)');
const la = JSON.parse((await A.c.callTool({ name: 'dms_list', arguments: { resourceId: 'SUB' } })).content[0].text);
ok(Array.isArray(la.resources) && la.resources[0].resourceId === 'F1', '[O4b] 허용 폴더 목록 호출 성공');
const B = await mk(tokA); const C = await mk(tokB);
const lb = JSON.parse((await B.c.callTool({ name: 'dms_list', arguments: { resourceId: 'SUB' } })).content[0].text);
const lc = JSON.parse((await C.c.callTool({ name: 'dms_list', arguments: { resourceId: 'SUB' } })).content[0].text);
ok(A.t.sessionId && B.t.sessionId && C.t.sessionId && new Set([A.t.sessionId, B.t.sessionId, C.t.sessionId]).size === 3 && lb.resources && lc.resources, '[O4c] 세 클라이언트(두 사용자) 동시 연결, 세션 번호 서로 다름, 모두 호출 성공');
const steal = await req(P, 'POST', '/mcp', { jsonrpc: '2.0', id: 9, method: 'tools/list' }, { ...bearer(tokB), 'mcp-session-id': A.t.sessionId, 'mcp-protocol-version': '2025-06-18' });
ok(steal.status === 403, '[O4d] 다른 사용자가 남의 세션 번호를 쓰면 403');
const ghost = await req(P, 'POST', '/mcp', { jsonrpc: '2.0', id: 9, method: 'tools/list' }, { ...bearer(tokA), 'mcp-session-id': crypto.randomUUID(), 'mcp-protocol-version': '2025-06-18' });
ok(ghost.status === 404, '[O4e] 없는 세션 번호는 404(클라이언트가 새로 연결)');
const noSess = await req(P, 'POST', '/mcp', { jsonrpc: '2.0', id: 9, method: 'tools/list' }, bearer(tokA));
ok(noSess.status === 400, '[O4f] 세션 번호 없이 초기화 아닌 요청은 400');
const out = await A.c.callTool({ name: 'dms_list', arguments: { resourceId: 'OUT' } });
ok(out.isError && /not_allowed/.test(out.content[0].text), '[O4g] 출입증이 맞아도 지킴이는 그대로(허용 밖 폴더 거부)');

console.log('[O5] 기타');
const rNo = await req(P, 'GET', '/api/v1/folders/SUB/resources'); const rOk = await req(P, 'GET', '/api/v1/folders/SUB/resources', undefined, bearer(tokA));
const rBad = await req(P, 'GET', '/api/v1/folders/SUB/resources', undefined, bearer(await sign({ aud: AUD, sub: STRANGER })));
ok(rNo.status === 401 && rOk.status === 200 && rBad.status === 403, '[O5a] REST 문도 같은 검사 (없음 ' + rNo.status + ' / 정상 ' + rOk.status + ' / 다른 사용자 ' + rBad.status + ')');
ok((await req(P, 'POST', '/mcp', initBody, { ...bearer(tokA), host: 'evil.example' })).status === 403, '[O5b] 공개 이름이 아닌 Host는 403');
S.p.kill();
const S2 = await start({ NL_SESSION_MAX: '2', NL_SESSION_IDLE_SEC: '1' }); const P2 = S2.port;
const i1 = await req(P2, 'POST', '/mcp', initBody, bearer(tokA)), i2 = await req(P2, 'POST', '/mcp', initBody, bearer(tokA)), i3 = await req(P2, 'POST', '/mcp', initBody, bearer(tokA));
ok(i1.status === 200 && i2.status === 200 && i3.status === 503, '[O5c] 세션 상한 2에서 세 번째 연결은 503 (' + [i1.status, i2.status, i3.status] + ')');
await new Promise(r => setTimeout(r, 2600));
const after = await req(P2, 'POST', '/mcp', { jsonrpc: '2.0', id: 3, method: 'tools/list' }, { ...bearer(tokA), 'mcp-session-id': i1.h['mcp-session-id'], 'mcp-protocol-version': '2025-06-18' });
const i4 = await req(P2, 'POST', '/mcp', initBody, bearer(tokA));
ok(after.status === 404 && i4.status === 200, '[O5d] 쉰 세션은 자동 정리(404) → 자리가 비어 새 연결 200');
S2.p.kill();
ok(jwksHits >= 1, '[O6] 서명 열쇠는 인증 서버 JWKS에서 받음 (' + jwksHits + '회)');
console.log(`통과 ${pass} / 실패 ${fail}`);
fs.writeFileSync('./oauth_log.txt', LOG.join('\n') + `\n통과 ${pass} / 실패 ${fail}\nMYBOX 호출 ${calls.length}건\n` + calls.join('\n'));
await A.c.close().catch(() => {}); await B.c.close().catch(() => {}); await C.c.close().catch(() => {});
mb.close(); as.close(); process.exit(fail ? 1 : 0);
