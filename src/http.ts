// mybox-mcp HTTP 문 (1.10.0 시험) — 같은 도구를 Streamable HTTP로 연다. 기본은 꺼짐(NL_TRANSPORT=http 일 때만).
// 1.9.1~1.9.3: 고정 토큰·Host·Origin·도구 허용 목록, 일반 HTTPS 문(/api/v1).
// 1.10.0 바뀐 것:
//  ① 연결(세션)마다 서버를 새로 만든다 → 여러 프로젝트·여러 대화가 동시에 붙는다. 세션은 처음 연 사용자(sub)에게 묶인다.
//     오래 쉬는 세션은 닫고(NL_SESSION_IDLE_SEC, 기본 1800), 동시에 열 수 있는 세션 수에 상한(NL_SESSION_MAX, 기본 50)을 둔다.
//  ② 인증 방식 NL_AUTH: token(기본, 이전과 같음) | oauth.
//     oauth = 이 서버는 출입증(JWT)을 검사만 한다. 로그인·출입증 발급은 바깥 인증 서비스(Auth0 등)가 한다.
//       · 발급자(iss)·대상(aud)·만료(exp)·서명(JWKS, RS256/ES256만)을 검사하고, 허용한 사용자(sub)만 통과시킨다(NL_OAUTH_ALLOWED_SUBS, 비면 시작 안 함).
//       · 출입증이 없거나 틀리면 401 + WWW-Authenticate에 안내 주소(resource_metadata)를 실어 Claude가 로그인 창을 열게 한다.
//       · 안내 주소: /.well-known/oauth-protected-resource(/mcp) — RFC 9728. 인증 없이 읽힌다(비밀 없음).
//       · 고정 토큰은 oauth 모드에서 통하지 않는다.
//  ④ (w1/json-response) POST 응답을 SSE가 아니라 JSON 한 번에 돌려주고(enableJsonResponse), GET /mcp는 405.
//  ③ Host 허용에 공개 주소(NL_PUBLIC_URL)의 이름을 더한다(클라우드에서는 바깥 이름으로 들어오므로).
import http from 'node:http';
import crypto from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createRemoteJWKSet, jwtVerify } from 'jose';

const safeEq = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };
// b1/claimlog (시험 전용, 기본 꺼짐): NL_CLAIMLOG=1 이고 NL_CLAIMLOG_KEY(16자 이상)가 있을 때만 검증한 클레임의 최소 진단을 stderr 한 줄로 남긴다.
// 남기는 것: 서버 키 HMAC 앞 12자(sub·azp·client_id 가명, 같은 값이면 같은 가명), aud 일치 여부·개수, scope 보유 여부, gty, MCP 메서드/도구 이름.
// 남기지 않는 것: 출입증 전문, 헤더, 원래 sub·azp·client_id 값, 요청 본문.
// w1/deploy-b1: 키를 안 주면 프로세스마다 무작위 키를 만든다(가명이 프로세스 안에서만 같음 → 재시작하면 바뀜, 같은 호출자 비교에는 충분).
// w1/deploy-b1: JSON 응답 모드는 NL_JSON_RESPONSE=1일 때만(기본 꺼짐 = 1.10.0과 같은 SSE). 실제 Claude 커넥터에서 확인되기 전까지 기본을 바꾸지 않는다.
const JSONMODE = process.env.NL_JSON_RESPONSE === '1';
const CLAIMLOG = process.env.NL_CLAIMLOG === '1';
const CLAIMKEY = (process.env.NL_CLAIMLOG_KEY || '').length >= 16 ? String(process.env.NL_CLAIMLOG_KEY) : crypto.randomBytes(24).toString('hex');
const hmac12 = (v: string) => crypto.createHmac('sha256', CLAIMKEY).update(v).digest('hex').slice(0, 12);
const claimLog = (who: any, req: http.IncomingMessage, path: string, body: any) => {
  if (!CLAIMLOG || !who || !who.diag) return;
  const sid = String(req.headers['mcp-session-id'] || '');
  const m = body && typeof body === 'object' ? String(body.method || '').slice(0, 40) : '';
  const tool = m === 'tools/call' && body.params ? String(body.params.name || '').slice(0, 40) : '';
  console.error('CLAIMLOG ' + JSON.stringify({ t: new Date().toISOString(), http: req.method, path: path.slice(0, 40), mcp: m || null, tool: tool || null, sess: sid ? hmac12(sid) : null, ...who.diag }));
};
const LOOP = ['127.0.0.1', 'localhost', '[::1]', '::1'];
const isLoopUrl = (u: URL) => LOOP.includes(u.hostname);
const list = (v: string | undefined) => (v || '').split(',').map(x => x.trim()).filter(Boolean);

