'use strict';
// 창 지정 캡처(v1.5) 시험 — 임시 폴더에서만 돌고 끝나면 지운다. 실행: node test/window.js
// 실제 Windows 창 호출(capture.ps1 안의 PrintWindow 등)은 여기서 못 돌린다. 여기서 시험하는 것:
// 창 고르기 규칙, 실패 코드, 한글 제목, 로그에 제목이 없는지, .part 정리, 가짜 powershell 배선, 기존 모드 불변.
const fs = require('fs'), os = require('os'), path = require('path'), zlib = require('zlib');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mover-win-'));
const ROOT = path.join(base, 'root'); fs.mkdirSync(ROOT);
for (const d of ['agent', 'file-mover', '_trash']) fs.mkdirSync(path.join(ROOT, d));
process.env.MOVER_ALLOWED_DIRS = ROOT; process.env.MOVER_ENABLE_CAPTURE = '1';
const m = require('../server.js'), capture = require('../capture.js');
const cfg = m.makeConfig(), cfgOff = Object.assign({}, cfg, { captureEnabled: false });
const rows = []; const rec = (n, ok, d) => rows.push({ name: n, ok: !!ok, detail: String(d || '').replace(/\s+/g, ' ').slice(0, 160) });
const call = async (tool, args, c = cfg) => { const r = await m.handle({ id: 1, method: 'tools/call', params: { name: tool, arguments: args } }, c);
  const text = r.content[0].text; let json; try { json = JSON.parse(text); } catch {} return { err: !!r.isError, text, json }; };
const CRC = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc = b => { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const t = Buffer.from(type), l = Buffer.alloc(4), c = Buffer.alloc(4); l.writeUInt32BE(data.length); c.writeUInt32BE(crc(Buffer.concat([t, data]))); return Buffer.concat([l, t, data, c]); };
const makePng = (w, h) => { const raw = Buffer.alloc((w * 3 + 1) * h, 200); for (let y = 0; y < h; y++) raw[y * (w * 3 + 1)] = 0;
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]); };
const leftovers = d => { try { return fs.readdirSync(d).filter(f => f.endsWith('.part')); } catch { return []; } };
const W = (o) => Object.assign({ hwnd: '100', title: 't', process: 'whale', pid: 1, x: 0, y: 0, w: 1000, h: 800, minimized: false, cloaked: false, owned: false, foreground: false, z: 1 }, o);
const thrown = (f) => { try { f(); } catch (e) { return e; } return null; };

