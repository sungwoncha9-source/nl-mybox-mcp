#!/usr/bin/env node
// mybox-mcp (노드랩 수정판) — 원본: minking/mybox-mcp (MIT)
// 수정: 모든 API 주소를 네이버 MYBOX Open API 공식 문서(developers.mybox.naver.com, 2026-10-19 확인)대로 고침.
//       PC 파일 경로로 바로 내려받기/올리기 도구 2개 추가.
// 1.2.0: 안전 장치(환경변수로 켬, 기본은 꺼짐: M1·M3·M4·M5·M8) + 항상 거부 목록(M1', 기본값 있음) + 텍스트 읽기·쓰기 도구(M7) + 목록 결과에 path(M9).
//        환경변수: NL_ALLOW_ROOTS, NL_WRITE_ROOTS, NL_DENY_PATHS, NL_BLOCK_PERMANENT_DELETE, NL_LOG_FILE (경로 목록은 ';' 또는 줄바꿈으로 구분).
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import axios from 'axios';
import fs from 'node:fs';
import path from 'node:path';

const server = new McpServer({ name: 'mybox-mcp', version: '1.2.0' });
const BASE_URL = 'https://open-api.mybox.naver.com/v1';

function getAuthHeaders() {
  const token = process.env.MYBOX_ACCESS_TOKEN;
  if (!token) {
    throw new Error('MYBOX_ACCESS_TOKEN environment variable is not set. Please set your Personal Access Token.');
  }
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

async function makeRequest(method: string, endpoint: string, data?: any, params?: any) {
  const url = `${BASE_URL}${endpoint}`;
  try {
    const response = await axios({ method, url, headers: getAuthHeaders(), data, params });
    return response.data === '' || response.data === undefined ? { ok: true, status: response.status } : response.data;
  } catch (error: any) {
    if (error.response) {
      throw new Error(`API Error: ${error.response.status} - ${JSON.stringify(error.response.data)}`);
    }
    throw error;
  }
}

function out(result: any) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
}

const idParam = (what: string) => z.string().describe(what);
const paging = {
  sort: z.string().optional().describe("정렬 '기준,순서' 예: modifiedAt,desc"),
  count: z.number().optional().describe('한 번에 가져올 개수(목록 최대 1000, 검색 20~200)'),
  cursor: z.string().optional().describe('다음 쪽: 앞 응답의 responseMetaData.nextCursor')
};


// ============================================================================
// 안전 장치 (1.2.0) — 환경변수가 없으면 지금까지와 똑같이 동작한다 (항상 거부 목록 NL_DENY_PATHS 기본값만 예외)
// ============================================================================
const normPath = (p: string) => {
  let x = String(p || '').replace(/\\/g, '/').normalize('NFC').trim();
  if (!x.startsWith('/')) x = '/' + x;
  x = x.replace(/\/{2,}/g, '/');
  if (x.length > 1 && x.endsWith('/')) x = x.slice(0, -1);
  return x === '/' ? '' : x; // 루트는 빈 문자열
};
const parseList = (v: string | undefined) =>
  (v ?? '').split(/[;\n]/).map((x) => x.trim()).filter(Boolean).map(normPath).filter((x) => x !== '');
const DEFAULT_DENY = ['/NPKI', '/b0_업무_관리/관리_세무자료', '/b0_업무_관리/관리_주식'];
const cfg = () => ({
  allow: parseList(process.env.NL_ALLOW_ROOTS),
  write: parseList(process.env.NL_WRITE_ROOTS),
  deny: process.env.NL_DENY_PATHS === undefined ? DEFAULT_DENY : parseList(process.env.NL_DENY_PATHS),
  blockPermanent: ['1', 'true'].includes(String(process.env.NL_BLOCK_PERMANENT_DELETE ?? '').toLowerCase()),
  logFile: process.env.NL_LOG_FILE || ''
});
const under = (p: string, root: string) => p === root || p.startsWith(root + '/');
const underAny = (p: string, roots: string[]) => roots.some((r) => under(p, r));
const isAncestorOfAny = (p: string, roots: string[]) => roots.some((r) => r.startsWith(p + '/'));
const denied = (msg: string) => new Error('DENIED: ' + msg);

