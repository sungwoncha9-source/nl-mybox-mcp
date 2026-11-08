// K3 이동 경쟁 스윕(가짜 MYBOX·합성 데이터만): 폴더 SUB 를 n번째 조회 직후 허용 밖(OUT)으로 옮기고, 일감 결과·업로드 수·탐지 여부를 본다.
// 사용: node tools/k3_sweep.mjs <번들 경로>
import http from 'node:http'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import crypto from 'node:crypto'; import { spawn } from 'node:child_process';
import { startFake } from '../s3/fake-mybox.mjs';
const bundle = path.resolve(process.argv[2]); const fake = await startFake(); const FP = fake.port;
const ctl = (p, b) => new Promise(res => { const d = Buffer.from(JSON.stringify(b || {})); const r = http.request({ host: '127.0.0.1', port: FP, path: '/__ctl/' + p, method: 'POST', headers: { 'content-length': d.length } }, x => { let s = ''; x.on('data', c => s += c); x.on('end', () => res(JSON.parse(s))); }); r.end(d); });
const TOKEN = crypto.randomBytes(16).toString('hex'); const JOBS = fs.mkdtempSync(path.join(os.tmpdir(), 'k3-'));
const env = { PATH: process.env.PATH, HOME: '/tmp', NL_TRANSPORT: 'http', NL_HTTP_HOST: '127.0.0.1', NL_HTTP_PORT: '0', NL_HTTP_TOKEN: TOKEN, NL_JOBS_DIR: JOBS, NL_JOB_ALLOWED_PARENTS: 'tree:ALLOW', NL_HTTP_TOOLS: 'job_put_chunk,job_status', MYBOX_ACCESS_TOKEN: 'fake-token', MYBOX_BASE_URL: 'http://127.0.0.1:' + FP + '/v1' };
const p = spawn('node', [bundle], { env }); let err = '';
const port = await new Promise((res, rej) => { p.stderr.on('data', d => { err += d; const m = err.match(/listening on http:\/\/[^:]+:(\d+)\/mcp/); if (m) res(+m[1]); }); setTimeout(() => rej(new Error('start timeout ' + err)), 20000); });
const req = (m, pth, body) => new Promise(resolve => { const d = body ? Buffer.from(JSON.stringify(body)) : null; const r = http.request({ host: '127.0.0.1', port, path: pth, method: m, headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json', ...(d ? { 'content-length': d.length } : {}) } }, x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch {} resolve({ status: x.statusCode, json: j }); }); }); if (d) r.write(d); r.end(); });
const buf = crypto.randomBytes(1500), sha = crypto.createHash('sha256').update(buf).digest('hex'); const rows = [];
for (const after of [0, 1, 2, 3, 4, 5]) {
  await ctl('reset'); if (after) await ctl('arm', { id: 'SUB', parent: 'OUT', after });
  const id = 'k3' + after + crypto.randomUUID().slice(0, 6);
  let a = await req('POST', '/api/v1/jobs/chunk', { job_id: id, files: [{ name: 'r.png', size: buf.length, sha256: sha }], file_name: 'r.png', offset: 0, content_base64: buf.toString('base64'), parent_id: 'SUB', wait_ms: 8000 });
  for (let i = 0; i < 20 && !(a.json && /^(done|failed)$/.test(a.json.state || '')); i++) { await new Promise(r => setTimeout(r, 300)); a = await req('GET', '/api/v1/jobs/' + id); }
  const s = await ctl('stats'); const f = (a.json && a.json.files && a.json.files[0]) || {};
  rows.push({ move_after_read: after || '이동 없음', http: a.status, state: a.json && a.json.state, uploads: s.uploads, sub_reads: s.readsOf.SUB || 0, escaped: !!f.escaped, err: String((a.json && a.json.error) || '').slice(0, 40) });
}
p.kill(); console.log(JSON.stringify({ bundle: path.basename(bundle), sha256: crypto.createHash('sha256').update(fs.readFileSync(bundle)).digest('hex').slice(0, 12), rows }, null, 1)); process.exit(0);
