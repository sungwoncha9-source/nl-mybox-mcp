# nl-mybox-mcp

노드랩 수정판 MYBOX MCP. 원본 minking/mybox-mcp (MIT)의 API 주소를 네이버 MYBOX Open API 공식 문서대로 고치고,
PC 경로로 바로 받기/올리기 도구 2개(files_download_to_path, files_upload_from_path)를 더했다.
1.2.0부터 작은 텍스트 읽기·쓰기 도구 2개(nl_read_text, nl_write_text)와 안전 장치가 더해져 도구는 24개다.

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

## 안전 장치 (1.2.0) — 환경변수로 켠다
> 구역(허용·쓰기 경로)의 정본은 브로셔 디자인 프로젝트 지침 5-2장이다. 여기에 넣는 값은 그 사본이다. 구역을 바꾸면 두 곳을 같이 고친다.

이 MCP는 여러 프로젝트가 같이 쓰므로 **환경변수를 넣지 않으면 1.1.0과 똑같이 동작한다.** 예외는 항상 거부 목록 하나다.

| 환경변수 | 하는 일 | 없을 때 |
|---|---|---|
| `NL_ALLOW_ROOTS` | 읽기 허용 경로 목록. 목록 밖 폴더·파일 조회와 검색을 거부. 검색은 `parentPath`(또는 `path`) 필수 | 제한 없음 |
| `NL_WRITE_ROOTS` | 쓰기(올리기·폴더 만들기·이동·이름 바꾸기·복사 도착지·삭제·복원)를 이 안으로만. 덮어쓰기는 `_시험_` 이름만 | 제한 없음 |
| `NL_DENY_PATHS` | 누가 불러도 거부하는 경로와 그 하위 | `/NPKI`, `/b0_업무_관리/관리_세무자료`, `/b0_업무_관리/관리_주식` (빈 값으로 두면 끔) |
| `NL_BLOCK_PERMANENT_DELETE` | `1`이면 휴지통 비우기·영구 삭제·휴지통 주기 설정을 거부 | 막지 않음 |
| `NL_LOG_FILE` | 쓰기·삭제 호출을 한 줄씩 기록(파일 내용은 기록하지 않음) | 기록 안 함 |

- 경로는 `;` 또는 줄바꿈으로 구분하고 `/b0_업무_관리/...` 처럼 루트부터 적는다.
- 항목 경로는 `parentId`를 위로 따라 올라가 만든다(5분 캐시). 허용·쓰기 목록이 켜진 상태에서 경로를 못 구하면 거부한다. 거부 목록만 켜진 상태에서는 통과시킨다.
- 목록·루트 조회 결과에는 `path`가 붙고, 거부 경로와 허용 구역 밖 항목은 빠진다.
- `nl_read_text`: 텍스트 확장자 파일(1MB 이하)을 읽어 내용을 돌려준다. `nl_write_text`: 새 텍스트 파일을 올린다(덮어쓰기 없음).
