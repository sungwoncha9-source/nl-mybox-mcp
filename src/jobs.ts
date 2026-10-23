// 일감(job) — 화면이 한 클릭 안에서 조각을 순서 없이·동시에 보내면 PC가 모아서 MYBOX까지 마무리한다.
// 설계 근거(2026-10-23, R1 시험): 앱 안 host 호출은 클릭 직후 약 4초 안에 "시작"만 하면 되고(응답은 길어도 됨),
// 동시에 날릴 수 있는 호출은 8개 안팎이다. 그래서 (1) 조각은 도착 순서와 상관없이 받고 (2) 마지막 조각이 들어오면
// PC 쪽이 스스로 올리기·크기 대조·정리를 한다. 토큰은 여기서 다루지 않는다(올리기는 index.ts의 기존 코드를 받아서 부른다).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export type FileSpec = { name: string; size: number; sha256: string };
export type JobOpts = { parentId?: string; subfolder?: string; isOverwrite?: boolean; dryRun?: boolean; cleanup?: 'trash' | 'keep' };
export interface Uploader {
  upload(filePath: string, parentId: string | undefined, isOverwrite: boolean): Promise<void>;
  /** 올린 파일이 MYBOX 폴더에 있고 크기가 같은지 읽어서 본다(읽기만) */
  verify(name: string, size: number, parentId: string | undefined): Promise<{ found: boolean; size?: number }>;
  /** 1.8.0: parentId 아래에 새 폴더를 만들고 그 폴더 ID를 돌려준다. 같은 이름이 이미 있으면 만들지 않고 오류를 던진다 */
  createFolder(name: string, parentId: string): Promise<string>;
}
type FileState = {
  size: number; sha256: string; ranges: Array<[number, number]>; done: boolean;
  uploaded?: boolean; verified?: boolean; error?: string;
};
export type JobState = {
  job_id: string; created: string; updated: string;
  state: 'receiving' | 'finalizing' | 'done' | 'dry_run_done' | 'failed';
  spec: { files: FileSpec[]; opts: JobOpts };
  files: Record<string, FileState>;
  error?: string; staged_dir?: string; folder_id?: string;
};

export const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const NAME_BAD = /[\\/:*?"<>|\u0000-\u001f]/;
const B64 = /^[A-Za-z0-9+/]*={0,2}$/;
export const LIMITS = { maxChunk: 1024 * 1024, maxFile: 200 * 1024 * 1024, maxJob: 600 * 1024 * 1024, maxFiles: 40 };

export function jobsRoot(): string {
  return process.env.NL_JOBS_DIR || 'D:\\nodelab_work\\_jobs';
}

function checkName(n: string) {
  if (typeof n !== 'string' || !n.trim() || n.length > 150 || NAME_BAD.test(n) || n === '.' || n === '..' || n.startsWith('.')
    || /\.part$/i.test(n) || /^(state|job)\.json$/i.test(n)) throw new Error('쓸 수 없는 파일 이름입니다: ' + n);
}
const resultPath = (id: string) => path.join(jobsRoot(), '_results', id + '.json');
const stagePath = (id: string) => path.join(jobsRoot(), id);
const mem = new Map<string, JobState>();
/** 이 프로세스에서 마무리 중인 일감(기다리는 호출이 같은 약속을 함께 기다린다) */
const running = new Map<string, Promise<void>>();
export const WAIT_MAX_MS = 120000;
const FINAL = new Set(['done', 'dry_run_done', 'failed']);

function save(st: JobState) {
  st.updated = new Date().toISOString();
  fs.mkdirSync(path.dirname(resultPath(st.job_id)), { recursive: true });
  const tmp = resultPath(st.job_id) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(st, null, 1));
  fs.renameSync(tmp, resultPath(st.job_id));
}
function load(id: string): JobState | null {
  const hit = mem.get(id);
  if (hit) return hit;
  try {
    const st = JSON.parse(fs.readFileSync(resultPath(id), 'utf8')) as JobState;
    mem.set(id, st);
    return st;
  } catch { return null; }
}

