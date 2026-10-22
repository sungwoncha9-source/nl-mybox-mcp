'use strict';
// receive_bytes 시험 — 임시 폴더에서만 돌고, 끝나면 지운다. 실행: node test/bytes.js
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const { spawn } = require('child_process');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mover-bytes-'));
const ROOT = path.join(base, 'root'), OUTSIDE = path.join(base, 'outside');
fs.mkdirSync(ROOT); fs.mkdirSync(OUTSIDE);
for (const d of ['agent', 'file-mover', '_trash']) fs.mkdirSync(path.join(ROOT, d));
process.env.MOVER_ALLOWED_DIRS = ROOT;
process.env.MOVER_MAX_BYTES = '3000000';
const m = require('../server.js');
const cfg = m.makeConfig();

const rows = [];
const rec = (name, ok, detail) => rows.push({ name, ok: !!ok, detail: String(detail || '').replace(/\s+/g, ' ').slice(0, 140) });
const call = async (args) => {
  const r = await m.handle({ id: 1, method: 'tools/call', params: { name: 'receive_bytes', arguments: args } }, cfg);
  const text = r.content[0].text; let json; try { json = JSON.parse(text); } catch {}
  return { err: !!r.isError, text, json };
};
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const b64 = b => Buffer.from(b).toString('base64');
const png = n => Buffer.from(Array.from({ length: n }, (_, i) => (i * 7 + 3) % 256)); // 0x00~0xff 바이트가 다 섞인 가짜 이진 파일
const ex = p => fs.existsSync(p);
const leftovers = d => { try { return fs.readdirSync(d).filter(f => f.endsWith('.part')); } catch { return []; } };

