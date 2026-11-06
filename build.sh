# mybox-mcp 다시 묶기 (1.10.0). 준비: npm i --no-save esbuild @modelcontextprotocol/sdk axios zod jose
# (src/index.ts 첫 줄의 #!가 맨 앞에 남는다)
#  mybox-mcp.mjs      = PC용 stdio 번들(HTTP 코드 없음)  · npx github:… 로 PC에서 실행되는 파일
#  mybox-mcp-http.mjs = 클라우드용 HTTP 번들(NL_TRANSPORT=http, NL_AUTH=token|oauth)
set -e
B=$(printf 'import{createRequire as __cr}from%smodule%s;const require=__cr(import.meta.url);' "'" "'")
npx esbuild src/index.ts --bundle --platform=node --format=esm --target=node20 --define:__HTTP__=false --banner:js="$B" --outfile=mybox-mcp.mjs --log-level=warning
npx esbuild src/index.ts --bundle --platform=node --format=esm --target=node20 --define:__HTTP__=true --banner:js="$B" --outfile=mybox-mcp-http.mjs --log-level=warning
chmod +x mybox-mcp.mjs mybox-mcp-http.mjs
