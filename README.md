# nl-mybox-mcp

노드랩 수정판 MYBOX MCP. 원본 minking/mybox-mcp (MIT)의 API 주소를 네이버 MYBOX Open API 공식 문서대로 고치고,
PC 경로로 바로 받기/올리기 도구 2개(files_download_to_path, files_upload_from_path)를 더했다. 도구 24개(일감 도구 2개 포함).

`mybox-mcp.mjs`는 `src/index.ts`를 esbuild로 묶은 단일 파일이라 설치·빌드가 필요 없다.

## Claude 데스크톱 설정
```json
"mybox-mcp": {
  "command": "npx",
  "args": ["-y", "github:sungwoncha9-source/nl-mybox-mcp"],
  "env": { "MYBOX_ACCESS_TOKEN": "<본인 토큰>" }
}
```
토큰은 설정의 env에만 둔다. 이 저장소에 넣지 않는다.

## 다시 묶기
`npm i --no-save esbuild @modelcontextprotocol/sdk axios zod` 후
`esbuild src/index.ts --bundle --platform=node --format=esm --target=node20 --outfile=mybox-mcp.mjs`
(맨 앞에 createRequire 배너 필요)

## 일감(job) 도구 — 화면이 조각을 동시에 보내는 길 (v1.6.0)
- `job_put_chunk`: 조각 하나를 받는다. 어떤 순서로 몇 개가 동시에 와도 되고, 같은 조각을 다시 보내도 안전하다.
  모든 호출에 같은 `job_id`와 `files`(이름·크기·sha256)를 싣는다. 파일이 다 모이면 sha256을 대조하고, 일감의 모든 파일이 모이면
  PC가 스스로 올리기 → MYBOX 크기 대조 → 작업 폴더를 `_trash`로 이동을 한다(기다리지 않고 바로 답함). `dry_run:true`면 올리기를 건너뛴다.
- `job_status`: 진행·마무리 결과를 읽는다(읽기 전용). 기록은 `<NL_JOBS_DIR>\_results\<job_id>.json`.
- 만료: 마지막 조각 뒤 `NL_JOB_IDLE_SEC`초(기본 1800=30분) 넘게 조용한 일감은 작업 폴더를 `_trash`로 옮기고 `failed(timeout)`으로 표시한다(마무리 도중 멈춘 일감은 사본을 남기고 `failed(interrupted)`). 같은 job_id로 다시 보내면 새 job_id를 안내한다.
- 작업 폴더: 환경변수 `NL_JOBS_DIR`(기본 `D:\nodelab_work\_jobs`). 토큰은 다루지 않는다(기존 올리기 코드를 안에서 부른다).
- 시험: `node test/jobs.mjs ./mybox-mcp.mjs` (가짜 MYBOX 서버로 전 흐름 20항목). 시험용 환경변수 `MYBOX_BASE_URL`은 시험 말고는 쓰지 않는다.

## 묶음(bundle) — 파일이 많을 때 호출 수를 줄이는 길 (v1.9.0 → 1.9.1)
화면(아티팩트)에서 한 클릭에 보낼 수 있는 호스트 호출은 약 30개 안팎이라, 파일마다 조각 호출을 하면 파일 수만큼 호출이 든다.
`job_put_chunk`에 `bundle:'pack1'`을 주면 `files`는 묶음 파일 하나뿐이고, 호출 수는 묶음의 바이트 수(조각 ≤1MiB)에 비례한다.
- 묶음 형식: `NLP1`(4바이트) + 목록 길이(uint32 BE) + 목록 JSON `{entries:[{name,size,sha256,parent_id?}]}` + 파일 바이트를 목록 순서대로 이어 붙인 것. 한도: 묶음 하나 ≤200MiB, 항목 ≤500개, 목록 ≤1MiB. 더 크면 여러 `job_id`로 나눈다.
- 같은 이름도 **대상 폴더가 다르면** 허용한다(1.9.1). 같은 폴더·같은 이름만 거절한다. 1.9.2부터 이름 비교는 모두 `normName`(유니코드 NFC + 소문자) 한 곳이다: 대소문자만 다르거나 한글 NFC/NFD만 다른 이름도 같은 이름으로 본다.
- **실효 목적 폴더**(1.9.2): 항목의 `parent_id`를 생략하면 일감의 기본 폴더(또는 새 하위 폴더)로 간다. 그 실제 폴더를 먼저 확정하고 (폴더, 정규화한 이름)이 겹치면 업로드를 시작하기 전에 일감 전체를 `duplicate_target`으로 막는다(아무것도 올리지 않음).
- 원격 파일 목록의 이름도 같은 정규화 키로 비교한다. 같은 이름이 있으면 `exists`, 덮어쓰기를 허용했더라도 이름이 대소문자·글자 구성만 다른 기존 파일이 있으면 `case_conflict`로 올리지 않는다.
- 마지막 조각이 오면 PC가 묶음을 1MiB씩 읽어 풀면서 파일마다 sha256을 대조하고, 폴더마다 목록을 한 번 읽어 **같은 이름이 있으면 올리지 않고**(`exists`), 올린 뒤 폴더 목록을 다시 읽어 크기를 대조한다. 파일별 결과는 `entries`(uploaded·size_verified·content_verified·verified·error)로 `job_status`와 마지막 호출 응답에 나온다.
- `verified` = 크기 대조(`size_verified`) 통과 + (`verify_content:true`면) 내용 대조(`content_verified`)도 통과. 크기만 대조한 파일은 `content_verified:null` = "내용은 확인 안 함".
- `verify_content:true`(선택, 느림): 올린 파일을 MYBOX에서 내려받아 sha256까지 비교한다. 같은 크기·다른 바이트를 잡는다.
- `upload_concurrency`(1~4, 기본 1): 마무리 때 동시에 올릴 파일 수. MYBOX 올리기 요청 수는 같고 기다리는 시간만 줄인다. 실제 MYBOX의 속도 제한은 확인 전이라 기본은 1.
- 디스크 여유가 모자라면 받기 전에 `disk_full`로 거절한다(`NL_MIN_FREE_MB`, 기본 64). 일감 기록도 만들지 않으므로 같은 `job_id`로 다시 보낼 수 있다.
- 쓸 수 있는 폴더 허용 목록: 환경변수 `NL_JOB_ALLOWED_PARENTS`(쉼표로 폴더 ID, 또는 `tree:<ID>` = 그 폴더와 모든 하위). 비어 있으면 제한 없음. 허용 밖 폴더로 가는 파일만 `not_allowed`로 막히고 나머지는 진행.
- 성공하면 풀어 둔 사본은 지우고 `_trash`에는 묶음 파일(증거)만 남긴다. 실패하면 풀어 둔 사본까지 그대로 둔다. 실패분은 새 `job_id`로 다시 보낸다.
- 업로드 본체는 파일 기반 Blob으로 보내 큰 파일을 통째로 메모리에 올리지 않는다(Node 19.8+).
- 구버전 서버는 `bundle`을 모르고 묶음 파일 자체를 올려 버린다 → 호출하는 쪽은 도구 설명에 `pack1`이 있는지 먼저 확인할 것.
- 시험: `node test/bundle.mjs <번들>`(45건) · `test/capacity.mjs`(용량 기준 7건) · `test/http.mjs`(HTTP 16건) · `test/jobs.mjs`(기존 58건). 모두 가짜 MYBOX.

