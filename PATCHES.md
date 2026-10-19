# TurboWarp scratch-gui 수정 기록

`vendor/scratch-gui`에 적용하는 수정은 `patches/scratch-gui.patch` 하나에 모은다. 기준 커밋은 `1e08e6a`(develop, 2026-10-04)이다.

| 파일 | 수정 | 이유 |
| --- | --- | --- |
| `src/components/menu-bar/menu-bar.jsx` | `TWSaveStatus`("컴퓨터에 저장하기")를 `@studio/save-status.jsx`로 교체 (import 1줄, 사용처 1곳) | TurboWarp는 스크래치의 서버 저장 버튼을 파일 다운로드로 바꿔 놓았다. 메뉴 바의 같은 자리에 저장 상태와 "저장하기" 버튼을 넣으려면 이 자리를 바꿔야 한다. 버튼 자체는 이 저장소의 `editor/save-status.jsx`에 있다. |
| `src/components/menu-bar/language-menu.jsx` | 언어 목록에 `window.__studioLocales` 필터 1줄 추가 | 언어 메뉴에 한국어와 영어만 남긴다. 목록이 `@turbowarp/scratch-l10n`의 전체 언어에서 바로 만들어져 설정으로는 줄일 수 없다. |

에디터 진입점, 브리지, 웹팩 설정은 `vendor` 밖(`editor/`, `webpack.config.js`)에 있어 수정이 아니다.