/** 멈춘 일감 정리. 마지막 활동(updated) 뒤 NL_JOB_IDLE_SEC초(기본 1800)가 지난 일감:
 *  receiving이면 작업 폴더를 _trash로 옮기고 failed(timeout)로 표시, finalizing이면 사본은 남기고 failed(interrupted)로 표시한다. */
export function idleSeconds(): number {
  const n = Number(process.env.NL_JOB_IDLE_SEC);
  return Number.isFinite(n) && n > 0 ? n : 1800;
}
export function sweepStale(now = Date.now()) {
  const dir = path.join(jobsRoot(), '_results');
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return; }
  const limit = idleSeconds() * 1000;
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    try {
      const id = n.slice(0, -5);
      if (!ID_RE.test(id)) continue;
      if (now - fs.statSync(path.join(dir, n)).mtimeMs < limit) continue;   // 파일이 최근이면 읽지 않는다
      const st = load(id);
      if (!st || now - Date.parse(st.updated) < limit) continue;
      if (st.state === 'receiving') {
        const from = stagePath(id);
        if (fs.existsSync(from)) {
          const trash = path.join(jobsRoot(), '_trash');
          fs.mkdirSync(trash, { recursive: true });
          const to = path.join(trash, id + '_expired_' + now);
          fs.renameSync(from, to); st.staged_dir = to;
        }
        st.state = 'failed';
        st.error = 'timeout: ' + Math.round(idleSeconds()) + '초 넘게 조각이 오지 않아 멈춘 일감입니다. PC 사본은 _trash로 옮겼습니다. 새 job_id로 처음부터 다시 보내세요';
        save(st);
      } else if (st.state === 'finalizing') {
        st.state = 'failed';
        st.error = 'interrupted: 마무리 도중 프로그램이 멈춘 것으로 보입니다. PC 사본은 지우지 않고 남겼습니다: ' + stagePath(id);
        save(st);
      }
    } catch { /* 한 건이 실패해도 나머지는 계속 */ }
  }
}
function sameSpec(a: JobState['spec'], files: FileSpec[], opts: JobOpts) {
  const norm = (f: FileSpec[]) => f.map(x => x.name + '|' + x.size + '|' + x.sha256.toLowerCase()).sort().join(',');
  const o = (x: JobOpts) => JSON.stringify([x.parentId || '', x.subfolder || '', !!x.isOverwrite, !!x.dryRun, x.cleanup || 'trash']);
  return norm(a.files) === norm(files) && o(a.opts) === o(opts);
}
function merge(r: Array<[number, number]>, s: number, e: number): Array<[number, number]> {
  const all = [...r, [s, e] as [number, number]].sort((x, y) => x[0] - y[0]);
  const out: Array<[number, number]> = [];
  for (const [a, b] of all) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b); else out.push([a, b]);
  }
  return out;
}
const receivedOf = (f: FileState) => f.ranges.reduce((n, [a, b]) => n + (b - a), 0);

function summary(st: JobState) {
  const names = Object.keys(st.files);
  return {
    job_id: st.job_id, state: st.state, files_total: names.length,
    files_done: names.filter(n => st.files[n].done).length,
    files: names.map(n => ({ name: n, size: st.files[n].size, received: receivedOf(st.files[n]), done: st.files[n].done,
      uploaded: st.files[n].uploaded ?? null, verified: st.files[n].verified ?? null, error: st.files[n].error ?? null })),
    error: st.error ?? null,
    final: FINAL.has(st.state),
    subfolder: st.spec.opts.subfolder ?? null, folder_id: st.folder_id ?? null
  };
}

