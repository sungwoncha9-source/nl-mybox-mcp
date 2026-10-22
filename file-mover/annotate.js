'use strict';
// 이미지에 그림·글자를 얹는 모듈 (file-mover v1.3). 사진 위에 SVG를 겹쳐 @resvg/resvg-js로 PNG로 굽는다.
// 좌표 기본값은 "비율"(0~1, 이미지 가로·세로 대비). units:'px'면 픽셀. 보이는 그림이 축소돼 있어도 어긋나지 않게 하려는 것.
// 이 파일은 순수 계산만 한다(파일 읽기·쓰기·허용 폴더 검사는 server.js 몫).

const MAX_ITEMS = 200, MAX_TEXT = 500, MAX_POINTS = 5000;
const FONT = "'Malgun Gothic','Noto Sans CJK KR','Noto Sans KR','Apple SD Gothic Neo','Noto Sans CJK SC',sans-serif";

function imageInfo(buf) {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47 && buf.toString('latin1', 12, 16) === 'IHDR')
    return { type: 'png', mime: 'image/png', w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let p = 2;
    while (p + 9 < buf.length) {
      if (buf[p] !== 0xff) { p++; continue; }
      const m = buf[p + 1];
      if (m === 0xff) { p++; continue; }
      if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return { type: 'jpeg', mime: 'image/jpeg', h: buf.readUInt16BE(p + 5), w: buf.readUInt16BE(p + 7) };
      p += 2 + buf.readUInt16BE(p + 2);
    }
  }
  throw new Error('PNG 또는 JPG 이미지만 열 수 있습니다');
}

