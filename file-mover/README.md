# 노드랩 파일 이동기 (file-mover)

피그마·어도비와 PC 폴더 사이로 파일을 옮기는 MCP 프로그램. 클로드가 주소와 경로만 말하면 이 프로그램이 직접 옮깁니다.

## 설치 (사장님 PC, 1회)
1. 폴더: `D:\nodelab_work\file-mover\` (server.js 가 들어 있음). Node 18 이상 필요(nodelab-fs 가 이미 돌면 있음).
2. 클로드 데스크톱 설정의 MCP 서버 목록(claude_desktop_config.json 의 mcpServers)에 추가:
```json
"nodelab-file-mover": {
  "command": "node",
  "args": ["D:\\nodelab_work\\file-mover\\server.js"],
  "env": { "MOVER_ALLOWED_DIRS": "D:\\nodelab_work" }
}
```
3. 클로드 데스크톱 재시작 → 새 대화에서 "file_stat 도구 보이는지" 확인.

## 환경변수 (선택)
- MOVER_ALLOWED_DIRS: 읽고 쓸 수 있는 폴더(여러 개는 `;` 구분). 기본 D:\nodelab_work
- MOVER_ALLOWED_HOSTS: 접속 허용 사이트(쉼표 구분). 기본 figma/adobe/amazonaws/cloudfront 등
- MOVER_MAX_BYTES: 한 번에 옮길 최대 크기. 기본 104857600(100MB)

## 시험
`node test/run.js` → 16 passed 가 나와야 정상.

## 쓰는 순서
- 피그마 올리기: upload_assets → **바로** send_file(mode=multipart, url=submitUrl)  (10분 만료, 1회용)
- 피그마 내려받기: download_assets → receive_file(url, dest_dir)
- 어도비 올리기: file_stat → asset_initialize_file_upload → 블록마다 send_file(mode=raw, method=PUT, offset, length) → asset_finalize_file_upload
- 어도비 내려받기: 편집 결과 URL → receive_file