export type ChunkArgs = {
  job_id: string; files: FileSpec[]; file_name: string; offset: number; content_base64: string;
  parent_id?: string; subfolder?: string; is_overwrite?: boolean; dry_run?: boolean; cleanup?: 'trash' | 'keep';
  /** 1.7.0: 이 호출이 일감을 완성하거나 이미 마무리 중이면, 마무리 결과가 나올 때까지 최대 wait_ms 기다렸다 답한다.
   *  시간 안에 안 끝나면 그때의 상태(finalizing, final:false)를 그대로 돌려준다(완료로 꾸미지 않는다). 0/생략 = 기다리지 않음 */
  wait_ms?: number;
};

/** 마무리를 기다린다: 끝나면 바로, 아니면 wait_ms에서 멈춘다(어느 쪽이었는지 waited로 알린다) */
async function waitFinal(id: string, waitMs: number): Promise<{ waited_ms: number; wait_timed_out: boolean }> {
  const p = running.get(id); const t0 = Date.now();
  if (!p || waitMs <= 0) return { waited_ms: 0, wait_timed_out: false };
  let timer: NodeJS.Timeout | undefined;
  const timedOut = await Promise.race([
    p.then(() => false, () => false),
    new Promise<boolean>(r => { timer = setTimeout(() => r(true), waitMs); })
  ]);
  if (timer) clearTimeout(timer);
  return { waited_ms: Date.now() - t0, wait_timed_out: timedOut };
}

/** 조각 하나를 받는다. 기다리기 전까지의 안쪽은 전부 동기 작업이라 동시에 여러 호출이 와도 서로 끼어들지 않는다
 *  (그래서 일감을 '다 모였다'로 바꾸는 호출은 정확히 하나다). */
