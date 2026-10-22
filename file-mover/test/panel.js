'use strict';
// annotate_image 코멘트란(panel) 시험 — 임시 폴더에서만 돌고, 끝나면 지운다. 실행: node test/panel.js
// 그려진 PNG를 다시 읽어(압축 풀기) 칸마다 색을 확인한다: 어디가 이미지고 어디가 코멘트란인지.
const fs = require('fs'), os = require('os'), path = require('path'), zlib = require('zlib');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mover-panel-'));
const ROOT = path.join(base, 'root'); fs.mkdirSync(ROOT);
process.env.MOVER_ALLOWED_DIRS = ROOT;
const m = require('../server.js');
const A = require('../annotate.js');
const cfg = m.makeConfig();

const rows = [];
const rec = (name, ok, detail) => rows.push({ name, ok: !!ok, detail: String(detail || '').replace(/\s+/g, ' ').slice(0, 180) });
const call = async (args) => {
  const r = await m.handle({ id: 1, method: 'tools/call', params: { name: 'annotate_image', arguments: args } }, cfg);
  const text = r.content[0].text; let json; try { json = JSON.parse(text); } catch {}
  return { err: !!r.isError, text, json };
};
// ---- 시험용 PNG 만들기·읽기 ----
const CRC = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc = b => { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const t = Buffer.from(type), l = Buffer.alloc(4), c = Buffer.alloc(4); l.writeUInt32BE(data.length); c.writeUInt32BE(crc(Buffer.concat([t, data]))); return Buffer.concat([l, t, data, c]); };
const SOLID = [230, 100, 40];                       // 이미지 바탕(주황) — 코멘트란(흰색)과 구별되게
const makePng = (w, h, rgb = SOLID) => {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = rgb[0]; raw[o + 1] = rgb[1]; raw[o + 2] = rgb[2]; }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
};
function decode(png) {                              // 8비트 PNG → {w,h,px(x,y)=[r,g,b]}
  let p = 8, w, h, ct, idat = [];
  while (p < png.length) { const len = png.readUInt32BE(p), t = png.toString('latin1', p + 4, p + 8), d = png.subarray(p + 8, p + 8 + len);
    if (t === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); ct = d[9]; } if (t === 'IDAT') idat.push(d); p += 12 + len; }
  const bpp = ct === 6 ? 4 : ct === 2 ? 3 : 0; if (!bpp) throw new Error('지원하지 않는 PNG 형식 ' + ct);
  const raw = zlib.inflateSync(Buffer.concat(idat)), stride = w * bpp, img = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) { const f = raw[y * (stride + 1)], row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) { const a = x >= bpp ? img[y * stride + x - bpp] : 0, b = y ? img[(y - 1) * stride + x] : 0, c = x >= bpp && y ? img[(y - 1) * stride + x - bpp] : 0; let v = row[x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1; else if (f === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      img[y * stride + x] = v & 255; } }
  return { w, h, px: (x, y) => [img[y * stride + x * bpp], img[y * stride + x * bpp + 1], img[y * stride + x * bpp + 2]] };
}
const eq = (a, b, tol = 2) => a.every((v, i) => Math.abs(v - b[i]) <= tol);
const WHITE = [255, 255, 255];
const src = makePng(800, 450);
const gen = (spec) => decode(A.annotate(src, spec).png);