// 일반 HTTPS 문(/api/v1). MCP와 같은 관문 뒤에서 같은 반영 핵심(core)을 부른다(1.9.3과 같음).
async function restRoute(req: http.IncomingMessage, res: http.ServerResponse, body: any, core: any, allow: Set<string>) {
  const send = (code: number, o: any) => { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
  const u = new URL(req.url || '/', 'http://x'); const p = u.pathname; let m: RegExpMatchArray | null; let tool = '', fn: (() => Promise<any>) | null = null;
  if (req.method === 'GET' && (m = p.match(/^\/api\/v1\/folders\/([^/]+)\/resources$/))) { tool = 'dms_list'; const id = m[1]; fn = () => core.list(id, Object.fromEntries(u.searchParams)); }
  else if (req.method === 'POST' && p === '/api/v1/folders') { tool = 'files_create_folder'; fn = () => core.createFolder(body || {}); }
  else if (req.method === 'POST' && (m = p.match(/^\/api\/v1\/resources\/([^/]+)\/(copy|move)$/))) { const id = m[1], k = m[2]; tool = k === 'copy' ? 'files_copy' : 'files_move'; fn = () => core[k](id, body || {}); }
  else if (req.method === 'GET' && (m = p.match(/^\/api\/v1\/resources\/([^/]+)\/download$/))) { tool = 'files_download'; const id = m[1]; fn = () => core.download(id); }
  else if (req.method === 'POST' && p === '/api/v1/jobs/chunk') { tool = 'job_put_chunk'; fn = () => core.putChunk(body || {}); }
  else if (req.method === 'GET' && (m = p.match(/^\/api\/v1\/jobs\/([^/]+)$/))) { tool = 'job_status'; const id = m[1]; fn = async () => core.status(id); }
  if (!fn) return send(404, { error: 'not found' });
  if (!allow.has(tool)) return send(403, { error: 'tool not open: ' + tool });
  try { send(200, await fn()); } catch (e: any) { const msg = String(e && e.message || e).slice(0, 300); send(msg.startsWith('not_allowed') ? 403 : /^API Error: (\d+)/.test(msg) ? 502 : 400, { error: msg }); }
}

type Who = { sub: string; diag?: any };
type Auth = { mode: 'token' | 'oauth'; check: (h: string) => Promise<Who | { status: number; error: string; desc?: string }>; challenge: (err?: string) => string; metadata?: any };

function makeAuth(): Auth {
  const mode = (process.env.NL_AUTH || 'token') as 'token' | 'oauth';
  if (mode === 'token') {
    const token = process.env.NL_HTTP_TOKEN || '';
    if (token.length < 24) throw new Error('NL_HTTP_TOKEN(24자 이상)이 필요합니다 — 토큰 없이 HTTP를 열지 않습니다');
    return { mode, challenge: () => 'Bearer',
      check: async (h) => (h.startsWith('Bearer ') && safeEq(h.slice(7), token)) ? { sub: 'token' } : { status: 401, error: 'unauthorized' } };
  }
  if (mode !== 'oauth') throw new Error('NL_AUTH는 token 또는 oauth 입니다: ' + mode);
  const pub = process.env.NL_PUBLIC_URL || ''; let pubU: URL;
  try { pubU = new URL(pub); } catch { throw new Error('oauth: NL_PUBLIC_URL(바깥에서 보이는 https 주소)이 필요합니다'); }
  if (pubU.protocol !== 'https:' && !isLoopUrl(pubU)) throw new Error('oauth: NL_PUBLIC_URL은 https여야 합니다(시험용 127.0.0.1만 예외)');
  const issuer = process.env.NL_OAUTH_ISSUER || ''; let issU: URL;
  try { issU = new URL(issuer); } catch { throw new Error('oauth: NL_OAUTH_ISSUER(인증 서비스 주소)가 필요합니다'); }
  if (issU.protocol !== 'https:' && !isLoopUrl(issU)) throw new Error('oauth: NL_OAUTH_ISSUER는 https여야 합니다');
  const jwksU = new URL(process.env.NL_OAUTH_JWKS_URL || new URL('.well-known/jwks.json', issuer.endsWith('/') ? issuer : issuer + '/').toString());
  if (jwksU.protocol !== 'https:' && !isLoopUrl(jwksU)) throw new Error('oauth: NL_OAUTH_JWKS_URL은 https여야 합니다');
  const resource = process.env.NL_OAUTH_AUDIENCE || pubU.origin + '/mcp';
  const subs = list(process.env.NL_OAUTH_ALLOWED_SUBS);
  if (!subs.length) throw new Error('oauth: NL_OAUTH_ALLOWED_SUBS가 비어 있어 시작하지 않습니다(누구나 로그인만 하면 들어오게 되므로)');
  const scope = (process.env.NL_OAUTH_REQUIRED_SCOPE || '').trim();
  const jwks = createRemoteJWKSet(jwksU, { timeoutDuration: 5000, cooldownDuration: 30000 });
  const metaUrl = pubU.origin + '/.well-known/oauth-protected-resource' + (new URL(resource).pathname.replace(/\/$/, '') || '');
  const metadata = { resource, authorization_servers: [issuer], bearer_methods_supported: ['header'], ...(scope ? { scopes_supported: [scope] } : {}) };
  const challenge = (err?: string) => 'Bearer resource_metadata="' + metaUrl + '"' + (scope ? ', scope="' + scope + '"' : '') + (err ? ', error="' + err + '"' : '');
  return { mode, challenge, metadata,
    check: async (h) => {
      if (!h.startsWith('Bearer ') || h.length < 20) return { status: 401, error: 'unauthorized' };
      let payload: any;
      try { ({ payload } = await jwtVerify(h.slice(7), jwks, { issuer, audience: resource, algorithms: ['RS256', 'ES256'], clockTolerance: 30, requiredClaims: ['exp', 'sub'] })); }
      catch (e: any) { return { status: 401, error: 'invalid_token', desc: String(e && e.code || 'invalid') }; }
      if (scope) { const have = String(payload.scope || '').split(' ').concat(Array.isArray(payload.permissions) ? payload.permissions : []); if (!have.includes(scope)) return { status: 403, error: 'insufficient_scope' }; }
      if (!subs.includes(String(payload.sub))) return { status: 403, error: 'forbidden_user' };
      const pseudo = (v: any) => (v === undefined || v === null || v === '') ? null : hmac12(String(v));
      const aud = Array.isArray(payload.aud) ? payload.aud : (payload.aud === undefined ? [] : [payload.aud]);
      const diag = { sub: pseudo(payload.sub), azp: pseudo(payload.azp), client_id: pseudo(payload.client_id), gty: payload.gty ? String(payload.gty).slice(0, 24) : null,
        aud_ok: aud.includes(resource), aud_n: aud.length, scope_has: !!scope && String(payload.scope || '').split(' ').concat(Array.isArray(payload.permissions) ? payload.permissions : []).includes(scope),
        scope_n: String(payload.scope || '').split(' ').filter(Boolean).length };
      return { sub: String(payload.sub), diag };
    } };
}

export async function runHttp(buildServer: (allow: Set<string>) => any, core?: any): Promise<http.Server> {
  const auth = makeAuth();
  const host = process.env.NL_HTTP_HOST || '127.0.0.1';
  if (!['127.0.0.1', 'localhost', '::1'].includes(host) && process.env.NL_HTTP_ALLOW_REMOTE !== '1') throw new Error('로컬 밖 주소(' + host + ')에는 NL_HTTP_ALLOW_REMOTE=1 이 있어야 합니다');
  const port = Number(process.env.NL_HTTP_PORT) || 0;
  const origins = list(process.env.NL_HTTP_ORIGINS);
  const allowTools = new Set(list(process.env.NL_HTTP_TOOLS || 'job_put_chunk,job_status'));
  const hosts = new Set([...LOOP, host]); if (process.env.NL_PUBLIC_URL) try { hosts.add(new URL(process.env.NL_PUBLIC_URL).hostname); } catch {}
  const IDLE = (Number(process.env.NL_SESSION_IDLE_SEC) || 1800) * 1000, MAX = Number(process.env.NL_SESSION_MAX) || 50;
  const sessions = new Map<string, { t: any; s: any; sub: string; last: number }>();
  const closeSession = (id: string) => { const e = sessions.get(id); if (!e) return; sessions.delete(id); try { e.t.close(); } catch {} try { e.s.close(); } catch {} };
  const sweep = setInterval(() => { const now = Date.now(); for (const [id, e] of sessions) if (now - e.last > IDLE) closeSession(id); }, Math.min(IDLE, 60000)); sweep.unref();

  const srv = http.createServer(async (req, res) => {
    const deny = (code: number, msg: string, extra: any = {}) => { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ error: msg, ...extra })); };
    try {
      const hostHdr = String(req.headers.host || '').replace(/:\d+$/, '');
      if (!hosts.has(hostHdr)) return deny(403, 'host not allowed');
      const origin = String(req.headers.origin || '');
      if (origin) {
        if (!origins.includes(origin)) return deny(403, 'origin not allowed');
        res.setHeader('access-control-allow-origin', origin); res.setHeader('vary', 'origin');
        res.setHeader('access-control-allow-headers', 'authorization, content-type, accept, mcp-session-id, mcp-protocol-version, last-event-id');
        res.setHeader('access-control-expose-headers', 'mcp-session-id, www-authenticate'); res.setHeader('access-control-allow-methods', 'POST, GET, DELETE, OPTIONS');
      }
      if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
      const path = (req.url || '/').split('?')[0];
      if (auth.metadata && req.method === 'GET' && (path === '/.well-known/oauth-protected-resource' || path.startsWith('/.well-known/oauth-protected-resource/'))) {
        res.setHeader('cache-control', 'public, max-age=300'); res.statusCode = 200; res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify(auth.metadata));
      }
      if (!(path === '/mcp' || (core && path.startsWith('/api/v1/')))) return deny(404, 'not found');
      const who = await auth.check(String(req.headers.authorization || ''));
      if (!('sub' in who)) { res.setHeader('www-authenticate', auth.challenge(who.error === 'unauthorized' ? undefined : who.error)); return deny(who.status, who.error); }
      let body: any = undefined;
      if (req.method === 'POST') { const chunks: Buffer[] = []; let n = 0; for await (const c of req) { n += (c as Buffer).length; if (n > 4 * 1024 * 1024) return deny(413, 'too large'); chunks.push(c as Buffer); } try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return deny(400, 'bad json'); } }
      claimLog(who, req, path, body);
      if (path.startsWith('/api/v1/')) return await restRoute(req, res, body, core, allowTools);
      // 응답은 JSON 한 번에(SSE 스트림 없음). 서버가 먼저 보내는 알림이 없으므로 GET 스트림은 열지 않는다(스펙상 405 허용).
      if (JSONMODE && req.method === 'GET') { res.setHeader('allow', 'POST, DELETE, OPTIONS'); return deny(405, 'method not allowed'); }
      const sid = String(req.headers['mcp-session-id'] || '');
      if (sid) {
        const e = sessions.get(sid);
        if (!e) return deny(404, 'session not found', { jsonrpc: '2.0', id: null });   // 클라이언트가 새로 연결하게 한다(스펙)
        if (e.sub !== who.sub) return deny(403, 'session belongs to another user');
        e.last = Date.now();
        await e.t.handleRequest(req, res, body);
        if (req.method === 'DELETE') closeSession(sid);
        return;
      }
      if (req.method !== 'POST' || !isInitializeRequest(body)) return deny(400, 'mcp-session-id required');
      if (sessions.size >= MAX) return deny(503, 'too many sessions');
      const s = buildServer(allowTools);
      const t: any = new StreamableHTTPServerTransport({ sessionIdGenerator: () => crypto.randomUUID(), enableJsonResponse: JSONMODE,
        onsessioninitialized: (id: string) => { sessions.set(id, { t, s, sub: who.sub, last: Date.now() }); } });
      t.onclose = () => { if (t.sessionId) sessions.delete(t.sessionId); };
      await s.connect(t);
      await t.handleRequest(req, res, body);
    } catch (e: any) { if (!res.headersSent) deny(500, String(e && e.message || e).slice(0, 200)); else res.end(); }
  });
  srv.on('close', () => { clearInterval(sweep); for (const id of [...sessions.keys()]) closeSession(id); });
  await new Promise<void>(r => srv.listen(port, host, r));
  if (CLAIMLOG) console.error('CLAIMLOG 켜짐 (시험 전용, 가명만 기록' + ((process.env.NL_CLAIMLOG_KEY || '').length >= 16 ? '' : ', 무작위 키') + ')');
  if (JSONMODE) console.error('JSON 응답 모드 켜짐 (NL_JSON_RESPONSE=1)');
  if (process.env.NL_B2_PROBE === '1') {   // w1/deploy-b1: 시작 때 한 번 MYBOX 읽기 시험(GET만). 결과 줄만 로그에 남고 토큰은 출력되지 않는다.
    import('node:child_process').then(({ spawn }) => { const c = spawn(process.execPath, [new URL('./tools/b2_read_probe.mjs', import.meta.url).pathname], { stdio: ['ignore', 'inherit', 'inherit'], env: process.env }); c.on('error', (e: any) => console.error('B2 시험 시작 실패: ' + String(e && e.message || e).slice(0, 120))); c.on('exit', (code: any) => console.error('B2 시험 종료 코드 ' + code)); });
  }
  const a: any = srv.address(); console.error('MYBOX MCP HTTP listening on http://' + host + ':' + a.port + '/mcp (인증: ' + auth.mode + ', 도구: ' + [...allowTools].join(',') + ')');
  return srv;
}