export async function putChunk(a: ChunkArgs, uploader: Uploader) {
  sweepStale();
  if (!ID_RE.test(a.job_id || '')) throw new Error('job_id는 영문·숫자·_·- 1~64자여야 합니다');
  if (!Array.isArray(a.files) || a.files.length < 1 || a.files.length > LIMITS.maxFiles) throw new Error('files는 1~' + LIMITS.maxFiles + '개여야 합니다');
  let total = 0; const seen = new Set<string>();
  for (const f of a.files) {
    checkName(f.name);
    if (seen.has(f.name.toLowerCase())) throw new Error('파일 이름이 겹칩니다: ' + f.name);
    seen.add(f.name.toLowerCase());
    if (!Number.isInteger(f.size) || f.size <= 0 || f.size > LIMITS.maxFile) throw new Error('파일 크기가 올바르지 않습니다: ' + f.name);
    if (!/^[0-9a-f]{64}$/i.test(f.sha256)) throw new Error('sha256은 16진수 64글자여야 합니다: ' + f.name);
    total += f.size;
  }
  if (total > LIMITS.maxJob) throw new Error('일감 전체 크기 한도 초과: ' + total + ' > ' + LIMITS.maxJob);
  const spec = a.files.find(f => f.name === a.file_name);
  if (!spec) throw new Error('file_name이 files 목록에 없습니다: ' + a.file_name);
  const b64 = a.content_base64;
  if (typeof b64 !== 'string' || b64.length % 4 !== 0 || !B64.test(b64)) throw new Error('content_base64가 올바른 base64 글자가 아닙니다');
  const buf = Buffer.from(b64, 'base64');
  if (buf.length === 0 || buf.length > LIMITS.maxChunk) throw new Error('조각 크기는 1바이트~1MiB여야 합니다: ' + buf.length);
  if (!Number.isInteger(a.offset) || a.offset < 0 || a.offset + buf.length > spec.size) throw new Error('offset+조각 크기가 파일 크기를 넘습니다');
  if (!a.dry_run && !(typeof a.parent_id === 'string' && a.parent_id.trim())) throw new Error('parent_id가 필요합니다(1.7.0부터 MYBOX 루트로 올리지 않습니다). dry_run이면 생략 가능');
  if (a.subfolder != null && a.subfolder !== '') {
    checkName(a.subfolder);
    if (/\.part$/i.test(a.subfolder) || a.subfolder.length > 100) throw new Error('쓸 수 없는 하위 폴더 이름입니다: ' + a.subfolder);
    if (!a.parent_id) throw new Error('subfolder를 쓰려면 parent_id(상위 폴더 ID)가 필요합니다');
  }
  const waitMs = a.wait_ms == null ? 0 : a.wait_ms;
  if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > WAIT_MAX_MS) throw new Error('wait_ms는 0~' + WAIT_MAX_MS + ' 정수여야 합니다');

  const opts: JobOpts = { parentId: a.parent_id, subfolder: a.subfolder || undefined, isOverwrite: a.is_overwrite, dryRun: a.dry_run, cleanup: a.cleanup };
  let st = load(a.job_id);
  if (!st) {
    st = { job_id: a.job_id, created: new Date().toISOString(), updated: '', state: 'receiving',
      spec: { files: a.files.map(f => ({ name: f.name, size: f.size, sha256: f.sha256.toLowerCase() })), opts }, files: {} };
    for (const f of a.files) st.files[f.name] = { size: f.size, sha256: f.sha256.toLowerCase(), ranges: [], done: false };
    mem.set(a.job_id, st);
  } else if (!sameSpec(st.spec, a.files, opts)) {
    throw new Error('job_mismatch: 같은 job_id인데 파일 목록·옵션이 처음과 다릅니다');
  }
  const fs0 = st.files[a.file_name];
  if (st.state !== 'receiving' || fs0.done) {
    save(st);
    const w = st.state === 'finalizing' ? await waitFinal(a.job_id, waitMs) : { waited_ms: 0, wait_timed_out: false };
    return { ...summary(st), accepted: false, completed_by_this_call: false, ...w, note: st.state === 'failed' ? '일감이 실패했거나 만료됐습니다(job_status의 error 참고) — 새 job_id로 처음부터 다시 보내세요' : fs0.done ? '이 파일은 이미 다 받았습니다(중복 조각은 무시)' : '일감이 이미 마무리 단계입니다' };
  }
  const dir = stagePath(a.job_id);
  fs.mkdirSync(dir, { recursive: true });
  const part = path.join(dir, a.file_name + '.part');
  if (!fs.existsSync(part)) { const fd0 = fs.openSync(part, 'w'); fs.ftruncateSync(fd0, spec.size); fs.closeSync(fd0); }
  const fd = fs.openSync(part, 'r+');
  try { fs.writeSync(fd, buf, 0, buf.length, a.offset); } finally { fs.closeSync(fd); }
  fs0.ranges = merge(fs0.ranges, a.offset, a.offset + buf.length);
  if (receivedOf(fs0) >= spec.size) {
    const sha = crypto.createHash('sha256').update(fs.readFileSync(part)).digest('hex');
    if (sha !== fs0.sha256) {
      fs0.ranges = []; fs0.error = 'sha256 불일치(전송 중 깨짐): 받은 ' + sha + ' / 기대 ' + fs0.sha256;
      try { fs.unlinkSync(part); } catch { /* 이미 없음 */ }
      save(st);
      throw new Error(fs0.error + ' — 이 파일은 처음부터 다시 보내세요');
    }
    fs.renameSync(part, path.join(dir, a.file_name));
    fs0.done = true; fs0.error = undefined;
  }
  const allDone = Object.values(st.files).every(f => f.done);
  if (allDone) { st.state = 'finalizing'; st.staged_dir = dir; }
  save(st);
  if (!allDone) return { ...summary(st), accepted: true, completed_by_this_call: false, waited_ms: 0, wait_timed_out: false };
  // 마무리는 PC가 한다. 화면이 연결을 끊어도 계속 진행된다. wait_ms가 있으면 이 호출이 결과까지 기다렸다 답한다.
  const p = finalize(st, uploader).finally(() => running.delete(a.job_id));
  running.set(a.job_id, p);
  const w = await waitFinal(a.job_id, waitMs);
  return { ...summary(st), accepted: true, completed_by_this_call: true, ...w };
}

