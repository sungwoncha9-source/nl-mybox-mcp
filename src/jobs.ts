// 일감(job) — 화면이 한 클릭 안에서 조각을 순서 없이·동시에 보내면 PC가 모아서 MYBOX까지 마무리한다.
// 설계 근거(2026-10-23, R1 시험): 앱 안 host 호출은 클릭 직후 약 4초 안에 "시작"만 하면 되고(응답은 길어도 됨),
// 동시에 날릴 수 있는 호출은 8개 안팎이다. 그래서 (1) 조각은 도착 순서와 상관없이 받고 (2) 마지막 조각이 들어오면
// PC 쪽이 스스로 올리기·크기 대조·정리를 한다. 토큰은 여기서 다루지 않는다(올리기는 index.ts의 기존 코드를 받아서 부른다).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export type FileSpec = { name: string; size: number; sha256: string };
export type JobOpts = { parentId?: string; subfolder?: string; isOverwrite?: boolean; dryRun?: boolean; cleanup?: 'trash' | 'keep'; bundle?: 'pack1'; verifyContent?: boolean; uploadConcurrency?: number };
export interface Uploader {
  upload(filePath: string, parentId: string | undefined, isOverwrite: boolean): Promise<void>;
  /** 올린 파일이 MYBOX 폴더에 있고 크기가 같은지 읽어서 본다(읽기만) */
  verify(name: string, size: number, parentId: string | undefined): Promise<{ found: boolean; size?: number }>;
  /** 1.8.0: parentId 아래에 새 폴더를 만들고 그 폴더 ID를 돌려준다. 같은 이름이 이미 있으면 만들지 않고 오류를 던진다 */
  createFolder(name: string, parentId: string): Promise<string>;
  /** 1.9.0: 폴더 안 파일 이름→크기 목록(읽기만). 묶음(bundle) 마무리가 폴더마다 한 번씩만 읽는다 */
  list(parentId: string | undefined): Promise<Map<string, { size?: number; rid?: string }>>;
  /** 1.9.1: 올린 파일의 내용 sha256을 MYBOX에서 내려받아 계산한다(선택, verify_content일 때만) */
  contentSha256?(resourceId: string): Promise<string>;
  /** 1.9.1: 폴더의 상위 폴더 ID(허용 목록 tree: 검사용). 없으면 null */
  parentOf?(resourceId: string): Promise<string | null>;
}
type FileState = {
  size: number; sha256: string; ranges: Array<[number, number]>; done: boolean;
  uploaded?: boolean; verified?: boolean; error?: string;
};
/** 1.9.0: 묶음(pack1) 안의 파일 하나의 진행·결과 */
export type EntryState = { id: number; name: string; size: number; sha256: string; parent_id?: string; target?: string; unpacked?: boolean; uploaded?: boolean; size_verified?: boolean; content_verified?: boolean; verified?: boolean; error?: string };
export type JobState = {
  job_id: string; created: string; updated: string;
  state: 'receiving' | 'finalizing' | 'done' | 'dry_run_done' | 'failed';
  spec: { files: FileSpec[]; opts: JobOpts };
  files: Record<string, FileState>;
  error?: string; staged_dir?: string; folder_id?: string;
  entries?: EntryState[];
};

