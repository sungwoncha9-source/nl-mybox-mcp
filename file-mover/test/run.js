'use strict';
const http = require('http'), fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const { spawn } = require('child_process');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mover-'));
const work = path.join(root, 'work'); fs.mkdirSync(work);
const outside = path.join(root, 'outside'); fs.mkdirSync(outside);
fs.writeFileSync(path.join(work, 'a.png'), Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256)));
fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
const got = {};
const srv = http.createServer((req, res) => {
  const chunks = []; req.on('data', c => chunks.push(c)); req.on('end', () => {
    const body = Buffer.concat(chunks);
    if (req.url.startsWith('/figma') && req.method === 'POST') { got.figma = { ct: req.headers['content-type'], len: body.length, hasField: body.toString('latin1').includes('name="file"') }; res.end('{"ok":1}'); }
    else if (req.url.startsWith('/block') && req.method === 'PUT') { (got.blocks ||= []).push({ ct: req.headers['content-type'], len: body.length, first: body[0] }); res.setHeader('etag', '"e1"'); res.end(); }
    else if (req.url === '/dl/result.png') { res.setHeader('content-type', 'image/png'); res.end(Buffer.alloc(500, 7)); }
    else if (req.url === '/dl/noext') { res.setHeader('content-type', 'image/jpeg'); res.end(Buffer.alloc(10, 1)); }
    else if (req.url === '/big') { res.end(Buffer.alloc(5000, 1)); }
    else if (req.url === '/redir') { res.statusCode = 302; res.setHeader('location', 'http://evil.example/x'); res.end(); }
    else { res.statusCode = 404; res.end(); }
  });
}).listen(0, '127.0.0.1', async () => {
  const port = srv.address().port, base = 'http://127.0.0.1:' + port;
  const env = { ...process.env, MOVER_ALLOWED_DIRS: work, MOVER_ALLOWED_HOSTS: '127.0.0.1', MOVER_ALLOW_HTTP: '1', MOVER_ALLOW_PRIVATE: '1', MOVER_MAX_BYTES: '4000' };
  const p = spawn('node', [path.join(__dirname, '..', 'server.js')], { env, stdio: ['pipe', 'pipe', 'inherit'] });
  let buf = '', waiters = {}, nid = 1;
  p.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); waiters[m.id]?.(m); } });
  const rpc = (method, params) => new Promise(r => { const id = nid++; waiters[id] = r; p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  const call = async (name, args) => { const r = (await rpc('tools/call', { name, arguments: args })).result; return { err: !!r.isError, text: r.content[0].text }; };
  let pass = 0; const t = async (n, f) => { try { await f(); pass++; console.log('PASS', n); } catch (e) { console.log('FAIL', n, e.message); process.exitCode = 1; } };

  await t('initialize+tools/list', async () => { const i = await rpc('initialize', { protocolVersion: '2025-03-26' }); assert(i.result.serverInfo); const l = await rpc('tools/list'); assert.deepStrictEqual(l.result.tools.map(x => x.name), ['file_stat', 'send_file', 'receive_file', 'delete_path', 'receive_bytes', 'capture_screen', 'annotate_image']); });
  await t('file_stat', async () => { const r = await call('file_stat', { path: path.join(work, 'a.png') }); assert(!r.err && JSON.parse(r.text).size === 1000 && JSON.parse(r.text).mime === 'image/png'); });
  await t('피그마식 multipart 업로드', async () => { const r = await call('send_file', { path: path.join(work, 'a.png'), url: base + '/figma/submit', mode: 'multipart' }); assert(!r.err, r.text); assert(got.figma.ct.startsWith('multipart/form-data') && got.figma.hasField); });
  await t('어도비식 블록 PUT 2개(offset/length)', async () => {
    for (const [o, l] of [[0, 600], [600, 400]]) { const r = await call('send_file', { path: path.join(work, 'a.png'), url: base + '/block/' + o, mode: 'raw', method: 'PUT', content_type: 'image/png', offset: o, length: l }); assert(!r.err && JSON.parse(r.text).etag === '"e1"', r.text); }
    assert.deepStrictEqual(got.blocks.map(b => b.len), [600, 400]); assert.strictEqual(got.blocks[1].first, 600 % 256); assert.strictEqual(got.blocks[0].ct, 'image/png'); });
  await t('받기: 파일명 URL에서', async () => { const r = await call('receive_file', { url: base + '/dl/result.png', dest_dir: path.join(work, 'figma-out') }); assert(!r.err, r.text); assert(fs.statSync(JSON.parse(r.text).saved_path).size === 500); });
  await t('받기: 같은 이름 덮어쓰기 방지', async () => { const r = await call('receive_file', { url: base + '/dl/result.png', dest_dir: path.join(work, 'figma-out') }); assert(JSON.parse(r.text).saved_path.endsWith('result_1.png')); });
  await t('받기: 확장자 없으면 content-type으로', async () => { const r = await call('receive_file', { url: base + '/dl/noext', dest_dir: work }); assert(JSON.parse(r.text).saved_path.endsWith('noext.jpg')); });
  await t('차단: 허용 폴더 밖 읽기', async () => { assert((await call('send_file', { path: path.join(outside, 'secret.txt'), url: base + '/figma/x' })).err); });
  await t('차단: .. 경로 탈출', async () => { assert((await call('send_file', { path: path.join(work, '..', 'outside', 'secret.txt'), url: base + '/figma/x' })).err); });
  await t('차단: 심볼릭 링크 탈출', async () => { fs.symlinkSync(outside, path.join(work, 'lnk')); assert((await call('send_file', { path: path.join(work, 'lnk', 'secret.txt'), url: base + '/figma/x' })).err); assert((await call('receive_file', { url: base + '/dl/result.png', dest_dir: path.join(work, 'lnk') })).err); });
  await t('차단: 허용 밖 사이트', async () => { assert((await call('send_file', { path: path.join(work, 'a.png'), url: 'http://evil.example/up' })).err); });
  await t('차단: 리다이렉트로 허용 밖 사이트', async () => { assert((await call('receive_file', { url: base + '/redir', dest_dir: work })).err); });
  await t('차단: 크기 한도(받기)·찌꺼기 .part 없음', async () => { const r = await call('receive_file', { url: base + '/big', dest_dir: path.join(work, 'big') }); assert(r.err); assert(!fs.readdirSync(path.join(work, 'big')).some(f => f.endsWith('.part'))); });
  await t('차단: 인증 헤더', async () => { assert((await call('send_file', { path: path.join(work, 'a.png'), url: base + '/figma/x', headers: { Authorization: 'Bearer x' } })).err); });
  await t('차단: 범위 초과 offset', async () => { assert((await call('send_file', { path: path.join(work, 'a.png'), url: base + '/block/9', mode: 'raw', offset: 900, length: 500 })).err); });
  await t('차단: 파일명 탈출(filename=../x)', async () => { const r = await call('receive_file', { url: base + '/dl/result.png', dest_dir: work, filename: '../../evil.png' }); assert(!r.err && path.dirname(JSON.parse(r.text).saved_path) === fs.realpathSync(work)); });
  console.log(pass + ' passed'); p.kill(); srv.close(); fs.rmSync(root, { recursive: true, force: true });
});
