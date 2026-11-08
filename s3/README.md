# S3 시험 전용 가지 (w1/cache-fix-s3)
- 목적: 폴더 검사 캐시 제거 + 올리기 직전 재확인(수정 번들)을 Cloudtype 실제 실행 환경에서 가짜 MYBOX로 시험한다. 합성 데이터만.
- 시작: `node s3/start.mjs` → 가짜 MYBOX(127.0.0.1) + 기준 번들(`s3/baseline-http.mjs` = w1/deploy-b1)과 수정 번들(`mybox-mcp-http.mjs`)을 같은 시험으로 비교. 결과는 로그(`SELFTEST …`)와 `/selftest.json`.
- fail-closed: MYBOX 토큰·주소·OAuth 설정이 환경에 있으면 시작 거부, 자식 프로세스 환경은 허용 목록으로만 구성.
- main·w1/deploy-b1·S1과 무관. 실제 MYBOX·운영 DB·본판 접근 없음.