export const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** 1.10.1: 서비스별 작업 번호 접두어(NL_JOB_PREFIX, 비면 검사 안 함 = 이전과 같음). 같은 서비스를 여러 프로젝트가 쓸 때 서로의 일감을 못 읽게 한다. 호출자(sub)로는 구분할 수 없어(W1-T02) 접두어로 한다 */
function checkPrefix(id: string) { const pf = (process.env.NL_JOB_PREFIX || '').trim(); if (pf && !String(id || '').startsWith(pf)) throw new Error('not_allowed: job_id는 "' + pf + '"로 시작해야 합니다'); }
/** 1.9.2: 이름 비교는 모두 이 함수 한 곳으로 한다 — 유니코드 NFC로 맞추고 소문자로 본다(한글 NFC/NFD, 대소문자만 다른 이름을 같은 이름으로 취급) */
export const normName = (n: string) => String(n).normalize('NFC').toLowerCase();
const NAME_BAD = /[\\/:*?"<>|\u0000-\u001f]/;
const B64 = /^[A-Za-z0-9+/]*={0,2}$/;
export const LIMITS = { maxChunk: 1024 * 1024, maxFile: 200 * 1024 * 1024, maxJob: 600 * 1024 * 1024, maxFiles: 40, maxEntries: 500, maxManifest: 1024 * 1024, maxConc: 4 };

export function jobsRoot(): string {
  return process.env.NL_JOBS_DIR || 'D:\\nodelab_work\\_jobs';
}

function checkName(n: string) {
  if (typeof n !== 'string' || !n.trim() || n.length > 150 || NAME_BAD.test(n) || n === '.' || n === '..' || n.startsWith('.')
    || /\.part$/i.test(n) || /^(state|job)\.json$/i.test(n)) throw new Error('쓸 수 없는 파일 이름입니다: ' + n);
}
// ---- 1.9.0 묶음(pack1): 호출 수를 파일 수가 아니라 바이트 수에 비례하게 한다 ----------------------------------------
// 형식: 'NLP1'(4) + 목록 길이 uint32 BE(4) + 목록 JSON(UTF-8) + 파일 바이트들을 목록 순서대로 이어 붙인 것.
// 목록: { entries: [{ name, size, sha256, parent_id? }] } — parent_id가 있으면 그 폴더로, 없으면 일감의 parent_id/subfolder로.
export type PackEntry = { name: string; size: number; sha256: string; parent_id?: string };
export function buildPack(entries: Array<{ name: string; data: Buffer; parent_id?: string }>): Buffer {
  const man = Buffer.from(JSON.stringify({ entries: entries.map(e => ({ name: e.name, size: e.data.length, sha256: crypto.createHash('sha256').update(e.data).digest('hex'), ...(e.parent_id ? { parent_id: e.parent_id } : {}) })) }), 'utf8');
  const head = Buffer.alloc(8); head.write('NLP1', 0, 'latin1'); head.writeUInt32BE(man.length, 4);
  return Buffer.concat([head, man, ...entries.map(e => e.data)]);
}
/** buf = 묶음의 머리(8바이트)+목록까지만 있어도 된다. total = 묶음 파일 전체 크기(바이트 합계 대조용). 1.9.1: 같은 이름도 대상 폴더가 다르면 허용한다 */
export function parsePack(buf: Buffer, total = buf.length): { entries: PackEntry[]; start: number } {
  if (buf.length < 10 || buf.toString('latin1', 0, 4) !== 'NLP1') throw new Error('묶음 형식이 아닙니다(머리표 NLP1 없음)');
  const m = buf.readUInt32BE(4);
  if (m < 2 || m > LIMITS.maxManifest || 8 + m > total || 8 + m > buf.length) throw new Error('묶음 목록 길이가 올바르지 않습니다: ' + m);
  let man: any; try { man = JSON.parse(buf.toString('utf8', 8, 8 + m)); } catch { throw new Error('묶음 목록(JSON)을 읽지 못했습니다'); }
  const es = man && man.entries;
  if (!Array.isArray(es) || es.length < 1 || es.length > LIMITS.maxEntries) throw new Error('묶음 안 파일은 1~' + LIMITS.maxEntries + '개여야 합니다');
  const seen = new Set<string>(); let sum = 0; const out: PackEntry[] = [];
  for (const e of es) {
    checkName(e && e.name);
    if (e.parent_id != null && (typeof e.parent_id !== 'string' || !e.parent_id.trim() || e.parent_id.length > 300 || /\s/.test(e.parent_id))) throw new Error('묶음 안 parent_id가 올바르지 않습니다: ' + e.name);
    const key = (e.parent_id || '') + '\u0000' + normName(e.name);   // 같은 대상 폴더 + 같은 이름만 충돌
    if (seen.has(key)) throw new Error('묶음 안에 같은 폴더·같은 이름이 겹칩니다: ' + e.name + (e.parent_id ? ' (폴더 ' + e.parent_id + ')' : ''));
    seen.add(key);
    if (!Number.isInteger(e.size) || e.size <= 0) throw new Error('묶음 안 파일 크기가 올바르지 않습니다: ' + e.name);
    if (typeof e.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(e.sha256)) throw new Error('묶음 안 sha256이 올바르지 않습니다: ' + e.name);
    sum += e.size; out.push({ name: e.name, size: e.size, sha256: e.sha256.toLowerCase(), ...(e.parent_id ? { parent_id: e.parent_id } : {}) });
  }
  if (8 + m + sum !== total) throw new Error('묶음 크기가 목록과 다릅니다: 목록 합계 ' + sum + ' / 실제 ' + (total - 8 - m));
  return { entries: out, start: 8 + m };
}
/** 파일 sha256을 1MiB씩 읽어 계산한다(파일 전체를 메모리에 올리지 않는다) */
export function sha256File(p: string): string {
  const h = crypto.createHash('sha256'), fd = fs.openSync(p, 'r'), buf = Buffer.allocUnsafe(1024 * 1024);
  try { for (;;) { const n = fs.readSync(fd, buf, 0, buf.length, null); if (n <= 0) break; h.update(buf.subarray(0, n)); } } finally { fs.closeSync(fd); }
  return h.digest('hex');
}
/** 디스크 여유가 모자라면 받기 전에 거절한다(1.9.1). 묶음은 묶음 파일 + 풀어 둔 사본이 함께 필요하다 */
export function checkDiskFree(need: number) {
  let free: number | null = null;
  try { const sf: any = (fs as any).statfsSync(jobsRoot()); free = Number(sf.bavail) * Number(sf.bsize); } catch { /* 폴더가 아직 없거나 지원 안 함 → 폴더 만든 뒤 다시 */ }
  if (free == null) { try { fs.mkdirSync(jobsRoot(), { recursive: true }); const sf: any = (fs as any).statfsSync(jobsRoot()); free = Number(sf.bavail) * Number(sf.bsize); } catch { return; } }
  const margin = (Number(process.env.NL_MIN_FREE_MB) || 64) * 1024 * 1024;
  if (free < need + margin) throw new Error('disk_full: PC 작업 폴더의 남은 공간이 모자랍니다(필요 약 ' + Math.ceil((need + margin) / 1048576) + ' MiB, 남음 ' + Math.floor(free / 1048576) + ' MiB). 공간을 비운 뒤 새 job_id로 다시 보내세요');
}
/** 쓸 수 있는 MYBOX 폴더 허용 목록(1.9.1). 환경변수 NL_JOB_ALLOWED_PARENTS = 쉼표로 구분한 폴더 ID, 또는 'tree:<ID>'(그 폴더와 모든 하위 폴더). 비어 있으면 제한 없음(이전과 같음) */
const ALLOW_CACHE = new Map<string, boolean>();
export async function checkAllowed(parentId: string | undefined, uploader: Uploader, cache = new Map<string, boolean>()) {
  const raw = (process.env.NL_JOB_ALLOWED_PARENTS || '').split(',').map(x => x.trim()).filter(Boolean);
  if (!raw.length) return;
  if (!parentId) throw new Error('not_allowed: 올릴 폴더가 없습니다(허용 목록이 켜져 있습니다)');
  const exact = new Set(raw.filter(x => !x.startsWith('tree:'))), trees = raw.filter(x => x.startsWith('tree:')).map(x => x.slice(5));
  if (cache.has(parentId)) { if (cache.get(parentId)) return; throw new Error('not_allowed: 허용되지 않은 폴더입니다: ' + parentId); }
  let ok = exact.has(parentId) || trees.includes(parentId);
  if (!ok && trees.length && uploader.parentOf) {
    let cur: string | null = parentId;
    for (let i = 0; i < 16 && cur && !ok; i++) { cur = await uploader.parentOf(cur); if (cur && trees.includes(cur)) ok = true; }
  }
  cache.set(parentId, ok);
  if (!ok) throw new Error('not_allowed: 허용되지 않은 폴더입니다: ' + parentId);
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
  const o = (x: JobOpts) => JSON.stringify([x.parentId || '', x.subfolder || '', !!x.isOverwrite, !!x.dryRun, x.cleanup || 'trash', x.bundle || '', !!x.verifyContent, x.uploadConcurrency || 1]);
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
    subfolder: st.spec.opts.subfolder ?? null, folder_id: st.folder_id ?? null,
    ...(st.spec.opts.bundle ? { bundle: st.spec.opts.bundle, entries: st.entries ? st.entries.map(e => ({ id: e.id, name: e.name, size: e.size, target: e.target ?? e.parent_id ?? null, uploaded: e.uploaded ?? null, size_verified: e.size_verified ?? null, content_verified: e.content_verified ?? null, verified: e.verified ?? null, error: e.error ?? null })) : null } : {})
  };
}

