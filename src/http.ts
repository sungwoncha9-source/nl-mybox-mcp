// 1.9.1 시험용: 같은 도구를 Streamable HTTP로도 연다(웹·데스크톱 공통 지원의 통신 계층 실증).
// 기본은 꺼짐 — NL_TRANSPORT=http 일 때만 쓴다. 이 모듈은 "공개 서비스"가 아니다:
//  · 토큰(NL_HTTP_TOKEN 24자 이상) 없으면 시작하지 않는다 · 기본 바인딩은 127.0.0.1 이고, 다른 주소는 NL_HTTP_ALLOW_REMOTE=1 이 있어야 한다
//  · Host 헤더 점검(DNS 리바인딩 방지) · 브라우저 출처(Origin)는 NL_HTTP_ORIGINS 허용 목록에 있는 것만(기본: 없음 = 브라우저에서 직접 호출 불가)
//  · HTTP로는 일감 도구(NL_HTTP_TOOLS, 기본 job_put_chunk·job_status)만 열고 나머지 MYBOX 도구(삭제·이동 등)는 비활성화한다
import http from 'node:http';
import crypto from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

const safeEq = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };

export async function runHttp(server: any): Promise<http.Server> {
  const token = process.env.NL_HTTP_TOKEN || '';
  if (token.length < 24) throw new Error('NL_HTTP_TOKEN(24자 이상)이 필요합니다 — 토큰 없이 HTTP를 열지 않습니다');
  const host = process.env.NL_HTTP_HOST || '127.0.0.1';
  if (!['127.0.0.1', 'localhost', '::1'].includes(host) && process.env.NL_HTTP_ALLOW_REMOTE !== '1') throw new Error('로컬 밖 주소(' + host + ')에는 NL_HTTP_ALLOW_REMOTE=1 이 있어야 합니다');
  const port = Number(process.env.NL_HTTP_PORT) || 0;
  const origins = (process.env.NL_HTTP_ORIGINS || '').split(',').map(x => x.trim()).filter(Boolean);
  const allowTools = new Set((process.env.NL_HTTP_TOOLS || 'job_put_chunk,job_status').split(',').map(x => x.trim()).filter(Boolean));
  const reg = server._registeredTools || {};
  for (const [name, t] of Object.entries<any>(reg)) if (!allowTools.has(name) && typeof t.disable === 'function') t.disable();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => crypto.randomUUID() });
  await server.connect(transport);
  const srv = http.createServer(async (req, res) => {
    const deny = (code: number, msg: string) => { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ error: msg })); };
    try {
      const hostHdr = String(req.headers.host || '').replace(/:\d+$/, '');
      if (!['127.0.0.1', 'localhost', '[::1]', host].includes(hostHdr)) return deny(403, 'host not allowed');
      const origin = String(req.headers.origin || '');
      if (origin) {
        if (!origins.includes(origin)) return deny(403, 'origin not allowed');
        res.setHeader('access-control-allow-origin', origin); res.setHeader('vary', 'origin');
        res.setHeader('access-control-allow-headers', 'authorization, content-type, accept, mcp-session-id, mcp-protocol-version, last-event-id');
        res.setHeader('access-control-expose-headers', 'mcp-session-id'); res.setHeader('access-control-allow-methods', 'POST, GET, DELETE, OPTIONS');
      }
      if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
      if (!req.url || !req.url.startsWith('/mcp')) return deny(404, 'not found');
      const auth = String(req.headers.authorization || '');
      if (!auth.startsWith('Bearer ') || !safeEq(auth.slice(7), token)) { res.setHeader('www-authenticate', 'Bearer'); return deny(401, 'unauthorized'); }
      let body: any = undefined;
      if (req.method === 'POST') { const chunks: Buffer[] = []; let n = 0; for await (const c of req) { n += (c as Buffer).length; if (n > 4 * 1024 * 1024) return deny(413, 'too large'); chunks.push(c as Buffer); } try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return deny(400, 'bad json'); } }
      await transport.handleRequest(req, res, body);
    } catch (e: any) { if (!res.headersSent) deny(500, String(e && e.message || e).slice(0, 200)); else res.end(); }
  });
  await new Promise<void>(r => srv.listen(port, host, r));
  const a: any = srv.address(); console.error('MYBOX MCP HTTP listening on http://' + host + ':' + a.port + '/mcp (도구: ' + [...allowTools].join(',') + ')');
  return srv;
}