// 경로 조회: dms_resourceId 에는 path 가 없고 parentId 만 있어서(2026-10-19 확인) 위로 따라 올라가며 이름을 이어 붙인다.
const META_TTL_MS = 5 * 60 * 1000;
const metaCache = new Map<string, { name: string; parentId?: string; ts: number }>();
const seedMeta = (items: any) => {
  if (!Array.isArray(items)) return;
  for (const it of items) {
    if (it && it.resourceId && typeof it.name === 'string') {
      metaCache.set(it.resourceId, { name: it.name, parentId: it.parentId, ts: Date.now() });
    }
  }
};
async function getMeta(id: string) {
  const hit = metaCache.get(id);
  if (hit && Date.now() - hit.ts < META_TTL_MS) return hit;
  const m: any = await makeRequest('GET', `/drive/resources/${id}`);
  const v = { name: String(m.name ?? ''), parentId: m.parentId as string | undefined, ts: Date.now() };
  metaCache.set(id, v);
  return v;
}
async function pathOf(id?: string): Promise<string> {
  if (!id) return ''; // 생략 = 루트
  const parts: string[] = [];
  let cur: string | undefined = id;
  for (let i = 0; i < 40 && cur; i++) {
    const m = await getMeta(cur);
    if (m.name === '') return normPath('/' + parts.join('/')); // 이름이 빈 항목 = 루트
    parts.unshift(m.name);
    cur = m.parentId;
  }
  throw new Error('path resolution did not reach root');
}

const deletedHere = new Set<string>(); // 이 프로세스가 지운 것(복원 허용용)

type Mode = 'read' | 'write';
async function checkPath(p: string, mode: Mode, tool: string) {
  const c = cfg();
  if (underAny(p, c.deny)) throw denied(`${tool}: 항상 거부 목록 안의 경로입니다 (${p})`);
  if (mode === 'write' && c.write.length && !underAny(p, c.write))
    throw denied(`${tool}: 쓰기 허용 구역(NL_WRITE_ROOTS) 밖입니다 (${p || '/'})`);
  if (mode === 'read' && c.allow.length && !underAny(p, [...c.allow, ...c.write]))
    throw denied(`${tool}: 허용 구역(NL_ALLOW_ROOTS) 밖입니다 (${p || '/'})`);
}
// id 로 가리킨 항목의 경로를 확인한다. 켜진 장치가 없으면 아무것도 하지 않는다.
async function guardId(id: string | undefined, mode: Mode, tool: string, opts: { restoring?: boolean } = {}) {
  const c = cfg();
  const strict = c.allow.length > 0 || c.write.length > 0;
  if (!strict && c.deny.length === 0) return;
  if (opts.restoring && id && deletedHere.has(id)) return;
  let p: string;
  try {
    p = await pathOf(id);
  } catch (e: any) {
    if (strict) throw denied(`${tool}: 경로를 확인하지 못해 막았습니다 (${String(e?.message || e).slice(0, 120)})`);
    return; // 항상 거부 목록만 켜진 상태에서는 확인 실패 시 통과(다른 프로젝트를 막지 않기 위해)
  }
  await checkPath(p, mode, tool);
}
// 검색 범위 (M6)
async function guardSearch(tool: string, args: { parentPath?: string; path?: string }) {
  const c = cfg();
  const scope = args.parentPath ?? args.path;
  if (c.allow.length > 0 && !scope) throw denied(`${tool}: parentPath 를 줘야 합니다 (허용 구역 안 경로)`);
  if (scope) await checkPath(normPath(scope), 'read', tool);
}
function overwriteGuard(isOverwrite: boolean | undefined, name: string | undefined, tool: string) {
  const c = cfg();
  if (c.write.length && isOverwrite && !String(name ?? '').startsWith('_시험_'))
    throw denied(`${tool}: 덮어쓰기는 이름이 _시험_ 으로 시작하는 파일만 됩니다. 새 번호(v2, v3)로 올리세요.`);
}
function permanentGuard(tool: string) {
  if (cfg().blockPermanent) throw denied(`${tool}: 영구 삭제 계열 도구는 NL_BLOCK_PERMANENT_DELETE 로 막혀 있습니다`);
}
// 목록 결과: 항상 거부 항목을 빼고, 허용 구역이 있으면 구역 밖(과 그 갈래가 아닌) 항목을 뺀다. 각 항목에 path 를 붙인다 (M9).
async function decorateList(parentId: string | undefined, result: any) {
  const items = result?.resources;
  if (!Array.isArray(items)) return result;
  seedMeta(items);
  let base: string | null = null;
  try { base = await pathOf(parentId); } catch { base = null; }
  const c = cfg();
  const keep: any[] = [];
  for (const it of items) {
    if (base !== null) {
      const p = normPath(base + '/' + it.name);
      it.path = p + (it.type === 'folder' ? '/' : '');
      if (underAny(p, c.deny)) continue;
      if (c.allow.length && !underAny(p, [...c.allow, ...c.write]) && !isAncestorOfAny(p, [...c.allow, ...c.write])) continue;
    } else if (c.allow.length) {
      continue; // 경로를 모르면 허용 구역이 켜진 상태에서는 보이지 않게 한다
    }
    keep.push(it);
  }
  return { ...result, resources: keep };
}
function filterSearch(result: any) {
  const c = cfg();
  const items = result?.resources;
  if (!Array.isArray(items) || (c.deny.length === 0 && c.allow.length === 0)) return result;
  const keep = items.filter((it: any) => {
    const p = it?.path ? normPath(it.path) : null;
    if (p === null) return c.allow.length === 0;
    if (underAny(p, c.deny)) return false;
    if (c.allow.length && !underAny(p, [...c.allow, ...c.write])) return false;
    return true;
  });
  return { ...result, resources: keep };
}