export type ChunkArgs = {
  job_id: string; files: FileSpec[]; file_name: string; offset: number; content_base64: string;
  parent_id?: string; subfolder?: string; is_overwrite?: boolean; dry_run?: boolean; cleanup?: 'trash' | 'keep';
  /** 1.7.0: 이 호출이 일감을 완성하거나 이미 마무리 중이면, 마무리 결과가 나올 때까지 최대 wait_ms 기다렸다 답한다.
   *  시간 안에 안 끝나면 그때의 상태(finalizing, final:false)를 그대로 돌려준다(완료로 꾸미지 않는다). 0/생략 = 기다리지 않음 */
  wait_ms?: number;
  /** 1.9.0: 'pack1'이면 files는 묶음 파일 하나뿐이고, 마지막 조각이 오면 PC가 묶음을 풀어 안의 파일을 하나씩 올린다 */
  bundle?: 'pack1';
  /** 1.9.1: 올린 뒤 MYBOX에서 내려받아 내용 sha256까지 대조(느림·전송량 증가, 선택) */
  verify_content?: boolean;
  /** 1.9.1: 묶음 마무리에서 동시에 올릴 파일 수(1~4, 기본 1) */
  upload_concurrency?: number;
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
  checkPrefix(a.job_id);
  if (!Array.isArray(a.files) || a.files.length < 1 || a.files.length > LIMITS.maxFiles) throw new Error('files는 1~' + LIMITS.maxFiles + '개여야 합니다');
  if (a.bundle != null && a.bundle !== 'pack1') throw new Error("bundle은 'pack1'만 쓸 수 있습니다");
  if (a.bundle && a.files.length !== 1) throw new Error('bundle이면 files는 묶음 파일 하나여야 합니다');
  let total = 0; const seen = new Set<string>();
  for (const f of a.files) {
    checkName(f.name);
    if (seen.has(normName(f.name))) throw new Error('파일 이름이 겹칩니다: ' + f.name);
    seen.add(normName(f.name));
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
  if (a.verify_content != null && typeof a.verify_content !== 'boolean') throw new Error('verify_content는 true/false여야 합니다');
  if (a.upload_concurrency != null && (!Number.isInteger(a.upload_concurrency) || a.upload_concurrency < 1 || a.upload_concurrency > LIMITS.maxConc)) throw new Error('upload_concurrency는 1~' + LIMITS.maxConc + ' 정수여야 합니다');
  if ((a.verify_content || a.upload_concurrency) && !a.bundle) throw new Error('verify_content·upload_concurrency는 bundle 일감에서만 씁니다');
  const waitMs = a.wait_ms == null ? 0 : a.wait_ms;
  if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > WAIT_MAX_MS) throw new Error('wait_ms는 0~' + WAIT_MAX_MS + ' 정수여야 합니다');

  if (!a.dry_run) await checkAllowed(a.parent_id, uploader, ALLOW_CACHE);   // 일감 기록을 만들기 전에(이 await 뒤부터는 다시 전부 동기 구간)
  const opts: JobOpts = { parentId: a.parent_id, subfolder: a.subfolder || undefined, isOverwrite: a.is_overwrite, dryRun: a.dry_run, cleanup: a.cleanup, bundle: a.bundle || undefined, verifyContent: a.verify_content || undefined, uploadConcurrency: a.upload_concurrency || undefined };
  let st = load(a.job_id);
  if (!st) {
    checkDiskFree(total * (a.bundle ? 2 : 1));   // 동기 점검: 모자라면 일감 기록도 만들지 않고 거절(같은 job_id로 다시 보낼 수 있다)
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
    const sha = sha256File(part);
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
  if (st.spec.opts.bundle) return finalizeBundle(st, uploader);
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
  checkPrefix(id);
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


/** 1.9.x 묶음 마무리: 풀기(스트리밍·파일마다 sha256 대조) → 폴더마다 목록을 한 번 읽어 같은 이름이 있으면 올리지 않음 → 올리기(동시 1~4) → 폴더마다 다시 읽어 크기 대조 → (선택) 내려받아 내용 sha256 대조.
 *  한 파일이 실패해도 나머지는 계속하고, 파일별 결과를 entries에 남긴다(하나라도 실패하면 일감 state는 failed). 덮어쓰기는 is_overwrite가 true일 때만.
 *  verified = 크기 대조(size_verified) 통과 + (verify_content면 content_verified도 통과). */
/** 1.9.2: 항목마다 parent_id를 생략하면 일감의 기본 폴더(또는 새 하위 폴더)로 간다. 그 '실효' 폴더를 먼저 확정하고 (폴더, 정규화한 이름)이 겹치면 **업로드를 시작하기 전에** 일감 전체를 막는다.
 *  (parsePack은 적힌 parent_id 문자열만 비교하므로, 명시한 항목과 생략한 항목이 같은 폴더로 가는 경우를 못 본다) */
export function effectiveDuplicates(entries: Array<{ name: string; parent_id?: string }>, o: JobOpts): string[] {
  const eff = (e: { parent_id?: string }) => e.parent_id || (o.subfolder ? '\u0001new-subfolder' : (o.parentId || ''));
  const seen = new Map<string, string>(), dup: string[] = [];
  for (const e of entries) { const k = eff(e) + '\u0000' + normName(e.name); if (seen.has(k)) dup.push(seen.get(k)! + ' ↔ ' + e.name); else seen.set(k, e.name); }
  return dup;
}
export async function finalizeBundle(st: JobState, uploader: Uploader) {
  const dir = stagePath(st.job_id), o = st.spec.opts;
  try {
    const packFile = st.spec.files[0], packPath = path.join(dir, packFile.name);
    const fd = fs.openSync(packPath, 'r'); let entries: PackEntry[], start: number;
    try {
      const h8 = Buffer.alloc(8); if (fs.readSync(fd, h8, 0, 8, 0) !== 8) throw new Error('묶음이 너무 짧습니다');
      const m = h8.readUInt32BE(4); if (m < 2 || m > LIMITS.maxManifest) throw new Error('묶음 목록 길이가 올바르지 않습니다: ' + m);
      const hm = Buffer.alloc(8 + m); fs.readSync(fd, hm, 0, 8 + m, 0);
      ({ entries, start } = parsePack(hm, packFile.size));
      st.entries = entries.map((e, i) => ({ id: i, name: e.name, size: e.size, sha256: e.sha256, ...(e.parent_id ? { parent_id: e.parent_id } : {}) }));
      const edir = path.join(dir, 'entries'); let pos = start, bad = 0; const blk = Buffer.allocUnsafe(1024 * 1024);
      for (const es of st.entries) {   // 한 건씩: 읽으면서 해시하고 파일로 쓴다(메모리는 1MiB 블록만)
        const edirOne = path.join(edir, String(es.id)); fs.mkdirSync(edirOne, { recursive: true });
        const outp = path.join(edirOne, es.name), ofd = fs.openSync(outp, 'w'), hh = crypto.createHash('sha256');
        try { let left = es.size; while (left > 0) { const n = fs.readSync(fd, blk, 0, Math.min(blk.length, left), pos); if (n <= 0) throw new Error('묶음 끝을 넘어 읽었습니다'); hh.update(blk.subarray(0, n)); fs.writeSync(ofd, blk, 0, n); pos += n; left -= n; } }
        finally { fs.closeSync(ofd); }
        if (hh.digest('hex') !== es.sha256) { es.error = 'sha256 불일치(묶음 안에서 깨짐)'; bad++; try { fs.unlinkSync(outp); } catch { /* 이미 없음 */ } } else es.unpacked = true;
      }
      save(st);
      const dups = effectiveDuplicates(st.entries, o);
      if (dups.length) { for (const es of st.entries) if (dups.some(d => d.includes(es.name))) es.error = 'duplicate_target: 실제로 올라갈 폴더와 이름이 다른 항목과 같아 일감 전체를 올리기 전에 막았습니다'; save(st); throw new Error('duplicate_target: 실효 목적 폴더·이름이 겹칩니다 — 아무것도 올리지 않았습니다: ' + dups.slice(0, 3).join(' / ')); }
      if (!o.dryRun) await uploadEntries(st, uploader, edir);
      const failed = st.entries.filter(e => e.error || (!o.dryRun && !e.verified)).length;
      if (failed) throw new Error('묶음 안 ' + failed + '개가 올라가지 않았거나 확인되지 않았습니다 — 파일별 결과는 entries를 보세요. PC 사본은 지우지 않고 남겼습니다: ' + dir);
    } finally { fs.closeSync(fd); }
    st.state = o.dryRun ? 'dry_run_done' : 'done';
    if (o.cleanup !== 'keep') {
      // 성공했을 때만: 풀어 둔 사본(entries/)은 묶음 파일에서 언제든 다시 풀 수 있고 sha256이 다 맞았으므로 지운다 → _trash에는 묶음 파일(증거)만 남아 디스크가 두 배로 남지 않는다.
      try { fs.rmSync(path.join(dir, 'entries'), { recursive: true, force: true }); } catch { /* 못 지워도 일감은 성공 */ }
      const trash = path.join(jobsRoot(), '_trash'); fs.mkdirSync(trash, { recursive: true });
      const to = path.join(trash, st.job_id + '_' + Date.now()); fs.renameSync(dir, to); st.staged_dir = to;
    }
  } catch (e: any) { st.state = 'failed'; st.error = String(e && e.message || e); }
  save(st);
}

async function uploadEntries(st: JobState, uploader: Uploader, edir: string) {
  const o = st.spec.opts, ents = st.entries as EntryState[];
  let base = o.parentId;
  if (o.subfolder) { base = await uploader.createFolder(o.subfolder, o.parentId as string); st.folder_id = base; save(st); }
  const allowCache = new Map<string, boolean>();
  const lists = new Map<string, Map<string, { name?: string; size?: number; rid?: string }>>();
  const listOf = async (t: string | undefined, fresh = false) => {   // 원격 목록의 이름도 같은 정규화 키로 다시 담는다(실제 이름은 name에 보관)
    const k = t || ''; if (fresh || !lists.has(k)) { const raw = await uploader.list(t); const m = new Map<string, { name?: string; size?: number; rid?: string }>(); for (const [nm, v] of raw) m.set(normName(nm), { ...v, name: v.name ?? nm }); lists.set(k, m); } return lists.get(k)!; };
  const todo = ents.filter(e => e.unpacked);
  for (const e of todo) { e.target = e.parent_id || base; }
  // 허용 폴더 검사는 올리기 전에 모두 한다(허용 안 된 폴더가 하나라도 있으면 그 파일만 막고 나머지는 진행)
  for (const e of todo) { try { await checkAllowed(e.target, uploader, allowCache); } catch (err: any) { e.error = String(err.message || err); e.unpacked = false; } }
  const run = todo.filter(e => e.unpacked);
  for (const t of new Set(run.map(e => e.target))) await listOf(t);   // 폴더마다 한 번
  const one = async (e: EntryState) => {
    try {
      const ls = await listOf(e.target);
      const ex = ls.get(normName(e.name));
      if (ex && !o.isOverwrite) { e.error = 'exists: 같은 이름이 이미 있어 올리지 않았습니다(MYBOX 이름 ' + ex.name + ', 크기 ' + ex.size + ')'; save(st); return; }
      if (ex && ex.name !== e.name) { e.error = 'case_conflict: 이름이 대소문자·글자 구성만 다른 기존 파일(' + ex.name + ')이 있어 덮어쓰기 대상이 모호해 올리지 않았습니다'; save(st); return; }
      await uploader.upload(path.join(edir, String(e.id), e.name), e.target, !!o.isOverwrite); e.uploaded = true; save(st);
    } catch (err: any) { e.error = String(err && err.message || err).slice(0, 300); save(st); }
  };
  const conc = Math.max(1, Math.min(LIMITS.maxConc, o.uploadConcurrency || 1)); let qi = 0;
  await Promise.all(Array.from({ length: conc }, async () => { for (;;) { const i = qi++; if (i >= run.length) return; await one(run[i]); } }));
  const up = run.filter(e => e.uploaded);
  for (const t of new Set(up.map(e => e.target))) await listOf(t, true);   // 올린 뒤 폴더마다 다시 한 번
  for (const e of up) {
    const it = lists.get(e.target || '')!.get(normName(e.name));
    e.size_verified = !!it && it.size === e.size;
    if (!e.size_verified) { e.error = it ? '크기가 다릅니다: MYBOX ' + it.size + ' / 기대 ' + e.size : 'MYBOX 목록에서 못 찾음'; e.verified = false; continue; }
    if (o.verifyContent) {
      try {
        if (!uploader.contentSha256 || !it!.rid) throw new Error('내용 대조 불가: MYBOX 파일 ID를 읽지 못했거나 서버가 내려받기를 지원하지 않습니다');
        const got = await uploader.contentSha256(it!.rid); e.content_verified = got === e.sha256;
        if (!e.content_verified) e.error = '내용(sha256)이 다릅니다: MYBOX ' + got + ' / 기대 ' + e.sha256;
      } catch (err: any) { e.content_verified = false; e.error = String(err && err.message || err).slice(0, 300); }
    }
    e.verified = e.size_verified && (!o.verifyContent || e.content_verified === true);
  }
  save(st);
}
