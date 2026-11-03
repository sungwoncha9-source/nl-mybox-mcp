import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import crypto from 'node:crypto'; import os from 'node:os';

const BUNDLE = process.argv[2];
const JOBS = fs.mkdtempSync(path.join(os.tmpdir(), 'jobs-'));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  OK  ' + m); } else { fail++; console.log('  FAIL ' + m); } };

// ---- 가짜 MYBOX ----
const store = new Map(); const calls = []; let uploadDelay = 0; const folderCalls = []; // 가짜 MYBOX의 올리기 지연(느린 네트워크 흉내)
const srv = http.createServer((req, res) => {
  const chunks = []; req.on('data', d => chunks.push(d)); req.on('end', () => {
    const body = Buffer.concat(chunks); const url = new URL(req.url, 'http://x'); calls.push(req.method + ' ' + url.pathname);
    const json = (o) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
    if (req.method === 'POST' && url.pathname === '/v1/drive/folders') { const b = JSON.parse(body); const id = 'FD' + crypto.randomUUID().slice(0, 8);
      folderCalls.push(b); store.set(id, { name: b.folderName, parent: b.parentId || 'root', size: 0, isFolder: true }); return json({ resourceId: id, name: b.folderName }); }
    if (req.method === 'POST' && url.pathname === '/v1/drive/files') { const b = JSON.parse(body); const id = crypto.randomUUID();
      store.set(id, { name: b.fileName, parent: b.parentId || 'root', declared: b.fileSize, size: null });
      return json({ uploadUrl: 'http://127.0.0.1:' + srv.address().port + '/upload/' + id }); }
    if (req.method === 'POST' && url.pathname.startsWith('/upload/')) { const id = url.pathname.split('/')[2];
      const finish = () => { if (/^fail/.test(store.get(id).name)) { res.statusCode = 500; return res.end('boom'); }
        const s = body.indexOf('\r\n\r\n') + 4, e = body.lastIndexOf('\r\n--'); const nm = store.get(id).name; let data = Buffer.from(body.subarray(s, e)); if (/^samesize/.test(nm)) data[0] ^= 0xff; store.get(id).data = data; store.get(id).size = /^short/.test(nm) ? e - s - 1 : e - s; res.statusCode = 200; res.end('ok'); };
      return uploadDelay ? setTimeout(finish, uploadDelay) : finish(); }
    const dm = url.pathname.match(/^\/v1\/drive\/files\/([^/]+)\/download$/);
    if (req.method === 'GET' && dm) return json({ downloadUrl: 'http://127.0.0.1:' + srv.address().port + '/dl/' + dm[1] });
    if (req.method === 'GET' && url.pathname.startsWith('/dl/')) { const f = store.get(url.pathname.split('/')[2]); res.setHeader('content-type', 'application/octet-stream'); return res.end(f && f.data || Buffer.alloc(0)); }
    const rm = url.pathname.match(/^\/v1\/drive\/resources\/([^/]+)$/);
    if (req.method === 'GET' && rm) { const f = store.get(rm[1]); return json({ resourceId: rm[1], parentId: f ? f.parent : null, name: f ? f.name : null }); }
    const m = url.pathname.match(/^\/v1\/drive\/(?:folders\/([^/]+)\/)?resources$/);
    if (req.method === 'GET' && m) { const parent = m[1] || 'root';
      return json({ resources: [...store.entries()].filter(([, x]) => x.parent === parent && x.size != null).map(([id, x]) => ({ resourceId: id, name: x.name, size: x.size })), responseMetaData: {} }); }
    res.statusCode = 404; res.end('nf');
  });
});
await new Promise(r => srv.listen(0, '127.0.0.1', r));

const connect = async (extra = {}) => { const c = new Client({ name: 't', version: '1' });
  await c.connect(new StdioClientTransport({ command: 'node', args: [BUNDLE], env: { ...process.env, MYBOX_ACCESS_TOKEN: 'dummy', MYBOX_BASE_URL: 'http://127.0.0.1:' + srv.address().port + '/v1', NL_JOBS_DIR: JOBS, ...extra } })); return c; };