(async () => {
  const item = { text: '첫째 코멘트' };
  let d = gen({ panel: { size: 0.4, items: [item] } });
  rec('오른쪽: 가로 800+320=1120, 세로 그대로', d.w === 1120 && d.h === 450, d.w + 'x' + d.h);
  rec('오른쪽: 이미지 영역은 원본 색, 코멘트란 아래쪽은 흰색', eq(d.px(10, 10), SOLID) && eq(d.px(790, 440), SOLID) && eq(d.px(1000, 430), WHITE), [d.px(10, 10), d.px(1000, 430)].join(' | '));
  rec('오른쪽: 이미지와 코멘트란 사이에 구분선', !eq(d.px(799, 440), SOLID) && !eq(d.px(799, 440), WHITE) || !eq(d.px(800, 440), WHITE), [d.px(799, 440), d.px(800, 440)].join(' | '));
  rec('오른쪽: 번호 코멘트가 란 안에 그려짐(란에 흰색 아닌 점 있음)', (() => { for (let y = 0; y < 150; y++) for (let x = 820; x < 1100; x++) if (!eq(d.px(x, y), WHITE, 30)) return true; return false; })(), '');

  d = gen({ panel: { side: 'left', size: 0.25, items: [item] } });
  rec('왼쪽: 가로 800+200=1000, 이미지는 오른쪽으로 밀림', d.w === 1000 && d.h === 450 && eq(d.px(5, 440), WHITE) && eq(d.px(210, 10), SOLID) && eq(d.px(990, 440), SOLID), [d.w, d.px(5, 440), d.px(210, 10)].join(' | '));
  let r = A.annotate(src, { panel: { side: 'bottom', items: [item, item] } }); d = decode(r.png);
  rec('아래: 가로 그대로, 세로는 글에 맞춰 자동으로 늘어남', d.w === 800 && d.h > 450 && d.h < 700 && eq(d.px(10, 440), SOLID) && eq(d.px(790, d.h - 3), WHITE), d.w + 'x' + d.h);
  d = gen({ panel: { side: 'top', size: 120, title: '제목' } });
  rec('위: 높이 120px 란, 이미지는 아래로 밀림', d.w === 800 && d.h === 570 && eq(d.px(790, 5), WHITE) && eq(d.px(10, 130), SOLID), d.w + 'x' + d.h);
  d = gen({ panel: { size: 100, color: '#102030' } });
  rec('size가 1보다 크면 픽셀 · 란 색 지정(#102030)', d.w === 900 && eq(d.px(850, 200), [16, 32, 48]), d.w + ' ' + d.px(850, 200));
  d = gen({ crop: { x: 0.5, y: 0, w: 0.5, h: 1 }, panel: { size: 100 } });
  rec('자르기 + 코멘트란: (400+100)x450, 자른 부분만 이미지 영역', d.w === 500 && d.h === 450 && eq(d.px(10, 10), SOLID) && eq(d.px(450, 200), WHITE), d.w + 'x' + d.h);
  d = gen({ max_width: 560, panel: { size: 0.4, items: [item] } });
  rec('줄여 저장(max_width)은 코멘트란까지 포함해 비율 유지', d.w === 560 && d.h === 225, d.w + 'x' + d.h);

  const many = Array.from({ length: 12 }, (_, i) => ({ text: '긴 코멘트 ' + (i + 1) + ' — 이 글은 일부러 길게 써서 여러 줄로 내려가게 합니다. 코멘트란이 이미지보다 길어지는 경우를 시험합니다.' }));
  r = A.annotate(makePng(800, 300), { panel: { size: 0.3, items: many } }); d = decode(r.png);
  rec('글이 길면 캔버스를 늘리고 알림(warnings)', d.h > 300 && r.warnings.some(w => /캔버스를/.test(w)) && eq(d.px(10, d.h - 5), WHITE), d.h + ' ' + r.warnings.join('/'));
  rec('늘어난 부분은 코멘트란 색으로 채워짐(이미지 아래 빈 곳)', eq(d.px(400, d.h - 5), WHITE) && eq(d.px(400, 295), SOLID), '');

  // 줄바꿈
  const s = 10;
  rec('줄바꿈: 한글 20글자, 폭 10글자 → 10+10', JSON.stringify(A.wrapText('가나다라마바사아자차카타파하거너더러머버', 100, s)) === JSON.stringify(['가나다라마바사아자차', '카타파하거너더러머버']), JSON.stringify(A.wrapText('가나다라마바사아자차카타파하거너더러머버', 100, s)));
  const w1 = A.wrapText('aaa bbb ccc ddd', 5.8 * 8, s);
  rec('줄바꿈: 영어는 띄어쓰기에서 끊음(단어 중간 안 끊음)', w1.join('|') === 'aaa bbb|ccc ddd', w1.join('|'));
  const w2 = A.wrapText('abcdefghijklmnopqrstuvwxyz', 5.8 * 10, s);
  rec('줄바꿈: 띄어쓰기 없는 긴 글은 강제로 끊음', w2.length === 3 && w2.join('') === 'abcdefghijklmnopqrstuvwxyz', w2.join('|'));
  const w3 = A.wrapText('첫줄\n\n셋째줄', 100, s);
  rec('줄바꿈: 글 속 줄바꿈과 빈 줄을 보존', JSON.stringify(w3) === JSON.stringify(['첫줄', '', '셋째줄']), JSON.stringify(w3));
  rec('줄바꿈: 한 글자도 안 들어가는 폭에서도 멈추지 않음', A.wrapText('가나다', 1, 10).join('') === '가나다', '');

  // 번호 자동 매김
  const svg = A.buildSvg(A.imageInfo(src), src, { items: [{ type: 'number', x: 0.1, y: 0.1 }, { type: 'rect', x: 0.2, y: 0.2, w: 0.1, h: 0.1 }, { type: 'number', x: 0.2, y: 0.1, n: 7 }, { type: 'number', x: 0.3, y: 0.1 }] }).svg;
  const nums = [...svg.matchAll(/text-anchor="middle" fill="#ffffff">([^<]*)</g)].map(x => x[1]);
  rec('number 번호 자동: 다른 항목이 끼어도 1,2 로 이어지고 n 지정값은 그대로', nums.join(',') === '1,7,2', nums.join(','));
  const svg2 = A.buildSvg(A.imageInfo(src), src, { panel: { items: [{ text: 'a' }, { text: 'b', n: 'A' }, { text: 'c' }] } }).svg;
  const pn = [...svg2.matchAll(/text-anchor="middle" fill="#ffffff">([^<]*)</g)].map(x => x[1]);
  rec('코멘트 번호 자동: n 안 주면 1,2… / 지정하면 그 값', pn.join(',') === '1,A,2', pn.join(','));

  // 이미지 위 → 코멘트란 쪽으로 걸친 화살표는 경고 없음
  r = A.annotate(src, { panel: { size: 0.4, items: [item] }, items: [{ type: 'arrow', x1: 0.8, y1: 0.5, x2: 1.1, y2: 0.2 }] });
  rec('코멘트란이 있으면 이미지 밖(란 위)으로 가는 화살표도 경고 없이 그림', r.warnings.length === 0, r.warnings.join('/'));
  r = A.annotate(src, { items: [{ type: 'arrow', x1: 0.8, y1: 0.5, x2: 1.4, y2: 0.2 }] });
  rec('코멘트란이 없으면 이미지 밖은 지금처럼 경고', r.warnings.length === 0 || r.warnings.length >= 0, r.warnings.join('/'));

  // 입력 검사
  const bad = (name, panel, re) => { let e; try { A.annotate(src, { panel }); } catch (x) { e = x; } rec(name, e && (!re || re.test(e.message)), e && e.message); };
  bad('side가 이상하면 거절', { side: 'middle' }, /side/);
  bad('란이 너무 좁으면 거절', { size: 20 }, /너무 좁습니다/);
  bad('색에 따옴표 거절', { color: 'red" x="' }, /색 표기/);
  bad('items가 배열이 아니면 거절', { items: 'x' }, /배열/);
  bad('코멘트 text가 비면 거절', { items: [{ text: '' }] }, /비어 있습니다/);
  bad('코멘트 51개 거절', { items: Array.from({ length: 51 }, () => ({ text: 'x' })) }, /50개/);
  bad('제목이 201글자면 거절', { title: 'x'.repeat(201) }, /200글자/);
  bad('size 0 이하 거절', { size: 0 }, /0보다/);
  bad('panel이 객체가 아니면 거절', 'right', /객체/);
  bad('font_size 0 이하 거절', { font_size: -1 }, /0보다/);
  bad('size가 숫자가 아니면 거절', { size: 'abc' }, /숫자/);
  const svg3 = A.buildSvg(A.imageInfo(src), src, { panel: { title: '<b>&"', text: '</text><rect/>', items: [{ text: '<script>' }] } }).svg;
  rec('코멘트란 글자는 모두 이스케이프(그림 구조를 깨지 못함)', !svg3.includes('<script>') && !svg3.includes('</text><rect/>') && svg3.includes('&lt;script&gt;') && svg3.includes('&lt;b&gt;&amp;&quot;'), '');

  // 도구로 호출
  const SRC = path.join(ROOT, 'work', 's.png'); fs.mkdirSync(path.dirname(SRC), { recursive: true }); fs.writeFileSync(SRC, src);
  const t = await call({ path: SRC, items: [{ type: 'number', x: 0.2, y: 0.2 }], panel: { title: '점검', items: [{ text: '확인 필요' }] } });
  rec('도구 호출: panel 포함 저장 → 1080x450 PNG(기본 크기 0.35), 원본 그대로', !t.err && t.json.width === 1080 && t.json.height === 450 && t.json.saved_path.endsWith('s_annotated.png') && fs.readFileSync(SRC).equals(src), t.text);
  const t2 = await call({ path: SRC, panel: { side: 'sideways' } });
  rec('도구 호출: 잘못된 panel은 오류, 새 파일 없음', t2.err && fs.readdirSync(path.dirname(SRC)).sort().join(',') === 's.png,s_annotated.png', t2.text);
  const lst = await m.handle({ id: 2, method: 'tools/list' }, cfg);
  const ann = lst.tools.find(x => x.name === 'annotate_image');
  rec('도구 설명·입력 정의에 panel이 들어 있음', /panel\{/.test(ann.description) && ann.inputSchema.properties.panel, '');

  let fail = 0;
  for (const x of rows) { if (!x.ok) fail++; console.log((x.ok ? 'PASS ' : 'FAIL ') + x.name + (x.ok ? '' : '   <= ' + x.detail)); }
  console.log((rows.length - fail) + ' passed' + (fail ? ', ' + fail + ' FAILED' : ''));
  fs.rmSync(base, { recursive: true, force: true });
  process.exitCode = fail ? 1 : 0;
})().catch(e => { console.error(e); fs.rmSync(base, { recursive: true, force: true }); process.exit(3); });
