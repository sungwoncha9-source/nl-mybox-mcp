'use strict';
// capture_screen / annotate_image 시험 — 임시 폴더에서만 돌고, 끝나면 지운다. 실행: node test/capture.js
// 실제 Windows 캡처(capture.ps1 안의 화면 호출)는 여기서 돌릴 수 없다: 그 부분은 문법 검사만 했고 PC에서 한 장 찍어 확인한다.
// 여기서 시험하는 것: 영역 계산, 설정 켜짐/꺼짐, 경로 안전, PowerShell 호출 배선(가짜 powershell로), 그림 그리기 전 종류.
const fs = require('fs'), os = require('os'), path = require('path'), zlib = require('zlib');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mover-cap-'));
const ROOT = path.join(base, 'root'), OUTSIDE = path.join(base, 'outside');
fs.mkdirSync(ROOT); fs.mkdirSync(OUTSIDE);
for (const d of ['agent', 'file-mover', '_trash']) fs.mkdirSync(path.join(ROOT, d));
process.env.MOVER_ALLOWED_DIRS = ROOT;
process.env.MOVER_ENABLE_CAPTURE = '1';
const m = require('../server.js');
const capture = require('../capture.js');
const annotate = require('../annotate.js');
const cfg = m.makeConfig(), cfgOff = Object.assign({}, cfg, { captureEnabled: false });

const rows = [];
const rec = (name, ok, detail) => rows.push({ name, ok: !!ok, detail: String(detail || '').replace(/\s+/g, ' ').slice(0, 160) });
const call = async (tool, args, c = cfg) => {
  const r = await m.handle({ id: 1, method: 'tools/call', params: { name: tool, arguments: args } }, c);
  const text = r.content[0].text; let json; try { json = JSON.parse(text); } catch {}
  return { err: !!r.isError, text, json };
};
// 시험용 PNG 만들기(압축 라이브러리만 사용)
const CRC = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc = b => { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const t = Buffer.from(type), l = Buffer.alloc(4), c = Buffer.alloc(4); l.writeUInt32BE(data.length); c.writeUInt32BE(crc(Buffer.concat([t, data]))); return Buffer.concat([l, t, data, c]); };
const makePng = (w, h, rgb = [230, 225, 210]) => {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = rgb[0]; raw[o + 1] = rgb[1]; raw[o + 2] = rgb[2]; }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
};
const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAAeACgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDtKKKK+iPmQooooAKKKKACiiigAooooAKKKKAP/9k=', 'base64');
const ex = p => fs.existsSync(p);
const leftovers = d => { try { return fs.readdirSync(d).filter(f => f.endsWith('.part')); } catch { return []; } };
const sizeOf = f => { const i = annotate.imageInfo(fs.readFileSync(f)); return i.w + 'x' + i.h; };