// 기록 (M8): 쓰기·삭제 호출만, NL_LOG_FILE 이 있을 때만. 파일 내용(content)은 기록하지 않는다.
const WRITE_TOOLS = new Set(['files_create_folder', 'files_upload', 'files_upload_from_path', 'files_copy', 'files_delete', 'files_move',
  'files_rename', 'files_trash_restore', 'files_trash_clean', 'files_trash_clean_resourceId', 'dms_trash_routine', 'nl_write_text']);
function logLine(tool: string, args: any, result: string) {
  const f = cfg().logFile;
  if (!f || !WRITE_TOOLS.has(tool)) return;
  try {
    const a: any = { ...(args || {}) };
    if (typeof a.content === 'string') a.content = `(${Buffer.byteLength(a.content)} bytes)`;
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.appendFileSync(f, `${new Date().toISOString()}\t${tool}\t${JSON.stringify(a)}\t${result}\n`);
  } catch { /* 기록 실패가 작업을 막지 않는다 */ }
}
function reg(name: string, desc: string, schema: any, handler: (args: any) => Promise<any>) {
  server.tool(name, desc, schema, async (args: any) => {
    try {
      const r = await handler(args);
      logLine(name, args, 'ok');
      return r;
    } catch (e: any) {
      logLine(name, args, 'error: ' + String(e?.message || e).slice(0, 200));
      throw e;
    }
  });
}

// 1
server.tool('dms_storage', '내 파일 속성 조회', {}, async () => out(await makeRequest('GET', '/drive/storage')));

// 2
server.tool('dms_root', '루트 파일/폴더 목록 조회', paging, async (args) =>
  out(await decorateList(undefined, await makeRequest('GET', '/drive/resources', undefined, args))));

// 3
server.tool('dms_list', '특정 폴더 내 파일/폴더 목록 조회 (결과 항목에 path 포함)', { resourceId: idParam('조회할 폴더의 ID'), ...paging },
  async ({ resourceId, ...params }) => {
    await guardId(resourceId, 'read', 'dms_list');
    return out(await decorateList(resourceId, await makeRequest('GET', `/drive/folders/${resourceId}/resources`, undefined, params)));
  });

// 4
server.tool('dms_resourceId', '개별 파일/폴더 속성 조회', { resourceId: idParam('파일/폴더 ID') }, async (args) => {
  await guardId(args.resourceId, 'read', 'dms_resourceId');
  return out(await makeRequest('GET', `/drive/resources/${args.resourceId}`));
});

// 5
reg('files_create_folder', '폴더 생성', {
  folderName: z.string().describe('생성할 폴더 이름'),
  parentId: z.string().optional().describe('상위 폴더 ID(생략 시 루트)')
}, async (args) => {
  await guardId(args.parentId, 'write', 'files_create_folder');
  return out(await makeRequest('POST', '/drive/folders', args));
});

