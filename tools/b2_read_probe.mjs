// W1-T03 / 트랙 B-2: 배포 서버에서 MYBOX를 "읽기만" 해서 닿는지 본다. 쓰기·삭제·이동 0.
// 필요: Node 18+ (fetch 내장, 추가 설치 없음). 서버 환경변수 MYBOX_ACCESS_TOKEN(사장님이 직접 넣은 값)을 쓴다. 이 스크립트는 토큰을 출력·저장하지 않는다.
// 사용: B2_FOLDER_ID=<허용 폴더 resourceId> node tools/b2_read_probe.mjs
//   B2_FILE_ID=<파일 resourceId>  (선택: 없으면 폴더 안에서 1MB 이하 파일 중 첫 번째를 고른다)
//   MYBOX_BASE_URL (시험용으로만 바꿈; 기본 https://open-api.mybox.naver.com/v1)
// 3단계: ① GET /drive/storage(용량 조회=관문일 뿐 채택 근거 아님) ② GET /drive/folders/{id}/resources(이름은 개수만 표시)
//        ③ 작은 파일 1개를 서명 주소로 두 번 내려받아 크기·sha256을 대조(서명 주소에는 토큰을 보내지 않음)
import crypto from 'node:crypto';
const BASE = process.env.MYBOX_BASE_URL || 'https://open-api.mybox.naver.com/v1';
const TOKEN = process.env.MYBOX_ACCESS_TOKEN || ''; const FOLDER = process.env.B2_FOLDER_ID || ''; const FILE = process.env.B2_FILE_ID || '';
const MAXB = 1024 * 1024;
if (!TOKEN) { console.log('중지: MYBOX_ACCESS_TOKEN이 서버 환경변수에 없습니다.'); process.exit(2); }
if (!FOLDER && !FILE) { console.log('중지: B2_FOLDER_ID(허용 폴더 resourceId)를 지정하세요. 루트를 열어 보지 않습니다.'); process.exit(2); }
let reads = 0;
const redact = (s) => String(s).split(TOKEN).join('[토큰]').slice(0, 300);
async function get(path, q) { // GET만 허용하는 유일한 관문
  const u = new URL(BASE + path); for (const [k, v] of Object.entries(q || {})) u.searchParams.set(k, v);
  const t0 = Date.now(); reads++;
  const r = await fetch(u, { method: 'GET', headers: { Authorization: 'Bearer ' + TOKEN, Accept: 'application/json' } });
  const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch {}
  return { status: r.status, ms: Date.now() - t0, json: j, text };
}
const res = { s1: '미실행', s2: '미실행', s3: '미실행' };
try {
  const a = await get('/drive/storage');
  console.log('① 용량 조회: HTTP ' + a.status + ' · ' + a.ms + 'ms · 항목 이름: ' + (a.json ? Object.keys(a.json).join(',') : '(JSON 아님: ' + redact(a.text.slice(0, 80)) + ')'));
  res.s1 = a.status === 200 ? '통과' : '불합격(HTTP ' + a.status + ')';
  let fid = FILE, fsize = null;
  if (FOLDER) {
    const b = await get('/drive/folders/' + encodeURIComponent(FOLDER) + '/resources', { count: '50' });
    const items = (b.json && (b.json.resources || b.json.items)) || [];
    console.log('② 폴더 목록: HTTP ' + b.status + ' · ' + b.ms + 'ms · 항목 ' + items.length + '개(이름은 표시하지 않음)');
    res.s2 = b.status === 200 ? '통과' : '불합격(HTTP ' + b.status + ')';
    if (!fid) { const f = items.find(x => !x.isFolder && x.resourceType !== 'FOLDER' && typeof x.size === 'number' && x.size > 0 && x.size <= MAXB); if (f) { fid = f.resourceId; fsize = f.size; } }
  }
  if (!fid) console.log('③ 내려받기: 1MB 이하 파일이 폴더에 없어 건너뜀 (B2_FILE_ID를 주면 됩니다)');
  else {
    if (fsize === null) { const m = await get('/drive/resources/' + encodeURIComponent(fid)); fsize = m.json && typeof m.json.size === 'number' ? m.json.size : null; }
    if (fsize !== null && fsize > MAXB) { console.log('③ 중지: 파일이 1MB를 넘어 시험하지 않음'); }
    else {
      const hashes = [];
      for (let i = 1; i <= 2; i++) {
        const t = await get('/drive/files/' + encodeURIComponent(fid) + '/download');
        if (!t.json || !t.json.downloadUrl) { console.log('③ 서명 주소 받기 실패: HTTP ' + t.status); break; }
        const t0 = Date.now(); const d = await fetch(t.json.downloadUrl); const buf = Buffer.from(await d.arrayBuffer()); // 서명 주소: 토큰을 보내지 않음
        hashes.push({ n: buf.length, h: crypto.createHash('sha256').update(buf).digest('hex'), ms: Date.now() - t0, st: d.status });
      }
      if (hashes.length === 2) {
        const same = hashes[0].h === hashes[1].h && hashes[0].n === hashes[1].n; const sizeOk = fsize === null ? null : hashes[0].n === fsize;
        console.log('③ 내려받기 2회: HTTP ' + hashes.map(x => x.st) + ' · ' + hashes.map(x => x.ms + 'ms') + ' · 크기 ' + hashes[0].n + 'B · 목록 크기와 ' + (sizeOk === null ? '대조 못 함' : sizeOk ? '일치' : '불일치') + ' · 두 번 sha256 ' + (same ? '일치' : '불일치') + ' · sha256 앞 12자 ' + hashes[0].h.slice(0, 12));
        res.s3 = same && sizeOk !== false && hashes.every(x => x.st === 200) ? '통과' : '불합격';
      } else res.s3 = '불합격(서명 주소 못 받음)';
    }
  }
} catch (e) { console.log('오류: ' + redact(e && e.message || e)); }
console.log('결과: ①' + res.s1 + ' ②' + res.s2 + ' ③' + res.s3 + ' · 읽기 호출 ' + reads + '회 · 쓰기 0 (이 스크립트에는 쓰기 코드가 없음)');
