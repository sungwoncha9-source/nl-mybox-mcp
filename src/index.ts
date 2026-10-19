#!/usr/bin/env node
// mybox-mcp (노드랩 수정판) — 원본: minking/mybox-mcp (MIT)
// 수정: 모든 API 주소를 네이버 MYBOX Open API 공식 문서(developers.mybox.naver.com, 2026-10-19 확인)대로 고침.
//       PC 파일 경로로 바로 내려받기/올리기 도구 2개 추가.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import axios from 'axios';
import fs from 'node:fs';
import path from 'node:path';

const server = new McpServer({ name: 'mybox-mcp', version: '1.1.0' });
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

// 1
server.tool('dms_storage', '내 파일 속성 조회', {}, async () => out(await makeRequest('GET', '/drive/storage')));

// 2
server.tool('dms_root', '루트 파일/폴더 목록 조회', paging, async (args) =>
  out(await makeRequest('GET', '/drive/resources', undefined, args)));

// 3
server.tool('dms_list', '특정 폴더 내 파일/폴더 목록 조회', { resourceId: idParam('조회할 폴더의 ID'), ...paging },
  async ({ resourceId, ...params }) =>
    out(await makeRequest('GET', `/drive/folders/${resourceId}/resources`, undefined, params)));

// 4
server.tool('dms_resourceId', '개별 파일/폴더 속성 조회', { resourceId: idParam('파일/폴더 ID') }, async (args) =>
  out(await makeRequest('GET', `/drive/resources/${args.resourceId}`)));

// 5
server.tool('files_create_folder', '폴더 생성', {
  folderName: z.string().describe('생성할 폴더 이름'),
  parentId: z.string().optional().describe('상위 폴더 ID(생략 시 루트)')
}, async (args) => out(await makeRequest('POST', '/drive/folders', args)));

// 6 업로드 URL
server.tool('files_upload', '파일 업로드 URL 생성 (PC 파일을 바로 올리려면 files_upload_from_path)', {
  fileName: z.string(),
  fileSize: z.number(),
  isOverwrite: z.boolean().optional(),
  modifiedTime: z.string().optional(),
  parentId: z.string().optional(),
  resume: z.boolean().optional(),
  offset: z.number().optional()
}, async (args) => out(await makeRequest('POST', '/drive/files', args)));

// 7 다운로드 URL
server.tool('files_download', '파일 다운로드 URL 생성 (PC 폴더로 바로 받으려면 files_download_to_path)', {
  resourceId: idParam('파일 ID')
}, async (args) => out(await makeRequest('GET', `/drive/files/${args.resourceId}/download`)));

// 8 복사
server.tool('files_copy', '파일/폴더 복사', {
  resourceId: idParam('원본 ID'),
  parentId: z.string().optional().describe('복사본을 둘 폴더 ID(생략 시 루트)'),
  name: z.string().optional(),
  isOverwrite: z.boolean().optional()
}, async ({ resourceId, ...body }) => out(await makeRequest('POST', `/drive/resources/${resourceId}/copy`, body)));

// 9 삭제 (휴지통으로 이동)
server.tool('files_delete', '파일/폴더 삭제 — 휴지통으로 이동(영구 삭제 아님). 한 번에 하나.', {
  resourceId: idParam('삭제할 파일/폴더 ID')
}, async (args) => out(await makeRequest('DELETE', `/drive/resources/${args.resourceId}`)));

// 10 이동
server.tool('files_move', '파일/폴더 이동', {
  resourceId: idParam('이동할 ID'),
  parentId: z.string().describe('이동할 위치의 폴더 ID'),
  isOverwrite: z.boolean().optional()
}, async ({ resourceId, ...body }) => out(await makeRequest('POST', `/drive/resources/${resourceId}/move`, body)));

// 11 이름 변경
server.tool('files_rename', '파일/폴더 이름 변경 (확장자 포함해서 입력)', {
  resourceId: idParam('ID'),
  name: z.string()
}, async ({ resourceId, ...body }) => out(await makeRequest('POST', `/drive/resources/${resourceId}/rename`, body)));

// 12, 13 즐겨찾기
server.tool('dms_favorite', '즐겨찾기 표시', { resourceId: idParam('ID') }, async (args) =>
  out(await makeRequest('POST', `/drive/resources/${args.resourceId}/favorite`)));
server.tool('dms_unfavorite', '즐겨찾기 표시 해제', { resourceId: idParam('ID') }, async (args) =>
  out(await makeRequest('POST', `/drive/resources/${args.resourceId}/unfavorite`)));

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
}, async (args) => out(await makeRequest('GET', '/search/resources/files', undefined, args)));

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
}, async (args) => out(await makeRequest('GET', '/search/resources/folders', undefined, args)));

// 16~20 휴지통
server.tool('dms_trash_list', '휴지통 목록 조회', paging, async (args) =>
  out(await makeRequest('GET', '/drive/trash', undefined, args)));
server.tool('files_trash_restore', '휴지통 파일/폴더 복원(원래 위치)', {
  resourceId: idParam('ID'),
  isOverwrite: z.boolean().optional()
}, async ({ resourceId, ...body }) => out(await makeRequest('POST', `/drive/trash/${resourceId}/restore`, body)));
server.tool('files_trash_clean_resourceId', '휴지통의 파일/폴더 하나를 영구 삭제 (되돌릴 수 없음)', {
  resourceId: idParam('ID')
}, async (args) => out(await makeRequest('DELETE', `/drive/trash/${args.resourceId}`)));
server.tool('files_trash_clean', '휴지통 전체 영구 삭제 — 비우기 (되돌릴 수 없음)', {}, async () =>
  out(await makeRequest('DELETE', '/drive/trash')));
server.tool('dms_trash_routine', '휴지통 자동 삭제 주기 설정 (0=끔, 5, 15, 30, 50일)', {
  trashAutoDeleteDays: z.number()
}, async (args) => out(await makeRequest('PATCH', '/drive/storage', args)));

// ---- 추가: PC 경로로 바로 받기/올리기 --------------------------------------
server.tool('files_download_to_path', '파일을 PC의 지정 폴더에 바로 내려받기 (같은 이름·같은 크기면 건너뜀)', {
  resourceId: idParam('파일 ID'),
  destDir: z.string().describe('저장할 PC 폴더 (예: D:\\nodelab_temp\\blog-writing\\00-받기)'),
  fileName: z.string().optional()
}, async (args) => {
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

server.tool('files_upload_from_path', 'PC의 파일 하나를 MYBOX에 올리기', {
  filePath: z.string(),
  parentId: z.string().optional().describe('올릴 폴더 ID(생략 시 루트)'),
  isOverwrite: z.boolean().optional()
}, async (args) => {
  const st = fs.statSync(args.filePath);
  if (!st.isFile()) throw new Error('not a file');
  const fileName = path.basename(args.filePath);
  const body: any = { fileName, fileSize: st.size, isOverwrite: !!args.isOverwrite };
  if (args.parentId) body.parentId = args.parentId;
  const ticket: any = await makeRequest('POST', '/drive/files', body);
  const form = new FormData();
  form.append('Filedata', new Blob([fs.readFileSync(args.filePath)]), fileName);
  const res = await fetch(ticket.uploadUrl, { method: 'POST', body: form });
  const text = await res.text();
  if (!res.ok) throw new Error('upload failed ' + res.status + ' ' + text.slice(0, 200));
  return out({ name: fileName, bytes: st.size, status: res.status });
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