## Streamable HTTP (v1.9.1, 시험용·기본 꺼짐)
`NL_TRANSPORT=http`일 때만 같은 서버를 HTTP로 연다(`src/http.ts`). 공개 서비스가 아니다.
- 토큰(`NL_HTTP_TOKEN` 24자 이상) 없으면 시작하지 않고, 기본 바인딩은 127.0.0.1이다(다른 주소는 `NL_HTTP_ALLOW_REMOTE=1`).
- Host 헤더를 점검하고, 브라우저 출처(Origin)는 `NL_HTTP_ORIGINS` 허용 목록에 있는 것만 받는다.
- HTTP로는 일감 도구(`NL_HTTP_TOOLS`, 기본 `job_put_chunk,job_status`)만 열고 나머지(삭제·이동 등)는 비활성화한다.
- 세션은 하나다(한 번에 클라이언트 하나). 외부 공개·인증 방식·비용은 이 모듈이 정하지 않는다.

## 영구 삭제 차단 가드 (v1.9.3)
지침(영구 삭제·휴지통 비우기 금지)을 서버가 받쳐 준다. 환경변수·인자로 풀 수 없다.
- 거부 도구 3개: `files_trash_clean`(비우기), `files_trash_clean_resourceId`(개별 영구 삭제), `dms_trash_routine`(휴지통 자동 삭제 주기 설정 — MYBOX가 나중에 영구 삭제하게 되므로 0 포함 모두 거부). 목록에는 `[차단됨]`으로 남고, 호출하면 이유를 담은 오류 응답만 오며 **MYBOX에는 요청을 보내지 않는다**.
- 이중 장치: 모든 요청이 지나는 `makeRequest`에서도 `DELETE /drive/trash*`, `trashAutoDeleteDays`가 든 `/drive/storage` 쓰기를 막는다(나중에 도구가 늘어도 같은 길이면 막힘).
- 그대로 되는 것: `files_delete`(휴지통 이동), `dms_trash_list`, `files_trash_restore`, 읽기 전부.
- 확인하지 못한 것 (B): `files_delete`가 어떤 조건에서도 휴지통을 거친다는 것은 도구 설명과 공식 문서 기록에 의존한다(실제 MYBOX로는 시험하지 않았다). `isOverwrite:true`(files_copy·files_move·files_trash_restore·files_upload_from_path·job_put_chunk의 `is_overwrite`)로 덮어쓸 때 기존 파일이 휴지통에 남는지도 미확인이며 이번 가드에는 포함하지 않았다.
- 시험: `node test/guard.mjs <번들>` (가짜 MYBOX 30건). 중앙 가드만 단독으로 보려면 도구 쪽 거부를 뺀 변형 번들로 같은 시험을 돌린다.

## 번들 두 가지 (1.9.2)
- `mybox-mcp.mjs`: **PC 적용용 stdio 번들.** HTTP 코드가 들어 있지 않다(`--define:__HTTP__=false`). `NL_TRANSPORT=http`를 주면 안내 후 종료한다.
- `mybox-mcp-http.mjs`: HTTP 시험용(`--define:__HTTP__=true`). PC 적용에는 쓰지 않는다.
- 빌드: `esbuild src/index.ts --bundle --platform=node --format=esm --target=node20 --define:__HTTP__=<false|true> --banner:js="import{createRequire as __cr}from'module';const require=__cr(import.meta.url);" --outfile=<파일>` (패키지: sdk 1.32.0, axios 1.20.0, zod 4.6.7).
- 시작 때 `NL_JOB_ALLOWED_PARENTS`가 비어 있으면 stderr에 경고를 남긴다(비어 있으면 어느 폴더로든 올릴 수 있다).