(async () => {
  // ---------- 영역 계산 ----------
  const two = { virtual: { x: -1920, y: 0, w: 4480, h: 1440 }, displays: [{ index: 1, x: 0, y: 0, w: 2560, h: 1440, primary: true }, { index: 2, x: -1920, y: 360, w: 1920, h: 1080, primary: false }] };
  let p = capture.planRegion(two, {});
  rec('영역: 기본은 모든 모니터 전체', p.x === -1920 && p.w === 4480 && p.h === 1440 && p.display === 'all', JSON.stringify(p));
  p = capture.planRegion(two, { display: 2, region: { x: 0.5, y: 0.5, w: 0.25, h: 0.25 } });
  rec('영역: 2번 모니터(왼쪽, 음수 좌표) 비율 → 바탕화면 절대 픽셀', p.x === -1920 + 960 && p.y === 360 + 540 && p.w === 480 && p.h === 270, JSON.stringify(p));
  p = capture.planRegion(two, { display: '1', region: { x: 100, y: 50, w: 300, h: 200, units: 'px' } });
  rec('영역: px 단위는 고른 모니터 왼쪽 위 기준', p.x === 100 && p.y === 50 && p.w === 300 && p.h === 200, JSON.stringify(p));
  p = capture.planRegion(two, { display: 1, region: { x: 0.9, y: 0.9, w: 0.5, h: 0.5 } });
  rec('영역: 화면 밖으로 넘치면 화면 안으로 자름', p.x === 2304 && p.w === 256 && p.h === 144, JSON.stringify(p));
  const bad = (name, a) => { let e; try { capture.planRegion(two, a); } catch (x) { e = x; } rec(name, !!e, e && e.message); };
  bad('영역: 없는 모니터 번호 거절', { display: 3 });
  bad('영역: 모니터 번호가 숫자가 아니면 거절', { display: 'abc' });
  bad('영역: 화면 완전히 밖이면 거절', { region: { x: 2, y: 2, w: 0.1, h: 0.1 }, display: 1 });
  bad('영역: w가 0 이하면 거절', { region: { x: 0, y: 0, w: 0, h: 0.5 } });
  bad('영역: 숫자가 아닌 값 거절', { region: { x: 'a', y: 0, w: 0.5, h: 0.5 } });
  p = capture.planRegion({ virtual: { x: 0, y: 0, w: 1920, h: 1080 }, displays: { index: 1, x: 0, y: 0, w: 1920, h: 1080, primary: true } }, { display: 1 });
  rec('영역: 모니터 한 개를 객체로 줘도(PowerShell이 배열을 풀어도) 처리', p.w === 1920, JSON.stringify(p));

  // ---------- PowerShell 호출 배선: 가짜 powershell로 ----------
  const fake = path.join(base, 'fake-ps.js');
  fs.writeFileSync(fake, '#!/usr/bin/env node\n' + [
    "const fs=require('fs');",
    "const a=process.argv.slice(2);const enc=a[a.indexOf('-File')+1]||'';",
    "const script=fs.readFileSync(enc,'utf8');",
    "fs.appendFileSync(process.env.FAKE_LOG||'/dev/null',JSON.stringify({mode:process.env.CAP_MODE,args:a.filter(x=>x!==enc),cmdLen:a.join(' ').length,viaFile:a.includes('-File')&&!a.includes('-EncodedCommand'),scriptOk:enc===process.env.FAKE_SCRIPT&&script===fs.readFileSync(process.env.FAKE_SCRIPT,'utf8')})+'\\n');",
    "const mode=process.env.CAP_MODE, f=process.env.FAKE;",
    "if(f==='hang'){setInterval(()=>{},1000);return;}",
    "if(f==='fail'){process.stderr.write('#< CLIXML\\n<Objs Version=\"1.1.0.1\"><S S=\"Error\">세션이 잠겨 있음_x000D__x000A_</S><S S=\"Error\">at line:1 &lt;x&gt;</S></Objs>');process.exit(1);}",
    "if(f==='junk'){console.log('hello');process.exit(0);}",
    "if(mode==='info'){console.log(process.env.FAKE_INFO);}",
    "else if(mode==='shot'){ if(f==='notpng'){fs.writeFileSync(process.env.CAP_OUT,'not a png');} else {fs.copyFileSync(process.env.FAKE_PNG_DIR+'/'+process.env.CAP_W+'x'+process.env.CAP_H+'.png',process.env.CAP_OUT);} console.log('{\"ok\":true}'); }"
  ].join('\n') + '\n');
  fs.chmodSync(fake, 0o755);
  const pngDir = path.join(base, 'pngs'); fs.mkdirSync(pngDir);
  for (const [w, h] of [[4480, 1440], [2560, 1440], [480, 270], [640, 360], [300, 200]]) fs.writeFileSync(path.join(pngDir, w + 'x' + h + '.png'), makePng(w, h));
  const log = path.join(base, 'fake.log');
  Object.assign(process.env, { MOVER_POWERSHELL: fake, FAKE_LOG: log, FAKE_SCRIPT: capture.SCRIPT_PATH, FAKE_PNG_DIR: pngDir, FAKE_INFO: JSON.stringify(two) });

  let r = await capture.runPs('info', {});
  rec('배선: info 호출 → JSON 결과, 스크립트는 -File 로 실행(명령줄 한도 안 걸림)', r.displays.length === 2 && (l0 => l0.scriptOk === true && l0.viaFile && l0.cmdLen < 1000)(JSON.parse(fs.readFileSync(log, 'utf8').trim().split('\n')[0])), JSON.stringify(r).slice(0, 80));
  const l0 = JSON.parse(fs.readFileSync(log, 'utf8').trim().split('\n')[0]);
  rec('배선: -NoProfile -NonInteractive -ExecutionPolicy Bypass 로 실행', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'].every(x => l0.args.includes(x)), l0.args.join(' '));
  process.env.FAKE = 'hang';
  let e; try { await capture.runPs('info', {}, 600); } catch (x) { e = x; }
  rec('배선: 끝나지 않으면 시간 초과로 끊음', e && /안에 끝나지 않았습니다/.test(e.message), e && e.message);
  process.env.FAKE = 'fail'; e = null;
  try { await capture.runPs('info', {}); } catch (x) { e = x; }
  rec('배선: 실패 코드면 이유를 돌려줌(진행 표시 찌꺼기 제거, 잠금 안내)', e && /세션이 잠겨 있음/.test(e.message) && !/CLIXML|Objs|_x000D_/.test(e.message) && /잠겨 있거나 꺼져/.test(e.message), e && e.message);
  process.env.FAKE = 'junk'; e = null;
  try { await capture.runPs('info', {}); } catch (x) { e = x; }
  rec('배선: JSON이 아닌 출력은 오류', e && /읽지 못했습니다/.test(e.message), e && e.message);
  delete process.env.FAKE;

  // ---------- capture_screen ----------
  const D = path.join(ROOT, 'capture');
  r = await call('capture_screen', {}, cfgOff);
  rec('꺼져 있으면 거절(기본 상태), 아무것도 만들지 않음', r.err && /꺼져 있습니다/.test(r.text) && !ex(D), r.text);
  r = await call('capture_screen', { info_only: true });
  rec('info_only: 모니터 목록만, 파일 없음', !r.err && r.json.displays.length === 2 && !ex(D) , r.text);
  r = await call('capture_screen', { filename: '전체 화면.png' });
  rec('전체 화면 저장(한글·공백 이름, 기본 폴더 capture\\)', !r.err && r.json.saved_path === path.join(fs.realpathSync(ROOT), 'capture', '전체 화면.png') && sizeOf(r.json.saved_path) === '4480x1440' && r.json.width === 4480, r.text);
  r = await call('capture_screen', { filename: '전체 화면.png' });
  rec('같은 이름은 _1로 보존', !r.err && r.json.saved_path.endsWith('전체 화면_1.png'), r.text);
  r = await call('capture_screen', { display: 2, region: { x: 0.5, y: 0.5, w: 0.25, h: 0.25 }, dest_dir: path.join(ROOT, 'doan', '시험'), filename: 'region' });
  rec('영역 저장: 확장자 보정(.png)·하위 폴더 자동 생성·크기 확인', !r.err && r.json.saved_path.endsWith('region.png') && sizeOf(r.json.saved_path) === '480x270' && r.json.region_px.x === -960, r.text);
  const shotLog = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse).filter(x => x.mode === 'shot');
  rec('PowerShell에는 계산된 절대 픽셀이 전달됨', shotLog.length === 3, shotLog.length);
  const logText = fs.readFileSync(path.join(D, 'capture_log.jsonl'), 'utf8').trim().split('\n');
  rec('찍을 때마다 기록(capture_log.jsonl)', logText.length === 2 && JSON.parse(logText[0]).file === '전체 화면.png', logText.length);

  const before = fs.readdirSync(D).length;
  r = await call('capture_screen', { region: { x: 5, y: 5, w: 1, h: 1 }, display: 1 });
  rec('잘못된 영역이면 찍지 않고 거절(파일·찌꺼기 없음)', r.err && fs.readdirSync(D).length === before, r.text);
  process.env.FAKE = 'notpng';
  r = await call('capture_screen', { filename: 'np.png', display: 1, region: { x: 0, y: 0, w: 0.1171875, h: 0.138888 } });
  delete process.env.FAKE;
  rec('PNG가 아닌 결과는 거절하고 .part 정리', r.err && leftovers(D).length === 0 && !ex(path.join(D, 'np.png')), r.text);
  process.env.FAKE = 'fail';
  r = await call('capture_screen', { filename: 'f.png' });
  delete process.env.FAKE;
  rec('PowerShell 실패는 오류로, 파일 없음', r.err && !ex(path.join(D, 'f.png')) && leftovers(D).length === 0, r.text);
  const denied = async (name, args) => { const x = await call('capture_screen', args); rec(name, x.err, x.text); };
  await denied('허용 폴더 밖 저장 거절', { dest_dir: OUTSIDE });
  await denied('.. 탈출 거절', { dest_dir: path.join(ROOT, '..', 'outside') });
  await denied('agent 폴더 거절', { dest_dir: path.join(ROOT, 'agent') });
  await denied('file-mover 폴더 거절', { dest_dir: path.join(ROOT, 'file-mover') });
  await denied('_trash 폴더 거절', { dest_dir: path.join(ROOT, '_trash') });
  await denied('delay_ms 범위 밖 거절', { delay_ms: 20000 });
  rec('거절 뒤 밖의 폴더는 비어 있음', fs.readdirSync(OUTSIDE).length === 0, '');
  r = await call('capture_screen', { filename: '../../evil.png' });
  rec('filename=../../evil.png → 이름만 살려 안쪽에 저장', !r.err && path.dirname(r.json.saved_path) === fs.realpathSync(D) && !ex(path.join(ROOT, 'evil.png')), r.text);
  delete process.env.MOVER_POWERSHELL;
  if (process.platform !== 'win32') { r = await call('capture_screen', {}); rec('Windows가 아니면 분명한 오류', r.err && /Windows에서만/.test(r.text), r.text); }

  // ---------- annotate_image ----------
  const SRC = path.join(ROOT, 'doan', 'src.png'); fs.mkdirSync(path.dirname(SRC), { recursive: true });
  fs.writeFileSync(SRC, makePng(800, 450));
  const srcSha = require('crypto').createHash('sha256').update(fs.readFileSync(SRC)).digest('hex');
  const all = [
    { type: 'rect', x: 0.1, y: 0.1, w: 0.3, h: 0.2 }, { type: 'ellipse', x: 0.5, y: 0.1, w: 0.2, h: 0.2, color: 'blue' }, { type: 'line', x1: 0.1, y1: 0.5, x2: 0.4, y2: 0.5 },
    { type: 'arrow', x1: 0.1, y1: 0.6, x2: 0.4, y2: 0.8 }, { type: 'text', x: 0.5, y: 0.5, text: '한글 & <b>태그</b> "따옴표"\n둘째 줄', bg: '#fff7cc' }, { type: 'text', x: 0.5, y: 0.8, text: '가운데', align: 'middle', size: 0.05 },
    { type: 'number', x: 0.9, y: 0.1, n: 3 }, { type: 'freehand', points: [[0.6, 0.6], [0.65, 0.7], [0.7, 0.62], [0.75, 0.72]] }, { type: 'highlight', x: 0.1, y: 0.35, w: 0.3, h: 0.05 }, { type: 'mask', x: 0.8, y: 0.8, w: 0.15, h: 0.1 }];
  r = await call('annotate_image', { path: SRC, items: all });
  rec('모든 종류를 한 번에 그림 → 새 PNG, 크기 그대로', !r.err && r.json.saved_path.endsWith('src_annotated.png') && sizeOf(r.json.saved_path) === '800x450' && r.json.items === 10 && r.json.warnings.length === 0, r.text);
  rec('원본은 한 바이트도 바뀌지 않음', require('crypto').createHash('sha256').update(fs.readFileSync(SRC)).digest('hex') === srcSha, '');
  const out1 = r.json.saved_path;
  rec('그린 결과는 원본과 다른 내용', fs.readFileSync(out1).length !== fs.readFileSync(SRC).length, '');
  r = await call('annotate_image', { path: SRC, items: [{ type: 'rect', x: 0.1, y: 0.1, w: 0.3, h: 0.2 }] });
  rec('같은 이름은 _1로 보존', !r.err && r.json.saved_path.endsWith('src_annotated_1.png') && ex(out1), r.text);
  r = await call('annotate_image', { path: SRC, units: 'px', crop: { x: 100, y: 50, w: 400, h: 200 }, max_width: 200, items: [{ type: 'arrow', x1: 120, y1: 70, x2: 300, y2: 150 }], out_filename: 'crop.png', out_dir: path.join(ROOT, 'doan', 'out') });
  rec('px 단위 + 자르기 + 줄이기 → 200x100, 지정 폴더·이름', !r.err && sizeOf(r.json.saved_path) === '200x100' && r.json.saved_path.endsWith(path.join('out', 'crop.png')), r.text);
  r = await call('annotate_image', { path: SRC, crop: { x: 0.5, y: 0.5, w: 1, h: 1 }, items: [] });
  rec('자르기 영역이 이미지를 넘으면 안쪽만', !r.err && sizeOf(r.json.saved_path) === '400x225', r.text);
  r = await call('annotate_image', { path: SRC, items: [{ type: 'rect', x: 1.5, y: 1.5, w: 0.1, h: 0.1 }, { type: 'text', x: -0.5, y: 0.1, text: 'x' }] });
  rec('이미지 밖 항목은 그리되 warnings로 알림', !r.err && r.json.warnings.length === 2, r.text);
  const tmpJpg = path.join(ROOT, 'doan', 'photo.jpg'); fs.writeFileSync(tmpJpg, JPEG);
  r = await call('annotate_image', { path: tmpJpg, items: [{ type: 'number', x: 0.5, y: 0.5, n: 1, size: 8 }], units: 'ratio' });
  rec('JPG 입력도 처리 → 40x30 PNG', !r.err && sizeOf(r.json.saved_path) === '40x30' && r.json.saved_path.endsWith('photo_annotated.png'), r.text);
  const files = fs.readdirSync(path.join(ROOT, 'doan')).sort().join(',');

  const bad2 = async (name, args) => { const x = await call('annotate_image', { path: SRC, ...args }); rec(name, x.err && fs.readdirSync(path.join(ROOT, 'doan')).sort().join(',') === files && leftovers(path.join(ROOT, 'doan')).length === 0, x.text); };
  await bad2('알 수 없는 종류 거절(아무 파일도 안 만듦)', { items: [{ type: 'star', x: 0.1, y: 0.1 }] });
  await bad2('SVG 끼워넣기(색에 따옴표) 거절', { items: [{ type: 'rect', x: 0, y: 0, w: 0.1, h: 0.1, color: 'red" onload="x' }] });
  await bad2('숫자 아닌 좌표 거절', { items: [{ type: 'rect', x: 'a', y: 0, w: 0.1, h: 0.1 }] });
  await bad2('w가 0이면 거절', { items: [{ type: 'rect', x: 0, y: 0, w: 0, h: 0.1 }] });
  await bad2('빈 글자 거절', { items: [{ type: 'text', x: 0, y: 0, text: '' }] });
  await bad2('시작=끝 화살표 거절', { items: [{ type: 'arrow', x1: 0.2, y1: 0.2, x2: 0.2, y2: 0.2 }] });
  await bad2('점 하나짜리 손그림 거절', { items: [{ type: 'freehand', points: [[0.1, 0.1]] }] });
  await bad2('items가 배열이 아니면 거절', { items: 'x' });
  await bad2('항목 201개 거절', { items: Array.from({ length: 201 }, () => ({ type: 'number', x: 0.5, y: 0.5 })) });
  await bad2('crop이 이미지 밖이면 거절', { crop: { x: 2, y: 2, w: 0.5, h: 0.5 } });
  r = await call('annotate_image', { path: SRC, items: [{ type: 'text', x: 0.1, y: 0.1, text: '<script>alert(1)</script> & </text><rect/>' }] });
  rec('글자 속 < > & 는 글자로만 취급(그림 구조를 깨지 못함)', !r.err && sizeOf(r.json.saved_path) === '800x450', r.text);
  const svgT = annotate.buildSvg(annotate.imageInfo(fs.readFileSync(SRC)), fs.readFileSync(SRC), { items: [{ type: 'text', x: 0.1, y: 0.1, text: '<b>&</b>' }] }).svg;
  rec('SVG에는 이스케이프된 글자만', svgT.includes('&lt;b&gt;&amp;&lt;/b&gt;') && !svgT.includes('<b>'), '');
  r = await call('annotate_image', { path: SRC, out_filename: 'src.png', overwrite: true, items: [] });
  rec('원본 덮어쓰기 거절(overwrite:true여도)', r.err && /덮어쓰지 않습니다/.test(r.text) && require('crypto').createHash('sha256').update(fs.readFileSync(SRC)).digest('hex') === srcSha, r.text);
  const notImg = path.join(ROOT, 'doan', 'a.txt'); fs.writeFileSync(notImg, 'hello');
  r = await call('annotate_image', { path: notImg, items: [] });
  rec('이미지가 아닌 파일 거절', r.err && /PNG 또는 JPG/.test(r.text), r.text);
  fs.writeFileSync(path.join(OUTSIDE, 'o.png'), makePng(10, 10));
  r = await call('annotate_image', { path: path.join(OUTSIDE, 'o.png'), items: [] });
  rec('허용 폴더 밖 원본 읽기 거절', r.err, r.text);
  r = await call('annotate_image', { path: SRC, items: [], out_dir: OUTSIDE });
  rec('허용 폴더 밖에 저장 거절', r.err && fs.readdirSync(OUTSIDE).length === 1, r.text);
  r = await call('annotate_image', { path: SRC, items: [], out_dir: path.join(ROOT, 'agent') });
  rec('agent 폴더에 저장 거절', r.err, r.text);
  r = await call('annotate_image', { path: path.join(ROOT, 'doan', 'nope.png'), items: [] });
  rec('없는 파일 오류', r.err, r.text);
  r = await call('annotate_image', { items: [] });
  rec('path 없음 오류', r.err, r.text);
  // JPEG 크기 읽기(진짜 JPEG)
  rec('imageInfo: JPEG 크기 40x30', annotate.imageInfo(JPEG).w === 40 && annotate.imageInfo(JPEG).h === 30, '');

  let fail = 0;
  for (const x of rows) { if (!x.ok) fail++; console.log((x.ok ? 'PASS ' : 'FAIL ') + x.name + (x.ok ? '' : '   <= ' + x.detail)); }
  console.log((rows.length - fail) + ' passed' + (fail ? ', ' + fail + ' FAILED' : ''));
  fs.rmSync(base, { recursive: true, force: true });
  process.exitCode = fail ? 1 : 0;
})().catch(e => { console.error(e); fs.rmSync(base, { recursive: true, force: true }); process.exit(3); });