(async () => {
  const D = path.join(ROOT, 'doan', '새 폴더');           // 없는 폴더·한글·공백
  const data = png(100000);
  let r = await call({ dest_dir: D, filename: '한글 도안 & 1.png', content_base64: b64(data) });
  rec('단건: 이진 파일이 한 바이트도 다르지 않게 저장(폴더 자동 생성, 한글·공백 이름)', !r.err && r.json.done && sha(fs.readFileSync(r.json.saved_path)) === sha(data) && r.json.sha256 === sha(data) && r.json.bytes === 100000, r.text);
  const first = r.json && r.json.saved_path;

  r = await call({ dest_dir: D, filename: '한글 도안 & 1.png', content_base64: b64(png(10)) });
  rec('같은 이름 → _1로 보존, 먼저 것은 그대로', !r.err && r.json.renamed && r.json.saved_path.endsWith('1_1.png') && sha(fs.readFileSync(first)) === sha(data), r.text);
  r = await call({ dest_dir: D, filename: '한글 도안 & 1.png', content_base64: b64(png(20)), overwrite: true });
  rec('overwrite:true → 같은 이름에 덮어씀', !r.err && r.json.saved_path === first && fs.statSync(first).size === 20, r.text);

  r = await call({ dest_dir: D, filename: 'empty.txt', content_base64: '' });
  rec('빈 파일(0바이트)', !r.err && r.json.bytes === 0 && ex(r.json.saved_path), r.text);

  // 나눠 보내기
  const big = png(1000000), T = big.length, cuts = [0, 400000, 800000, T];
  const outs = [];
  for (let i = 0; i < 3; i++) outs.push(await call({ dest_dir: D, filename: 'big.bin', content_base64: b64(big.subarray(cuts[i], cuts[i + 1])), offset: cuts[i], total_bytes: T, sha256: sha(big) }));
  rec('나눠 보내기 3조각: 중간은 done:false, 끝에서 done:true·원본과 동일', !outs.some(x => x.err) && outs[0].json.done === false && outs[1].json.received === 800000 && outs[2].json.done && sha(fs.readFileSync(outs[2].json.saved_path)) === sha(big) && leftovers(D).length === 0, outs.map(x => x.text).join(' | '));

  let a = await call({ dest_dir: D, filename: 'seq.bin', content_base64: b64(big.subarray(0, 1000)), offset: 0, total_bytes: 3000 });
  let b = await call({ dest_dir: D, filename: 'seq.bin', content_base64: b64(big.subarray(2000, 3000)), offset: 2000, total_bytes: 3000 });
  rec('순서가 어긋난 조각(건너뛰기)은 거절, 받은 부분은 보존', !a.err && b.err && fs.statSync(path.join(D, 'seq.bin.part')).size === 1000, b.text);
  let c = await call({ dest_dir: D, filename: 'seq.bin', content_base64: b64(big.subarray(0, 500)), offset: 0, total_bytes: 3000 });
  rec('offset 0으로 다시 시작하면 처음부터 새로', !c.err && c.json.received === 500, c.text);
  c = await call({ dest_dir: D, filename: 'seq.bin', content_base64: b64(big.subarray(500, 700)), offset: 500, total_bytes: 3000 });
  c = await call({ dest_dir: D, filename: 'seq.bin', content_base64: b64(big.subarray(700, 1000)), offset: 700 });
  rec('나눠 보낼 때 total_bytes 빠지면 거절', c.err, c.text);
  c = await call({ dest_dir: D, filename: 'seq.bin', content_base64: b64(big.subarray(700, 3500)), offset: 700, total_bytes: 3000 });
  rec('offset+크기가 total을 넘으면 거절', c.err, c.text);
  fs.unlinkSync(path.join(D, 'seq.bin.part'));

  // 깨짐·잘못된 입력
  const good = png(5000);
  r = await call({ dest_dir: D, filename: 'sum.png', content_base64: b64(good), sha256: sha(png(5001)) });
  rec('sha256이 다르면 거절, 파일·찌꺼기 없음', r.err && !ex(path.join(D, 'sum.png')) && leftovers(D).length === 0, r.text);
  r = await call({ dest_dir: D, filename: 'sum2.png', content_base64: b64(good), sha256: sha(good).toUpperCase() });
  rec('sha256 대문자도 인정', !r.err, r.text);
  rec('base64가 아닌 글자 거절', (await call({ dest_dir: D, filename: 'x.png', content_base64: 'abc$' })).err);
  rec('길이가 4의 배수가 아닌 base64 거절', (await call({ dest_dir: D, filename: 'x.png', content_base64: 'abcde' })).err);
  rec('content_base64 없음 거절', (await call({ dest_dir: D, filename: 'x.png' })).err);
  rec('filename 없음 거절', (await call({ dest_dir: D, content_base64: 'AAAA' })).err);
  rec('dest_dir 없음 거절', (await call({ filename: 'x', content_base64: 'AAAA' })).err);
  r = await call({ dest_dir: D, filename: 'huge.bin', content_base64: b64(png(3000001)) });
  rec('크기 한도(MOVER_MAX_BYTES) 초과 거절', r.err && !ex(path.join(D, 'huge.bin')), r.text);
  rec('.part 이름 거절', (await call({ dest_dir: D, filename: 'a.PART', content_base64: 'AAAA' })).err);

  // 경로 안전
  const denied = async (name, args) => { const x = await call({ content_base64: 'AAAA', ...args }); rec(name, x.err, x.text); };
  await denied('허용 폴더 밖 거절', { dest_dir: OUTSIDE, filename: 'evil.txt' });
  await denied('.. 탈출 거절', { dest_dir: path.join(ROOT, 'doan', '..', '..', 'outside'), filename: 'evil.txt' });
  await denied('agent 폴더에 쓰기 거절', { dest_dir: path.join(ROOT, 'agent'), filename: 'x.js' });
  await denied('file-mover 폴더(이동기 자신)에 쓰기 거절', { dest_dir: path.join(ROOT, 'file-mover'), filename: 'server.js', overwrite: true });
  await denied('_trash 폴더에 쓰기 거절', { dest_dir: path.join(ROOT, '_trash'), filename: 'x.txt' });
  await denied('보호 폴더 하위 폴더에 쓰기 거절', { dest_dir: path.join(ROOT, 'agent', 'sub'), filename: 'x.txt' });
  fs.mkdirSync(path.join(D, 'isdir'));
  await denied('같은 이름의 폴더가 있으면 거절(덮어쓰기여도)', { dest_dir: D, filename: 'isdir', overwrite: true });
  rec('거절 뒤 밖의 폴더는 비어 있음', fs.readdirSync(OUTSIDE).length === 0, fs.readdirSync(OUTSIDE).join(','));
  r = await call({ dest_dir: D, filename: '../../evil.png', content_base64: b64(good) });
  rec('filename=../../evil.png → 이름만 살려 안쪽에 저장', !r.err && path.dirname(r.json.saved_path) === fs.realpathSync(D) && !ex(path.join(ROOT, 'evil.png')), r.text);
  if (process.platform !== 'win32') {
    fs.symlinkSync(OUTSIDE, path.join(ROOT, 'link_out'));
    await denied('밖을 가리키는 링크 안에 쓰기 거절', { dest_dir: path.join(ROOT, 'link_out'), filename: 'evil.txt' });
    rec('링크 거절 뒤 밖의 폴더는 비어 있음', fs.readdirSync(OUTSIDE).length === 0, '');
  }
  rec('거절 뒤 .part 찌꺼기 없음', leftovers(D).length === 0 && leftovers(ROOT).length === 0, leftovers(D).join(','));

  // 실제 stdio로 큰 한 줄(약 16MiB 파일 = 21MB 글자)이 오가는지: 느려지거나 깨지지 않는지
  await new Promise(done => {
    const SZ = 16 * 1024 * 1024, payload = png(SZ);
    const env = { ...process.env, MOVER_ALLOWED_DIRS: ROOT, MOVER_MAX_BYTES: String(100 * 1024 * 1024) };
    const p = spawn('node', [path.join(__dirname, '..', 'server.js')], { env, stdio: ['pipe', 'pipe', 'ignore'] });
    let buf = '';
    const t0 = Date.now();
    p.stdout.on('data', d => {
      buf += d; if (!buf.includes('\n')) return;
      const res = JSON.parse(buf.slice(0, buf.indexOf('\n'))), ms = Date.now() - t0;
      const out = JSON.parse(res.result.content[0].text);
      rec('stdio 실전: 16MiB 한 번에 → 동일 저장 (' + ms + 'ms)', !res.result.isError && out.bytes === SZ && sha(fs.readFileSync(out.saved_path)) === sha(payload) && ms < 15000, res.result.content[0].text);
      p.kill(); done();
    });
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'receive_bytes', arguments: { dest_dir: path.join(ROOT, 'stdio'), filename: 'sixteen.bin', content_base64: b64(payload) } } }) + '\n');
  });

  let fail = 0;
  for (const x of rows) { if (!x.ok) fail++; console.log((x.ok ? 'PASS ' : 'FAIL ') + x.name + (x.ok ? '' : '   <= ' + x.detail)); }
  console.log((rows.length - fail) + ' passed' + (fail ? ', ' + fail + ' FAILED' : ''));
  fs.rmSync(base, { recursive: true, force: true });
  process.exitCode = fail ? 1 : 0;
})().catch(e => { console.error(e); fs.rmSync(base, { recursive: true, force: true }); process.exit(3); });
