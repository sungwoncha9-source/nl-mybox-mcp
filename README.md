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
