# 노드랩 파일 이동기 (file-mover)

피그마·어도비와 PC 폴더 사이로 파일을 옮기는 MCP 프로그램. 클로드가 주소와 경로만 말하면 이 프로그램이 직접 옮깁니다.
v1.2부터는 화면(아티팩트)이 MCP로 보낸 파일 바이트도 받아 PC 허용 폴더에 씁니다(receive_bytes).

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
   (GitHub 로 받는 방식: `"command":"npx","args":["-y","-p","github:sungwoncha9-source/nl-mybox-mcp#add-file-mover","nl-file-mover"]` — 되돌릴 때는 `#add-file-mover` 대신 커밋으로 고정: v1.0 `#60b236e`, v1.1 `#3633235`)
   (npx는 같은 주소를 캐시해 두므로, 새 판을 받으려면 `#add-file-mover` 대신 새 커밋 번호를 적거나 npx 캐시 폴더 `%LOCALAPPDATA%\npm-cache\_npx`를 지우고 재시작)
3. 클로드 데스크톱 재시작 → 새 대화에서 "file_stat 도구 보이는지" 확인.

## 환경변수 (선택)
- MOVER_ALLOWED_DIRS: 읽고 쓸 수 있는 폴더(여러 개는 `;` 구분). 기본 D:\nodelab_work. 예: `D:\nodelab_work;D:\nodelab_temp`
- MOVER_ALLOWED_HOSTS: 접속 허용 사이트(쉼표 구분). 기본 figma/adobe/amazonaws/cloudfront 등
- MOVER_MAX_BYTES: 한 번에 옮길 최대 크기. 기본 104857600(100MB)
- MOVER_PROTECTED: 지우면 안 되는 경로 추가(`;` 구분). 기본 보호: agent, file-mover, _trash

## 도구 5개
file_stat(확인) · send_file(PC→주소) · receive_file(주소→PC) · delete_path(삭제) · receive_bytes(보낸 바이트→PC, v1.2)

## 바이트 받아 쓰기 (receive_bytes, v1.2)
- 화면(아티팩트)이 파일을 MCP 도구로 넘길 때 쓴다. 파일은 `content_base64`(base64 글자)로 온다. 화면 쪽은 MCP의 `$file` 인자를 이 자리에 두면 16MiB까지 보낼 수 있다.
- 인자: `dest_dir`(허용 폴더 안, 없으면 만듦) · `filename`(경로 문자는 `_`로 바뀜) · `content_base64` · 선택 `overwrite` · `sha256`(주면 전송 중 깨짐을 확인).
- 같은 이름이 있으면 `_1`,`_2`를 붙여 보존. 실제로 저장된 이름은 결과의 `saved_path`로 돌려주니 그 값을 써야 한다. `overwrite:true`면 덮어씀.
- 큰 파일은 순서대로 나눠 보낸다: 매번 `offset`(0부터, 지금까지 받은 크기와 같아야 함)과 `total_bytes`(전체 크기)를 같이 보낸다. 마지막 조각이 오면 `done:true`와 `saved_path`·`sha256`을 돌려준다. 순서가 어긋나면 거절하고 받은 부분은 보존, `offset:0`이면 처음부터 다시.
- `agent`·`file-mover`·`_trash`(및 그 안)에는 쓸 수 없다. 허용 폴더 밖, `..`, 링크 탈출, 같은 이름의 폴더도 거절. 한 번에 최대 `MOVER_MAX_BYTES`(기본 100MB).
- 쓰는 순서(MYBOX까지): receive_bytes로 PC 허용 폴더에 쓰기 → 결과 `saved_path`를 mybox-mcp의 `files_upload_from_path`에 넘기기.

## 삭제 (delete_path, v1.1)
- 기본은 휴지통: 허용 폴더 안 `_trash\<날짜시각>_<이름>` 으로 옮김(복구 가능). 기록은 `_trash\delete_log.jsonl`.
- 비어 있지 않은 폴더는 `recurse:true` 필요. `permanent:true` 면 완전 삭제. `_trash` 안의 항목을 지우면 영구 삭제.
- 허용 폴더 밖, `..`·링크 탈출, 허용 루트 자체, 보호 경로(및 그것을 포함한 상위 폴더)는 거절하고 이유를 돌려줌.

## 시험
`npm test` → `16 passed`, `22 passed`, `31 passed` 가 차례로 나와야 정상.

## 쓰는 순서
- 피그마 올리기: upload_assets → **바로** send_file(mode=multipart, url=submitUrl)  (10분 만료, 1회용)
- 피그마 내려받기: download_assets → receive_file(url, dest_dir)
- 어도비 올리기: file_stat → asset_initialize_file_upload → 블록마다 send_file(mode=raw, method=PUT, offset, length) → asset_finalize_file_upload
- 어도비 내려받기: 편집 결과 URL → receive_file