export async function finalize(st: JobState, uploader: Uploader) {
  const dir = stagePath(st.job_id), o = st.spec.opts;
  try {
    if (!o.dryRun) {
      let target = o.parentId;
      if (o.subfolder) {   // 새 폴더를 만들고 거기에만 올린다 → 옛 파일과 섞이지 않는다. 같은 이름 폴더가 있으면 실패(새 이름으로 새 일감)
        target = await uploader.createFolder(o.subfolder, o.parentId as string);
        st.folder_id = target; save(st);
      }
      for (const f of st.spec.files) {
        await uploader.upload(path.join(dir, f.name), target, !!o.isOverwrite);
        st.files[f.name].uploaded = true; save(st);
      }
      for (const f of st.spec.files) {
        const v = await uploader.verify(f.name, f.size, target);
        st.files[f.name].verified = v.found && v.size === f.size;
        if (!st.files[f.name].verified) st.files[f.name].error = v.found ? '크기가 다릅니다: MYBOX ' + v.size + ' / 기대 ' + f.size : 'MYBOX 목록에서 못 찾음';
        save(st);
      }
      if (st.spec.files.some(f => !st.files[f.name].verified)) throw new Error('MYBOX 대조 실패 — PC 사본은 지우지 않고 남겼습니다: ' + dir);
    }
    st.state = o.dryRun ? 'dry_run_done' : 'done';
    if (o.cleanup !== 'keep') { // 지우지 않고 _trash로 옮긴다(복구 가능)
      const trash = path.join(jobsRoot(), '_trash');
      fs.mkdirSync(trash, { recursive: true });
      const to = path.join(trash, st.job_id + '_' + Date.now());
      fs.renameSync(dir, to); st.staged_dir = to;
    }
  } catch (e: any) {
    st.state = 'failed'; st.error = String(e && e.message || e);
  }
  save(st);
}

/** 읽기만 한다(1.7.0: 만료 정리는 타이머와 job_put_chunk가 맡고 여기서는 하지 않는다 → 읽기 전용 표시) */
export function jobStatus(id: string) {
  if (!ID_RE.test(id || '')) throw new Error('job_id가 올바르지 않습니다');
  const st = load(id);
  if (!st) return { job_id: id, state: 'unknown', final: false, note: '이 job_id의 기록이 없습니다' };
  const base = { ...summary(st), created: st.created, updated: st.updated, staged_dir: st.staged_dir ?? null };
  // 만료 시간이 지났는데 아직 정리 전이면, 쓰지 않고 정리될 결과를 그대로 보여 준다(실제 정리는 타이머·job_put_chunk)
  if ((st.state === 'receiving' || (st.state === 'finalizing' && !running.has(id))) && Date.now() - Date.parse(st.updated) >= idleSeconds() * 1000) {
    return { ...base, state: 'failed', final: true, cleanup_pending: true,
      error: st.state === 'receiving' ? 'timeout: ' + Math.round(idleSeconds()) + '초 넘게 조각이 오지 않아 멈춘 일감입니다(정리 대기 중). 새 job_id로 처음부터 다시 보내세요'
        : 'interrupted: 마무리 도중 프로그램이 멈춘 것으로 보입니다. PC 사본은 지우지 않고 남깁니다' };
  }
  return base;
}

/** 시험용: 메모리 캐시 비우기(프로세스가 다시 뜬 것처럼) */
export function _resetMemory() { mem.clear(); }

// 오래 떠 있는 프로세스에서도 주기적으로 정리(프로세스 종료를 막지 않는다)
setInterval(() => { try { sweepStale(); } catch { /* 다음 주기에 다시 */ } }, 60000).unref();
