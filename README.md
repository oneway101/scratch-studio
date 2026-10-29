# scratch-studio

스크래치 수업용 에디터다. TurboWarp scratch-gui를 빌드해 다른 사이트(이하 호스트 사이트)의 iframe 안에서 띄우고, 호스트 사이트와는 `postMessage`로만 통신한다. 에디터는 로그인, DB, 서버 통신이 없는 정적 앱이다.

현재 3단계(동적 채점)까지 진행했다. 0단계(에디터 검증) 결과는 [docs/spike.md](docs/spike.md), 채점 규칙의 형식과 판정 방법은 [docs/grader.md](docs/grader.md)에 있다.

## 실행

Node 24 이상이 필요하다.

```
npm install                       # 이 저장소의 개발 도구 (TypeScript, Playwright)
npm run vendor                    # TurboWarp 소스(기준 커밋)를 받고 패치를 적용하고 의존성을 설치한다 (수 분)
npm run build                     # build/ 에 에디터를 만든다
npm run serve                     # 8601 에디터, 8602 시험 페이지, 8603/8604 출처 검증용
```

`vendor`와 `build` 스크립트는 sh 문법이다. Windows에서는 Git Bash에서 같은 명령을 직접 실행하거나, npm의 스크립트 셸을 Git Bash로 지정한다(`npm config set script-shell "C:\Program Files\Git\bin\bash.exe"`).

브라우저에서 http://localhost:8602 를 열면 시험 페이지의 버튼으로 메시지를 보내 볼 수 있다.

다른 로컬 호스트 사이트에 붙여 보려면 빌드와 서버에 같은 `STUDIO_ALLOWED_ORIGINS`를 준다. 8602를 함께 넣어야 시험 페이지와 점검도 그대로 쓸 수 있다.

```
STUDIO_ALLOWED_ORIGINS=http://localhost:8602,http://localhost:8000 npm run build
STUDIO_ALLOWED_ORIGINS=http://localhost:8602,http://localhost:8000 npm run serve
```

점검은 네 가지다. 브라우저 점검(`check`, `check:grade`)은 빌드와 `npm run serve`가 떠 있어야 하고, 처음 한 번 크로미움을 설치한다.

```
npm run typecheck                 # editor/, grader/ 타입 검사
npm test                          # 채점 규칙 단위 테스트 (빌드 없이 실행)
npx playwright install chromium
npm run check                     # 브리지 자동 점검. 결과와 화면 캡처는 test/out/
npm run check:grade               # grade 메시지와 동적 채점 점검. 결과는 test/out/grade-result.json
```

## 메시지 규약

호스트 사이트와 주고받는 메시지는 [editor/protocol.ts](editor/protocol.ts)에 정의되어 있다. 이 파일이 에디터와 호스트 사이트 사이의 유일한 계약이고, 호스트 사이트는 같은 정의를 따른다. 규약을 바꿀 때는 `VERSION`을 올린다.

## 배포 설정

에디터는 호스트 사이트와 다른 출처(서브도메인)에서 제공한다. 배포할 때 두 가지를 설정한다.

| 설정 | 위치 | 값 |
| --- | --- | --- |
| 메시지를 주고받을 수 있는 출처 | 빌드할 때 환경 변수 `STUDIO_ALLOWED_ORIGINS` (쉼표로 구분) | 호스트 사이트의 출처. 예: `STUDIO_ALLOWED_ORIGINS=https://edu.example.com npm run build`. 지정하지 않으면 `http://localhost:8602` |
| 임베드를 허용할 출처 | 호스팅의 HTTP 응답 헤더 | `Content-Security-Policy: frame-ancestors <호스트 사이트의 출처>`. HTML의 `<meta>`로는 동작하지 않는다. `dev/serve.mjs`의 8601 서버는 `STUDIO_ALLOWED_ORIGINS`(기본 `http://localhost:8602`)로 같은 헤더를 붙인다 |

## 구성

| 경로 | 내용 |
| --- | --- |
| `editor/protocol.ts` | 메시지 규약 (타입, 오류 코드, payload 검증, 요청 제한 시간) |
| `editor/bridge.ts` | 에디터 쪽 메시지 처리 |
| `editor/studio.jsx` | 에디터 진입점. 테마 고정, 번들되지 않은 확장 차단 |
| `editor/save-status.jsx`, `editor/save-store.ts` | 메뉴 바의 저장 상태와 "불러오기", "저장하기" 버튼 |
| `editor/project-file.ts` | 학생 컴퓨터의 작품 파일 열기 ("불러오기" 버튼, 에디터에 끌어다 놓기). edit 모드에서만, 불러온 작품은 바뀐 상태가 되어 사이트가 저장한다 |
| `editor/index.ejs` | 에디터 HTML |
| `editor/grading-runtime.ts` | 동적 채점용 실행 환경 (보이지 않는 두 번째 VM과 렌더러) |
| `editor/extensions.ts` | 번들되지 않은 확장 차단. 학생 VM과 채점 VM에 같이 쓴다 |
| `grader/` | 채점 엔진. UI와 분리된 TypeScript 모듈과 단위 테스트(`*.test.ts`), 시험용 작품(`fixtures/`) |
| `patches/`, `PATCHES.md` | TurboWarp 소스에 적용하는 수정과 그 이유 |
| `webpack.config.js` | TurboWarp의 웹팩 설정에 이 저장소의 진입점을 얹는다 |
| `dev/` | 시험 페이지와 로컬 서버 |
| `test/` | 브리지 점검(`bridge-check.mjs`)과 채점 점검(`grade-check.mjs`) |
| `vendor/` | TurboWarp scratch-gui (git에 넣지 않는다) |

## 라이선스

GPL-3.0. TurboWarp의 수정분은 GPL-3.0이고 그 안의 스크래치 원본 코드는 BSD 3-Clause다.
