# nl-mybox-mcp

노드랩 수정판 MYBOX MCP. 원본 minking/mybox-mcp (MIT)의 API 주소를 네이버 MYBOX Open API 공식 문서대로 고치고,
PC 경로로 바로 받기/올리기 도구 2개(files_download_to_path, files_upload_from_path)를 더했다. 도구 22개.

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
