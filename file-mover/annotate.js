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


// ---------- 글 줄바꿈과 코멘트란 ----------
const chW = (ch, s) => { const c = ch.charCodeAt(0); return c === 32 ? s * 0.3 : c > 0x2e80 ? s : s * 0.58; };
const lineW = (l, s) => [...l].reduce((a, ch) => a + chW(ch, s), 0);
// 글자 폭으로 줄을 나눈다: 한글은 글자 단위, 영어는 띄어쓰기 단위(띄어쓰기 없는 긴 글은 강제로 끊음). 글자 폭은 어림값이다.
function wrapText(text, maxW, s) {
  const out = [];
  for (const para of String(text).split(/\r?\n/)) {
    if (para === '') { out.push(''); continue; }
    let line = '', w = 0, lastSpace = -1;
    for (const ch of para) {
      const cw = chW(ch, s);
      if (w + cw > maxW && line) {
        if (ch !== ' ' && lastSpace > 0) { out.push(line.slice(0, lastSpace).trimEnd()); line = line.slice(lastSpace + 1); w = lineW(line, s); }
        else { out.push(line.trimEnd()); line = ''; w = 0; }
        lastSpace = line.lastIndexOf(' ');
        if (ch === ' ') continue;
      }
      if (ch === ' ') lastSpace = line.length;
      line += ch; w += cw;
    }
    out.push(line.trimEnd());
  }
  return out;
}

