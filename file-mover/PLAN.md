# 노드랩 파일 이동기 — 어도비·피그마 MCP 확장 구현 플랜 (v1.0, 2026-10-19)

해석: 요청의 "클로드 mcp"는 문맥상 "피그마 mcp"로 읽었습니다(어도비 + 피그마). 아니면 알려 주세요.

## 0. 한계 (착수 전)
- (A) 피그마·어도비 MCP는 파일 바이트를 클로드 대화로 못 넘깁니다. 주소(URL)만 주고받습니다. 업로드 주소는 피그마 submitUrl(10분·1회용), 어도비 블록 URL(서명됨).
- (A) 클로드 작업공간은 외부 사이트 접속이 막혀 있어(허용 목록) 거기서 올릴 수 없습니다.
- 그래서 PC 쪽에서 "주소 ↔ PC 폴더"를 옮기는 작은 프로그램이 필요합니다 = 파일 이동기(MCP 도구 3개).
- 제가 못 하는 것: 이 프로그램을 사장님 PC의 클로드 설정에 등록하는 일. 등록은 사장님이 한 번 하셔야 합니다(README 참고).

## 1. 흐름 (입력→출력 전체)
| 방향 | 순서 |
|---|---|
| PC/MYBOX → 피그마 | MYBOX files_download_to_path → PC 폴더 / 클로드: 피그마 upload_assets(submitUrl 받음) → 이동기 send_file(multipart, 필드 file) / use_figma로 노드에 이미지 배치 |
| 피그마 → PC | 클로드: 피그마 download_assets(임시 URL) → 이동기 receive_file → PC 폴더 / (필요 시) MYBOX files_upload_from_path |
| PC → 어도비 | 이동기 file_stat(크기·형식) → 어도비 asset_initialize_file_upload(블록 URL들) → 이동기 send_file(raw, PUT, offset/length 블록별) → asset_finalize_file_upload(전송문서 그대로) → assetId/presignedAssetUrl |
| 어도비 → PC | 어도비 편집 도구(crop, remove_background 등)가 결과 URL 반환 → 이동기 receive_file → PC 폴더 |

## 2. 구현 범위
- 도구 3개: file_stat, send_file, receive_file. 의존성 없음(Node 18+), stdio MCP.
- 시험: mock 서버로 업로드·내려받기·차단 16항목 자동시험(test/run.js).

## 3. 검증 3회 루프 (결과)
### 루프 1 — 사실 대조 (도구 설명 vs 플랜)  → 보완 3건
- (A) 어도비 업로드는 블록별 PUT(서명 URL, 인증 헤더 없음, Content-Type 필요) → 처음 플랜은 "파일 통째로 PUT"이었음. **보완: send_file에 offset/length 추가, 블록 크기(repo:blocksize)만큼 나눠 보냄.**
- (A) 어도비 시작 호출에 file_size·media_type 필요 → **보완: file_stat 도구 추가.**
- (A) 피그마는 multipart 'file' 필드 권장 → mode=multipart 기본값, 어도비는 mode=raw.
### 루프 2 — 안전·권한  → 보완 5건
- 폴더 허용 목록(기본 D:\nodelab_work) 밖 읽기/쓰기 차단, `..`·심볼릭 링크 탈출 차단(실경로 비교, 윈도 대소문자 무시).
- 사이트 허용 목록(figma·adobe·amazonaws 등), https만, 리다이렉트마다 재검사. **보완: 내부망/로컬 주소 차단(DNS 해석 후 검사).**
- **보완: 헤더 제한(content-type, x-* 만) — Authorization 등 불가.** 
- **보완: 받기는 .part 임시 파일 → 크기 한도 초과 시 삭제, 같은 이름은 _1 _2로 보존(덮어쓰기 안 함), 파일명 경로문자 제거.**
- **보완: 로그에 URL 쿼리(토큰) 안 남김(host+path만).** 크기 한도 기본 100MB.
### 루프 3 — 입력~출력 연결 점검  → 보완 3건
- 누가 부르나: 클로드가 각 MCP 결과의 URL을 이동기 인자로 넘김. 누가 읽나: 이동기는 PC 폴더만 읽음 → 폴더가 MYBOX 다운로드 폴더와 같아야 이어짐. **보완: 기본 폴더 하나(D:\nodelab_work)로 통일, 하위 폴더(reservation-photos 등)는 그대로 사용 가능.**
- 피그마 submitUrl 10분 만료 → **보완: 호출 순서를 "upload_assets 직후 send_file 바로"로 명시(README).**
- 어도비 finalize는 전송문서 전체 필요 → 이동기는 응답 etag만 돌려주고 전송문서는 클로드가 보관(이동기는 상태 없음).
- 남은 불확실(B): 피그마 download_assets URL과 어도비 결과 URL의 실제 도메인이 허용 목록에 모두 들어 있는지는 첫 실사용에서 확인 필요. 막히면 로그에 "허용 목록에 없는 사이트: 도메인"이 나오므로 MOVER_ALLOWED_HOSTS에 추가.

## 4. 첫 실사용 시험 (사장님 등록 후, 각 1회)
1. 피그마: reservation-photos의 사진 1장 → 노드랩 예약 첫 화면 후보 카드에 올리기.
2. 피그마 → PC: 그 카드 PNG 내보내 reservation-photos에 저장.
3. 어도비: 사진 1장 올리기 → image_crop_and_resize(4:3) → PC 저장.