// 6 업로드 URL
reg('files_upload', '파일 업로드 URL 생성 (PC 파일을 바로 올리려면 files_upload_from_path)', {
  fileName: z.string(),
  fileSize: z.number(),
  isOverwrite: z.boolean().optional(),
  modifiedTime: z.string().optional(),
  parentId: z.string().optional(),
  resume: z.boolean().optional(),
  offset: z.number().optional()
}, async (args) => {
  await guardId(args.parentId, 'write', 'files_upload');
  overwriteGuard(args.isOverwrite, args.fileName, 'files_upload');
  return out(await makeRequest('POST', '/drive/files', args));
});

// 7 다운로드 URL
server.tool('files_download', '파일 다운로드 URL 생성 (PC 폴더로 바로 받으려면 files_download_to_path)', {
  resourceId: idParam('파일 ID')
}, async (args) => {
  await guardId(args.resourceId, 'read', 'files_download');
  return out(await makeRequest('GET', `/drive/files/${args.resourceId}/download`));
});

// 8 복사 (원본은 읽기 허용이면 되고, 도착 폴더는 쓰기 허용이어야 한다)
reg('files_copy', '파일/폴더 복사', {
  resourceId: idParam('원본 ID'),
  parentId: z.string().optional().describe('복사본을 둘 폴더 ID(생략 시 루트)'),
  name: z.string().optional(),
  isOverwrite: z.boolean().optional()
}, async ({ resourceId, ...body }) => {
  await guardId(resourceId, 'read', 'files_copy');
  await guardId(body.parentId, 'write', 'files_copy');
  overwriteGuard(body.isOverwrite, body.name, 'files_copy');
  return out(await makeRequest('POST', `/drive/resources/${resourceId}/copy`, body));
});

// 9 삭제 (휴지통으로 이동)
reg('files_delete', '파일/폴더 삭제 — 휴지통으로 이동(영구 삭제 아님). 한 번에 하나.', {
  resourceId: idParam('삭제할 파일/폴더 ID')
}, async (args) => {
  await guardId(args.resourceId, 'write', 'files_delete');
  const r = await makeRequest('DELETE', `/drive/resources/${args.resourceId}`);
  deletedHere.add(args.resourceId);
  metaCache.delete(args.resourceId);
  return out(r);
});

// 10 이동 (원본과 도착 폴더 모두 쓰기 허용이어야 한다)
reg('files_move', '파일/폴더 이동', {
  resourceId: idParam('이동할 ID'),
  parentId: z.string().describe('이동할 위치의 폴더 ID'),
  isOverwrite: z.boolean().optional()
}, async ({ resourceId, ...body }) => {
  await guardId(resourceId, 'write', 'files_move');
  await guardId(body.parentId, 'write', 'files_move');
  overwriteGuard(body.isOverwrite, undefined, 'files_move');
  const r = await makeRequest('POST', `/drive/resources/${resourceId}/move`, body);
  metaCache.delete(resourceId);
  return out(r);
});

// 11 이름 변경
reg('files_rename', '파일/폴더 이름 변경 (확장자 포함해서 입력)', {
  resourceId: idParam('ID'),
  name: z.string()
}, async ({ resourceId, ...body }) => {
  await guardId(resourceId, 'write', 'files_rename');
  const r = await makeRequest('POST', `/drive/resources/${resourceId}/rename`, body);
  metaCache.delete(resourceId);
  return out(r);
});

// 12, 13 즐겨찾기 (표시만 바뀌므로 읽기 권한으로 본다)
server.tool('dms_favorite', '즐겨찾기 표시', { resourceId: idParam('ID') }, async (args) => {
  await guardId(args.resourceId, 'read', 'dms_favorite');
  return out(await makeRequest('POST', `/drive/resources/${args.resourceId}/favorite`));
});
server.tool('dms_unfavorite', '즐겨찾기 표시 해제', { resourceId: idParam('ID') }, async (args) => {
  await guardId(args.resourceId, 'read', 'dms_unfavorite');
  return out(await makeRequest('POST', `/drive/resources/${args.resourceId}/unfavorite`));
});

// 14 파일 검색
server.tool('search_files_resources', '파일 검색 (q·category·startDate/endDate 중 하나 이상 필요)', {
  q: z.string().optional().describe('검색어(공백=AND, 확장자도 가능)'),
  category: z.enum(['image', 'video', 'audio', 'document', 'archive', 'executable', 'etc']).optional(),
  startDate: z.string().optional().describe('예: 2026-01-01T00:00:00+09:00'),
  endDate: z.string().optional(),
  dateField: z.enum(['created', 'modified']).optional(),
  parentPath: z.string().optional().describe('이 폴더 아래에서만 검색'),
  count: z.number().optional().describe('20~200'),
  cursor: z.string().optional()
}, async (args) => {
  await guardSearch('search_files_resources', args);
  return out(filterSearch(await makeRequest('GET', '/search/resources/files', undefined, args)));
});