// 좌표는 코멘트란 왼쪽 위가 (0,0). 돌려주는 contentH는 글이 차지한 높이(위아래 여백 포함).
function layoutPanel(panel, cw, ch, H, defSize, warnings) {
  if (!panel || typeof panel !== 'object') throw new Error('panel은 객체여야 합니다');
  const side = panel.side === undefined ? 'right' : panel.side;
  if (!['right', 'left', 'top', 'bottom'].includes(side)) throw new Error('panel.side는 right, left, top, bottom 중 하나입니다');
  const horizontal = side === 'left' || side === 'right';
  let s = defSize;
  if (panel.font_size !== undefined) { const f = num(panel.font_size, 'panel.font_size'); if (f <= 0) throw new Error('panel.font_size는 0보다 커야 합니다'); s = r2(f <= 1 ? f * H : f); }
  const pad = Math.round(s * 0.8), lh = r2(s * 1.35);
  let pw = 0, ph = 0, sizeGiven = false;
  if (panel.size !== undefined) {
    const z = num(panel.size, 'panel.size'); if (z <= 0) throw new Error('panel.size는 0보다 커야 합니다');
    sizeGiven = true;
    if (horizontal) pw = Math.round(z <= 1 ? z * cw : z); else ph = Math.round(z <= 1 ? z * ch : z);
  } else if (horizontal) pw = Math.round(cw * 0.35);
  const textW = (horizontal ? pw : cw) - 2 * pad;
  if (textW < s * 4) throw new Error('코멘트란이 너무 좁습니다(글 영역 ' + Math.round(textW) + 'px). size를 키우거나 font_size를 줄이세요');
  const pcolor = color(panel.color, '#ffffff'), tcol = color(panel.text_color, '#1f2937'), hcol = color(panel.title_color, '#111827');
  const parts = [];
  let y = pad;
  const textLines = (lines, x, y0, size, fill, bold) => '<text font-family="' + FONT + '" font-size="' + size + '"' + (bold ? ' font-weight="bold"' : '') + ' fill="' + fill + '">' +
    lines.map((l, i) => '<tspan x="' + x + '" y="' + r2(y0 + size * 0.95 + i * size * 1.35) + '">' + (esc(l) || ' ') + '</tspan>').join('') + '</text>';
  if (panel.title !== undefined && String(panel.title) !== '') {
    const t = String(panel.title); if (t.length > 200) throw new Error('panel.title은 최대 200글자입니다');
    const ts = r2(s * 1.15), L = wrapText(t, textW, ts);
    parts.push(textLines(L, pad, y, ts, hcol, true)); y += L.length * ts * 1.35 + s * 0.25;
    parts.push('<line x1="' + pad + '" y1="' + r2(y) + '" x2="' + (pad + textW) + '" y2="' + r2(y) + '" stroke="#c9c9cf" stroke-width="2"/>'); y += s * 0.6;
  }
  if (panel.text !== undefined && String(panel.text) !== '') {
    const t = String(panel.text); if (t.length > 3000) throw new Error('panel.text는 최대 3000글자입니다');
    const L = wrapText(t, textW, s);
    parts.push(textLines(L, pad, y, s, tcol, false)); y += L.length * lh + s * 0.5;
  }
  const items = panel.items === undefined ? [] : panel.items;
  if (!Array.isArray(items)) throw new Error('panel.items는 배열이어야 합니다');
  if (items.length > 50) throw new Error('panel.items는 최대 50개입니다');
  const r = r2(s * 0.62), indent = r2(r * 2 + s * 0.45);
  let auto = 0;
  items.forEach((it, i) => {
    if (!it || typeof it !== 'object') throw new Error('panel.items[' + i + ']가 올바르지 않습니다');
    const t = String(it.text === undefined ? '' : it.text);
    if (!t) throw new Error('panel.items[' + i + '].text가 비어 있습니다');
    if (t.length > 1000) throw new Error('panel.items[' + i + '].text는 최대 1000글자입니다');
    const L = wrapText(t, textW - indent, s), h = Math.max(2 * r, L.length * lh);
    const bcol = color(it.color, '#e11d48'), icol = color(it.text_color, tcol);
    const n = it.n === null || it.n === '' ? undefined : it.n;
    const label = n === undefined ? String(++auto) : String(n).slice(0, 4);
    parts.push('<circle cx="' + r2(pad + r) + '" cy="' + r2(y + r) + '" r="' + r + '" fill="' + bcol + '"/>' +
      '<text x="' + r2(pad + r) + '" y="' + r2(y + r + s * 0.36) + '" font-family="' + FONT + '" font-size="' + s + '" font-weight="bold" text-anchor="middle" fill="#ffffff">' + esc(label) + '</text>');
    parts.push(textLines(L, pad + indent, y, s, icol, false));
    y += h + s * 0.6;
  });
  const contentH = Math.ceil(y + pad - s * 0.6);
  if (!horizontal) { if (sizeGiven && ph < contentH) warnings.push('코멘트가 길어 코멘트란 높이를 ' + ph + 'px에서 ' + contentH + 'px로 늘렸습니다'); ph = sizeGiven ? Math.max(ph, contentH) : Math.max(contentH, Math.round(s * 3)); }
  else if (contentH > ch) warnings.push('코멘트가 길어 이미지 높이(' + ch + 'px)보다 캔버스를 ' + contentH + 'px로 늘렸습니다');
  return { side, horizontal, pw, ph, color: pcolor, svg: parts.join(''), contentH };
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
  let numAuto = 0;
  const sw = it => { const v = it.width === undefined ? base : num(it.width, 'width'); if (v <= 0 || v > Math.max(W, H)) throw new Error('width가 범위를 벗어납니다'); return r2(v); };
  const sizeOf = it => { if (it.size === undefined) return defSize; const s = num(it.size, 'size'); if (s <= 0) throw new Error('size는 0보다 커야 합니다'); return r2(s <= 1 ? s * H : s); };
  const op = it => it.opacity === undefined ? '' : ' opacity="' + Math.min(1, Math.max(0, num(it.opacity, 'opacity'))) + '"';
  const box = it => { const x = X(it.x), y = Y(it.y), w = r2((units === 'px' ? 1 : W) * num(it.w, 'w')), h = r2((units === 'px' ? 1 : H) * num(it.h, 'h'));
    if (w <= 0 || h <= 0) throw new Error('w, h는 0보다 커야 합니다'); return { x, y, w, h }; };
  const inside = (x, y) => spec.panel !== undefined || (x >= -W * 0.05 && x <= W * 1.05 && y >= -H * 0.05 && y <= H * 1.05); // 코멘트란이 있으면 이미지 밖(란 위)에도 그릴 수 있다

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
        const x = X(it.x), y = Y(it.y), s = sizeOf(it), n = esc(it.n === undefined || it.n === null || it.n === '' ? ++numAuto : String(it.n).slice(0, 4));
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
  // 코멘트란(panel): 캔버스를 한쪽으로 넓혀 제목·글·번호 코멘트를 적는다
  let ox = 0, oy = 0, CW = cw, CH = ch, panelSvg = '', bg = '';
  if (spec.panel !== undefined) {
    const P = layoutPanel(spec.panel, cw, ch, H, defSize, warnings);
    ox = P.side === 'left' ? P.pw : 0; oy = P.side === 'top' ? P.ph : 0;
    CW = P.horizontal ? cw + P.pw : cw; CH = P.horizontal ? Math.max(ch, P.contentH) : ch + P.ph;
    const px0 = P.side === 'right' ? cw : 0, py0 = P.side === 'bottom' ? ch : 0;
    const divider = P.side === 'right' ? '<line x1="' + cw + '" y1="0" x2="' + cw + '" y2="' + CH + '"' : P.side === 'left' ? '<line x1="' + P.pw + '" y1="0" x2="' + P.pw + '" y2="' + CH + '"'
      : P.side === 'top' ? '<line x1="0" y1="' + P.ph + '" x2="' + CW + '" y2="' + P.ph + '"' : '<line x1="0" y1="' + ch + '" x2="' + CW + '" y2="' + ch + '"';
    bg = '<rect width="' + CW + '" height="' + CH + '" fill="' + P.color + '"/>';
    panelSvg = divider + ' stroke="#c9c9cf" stroke-width="2"/><g transform="translate(' + px0 + ',' + py0 + ')">' + P.svg + '</g>';
  }
  if (CW * CH > 120e6) throw new Error('결과 이미지가 너무 큽니다: ' + CW + 'x' + CH);
  const b64 = buf.toString('base64'), tr = 'translate(' + (ox - cx) + ',' + (oy - cy) + ')';
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="' + CW + '" height="' + CH + '" viewBox="0 0 ' + CW + ' ' + CH + '">' + bg +
    '<clipPath id="nlclip"><rect x="' + ox + '" y="' + oy + '" width="' + cw + '" height="' + ch + '"/></clipPath>' +
    '<g clip-path="url(#nlclip)"><g transform="' + tr + '"><image x="0" y="0" width="' + W + '" height="' + H + '" xlink:href="data:' + info.mime + ';base64,' + b64 + '"/></g></g>' +
    '<g transform="' + tr + '">' + out.join('') + '</g>' + panelSvg + '</svg>';
  return { svg, width: CW, height: CH, count: items.length, warnings };
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

module.exports = { annotate, buildSvg, imageInfo, wrapText, MAX_ITEMS };
