# TurboWarp scratch-gui 수정 기록

`vendor/scratch-gui`에 적용하는 수정은 `patches/scratch-gui.patch` 하나에 모은다. 기준 커밋은 `1e08e6a581ddd2cd555a9ca42e0f4b6c6a4f551e`(develop, 2026-10-04)이고, `npm run vendor`가 이 커밋을 받아 패치를 적용한다.

| 파일 | 수정 | 이유 |
| --- | --- | --- |
| `src/components/menu-bar/menu-bar.jsx` | `TWSaveStatus`("컴퓨터에 저장하기")를 `@studio/save-status.jsx`로 교체 (import 1줄, 사용처 1곳) | TurboWarp는 스크래치의 서버 저장 버튼을 파일 다운로드로 바꿔 놓았다. 메뉴 바의 같은 자리에 저장 상태와 "저장하기" 버튼을 넣으려면 이 자리를 바꿔야 한다. 버튼 자체는 이 저장소의 `editor/save-status.jsx`에 있다. |
| `src/components/menu-bar/menu-bar.jsx` | "고급 설정" 버튼, 편집 메뉴의 "고급 설정" 항목, "TurboWarp 문의하기" 버튼 삭제 | 학생 화면에 필요 없는 설정과 외부 링크다. 고급 설정은 `mapDispatchToProps`가 항상 넘기는 함수로 그려져 props로 끌 수 없다. |
| `src/components/menu-bar/language-menu.jsx` | 언어 목록을 `@studio/protocol`의 `LOCALES`(한국어, 영어)로 거름 (import 1줄, 필터 1줄) | 언어 메뉴에 한국어와 영어만 남긴다. 목록이 `@turbowarp/scratch-l10n`의 전체 언어에서 바로 만들어져 설정으로는 줄일 수 없다. |
| `src/containers/extension-library.jsx` | 확장 라이브러리에서 "사용자 확장" 항목과 TurboWarp 확장 갤러리를 뺌 (상수 1개, 조건 2곳) | 사용자 확장과 갤러리 확장은 임의의 자바스크립트를 실행한다. 갤러리 목록을 `extensions.turbowarp.org`에서 받아 오는 요청도 없앤다. 에디터에 번들된 확장(펜, 음악 등)은 그대로 둔다. |

패치 없이 이 저장소의 코드로 처리한 것은 다음과 같다.

- 진입점, 브리지, 웹팩 설정, HTML 템플릿은 `vendor` 밖(`editor/`, `webpack.config.js`)에 있다.
- 테마 메뉴는 `canChangeTheme={false}`로 숨기고, 보라 테마는 `editor/studio.jsx`가 Redux 상태를 고정해서 유지한다.
- 번들되지 않은 확장은 `editor/studio.jsx`가 `extensionManager.loadExtensionURL`을 감싸 거부한다. 라이브러리 UI를 거치지 않는 경로(URL, 파일, 코드, 작품 안의 확장)도 모두 여기서 막힌다.

## 패치를 고치는 방법

`vendor/scratch-gui`에서 소스를 고친 뒤 패치 파일을 다시 만들고 이 표를 고친다.

```
cd vendor/scratch-gui
git diff > ../../patches/scratch-gui.patch
```