// 15 폴더 검색
server.tool('search_folders_resources', '폴더 검색 (q·path·startDate/endDate 중 하나 이상 필요)', {
  q: z.string().optional(),
  path: z.string().optional().describe('지정한 폴더 안에서만 검색(다른 조건 무시)'),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  dateField: z.enum(['created', 'modified']).optional(),
  parentPath: z.string().optional(),
  count: z.number().optional().describe('20~200'),
  cursor: z.string().optional()
}, async (args) => {
  await guardSearch('search_folders_resources', args);
  return out(filterSearch(await makeRequest('GET', '/search/resources/folders', undefined, args)));
});

// 16~20 휴지통
server.tool('dms_trash_list', '휴지통 목록 조회', paging, async (args) =>
  out(await makeRequest('GET', '/drive/trash', undefined, args)));
reg('files_trash_restore', '휴지통 파일/폴더 복원(원래 위치)', {
  resourceId: idParam('ID'),
  isOverwrite: z.boolean().optional()
}, async ({ resourceId, ...body }) => {
  await guardId(resourceId, 'write', 'files_trash_restore', { restoring: true });
  overwriteGuard(body.isOverwrite, undefined, 'files_trash_restore');
  const r = await makeRequest('POST', `/drive/trash/${resourceId}/restore`, body);
  deletedHere.delete(resourceId);
  metaCache.delete(resourceId);
  return out(r);
});
reg('files_trash_clean_resourceId', '휴지통의 파일/폴더 하나를 영구 삭제 (되돌릴 수 없음)', {
  resourceId: idParam('ID')
}, async (args) => {
  permanentGuard('files_trash_clean_resourceId');
  return out(await makeRequest('DELETE', `/drive/trash/${args.resourceId}`));
});
reg('files_trash_clean', '휴지통 전체 영구 삭제 — 비우기 (되돌릴 수 없음)', {}, async () => {
  permanentGuard('files_trash_clean');
  return out(await makeRequest('DELETE', '/drive/trash'));
});
reg('dms_trash_routine', '휴지통 자동 삭제 주기 설정 (0=끔, 5, 15, 30, 50일)', {
  trashAutoDeleteDays: z.number()
}, async (args) => {
  permanentGuard('dms_trash_routine');
  return out(await makeRequest('PATCH', '/drive/storage', args));
});