(async () => {
  // ---------- 창 고르기 규칙 ----------
  const list = [W({ hwnd: '1', title: '도안관리 - 웨일', process: 'whale', w: 1200, h: 900, z: 1 }),
    W({ hwnd: '2', title: 'Figma - 웨일', process: 'whale', w: 800, h: 600, z: 2 }),
    W({ hwnd: '3', title: '메모장', process: 'notepad', w: 500, h: 400, minimized: true, z: 3 }),
    W({ hwnd: '4', title: '도안관리 - 웨일 (다른 데스크톱)', process: 'whale', cloaked: true, z: 4 }),
    W({ hwnd: '5', title: 'Claude', process: 'claude', cloaked: true, z: 5 })];
  let r = capture.planWindow(list, { title: '도안관리' });
  rec('고르기: 제목 일부로 하나 → 선택(숨은 데스크톱 창은 보이는 쪽 우선 제외)', r.win.hwnd === '1' && r.matched === 1, JSON.stringify(r.win.hwnd));
  r = capture.planWindow(list, { title: 'FIGMA' });
  rec('고르기: 대소문자 무시', r.win.hwnd === '2', r.win.hwnd);
  r = capture.planWindow(list, { process: 'Whale.exe', index: 2 });
  rec('고르기: process는 .exe·대소문자 무시, index로 둘째', r.win.hwnd === '2', r.win.hwnd);
  r = capture.planWindow(list, { process: 'whale', pick: 'largest' });
  rec('고르기: pick largest', r.win.hwnd === '1', r.win.hwnd);
  r = capture.planWindow(list, { process: 'whale', pick: 'topmost' });
  rec('고르기: pick topmost = 목록 맨 앞', r.win.hwnd === '1', r.win.hwnd);
  r = capture.planWindow(list, { title: '웨일', match: 'exact', index: 1 }.title ? { title: 'Figma - 웨일', match: 'exact' } : {});
  rec('고르기: match exact', r.win.hwnd === '2', r.win.hwnd);
  let e = thrown(() => capture.planWindow(list, { title: '웨일' }));
  rec('실패: 여러 개 → window_ambiguous + 후보(번호·제목·크기)', e && e.code === 'window_ambiguous' && e.candidates.length === 2 && /1\) whale/.test(e.message) && /도안관리/.test(e.message), e && e.message);
  e = thrown(() => capture.planWindow(list, { title: '없는창' }));
  rec('실패: 못 찾음 → window_not_found, 제목 목록을 싣지 않음', e && e.code === 'window_not_found' && !/도안관리|Figma/.test(e.message), e && e.message);
  e = thrown(() => capture.planWindow(list, { process: 'whale', index: 5 }));
  rec('실패: index가 범위 밖 → window_not_found', e && e.code === 'window_not_found', e && e.message);
  e = thrown(() => capture.planWindow(list, { title: '메모장' }));
  rec('실패: 최소화 → window_minimized (restore 안내)', e && e.code === 'window_minimized' && /restore/.test(e.message), e && e.message);
  r = capture.planWindow(list, { title: '메모장', restore: true });
  rec('최소화 + restore:true → 선택됨', r.win.hwnd === '3', r.win.hwnd);
  e = thrown(() => capture.planWindow(list, { process: 'claude' }));
  rec('실패: 다른 가상 데스크톱만 있음 → window_cloaked', e && e.code === 'window_cloaked', e && e.message);
  for (const [n, spec] of [['빈 조건', {}], ['공백 제목', { title: '  ' }], ['배열', []], ['match 오타', { title: 'a', match: 'regex' }], ['index 0', { title: 'a', index: 0 }],
    ['pick 오타', { title: 'a', pick: 'x' }], ['method 오타', { title: 'a', method: 'gdi' }], ['restore 문자열', { title: 'a', restore: 'yes' }], ['settle 범위', { title: 'a', settle_ms: 99999 }]]) {
    e = thrown(() => capture.checkWindowSpec(spec)); rec('입력 검사: ' + n + ' 거절', e && e.code === 'window_spec', e && e.message); }
  const long = [W({ title: '가'.repeat(200) }), W({ title: '나'.repeat(200), hwnd: '9' })];
  e = thrown(() => capture.planWindow(long, { process: 'whale' }));
  rec('후보 제목은 80자로 자름(이모지도 안 깨짐)', e && e.candidates.every(c => Array.from(c.title).length <= 80), '');
  rec('영역: window 안 region 없으면 {}', JSON.stringify(capture.planWindowRegion(undefined)) === '{}', '');
  const re = capture.planWindowRegion({ x: 0, y: 0, w: 0.5, h: 0.5 });
  rec('영역: 기본 단위 ratio, 문자열 환경변수', re.CAP_RUNITS === 'ratio' && re.CAP_RW === '0.5', JSON.stringify(re));
  rec('영역: px 단위', capture.planWindowRegion({ x: 1, y: 2, w: 3, h: 4, units: 'px' }).CAP_RUNITS === 'px', '');
  rec('영역: w 0 이하 거절', !!thrown(() => capture.planWindowRegion({ x: 0, y: 0, w: 0, h: 1 })), '');
  rec('영역: 숫자 아님 거절', !!thrown(() => capture.planWindowRegion({ x: 'a', y: 0, w: 1, h: 1 })), '');

  // ---------- 가짜 powershell 로 도구 전체 ----------
  const fake = path.join(base, 'fake-ps.js');
  fs.writeFileSync(fake, '#!/usr/bin/env node\n' + [
    "const fs=require('fs');",
    "fs.appendFileSync(process.env.FAKE_LOG,JSON.stringify({mode:process.env.CAP_MODE,env:Object.fromEntries(Object.entries(process.env).filter(([k])=>k.startsWith('CAP_')))})+'\\n');",
    "const mode=process.env.CAP_MODE,f=process.env.FAKE||'';",
    "if(mode==='info'){console.log(process.env.FAKE_INFO);}",
    "else if(mode==='win_list'){console.log(process.env.FAKE_WINS);}",
    "else if(mode==='win_shot'){",
    " if(f.startsWith('code:')){fs.writeFileSync(process.env.CAP_OUT,'partial');console.log(JSON.stringify({ok:false,code:f.slice(5),message:'fake '+f}));return;}",
    " if(f==='notpng'){fs.writeFileSync(process.env.CAP_OUT,'x');console.log('{\"ok\":true,\"method\":\"print\"}');return;}",
    " fs.copyFileSync(process.env.FAKE_PNG,process.env.CAP_OUT);",
    " console.log(JSON.stringify({ok:true,method:process.env.FAKE_METHOD||'print',fallback:false,area_w:640,area_h:360,region:{x:0,y:0,w:640,h:360},occluded_ratio:null,restored:process.env.CAP_RESTORE==='1',activated:false,warnings:process.env.FAKE_WARN?[process.env.FAKE_WARN]:[]}));}",
    "else if(mode==='shot'){fs.copyFileSync(process.env.FAKE_PNG,process.env.CAP_OUT);console.log('{\"ok\":true}');}"
  ].join('\n') + '\n'); fs.chmodSync(fake, 0o755);
  const png = path.join(base, 'w.png'); fs.writeFileSync(png, makePng(640, 360));
  const log = path.join(base, 'fake.log');
  const wins = [W({ hwnd: '77', title: '도안관리 — 웨일 🙂', process: 'whale', pid: 4242, w: 640, h: 360 }), W({ hwnd: '78', title: '메모장', process: 'notepad', minimized: true, w: 300, h: 200 })];
  const info = { virtual: { x: 0, y: 0, w: 1920, h: 1080 }, displays: [{ index: 1, x: 0, y: 0, w: 1920, h: 1080, primary: true }] };
  Object.assign(process.env, { MOVER_POWERSHELL: fake, FAKE_LOG: log, FAKE_PNG: png, FAKE_WINS: JSON.stringify({ windows: wins }), FAKE_INFO: JSON.stringify(info) });
  const calls = () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  const dir = path.join(ROOT, 'capture');

  let x = await call('capture_screen', { window: { title: '도안관리' } });
  const shot = calls().find(c => c.mode === 'win_shot');
  rec('도구: 한글·이모지 제목 창 캡처 성공, PNG 저장', !x.err && x.json && fs.existsSync(x.json.saved_path) && x.json.width === 640 && x.json.height === 360, x.text.slice(0, 100));
  rec('도구: 파일 이름에 프로그램 이름', /window_whale_/.test(path.basename(x.json.saved_path)), x.json.saved_path);
  rec('도구: 결과에 창 정보·방법·경고 목록', x.json.window.process === 'whale' && x.json.window.pid === 4242 && x.json.method_used === 'print' && Array.isArray(x.json.warnings), JSON.stringify(x.json.window));
  rec('도구: hwnd·기본값(auto, restore 0, 되돌림 1)이 PowerShell로 감', shot.env.CAP_HWND === '77' && shot.env.CAP_METHOD === 'auto' && shot.env.CAP_RESTORE === '0' && shot.env.CAP_BACK === '1' && shot.env.CAP_ACTIVATE === '0', JSON.stringify(shot.env));
  const logLine = fs.readFileSync(path.join(dir, 'capture_log.jsonl'), 'utf8');
  rec('로그에는 프로그램 이름만, 창 제목은 없음', /"window_process":"whale"/.test(logLine) && !/도안관리/.test(logLine), logLine.trim());
  rec('결과 .part 찌꺼기 없음', leftovers(dir).length === 0, '');

  x = await call('capture_screen', { window: { title: '메모장', restore: true, restore_back: false, activate: true, client_only: true, method: 'screen', settle_ms: 100 }, filename: 'memo.png', region: { x: 0, y: 0, w: 0.5, h: 0.5 } });
  const s2 = calls().filter(c => c.mode === 'win_shot').pop();
  rec('도구: 옵션 전달(restore/activate/client/method/settle/region)', !x.err && s2.env.CAP_RESTORE === '1' && s2.env.CAP_BACK === '0' && s2.env.CAP_ACTIVATE === '1' && s2.env.CAP_CLIENT === '1' && s2.env.CAP_METHOD === 'screen' && s2.env.CAP_SETTLE === '100' && s2.env.CAP_RW === '0.5' && s2.env.CAP_RUNITS === 'ratio', JSON.stringify(s2.env));
  rec('도구: filename 적용', path.basename(x.json.saved_path) === 'memo.png', x.json.saved_path);

  const before = calls().length;
  x = await call('capture_screen', { window: { title: '메모장' } });
  rec('도구: 최소화 + restore 없음 → [window_minimized], PowerShell 촬영 호출 없음', x.err && /\[window_minimized\]/.test(x.text) && calls().length === before + 1 && calls().pop().mode === 'win_list', x.text.slice(0, 90));
  x = await call('capture_screen', { window: { title: '없음' } });
  rec('도구: 못 찾음 → [window_not_found], 파일 안 생김', x.err && /\[window_not_found\]/.test(x.text) && leftovers(dir).length === 0, x.text.slice(0, 90));
  x = await call('capture_screen', { window: { process: 'whale' }, display: 1 });
  rec('도구: window + display 함께 → 거절', x.err && /window_spec/.test(x.text), x.text.slice(0, 90));
  x = await call('capture_screen', { window: { title: 'x' } }, cfgOff);
  rec('도구: 캡처 꺼짐이면 창 캡처도 거절', x.err && /MOVER_ENABLE_CAPTURE/.test(x.text), x.text.slice(0, 60));
  x = await call('capture_screen', { window: { title: '도안관리' }, dest_dir: path.join(base, 'outside') });
  rec('경로 안전: 허용 폴더 밖 dest_dir 거절', x.err && !fs.existsSync(path.join(base, 'outside')), x.text.slice(0, 80));
  x = await call('capture_screen', { window: { title: '도안관리' }, dest_dir: path.join(ROOT, 'agent') });
  rec('경로 안전: agent 폴더 거절', x.err, x.text.slice(0, 80));
  x = await call('capture_screen', { window: { title: '도안관리' }, filename: '../../evil.png' });
  rec('경로 안전: filename의 ../ 는 이름만 남김', !x.err && path.dirname(x.json.saved_path) === dir, x.json && x.json.saved_path);

  for (const code of ['window_blank', 'window_empty', 'window_gone', 'window_minimized', 'region_outside']) {
    process.env.FAKE = 'code:' + code; const b = calls().length;
    x = await call('capture_screen', { window: { title: '도안관리' } });
    rec('PowerShell 실패 ' + code + ' → [코드] 오류 + .part 정리', x.err && x.text.includes('[' + code + ']') && leftovers(dir).length === 0, x.text.slice(0, 80));
  }
  process.env.FAKE = 'notpng';
  x = await call('capture_screen', { window: { title: '도안관리' } });
  rec('PNG가 아니면 거절 + .part 정리', x.err && leftovers(dir).length === 0, x.text.slice(0, 80));
  delete process.env.FAKE;

  process.env.FAKE_WARN = 'occluded'; process.env.FAKE_METHOD = 'screen';
  x = await call('capture_screen', { window: { process: 'whale' } });
  rec('경고 전달: occluded', !x.err && x.json.warnings.includes('occluded') && x.json.method_used === 'screen', JSON.stringify(x.json.warnings));
  delete process.env.FAKE_WARN; delete process.env.FAKE_METHOD;
  process.env.FAKE_WINS = JSON.stringify({ windows: [W({ hwnd: '1', title: 'A', w: 100, h: 100 }), W({ hwnd: '2', title: 'A2', w: 200, h: 200 })] });
  x = await call('capture_screen', { window: { process: 'whale' } });
  rec('여러 개 → [window_ambiguous] + 후보, 파일 안 생김', x.err && /\[window_ambiguous\]/.test(x.text) && /2\) whale/.test(x.text), x.text.slice(0, 120));
  x = await call('capture_screen', { window: { process: 'whale', pick: 'largest' } });
  rec('여러 개 + pick largest → 성공, 경고에 matched_2_windows', !x.err && x.json.warnings.includes('matched_2_windows') && calls().pop().env.CAP_HWND === '2', JSON.stringify(x.json && x.json.warnings));
  process.env.FAKE_WINS = JSON.stringify({ windows: [W({ hwnd: '1', title: 'A' })] });   // PowerShell이 목록 1개를 배열로 안 감싸도
  x = await call('capture_screen', { window: { title: 'A' } });
  rec('목록 1개를 객체로 줘도 처리', !x.err, x.text.slice(0, 80));
  process.env.FAKE_WINS = JSON.stringify({ windows: wins });

  // ---------- 창 목록 (info_only + windows) ----------
  x = await call('capture_screen', { info_only: true });
  rec('목록: windows 없이 info_only 는 창 제목을 내지 않음(기존 동작)', !x.err && x.json.windows === undefined && !/도안관리/.test(x.text), Object.keys(x.json || {}).join(','));
  x = await call('capture_screen', { info_only: true, windows: true });
  rec('목록: windows:true → 번호·제목·프로그램·크기·최소화', !x.err && x.json.windows.length === 2 && x.json.windows[0].title.includes('도안관리') && x.json.windows[1].minimized === true && x.json.windows[0].hwnd === undefined, JSON.stringify(x.json.windows[0]));
  rec('목록: 모니터 정보도 함께', x.json.displays.length === 1, '');
  x = await call('capture_screen', { info_only: true, windows: true }, cfgOff);
  rec('목록: 캡처 꺼짐이면 거절', x.err, x.text.slice(0, 50));
  x = await call('capture_screen', { windows: 'yes', info_only: true });
  rec('목록: windows가 true/false 아니면 거절', x.err, x.text.slice(0, 60));

  // ---------- 기존 모드 불변 ----------
  x = await call('capture_screen', { display: 1, region: { x: 0, y: 0, w: 0.5, h: 0.5 }, filename: 'old.png' });
  const oldShot = calls().filter(c => c.mode === 'shot').pop();
  fs.copyFileSync(png, png);
  rec('기존: display 캡처는 그대로 shot 모드 호출', !!oldShot && oldShot.env.CAP_W === '960' && oldShot.env.CAP_H === '540', JSON.stringify(oldShot && oldShot.env));

  // ---------- 도구 목록·스크립트 ----------
  const tl = (await m.handle({ id: 1, method: 'tools/list' }, cfg)).tools;
  const cs = tl.find(t => t.name === 'capture_screen');
  rec('도구 목록: 7개 그대로, capture_screen 스키마에 window/windows', tl.length === 7 && cs.inputSchema.properties.window && cs.inputSchema.properties.windows && /window_ambiguous/.test(cs.description), tl.length);
  const init = await m.handle({ id: 1, method: 'initialize', params: {} }, cfg);
  rec('버전 1.5.0', init.serverInfo.version === '1.5.0', init.serverInfo.version);
  const ps = fs.readFileSync(capture.SCRIPT_PATH, 'utf8');
  rec('capture.ps1: 네 모드가 모두 있음', ['info', 'shot', 'win_list', 'win_shot'].every(k => ps.includes("CAP_MODE -eq '" + k + "'")), '');
  rec('capture.ps1: UTF-8 출력 설정은 창 모드 한정', /isWinMode/.test(ps) && /OutputEncoding/.test(ps), '');

  fs.rmSync(base, { recursive: true, force: true });
  const bad = rows.filter(r => !r.ok);
  for (const r of rows) console.log((r.ok ? 'PASS ' : 'FAIL ') + r.name + (r.ok ? '' : '  → ' + r.detail));
  console.log('\n' + (rows.length - bad.length) + '/' + rows.length + ' 통과');
  process.exit(bad.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
