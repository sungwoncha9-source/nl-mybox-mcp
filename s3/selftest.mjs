// S3 컨테이너 안에서 도는 자체 시험: 기준 번들(w1/deploy-b1)과 수정 번들을 같은 가짜 MYBOX로 비교한다. 합성 데이터만.
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import crypto from 'node:crypto'; import { spawn } from 'node:child_process';
const hwm = pid => { try { const m = /VmHWM:\s+(\d+) kB/.exec(fs.readFileSync('/proc/' + pid + '/status', 'utf8')); return m ? Math.round(+m[1] / 1024 * 10) / 10 : null; } catch { return null; } };   // 자식 프로세스 최고 메모리(관측값)
const ALL6 = 'job_put_chunk,job_status,dms_list,files_copy,files_move,files_create_folder';
export async function runSelfTest({ fakePort, bundles, tmp, log, childEnv, guardEnv }) {
  const FAKE = 'http://127.0.0.1:' + fakePort; const BASE = FAKE + '/v1';
  const ctl = (p, b) => new Promise((res, rej) => { const d = Buffer.from(JSON.stringify(b || {})); const r = http.request({ host: '127.0.0.1', port: fakePort, path: '/__ctl/' + p, method: 'POST', headers: { 'content-length': d.length } }, x => { let s = ''; x.on('data', c => s += c); x.on('end', () => res(JSON.parse(s))); }); r.on('error', rej); r.end(d); });
  const stats = () => ctl('stats');
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  let seq = 0;
  async function start(file, jobsDir, TOKEN) {
    const env = childEnv(process.env, BASE, { NL_HTTP_TOKEN: TOKEN, NL_HTTP_PORT: '0', NL_JOBS_DIR: jobsDir, NL_JOB_ALLOWED_PARENTS: 'tree:ALLOW', NL_HTTP_TOOLS: ALL6 });
    const p = spawn('node', [file], { env }); let err = '';
    const port = await new Promise((res, rej) => { p.stderr.on('data', d => { err += d; const m = err.match(/listening on http:\/\/[^:]+:(\d+)\/mcp/); if (m) res(+m[1]); }); p.on('exit', c => rej(new Error('child exit ' + c + ' ' + err.slice(0, 400)))); setTimeout(() => rej(new Error('child start timeout ' + err.slice(0, 400))), 20000); });
    return { p, port };
  }
  const req = (port, TOKEN, method, pth, body) => new Promise(resolve => { const d = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const r = http.request({ host: '127.0.0.1', port, path: pth, method, headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json', ...(d ? { 'content-length': d.length } : {}) } }, x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch {} resolve({ status: x.statusCode, json: j, text: s.slice(0, 300) }); }); });
    r.on('error', e => resolve({ status: 0, text: String(e) })); if (d) r.write(d); r.end(); });
  const buf = crypto.randomBytes(2000); const sha = crypto.createHash('sha256').update(buf).digest('hex');
  const job = (id, pid) => ({ job_id: id, files: [{ name: 'r.png', size: buf.length, sha256: sha }], file_name: 'r.png', offset: 0, content_base64: buf.toString('base64'), parent_id: pid, wait_ms: 8000 });
  const out = {};
  for (const [name, file] of Object.entries(bundles)) {
    const R = {}; const TOKEN = crypto.randomBytes(24).toString('hex'); const JOBS = fs.mkdtempSync(path.join(tmp, name + '-'));
    let S = await start(file, JOBS, TOKEN); const q = (m, p, b) => req(S.port, TOKEN, m, p, b); const id = () => 'j' + (++seq) + crypto.randomUUID().slice(0, 4);
    try {
      await ctl('reset');
      // C1 OK_UNTIL: 폴더 만들기 통과 → 폴더를 허용 밖으로 이동 → 같은 요청
      let a = await q('POST', '/api/v1/folders', { folderName: 'a', parentId: 'SUB' }); let s0 = await stats(); await ctl('move', { id: 'SUB', parent: 'OUT' });
      let b = await q('POST', '/api/v1/folders', { folderName: 'b', parentId: 'SUB' }); let s1 = await stats();
      R.c1_move_out_then_create = { first: a.status, afterMove: b.status, mybox_writes_after_move: s1.posts - s0.posts, pass: a.status === 200 && b.status === 403 && s1.posts === s0.posts, expect: 'afterMove=403, writes=0' };
      // C2 거절 → 허용 안으로 이동
      await ctl('reset'); a = await q('POST', '/api/v1/jobs/chunk', job(id(), 'MOVER')); await ctl('move', { id: 'MOVER', parent: 'ALLOW' }); b = await q('POST', '/api/v1/jobs/chunk', job(id(), 'MOVER'));
      R.c2_deny_then_allow = { first: a.status, afterMove: b.status, state: b.json && b.json.state, pass: a.status === 403 && b.status === 200, expect: 'first=403, afterMove=200' };
      // C3 허용 → 밖으로 이동
      await ctl('reset'); a = await q('POST', '/api/v1/jobs/chunk', job(id(), 'SUB')); await ctl('move', { id: 'SUB', parent: 'OUT' }); s0 = await stats(); b = await q('POST', '/api/v1/jobs/chunk', job(id(), 'SUB')); s1 = await stats();
      R.c3_allow_then_move_out = { first: a.status, firstState: a.json && a.json.state, afterMove: b.status, uploads_after_move: s1.uploads - s0.uploads, pass: a.status === 200 && b.status === 403 && s1.uploads === s0.uploads, expect: 'afterMove=403, uploads=0' };
      // C4 접수 뒤 올리기 전 이동 경쟁
      await ctl('reset'); await ctl('arm', { id: 'SUB', parent: 'OUT', after: 1 }); const jid = id(); a = await q('POST', '/api/v1/jobs/chunk', job(jid, 'SUB'));
      for (let i = 0; i < 20 && !(a.json && /done|failed/.test(a.json.state || '')); i++) { await sleep(500); a = await q('GET', '/api/v1/jobs/' + jid); }
      s1 = await stats(); const c4state = a.json && a.json.state; const c4resolved = /^(done|failed)$/.test(c4state || '');
      R.c4_race_after_accept = { state: c4state, resolved: c4resolved, uploads: s1.uploads, tree_SUB: s1.tree.SUB, pass: c4resolved && c4state === 'failed' && s1.uploads === 0, expect: 'state=failed(끝까지 처리됨), uploads=0' };
      // P1 비용: 일감 한 건당 가짜 MYBOX 폴더 조회 수, 시간
      await ctl('reset'); const cost = {};
      for (const [k, pid] of [['depth2_SUB', 'SUB'], ['depth6_D5', 'D5']]) { s0 = await stats(); const t0 = Date.now(); const r = await q('POST', '/api/v1/jobs/chunk', job(id(), pid)); const ms = Date.now() - t0; s1 = await stats(); cost[k] = { status: r.status, state: r.json && r.json.state, resource_reads: s1.resGets - s0.resGets, ms }; }
      R.p1_cost_per_job = { ...cost, pass: null, expect: '관측값(합격 기준 없음, 호출 한도 영향은 실제 환경에서 별도)' };
      // R1 재시작: 끝난 일감 기록이 재시작 뒤에도 읽히는가, 새 일감이 되는가
      await ctl('reset'); const rid = id(); a = await q('POST', '/api/v1/jobs/chunk', job(rid, 'SUB')); S.p.kill(); await sleep(500); S = await start(file, JOBS, TOKEN); b = await q('GET', '/api/v1/jobs/' + rid); const c = await q('POST', '/api/v1/jobs/chunk', job(id(), 'SUB'));
      R.r1_restart = { before: a.json && a.json.state, status_after_restart: b.status, state_after_restart: b.json && b.json.state, new_job_after_restart: c.json && c.json.state, pass: null, expect: '관측값' };
    } catch (e) { R.error = String(e && e.stack || e).slice(0, 800); }
    finally { R.child_vmhwm_mb = hwm(S.p.pid); try { S.p.kill(); } catch {} }
    out[name] = R; log('SELFTEST ' + name + ' ' + JSON.stringify(R));
  }
  out.guard = { refuses_real_token: guardEnv({ MYBOX_ACCESS_TOKEN: 'x' }).length > 0, refuses_base_url: guardEnv({ MYBOX_BASE_URL: 'https://open-api.mybox.naver.com/v1' }).length > 0, refuses_oauth_copy: guardEnv({ NL_OAUTH_ISSUER: 'x' }).length > 0, clean_env_ok: guardEnv({}).length === 0 };
  try { childEnv({}, 'https://open-api.mybox.naver.com/v1', {}); out.guard.nonloopback_throws = false; } catch { out.guard.nonloopback_throws = true; }
  log('SELFTEST guard ' + JSON.stringify(out.guard));
  return out;
}

// 전체 판정(9판, 8차 검증 반영): 항목에 기록된 pass 표시는 믿지 않고 원자료(HTTP 상태·쓰기/업로드 수·일감 상태)로 다시 판정한다.
// 1) 수정 번들(fixed) c1~c4 의 원자료가 「결함 없음」 모양, 2) 기준 번들(baseline) c1~c4 의 원자료가 「알려진 결함」 모양 그대로
//    (그냥 실패가 아니라 결함이 재현된 모양이어야 대조가 성립: HTTP 0·오류로 실패한 것은 대조가 아님),
// 3) 기록된 pass 표시가 원자료 판정과 다르면 기록기 고장으로 보고 불합격, 4) 시험 도중 오류 없음, 5) p1·r1 관측 정상, 6) 시작 가드 다섯 항목.
export const CHECKS = ['c1_move_out_then_create', 'c2_deny_then_allow', 'c3_allow_then_move_out', 'c4_race_after_accept'];
const isInt = v => Number.isInteger(v);
// 수정본이 가져야 할 원자료 모양(결함 없음)
export const FIXED_SIG = {
  c1_move_out_then_create: c => c.first === 200 && c.afterMove === 403 && c.mybox_writes_after_move === 0,
  c2_deny_then_allow: c => c.first === 403 && c.afterMove === 200,
  c3_allow_then_move_out: c => c.first === 200 && c.afterMove === 403 && c.uploads_after_move === 0,
  c4_race_after_accept: c => c.resolved === true && c.state === 'failed' && c.uploads === 0,
};
// 기준본(w1/deploy-b1)이 보여야 할 원자료 모양(알려진 결함이 재현됨)
export const BASE_SIG = {
  c1_move_out_then_create: c => c.first === 200 && c.afterMove === 200 && isInt(c.mybox_writes_after_move) && c.mybox_writes_after_move >= 1,   // OK_UNTIL: 옮긴 뒤에도 통과·쓰기 생김
  c2_deny_then_allow: c => c.first === 403 && c.afterMove === 403,   // ALLOW_CACHE: 거절이 고착
  c3_allow_then_move_out: c => c.first === 200 && c.afterMove === 200 && isInt(c.uploads_after_move) && c.uploads_after_move >= 1,   // ALLOW_CACHE: 통과가 고착·업로드 생김
  c4_race_after_accept: c => c.resolved === true && c.state === 'done' && isInt(c.uploads) && c.uploads >= 1,   // 재확인 없음: 옮겨진 폴더로 올라감
};
export function judge(out) {
  const why = []; const o = out || {};
  const fx = o.fixed, bl = o.baseline;
  const side = (name, R, sig, expectPass) => {
    if (!R) { why.push(name + ' 결과 없음'); return; }
    if (R.error) why.push(name + ' 시험 도중 오류: ' + String(R.error).split('\n')[0]);
    for (const k of CHECKS) {
      const c = R[k];
      if (!c || typeof c !== 'object') { why.push(name + ' ' + k + ' 결과 없음'); continue; }
      const raw = !!sig[k](c);
      if (!raw) why.push(name + ' ' + k + ' 원자료가 기대 모양이 아님(' + (expectPass ? '결함 없음' : '알려진 결함 재현') + '): ' + JSON.stringify(c));
      const shouldPass = expectPass ? raw : !raw;   // 원자료로 본 이 항목의 합격 여부(기준본은 결함이 재현되면 pass=false 가 맞음)
      if (raw && c.pass !== shouldPass) why.push(name + ' ' + k + ' 기록된 pass(' + c.pass + ')가 원자료 판정과 다름(기록기 고장)');
    }
  };
  side('fixed', fx, FIXED_SIG, true);
  side('baseline', bl, BASE_SIG, false);
  if (fx) {
    // P1(7차 NV7-02): 깊이마다 HTTP 200 + done + ms 유한 0 이상 + 조회 1 이상 정수. 상한은 합의 기준이 없어 두지 않음.
    const p = fx.p1_cost_per_job;
    const p1ok = c => !!c && c.status === 200 && c.state === 'done' && Number.isFinite(c.ms) && c.ms >= 0 && isInt(c.resource_reads) && c.resource_reads >= 1;
    if (!p) why.push('fixed p1 관측 누락');
    else for (const k of ['depth2_SUB', 'depth6_D5']) if (!p1ok(p[k])) why.push('fixed p1 ' + k + ' 관측 비정상: ' + JSON.stringify(p[k] === undefined ? null : p[k]));
    // R1(7차 NV7-01): 재시작 전 done, 재시작 뒤 기존 기록 200·done, 새 일감 done.
    const r = fx.r1_restart;
    if (!r) why.push('fixed r1 재시작 관측 누락');
    else {
      if (r.before !== 'done') why.push('fixed r1 재시작 전 일감이 done 아님: ' + r.before);
      if (r.status_after_restart !== 200 || r.state_after_restart !== 'done') why.push('fixed r1 재시작 뒤 기존 기록 보존 안 됨: ' + r.status_after_restart + '/' + r.state_after_restart);
      if (r.new_job_after_restart !== 'done') why.push('fixed r1 재시작 뒤 새 일감이 done 아님: ' + r.new_job_after_restart);
    }
  }
  const g = o.guard; const want = { refuses_real_token: true, refuses_base_url: true, refuses_oauth_copy: true, clean_env_ok: true, nonloopback_throws: true };
  if (!g) why.push('guard 결과 없음'); else for (const [k, v] of Object.entries(want)) if (g[k] !== v) why.push('guard ' + k + ' 기대 ' + v + ' 실제 ' + g[k]);
  return { verdict: why.length ? 'FAIL' : 'PASS', reasons: why };
}