const call = async (c, name, args) => { const r = await c.callTool({ name, arguments: args }); const t = r.content?.[0]?.text; if (r.isError) { const e = new Error(t); e.isErr = true; throw e; } return JSON.parse(t); };
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const CH = 600 * 1024;
const mkChunks = (id, files, extra = {}) => { const specs = files.map(f => ({ name: f.name, size: f.buf.length, sha256: sha(f.buf) })); const out = [];
  for (const f of files) for (let o = 0; o < f.buf.length; o += CH) out.push({ job_id: id, files: specs, file_name: f.name, offset: o, content_base64: f.buf.subarray(o, Math.min(o + CH, f.buf.length)).toString('base64'), ...extra });
  return out; };
const waitState = async (c, id, want) => { for (let i = 0; i < 100; i++) { const s = await call(c, 'job_status', { job_id: id }); if (want.includes(s.state)) return s; await new Promise(r => setTimeout(r, 50)); } return await call(c, 'job_status', { job_id: id }); };


// ===== Streamable HTTP 시험 (v1.9.1, 통신 계층 실증 · 외부 노출 없음 · 127.0.0.1 전용) =====
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { spawn } from 'node:child_process';
import net from 'node:net';
const packOf = (entries) => { const man = Buffer.from(JSON.stringify({ entries: entries.map(e => ({ name: e.name, size: e.buf.length, sha256: sha(e.buf), ...(e.parent_id ? { parent_id: e.parent_id } : {}) })) }), 'utf8'); const h = Buffer.alloc(8); h.write('NLP1', 0, 'latin1'); h.writeUInt32BE(man.length, 4); return Buffer.concat([h, man, ...entries.map(e => e.buf)]); };
const jobArgs = (id, pack, extra = {}) => ({ job_id: id, files: [{ name: 'b.pack', size: pack.length, sha256: sha(pack) }], file_name: 'b.pack', offset: 0, content_base64: pack.toString('base64'), bundle: 'pack1', parent_id: 'F0', wait_ms: 15000, ...extra });
const TOKEN = crypto.randomBytes(24).toString('hex');
const startHttp = (env = {}) => new Promise((resolve, reject) => {
  const p = spawn('node', [BUNDLE], { env: { ...process.env, NL_TRANSPORT: 'http', NL_HTTP_TOKEN: TOKEN, NL_HTTP_PORT: '0', MYBOX_ACCESS_TOKEN: 'dummy', MYBOX_BASE_URL: 'http://127.0.0.1:' + srv.address().port + '/v1', NL_JOBS_DIR: JOBS, ...env } });
  let err = ''; p.stderr.on('data', d => { err += d; const m = err.match(/listening on http:\/\/([^:]+):(\d+)\/mcp/); if (m) resolve({ p, port: Number(m[2]), host: m[1] }); });
  p.on('exit', (code) => resolve({ p, exited: code, err })); setTimeout(() => reject(new Error('http 서버 시작 시간 초과: ' + err)), 8000);
});
const raw = (port, { method = 'POST', headers = {}, body, hostHdr } = {}) => new Promise((resolve) => { const h = { ...headers }; if (hostHdr) h.host = hostHdr; const rq = http.request({ host: '127.0.0.1', port, path: '/mcp', method, headers: h }, (res) => { const cs = []; res.on('data', d => cs.push(d)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(cs).toString('utf8') })); }); rq.on('error', e => resolve({ status: 0, text: String(e) })); if (body) rq.write(body); rq.end(); });
const INIT = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'br', version: '1' } } });
const AUTH = { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json', accept: 'application/json, text/event-stream' };

console.log('[H1] 안전하게 시작하는가');
const h1 = await startHttp({ NL_HTTP_TOKEN: '' }); ok(h1.exited !== undefined && h1.exited !== 0 && /NL_HTTP_TOKEN/.test(h1.err), '[H1a] 토큰 없이는 시작하지 않는다');
const h2 = await startHttp({ NL_HTTP_HOST: '0.0.0.0' }); ok(h2.exited !== undefined && h2.exited !== 0 && /ALLOW_REMOTE/.test(h2.err), '[H1b] 로컬 밖 주소는 NL_HTTP_ALLOW_REMOTE=1 없이는 시작하지 않는다');
const h1c = await startHttp({ NL_HTTP_TOKEN: 'short' }); ok(h1c.exited !== undefined && h1c.exited !== 0, '[H1c] 짧은 토큰(24자 미만)은 거절');

console.log('[H2] 인증·호스트·출처');
const S1 = await startHttp({ NL_HTTP_ORIGINS: 'https://ok.example' });
ok(S1.port > 0 && (await raw(S1.port, { headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: INIT })).status === 401, '[H2a] 토큰 없는 요청은 401');
ok((await raw(S1.port, { headers: { ...AUTH, authorization: 'Bearer ' + 'x'.repeat(TOKEN.length) }, body: INIT })).status === 401, '[H2b] 틀린 토큰은 401');
ok((await raw(S1.port, { headers: AUTH, body: INIT, hostHdr: 'evil.example' })).status === 403, '[H2c] 다른 Host 헤더는 403(DNS 리바인딩 방지)');
ok((await raw(S1.port, { headers: { ...AUTH, origin: 'https://evil.example' }, body: INIT })).status === 403, '[H2d] 허용 목록에 없는 브라우저 출처(Origin)는 403');
const pre = await raw(S1.port, { method: 'OPTIONS', headers: { origin: 'https://ok.example', 'access-control-request-method': 'POST' } });
ok(pre.status === 204 && pre.headers['access-control-allow-origin'] === 'https://ok.example', '[H2e] 허용한 출처의 사전 요청(OPTIONS)은 204 + 그 출처만 허용');
S1.p.kill();

console.log('[H3] SDK HTTP 클라이언트(웹 앱이 쓸 형태)와 stdio 클라이언트(데스크톱)로 같은 일 시키기');
const S2 = await startHttp();
const hc = new Client({ name: 'h', version: '1' }); await hc.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:' + S2.port + '/mcp'), { requestInit: { headers: { authorization: 'Bearer ' + TOKEN } } }));
const tools = (await hc.listTools()).tools.map(t => t.name).sort();
ok(JSON.stringify(tools) === JSON.stringify(['job_put_chunk', 'job_status']), '[H3a] HTTP로는 일감 도구 2개만 보인다(삭제·이동 등 나머지는 열지 않음): ' + tools.join(','));
let eDel = null; try { const r = await hc.callTool({ name: 'files_delete', arguments: { resourceId: 'x' } }); if (r.isError) eDel = new Error(r.content?.[0]?.text); } catch (e) { eDel = e; }
ok(!!eDel, '[H3b] 닫아 둔 도구(files_delete)는 HTTP로 부를 수 없다');
const E5 = Array.from({ length: 5 }, (_, i) => ({ name: `H${i}.png`, buf: crypto.randomBytes(84742), parent_id: 'CATH1' }));
const norm = (r) => JSON.stringify({ state: r.state, final: r.final, entries: r.entries.map(e => [e.name, e.size, e.target, e.uploaded, e.size_verified, e.verified, e.error]) });
const rHttp = JSON.parse((await hc.callTool({ name: 'job_put_chunk', arguments: jobArgs('hj1', packOf(E5)) })).content[0].text);
ok(rHttp.state === 'done' && rHttp.entries.length === 5 && rHttp.entries.every(e => e.verified), '[H3c] HTTP 클라이언트: 5건 done·전부 verified');
ok(E5.every(e => [...store.values()].some(x => x.parent === 'CATH1' && x.name === e.name && x.size === e.buf.length)), '[H3d] 가짜 MYBOX에 5건이 같은 크기로 도착');
const cs = await connect(); const E5s = E5.map(e => ({ ...e, parent_id: 'CATH2' }));
const rStd = await call(cs, 'job_put_chunk', jobArgs('hj2', packOf(E5s)));
ok(rStd.state === 'done' && norm({ ...rHttp, entries: rHttp.entries.map(e => ({ ...e, target: 'T' })) }) === norm({ ...rStd, entries: rStd.entries.map(e => ({ ...e, target: 'T' })) }), '[H3e] stdio 클라이언트(데스크톱 방식)의 결과가 HTTP와 같은 모양(상태·파일별 결과 동일)');
await cs.close();
// 응답 유실: HTTP 호출을 보내는 도중 취소 → 같은 일감 다시 보내기 → 중복 0
const E6 = Array.from({ length: 4 }, (_, i) => ({ name: `L${i}.png`, buf: crypto.randomBytes(30000), parent_id: 'CATH3' })); const P6 = packOf(E6);
const ac = new AbortController(); const up0 = calls.filter(x => x === 'POST /v1/drive/files').length;
const lost = hc.callTool({ name: 'job_put_chunk', arguments: jobArgs('hj3', P6) }, undefined, { signal: ac.signal }).then(() => 'ok', e => 'cancelled'); setTimeout(() => ac.abort(), 1); const lr = await lost;
await new Promise(r => setTimeout(r, 1500));
const again = JSON.parse((await hc.callTool({ name: 'job_put_chunk', arguments: jobArgs('hj3', P6) })).content[0].text);
ok(again.final === true && again.state === 'done' && calls.filter(x => x === 'POST /v1/drive/files').length - up0 === 4, '[H3f] 응답 유실(' + lr + ') 뒤 같은 일감을 다시 보내도 완료 상태를 돌려주고 MYBOX 올리기는 정확히 4번(중복 0)');
await hc.close(); S2.p.kill();

console.log('[H4] 브라우저 fetch와 같은 방식(SDK 없이 JSON-RPC 직접)');
const S3 = await startHttp({ NL_HTTP_ORIGINS: 'https://ok.example' });
const hdr = { ...AUTH, origin: 'https://ok.example' };
const i0 = await raw(S3.port, { headers: hdr, body: INIT }); const sid = i0.headers['mcp-session-id'];
ok(i0.status === 200 && !!sid && i0.headers['access-control-allow-origin'] === 'https://ok.example' && /mcp-session-id/.test(i0.headers['access-control-expose-headers'] || ''), '[H4a] initialize 성공, 세션 ID를 받음, 허용 출처에 CORS 헤더가 붙고 세션 ID 헤더는 브라우저가 읽을 수 있게 노출됨');
await raw(S3.port, { headers: { ...hdr, 'mcp-session-id': sid, 'mcp-protocol-version': '2025-06-18' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
const E7 = Array.from({ length: 5 }, (_, i) => ({ name: `W${i}.png`, buf: crypto.randomBytes(84742), parent_id: 'CATH4' }));
const call7 = await raw(S3.port, { headers: { ...hdr, 'mcp-session-id': sid, 'mcp-protocol-version': '2025-06-18' }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'job_put_chunk', arguments: jobArgs('hj4', packOf(E7)) } }) });
const dataLine = call7.text.split('\n').find(l => l.startsWith('data: ')); const rpc = JSON.parse(dataLine ? dataLine.slice(6) : call7.text); const r7 = JSON.parse(rpc.result.content[0].text);
ok(r7.state === 'done' && r7.entries.every(e => e.verified) && E7.every(e => [...store.values()].some(x => x.parent === 'CATH4' && x.name === e.name && x.size === e.buf.length)), '[H4b] fetch 방식으로도 5건 done·전부 verified·MYBOX에 같은 크기로 도착');
S3.p.kill(); srv.close();
console.log(`\n통과 ${pass} / 실패 ${fail}`); fs.rmSync(JOBS, { recursive: true, force: true }); process.exit(fail ? 1 : 0);