// ---- 추가: PC 경로로 바로 받기/올리기 --------------------------------------
server.tool('files_download_to_path', '파일을 PC의 지정 폴더에 바로 내려받기 (같은 이름·같은 크기면 건너뜀)', {
  resourceId: idParam('파일 ID'),
  destDir: z.string().describe('저장할 PC 폴더 (예: D:\\nodelab_temp\\blog-writing\\00-받기)'),
  fileName: z.string().optional()
}, async (args) => {
  await guardId(args.resourceId, 'read', 'files_download_to_path');
  const meta: any = await makeRequest('GET', `/drive/resources/${args.resourceId}`);
  const name = args.fileName || meta.name || args.resourceId;
  fs.mkdirSync(args.destDir, { recursive: true });
  const target = path.join(args.destDir, name);
  if (meta.size && fs.existsSync(target) && fs.statSync(target).size === meta.size) {
    return out({ path: target, skipped: true, bytes: meta.size });
  }
  const ticket: any = await makeRequest('GET', `/drive/files/${args.resourceId}/download`);
  const res = await fetch(ticket.downloadUrl); // 서명된 주소: 토큰을 보내지 않는다
  if (!res.ok) throw new Error('download failed ' + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  const part = target + '.part';
  fs.writeFileSync(part, buf);
  fs.renameSync(part, target);
  return out({ path: target, skipped: false, bytes: buf.length, expected: meta.size ?? null });
});

async function uploadBytes(fileName: string, bytes: Buffer, parentId: string | undefined, isOverwrite: boolean) {
  const body: any = { fileName, fileSize: bytes.length, isOverwrite };
  if (parentId) body.parentId = parentId;
  const ticket: any = await makeRequest('POST', '/drive/files', body);
  const form = new FormData();
  form.append('Filedata', new Blob([new Uint8Array(bytes)]), fileName);
  const res = await fetch(ticket.uploadUrl, { method: 'POST', body: form });
  const text = await res.text();
  if (!res.ok) throw new Error('upload failed ' + res.status + ' ' + text.slice(0, 200));
  return { name: fileName, bytes: bytes.length, status: res.status };
}

reg('files_upload_from_path', 'PC의 파일 하나를 MYBOX에 올리기', {
  filePath: z.string(),
  parentId: z.string().optional().describe('올릴 폴더 ID(생략 시 루트)'),
  isOverwrite: z.boolean().optional()
}, async (args) => {
  const st = fs.statSync(args.filePath);
  if (!st.isFile()) throw new Error('not a file');
  const fileName = path.basename(args.filePath);
  await guardId(args.parentId, 'write', 'files_upload_from_path');
  overwriteGuard(args.isOverwrite, fileName, 'files_upload_from_path');
  return out(await uploadBytes(fileName, fs.readFileSync(args.filePath), args.parentId, !!args.isOverwrite));
});

// ---- 추가(1.2.0): 작은 텍스트 파일을 대화로 바로 읽고 쓰기 (M7) ------------------
const TEXT_EXT = new Set(['.txt', '.md', '.json', '.csv', '.tsv', '.html', '.htm', '.css', '.js', '.mjs', '.ts', '.tsx', '.jsx', '.py',
  '.xml', '.yml', '.yaml', '.log', '.svg', '.ini', '.toml']);
const TEXT_MAX = 1024 * 1024; // 1MB
const hasTextExt = (name: string) => TEXT_EXT.has(path.extname(String(name)).toLowerCase());

server.tool('nl_read_text', '허용 구역의 작은 텍스트·JSON·MD 파일(기본 1MB 이하)을 읽어 내용을 바로 돌려준다. 이미지·PDF·큰 파일은 files_download_to_path 를 쓴다.', {
  resourceId: idParam('파일 ID'),
  maxBytes: z.number().optional().describe('읽을 최대 크기(바이트). 기본·상한 1048576')
}, async (args) => {
  await guardId(args.resourceId, 'read', 'nl_read_text');
  const meta: any = await makeRequest('GET', `/drive/resources/${args.resourceId}`);
  if (meta.type === 'folder') throw new Error('폴더는 읽을 수 없습니다');
  if (!hasTextExt(meta.name)) throw new Error(`텍스트 파일 확장자가 아닙니다 (${meta.name}). files_download_to_path 를 쓰세요`);
  const limit = Math.min(args.maxBytes ?? TEXT_MAX, TEXT_MAX);
  if ((meta.size ?? 0) > limit) throw new Error(`파일이 큽니다 (${meta.size} > ${limit} 바이트). files_download_to_path 를 쓰세요`);
  const ticket: any = await makeRequest('GET', `/drive/files/${args.resourceId}/download`);
  const res = await fetch(ticket.downloadUrl);
  if (!res.ok) throw new Error('download failed ' + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  return out({ name: meta.name, bytes: buf.length, expected: meta.size ?? null, text: buf.toString('utf8') });
});

reg('nl_write_text', '새 텍스트 파일을 MYBOX 폴더에 올린다(덮어쓰기 없음, 내용 1MB 이하). 같은 이름이 있으면 실패하니 v2, v3 로 새 이름을 쓴다.', {
  parentId: idParam('올릴 폴더 ID'),
  fileName: z.string().describe('확장자 포함 (예: 20261019_메모_v1.md)'),
  content: z.string()
}, async (args) => {
  if (!hasTextExt(args.fileName)) throw new Error('텍스트 확장자(.txt .md .json …)만 올릴 수 있습니다');
  const bytes = Buffer.from(args.content, 'utf8');
  if (bytes.length > TEXT_MAX) throw new Error(`내용이 큽니다 (${bytes.length} > ${TEXT_MAX} 바이트)`);
  await guardId(args.parentId, 'write', 'nl_write_text');
  return out(await uploadBytes(args.fileName, bytes, args.parentId, false));
});

async function run() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('MYBOX MCP Server running on stdio');
}

run().catch((error) => {
  console.error('Fatal error in main():', error);
  process.exit(1);
});
