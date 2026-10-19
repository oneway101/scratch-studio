# scratch-studio

edu-platform의 스크래치 과목용 에디터다. TurboWarp scratch-gui를 빌드해 본 사이트의 iframe 안에서 띄우고, 본 사이트와는 `postMessage`로만 통신한다. 기획은 본 사이트 저장소의 `docs/scratch-studio/scratch-studio-spec.md`에 있다.

현재 0단계(에디터 검증)까지 진행했다. 결과는 [docs/spike.md](docs/spike.md)에 있다.

## 실행

Node 24 이상이 필요하다.

```
npm run vendor        # TurboWarp 소스를 받고 패치를 적용하고 의존성을 설치한다 (수 분)
npm run build         # build/ 에 에디터를 만든다
npm run spike:serve   # 8601 에디터, 8602 시험 페이지, 8603/8604 출처 검증용
```

브라우저에서 http://localhost:8602 를 열면 시험 페이지의 버튼으로 메시지를 보내 볼 수 있다.

자동 점검은 Playwright로 실행한다. 처음 한 번 의존성과 크로미움을 설치한다.

```
npm install
npx playwright install chromium
npm run spike:check
```

## 구성

| 경로 | 내용 |
| --- | --- |
| `editor/` | 에디터 진입점, 브리지, 메뉴 바의 저장 버튼, 0단계용 채점 실험 코드 |
| `patches/`, `PATCHES.md` | TurboWarp 소스에 적용하는 수정과 그 이유 |
| `webpack.config.js` | TurboWarp의 웹팩 설정에 이 저장소의 진입점을 얹는다 |
| `spike/` | 0단계 시험 페이지, 서버, 자동 점검 |
| `vendor/` | TurboWarp scratch-gui (git에 넣지 않는다) |

## 라이선스

GPL-3.0. TurboWarp의 수정분은 GPL-3.0이고 그 안의 스크래치 원본 코드는 BSD 3-Clause다.