const num = (v, what) => { const n = Number(v); if (v === undefined || v === null || v === '' || !Number.isFinite(n)) throw new Error(what + ' 값이 숫자가 아닙니다'); return n; };
const r2 = n => Math.round(n * 100) / 100;
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function color(c, def) {
  if (c === undefined || c === null || c === '') return def;
  c = String(c).trim();
  if (!/^(#[0-9a-fA-F]{3,8}|[a-zA-Z]{3,20}|rgba?\([0-9., %]{5,40}\))$/.test(c)) throw new Error('색 표기가 올바르지 않습니다: ' + c + ' (예: #e11d48, red, rgba(255,0,0,0.5))');
  return c;
}

function buildSvg(info, buf, spec) {
  if (!spec || typeof spec !== 'object') throw new Error('설정이 필요합니다');
  const W = info.w, H = info.h;
  const units = spec.units === 'px' ? 'px' : 'ratio';
  const X = v => r2((units === 'px' ? 1 : W) * num(v, 'x'));
  const Y = v => r2((units === 'px' ? 1 : H) * num(v, 'y'));
  const items = spec.items === undefined ? [] : spec.items;
  if (!Array.isArray(items)) throw new Error('items는 배열이어야 합니다');
  if (items.length > MAX_ITEMS) throw new Error('items는 최대 ' + MAX_ITEMS + '개입니다');
  const base = Math.max(3, Math.round(Math.min(W, H) * 0.004));   // 기본 선 굵기
  const defSize = Math.max(18, Math.round(H * 0.028));              // 기본 글자 크기
  const warnings = [];
  const out = [];
  const sw = it => { const v = it.width === undefined ? base : num(it.width, 'width'); if (v <= 0 || v > Math.max(W, H)) throw new Error('width가 범위를 벗어납니다'); return r2(v); };
  const sizeOf = it => { if (it.size === undefined) return defSize; const s = num(it.size, 'size'); if (s <= 0) throw new Error('size는 0보다 커야 합니다'); return r2(s <= 1 ? s * H : s); };
  const op = it => it.opacity === undefined ? '' : ' opacity="' + Math.min(1, Math.max(0, num(it.opacity, 'opacity'))) + '"';
  const box = it => { const x = X(it.x), y = Y(it.y), w = r2((units === 'px' ? 1 : W) * num(it.w, 'w')), h = r2((units === 'px' ? 1 : H) * num(it.h, 'h'));
    if (w <= 0 || h <= 0) throw new Error('w, h는 0보다 커야 합니다'); return { x, y, w, h }; };
  const inside = (x, y) => x >= -W * 0.05 && x <= W * 1.05 && y >= -H * 0.05 && y <= H * 1.05;

  items.forEach((it, idx) => {
    if (!it || typeof it !== 'object') throw new Error('items[' + idx + ']가 올바르지 않습니다');
    const t = it.type;
    try {
      if (t === 'rect' || t === 'highlight' || t === 'mask') {
        const b = box(it);
        if (!inside(b.x, b.y)) warnings.push('items[' + idx + '] ' + t + '이 이미지 밖에 있습니다');
        if (t === 'rect') {
          const fill = color(it.fill, 'none');
          const rad = it.radius === undefined ? 0 : r2(num(it.radius, 'radius') <= 1 ? Number(it.radius) * Math.min(b.w, b.h) : Number(it.radius));
          out.push('<rect x="' + b.x + '" y="' + b.y + '" width="' + b.w + '" height="' + b.h + '" rx="' + rad + '" fill="' + fill + '" stroke="' + color(it.color, '#e11d48') + '" stroke-width="' + sw(it) + '"' + op(it) + '/>');
        } else if (t === 'highlight') {
          out.push('<rect x="' + b.x + '" y="' + b.y + '" width="' + b.w + '" height="' + b.h + '" fill="' + color(it.color, '#facc15') + '" opacity="' + (it.opacity === undefined ? 0.4 : Math.min(1, Math.max(0, num(it.opacity, 'opacity')))) + '"/>');
        } else {
          out.push('<rect x="' + b.x + '" y="' + b.y + '" width="' + b.w + '" height="' + b.h + '" fill="' + color(it.color, '#000000') + '"/>');
        }
      } else if (t === 'ellipse') {
        const b = box(it);
        if (!inside(b.x, b.y)) warnings.push('items[' + idx + '] ellipse가 이미지 밖에 있습니다');
        out.push('<ellipse cx="' + r2(b.x + b.w / 2) + '" cy="' + r2(b.y + b.h / 2) + '" rx="' + r2(b.w / 2) + '" ry="' + r2(b.h / 2) + '" fill="' + color(it.fill, 'none') + '" stroke="' + color(it.color, '#e11d48') + '" stroke-width="' + sw(it) + '"' + op(it) + '/>');
      } else if (t === 'line' || t === 'arrow') {
        const x1 = X(it.x1), y1 = Y(it.y1), x2 = X(it.x2), y2 = Y(it.y2), c = color(it.color, '#e11d48'), w = sw(it);
        if (!inside(x1, y1) && !inside(x2, y2)) warnings.push('items[' + idx + '] ' + t + '이 이미지 밖에 있습니다');
        if (t === 'line') out.push('<line x1="' + x1 + '" y1="' + y1 + '" x2="' + x2 + '" y2="' + y2 + '" stroke="' + c + '" stroke-width="' + w + '" stroke-linecap="round"' + op(it) + '/>');
        else {
          const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy);
          if (len < 1) throw new Error('arrow의 시작과 끝이 같습니다');
          const L = Math.min(len * 0.6, w * 4 + 10), ux = dx / len, uy = dy / len, ang = Math.PI / 7;
          const rot = (a) => [r2(x2 - L * (ux * Math.cos(a) - uy * Math.sin(a))), r2(y2 - L * (ux * Math.sin(a) + uy * Math.cos(a)))];
          const [ax, ay] = rot(ang), [bx, by] = rot(-ang), sx = r2(x2 - ux * L * 0.8), sy = r2(y2 - uy * L * 0.8);
          out.push('<g' + op(it) + '><line x1="' + x1 + '" y1="' + y1 + '" x2="' + sx + '" y2="' + sy + '" stroke="' + c + '" stroke-width="' + w + '" stroke-linecap="round"/>' +
            '<polygon points="' + x2 + ',' + y2 + ' ' + ax + ',' + ay + ' ' + bx + ',' + by + '" fill="' + c + '" stroke="' + c + '" stroke-width="' + r2(w * 0.3) + '" stroke-linejoin="round"/></g>');
        }
      } else if (t === 'freehand') {
        const pts = it.points;
        if (!Array.isArray(pts) || pts.length < 2) throw new Error('points는 [x,y] 두 개 이상의 배열이어야 합니다');
        if (pts.length > MAX_POINTS) throw new Error('points는 최대 ' + MAX_POINTS + '개입니다');
        const P = pts.map(p => { if (!Array.isArray(p) || p.length < 2) throw new Error('points 항목은 [x,y]여야 합니다'); return [X(p[0]), Y(p[1])]; });
        let d = 'M' + P[0][0] + ' ' + P[0][1];
        for (let i = 1; i < P.length - 1; i++) d += ' Q' + P[i][0] + ' ' + P[i][1] + ' ' + r2((P[i][0] + P[i + 1][0]) / 2) + ' ' + r2((P[i][1] + P[i + 1][1]) / 2);
        d += ' L' + P[P.length - 1][0] + ' ' + P[P.length - 1][1];
        out.push('<path d="' + d + '" fill="none" stroke="' + color(it.color, '#e11d48') + '" stroke-width="' + sw(it) + '" stroke-linecap="round" stroke-linejoin="round"' + op(it) + '/>');
      } else if (t === 'number') {
        const x = X(it.x), y = Y(it.y), s = sizeOf(it), n = esc(it.n === undefined ? idx + 1 : String(it.n).slice(0, 4));
        if (!inside(x, y)) warnings.push('items[' + idx + '] number가 이미지 밖에 있습니다');
        out.push('<g' + op(it) + '><circle cx="' + x + '" cy="' + y + '" r="' + r2(s * 0.75) + '" fill="' + color(it.color, '#e11d48') + '" stroke="#ffffff" stroke-width="' + r2(Math.max(2, s * 0.1)) + '"/>' +
          '<text x="' + x + '" y="' + r2(y + s * 0.36) + '" font-family="' + FONT + '" font-size="' + s + '" font-weight="bold" text-anchor="middle" fill="#ffffff">' + n + '</text></g>');
      } else if (t === 'text') {
        const text = String(it.text === undefined ? '' : it.text);
        if (!text) throw new Error('text가 비어 있습니다');
        if (text.length > MAX_TEXT) throw new Error('text는 최대 ' + MAX_TEXT + '글자입니다');
        const x = X(it.x), y = Y(it.y), s = sizeOf(it), lh = r2(s * 1.25), lines = text.split(/\r?\n/);
        const align = it.align === 'middle' || it.align === 'end' ? it.align : 'start';
        if (!inside(x, y)) warnings.push('items[' + idx + '] text가 이미지 밖에 있습니다');
        const wOf = l => [...l].reduce((a, ch) => a + (ch.charCodeAt(0) > 0x2e80 ? s : s * 0.58), 0);
        const tw = Math.max(...lines.map(wOf)), pad = r2(s * 0.3);
        const left = align === 'start' ? x : align === 'middle' ? x - tw / 2 : x - tw;
        const fill = color(it.color, '#e11d48'), bg = color(it.bg, '');
        let g = '<g' + op(it) + '>';
        if (bg) g += '<rect x="' + r2(left - pad) + '" y="' + r2(y - pad * 0.4) + '" width="' + r2(tw + pad * 2) + '" height="' + r2(lines.length * lh + pad * 0.8) + '" rx="' + r2(s * 0.2) + '" fill="' + bg + '"/>';
        const halo = bg ? '' : ' stroke="' + color(it.halo, '#ffffff') + '" stroke-width="' + r2(s * 0.22) + '" stroke-linejoin="round" paint-order="stroke"';
        g += '<text font-family="' + FONT + '" font-size="' + s + '"' + (it.bold === false ? '' : ' font-weight="bold"') + ' text-anchor="' + align + '" fill="' + fill + '"' + halo + '>';
        lines.forEach((l, i) => { g += '<tspan x="' + x + '" y="' + r2(y + s * 0.95 + i * lh) + '">' + (esc(l) || ' ') + '</tspan>'; });
        out.push(g + '</text></g>');
      } else {
        throw new Error('알 수 없는 type: ' + t + ' (rect, ellipse, line, arrow, text, number, freehand, highlight, mask)');
      }
    } catch (e) { throw new Error('items[' + idx + '] ' + e.message); }
  });

  // 자르기: 화면 영역만 내보낸다
  let cx = 0, cy = 0, cw = W, ch = H;
  if (spec.crop !== undefined) {
    const c = spec.crop;
    if (!c || typeof c !== 'object') throw new Error('crop은 {x,y,w,h} 여야 합니다');
    cx = Math.max(0, Math.round(X(c.x))); cy = Math.max(0, Math.round(Y(c.y)));
    cw = Math.round((units === 'px' ? 1 : W) * num(c.w, 'crop.w')); ch = Math.round((units === 'px' ? 1 : H) * num(c.h, 'crop.h'));
    cw = Math.min(cw, W - cx); ch = Math.min(ch, H - cy);
    if (cw < 1 || ch < 1) throw new Error('crop 영역이 이미지 밖입니다');
  }
  const b64 = buf.toString('base64');
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="' + cw + '" height="' + ch + '" viewBox="' + cx + ' ' + cy + ' ' + cw + ' ' + ch + '">' +
    '<image x="0" y="0" width="' + W + '" height="' + H + '" xlink:href="data:' + info.mime + ';base64,' + b64 + '"/>' + out.join('') + '</svg>';
  return { svg, width: cw, height: ch, count: items.length, warnings };
}

function annotate(buf, spec) {
  const info = imageInfo(buf);
  if (info.w * info.h > 120e6) throw new Error('이미지가 너무 큽니다: ' + info.w + 'x' + info.h);
  const built = buildSvg(info, buf, spec);
  let Resvg;
  try { ({ Resvg } = require('@resvg/resvg-js')); }
  catch { throw new Error('그림 그리기 부품(@resvg/resvg-js)이 설치되지 않았습니다. 설치가 끝났는지 확인하고 다시 시작하세요'); }
  const opts = { font: { loadSystemFonts: true, defaultFontFamily: 'Malgun Gothic' } };
  if (spec.max_width !== undefined) { const mw = Math.round(num(spec.max_width, 'max_width')); if (mw >= 16 && mw < built.width) opts.fitTo = { mode: 'width', value: mw }; }
  const img = new Resvg(built.svg, opts).render();
  return { png: img.asPng(), width: img.width, height: img.height, count: built.count, warnings: built.warnings, source: { w: info.w, h: info.h } };
}

module.exports = { annotate, buildSvg, imageInfo, MAX_ITEMS };
