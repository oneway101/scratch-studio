# 채점 규칙

채점 엔진(`grader/`)이 받는 채점 규칙의 형식과 판정 방법이다. 규칙은 교안의 스텝마다 `checks` 목록으로 적고, 호스트 사이트가 `grade` 메시지로 에디터에 보낸다. `checks`는 모두 통과해야 스텝 통과다.

정적 검사(2단계)와 동적 검사, `grade` 메시지 연결(3단계)까지 만들었다.

## 규칙의 종류

| `type` | 내용 | 채점하는 곳 |
| --- | --- | --- |
| `static` | 블록 구성을 읽는 정적 검사. `rule`로 규칙을 고른다 | 에디터 |
| `dynamic` | 작품을 실행해 보는 동적 검사 | 에디터 |
| `anyOf` | `checks` 중 하나라도 통과하면 통과. 여러 풀이를 허용할 때 쓴다 | 에디터 |
| `record` | 교안의 입력 표. 학생이 적은 값으로 채점한다 | 호스트 사이트 (에디터는 통과로 둔다) |

```json
{ "type": "static", "rule": "hasBlock", "opcode": "control_forever", "sprite": "신호등" }
{ "type": "anyOf", "checks": [ { "type": "static", "rule": "hasBlock", "opcode": "control_repeat" },
                               { "type": "static", "rule": "hasBlock", "opcode": "control_forever" } ] }
```

## 정적 검사

입력은 `vm.toJSON()`의 프로젝트 JSON이다. 블록은 opcode로 판별하므로 에디터 언어와 무관하다.

| `rule` | 통과 조건 | 옵션 |
| --- | --- | --- |
| `hasBlock` | 블록이 `minCount`개(기본 1) 이상 있다 | `opcode`(필수), `sprite`, `minCount`, `fields`, `inputs`, `includeDetached` |
| `notHasBlock` | 블록이 없다 | `opcode`(필수), `sprite`, `includeDetached` |
| `blockCount` | 블록 수가 `min` 이상, `max` 이하다. `opcode`를 빼면 모든 블록을 센다 | `opcode`, `min`, `max`(둘 중 하나는 필수), `sprite`, `includeDetached` |
| `sequence` | 한 스크립트 안에 `opcodes`가 이 순서로 있다 | `opcodes`(필수), `strict`, `sprite`, `includeDetached` |
| `inside` | `parent` 블록 안에 `child` 블록이 있다 | `parent`, `child`(필수), `sprite`, `includeDetached` |
| `underHat` | `hat` 모자 블록의 스크립트에 블록이 있다 | `hat`, `opcode`(필수), `sprite` |
| `variableExists` | 변수(또는 리스트)가 있다 | `kind`(`variable` 기본, `list`), `name`, `sprite` |
| `spriteCount` | 스프라이트 수(무대 제외)가 `min` 이상, `max` 이하다 | `min`, `max`(둘 중 하나는 필수) |

### 어떤 블록을 세는가

- 모자 블록(`event_when…`, `control_start_as_clone`, `procedures_definition` 등)에 연결된 스크립트의 블록만 센다. 작업 공간에 떨어져 있는 블록은 `includeDetached: true`일 때만 센다.
- C 블록 안의 블록과 입력 칸에 끼운 블록(예: `pick random`, 변수)도 센다.
- 드롭다운 메뉴처럼 블록에 딸린 그림자 블록은 세지 않는다.

### 스프라이트 지정 (`sprite`)

| 값 | 대상 |
| --- | --- |
| 생략 또는 `@any` | 무대를 포함한 모든 대상. 개수(`minCount`, `blockCount`)는 모두 더한다 |
| `@first` | 스프라이트 목록의 첫 스프라이트 |
| `@stage` | 무대 |
| 이름 | 그 이름의 스프라이트. 작품에 없으면 규칙은 실패한다 |

`variableExists`에서 스프라이트를 지정하면 그 스프라이트의 변수와 무대의 변수("모든 스프라이트에서 사용")를 함께 본다.

### 값 비교 (`fields`, `inputs`)

`fields`는 드롭다운 값, `inputs`는 칸에 입력한 숫자나 글자를 비교한다. 키 이름은 블록의 입력 이름이다.

```json
{ "type": "static", "rule": "hasBlock", "opcode": "event_whenkeypressed", "fields": { "KEY_OPTION": "space" } }
{ "type": "static", "rule": "hasBlock", "opcode": "operator_random",
  "inputs": { "FROM": { "op": "eq", "value": 2 }, "TO": { "op": "between", "value": [3, 5] } } }
```

- 값만 적으면 `eq`다. 연산은 `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `between`(`[최소, 최대]`, 양 끝 포함), `contains`, `startsWith`(제안, 아래 `music`)이고, 숫자 비교에 `tolerance`를 줄 수 있다.
- 스크래치처럼 양쪽이 숫자면 숫자로, 아니면 대소문자 구분 없이 글자로 비교한다(`"10"`과 `10`은 같다).
- `{ "ko": "점수", "en": "score" }`처럼 언어별 값을 주면 둘 중 하나와 맞으면 된다.
- 드롭다운이 블록에 딸린 메뉴에 있는 경우(예: `sensing_keypressed`의 `KEY_OPTION`, `sound_play`의 `SOUND_MENU`)도 같은 이름으로 비교한다.
- 칸에 다른 블록을 끼웠으면 입력한 값이 없는 것으로 보고 `inputs` 조건은 맞지 않는다.

### `sequence`의 순서

스크립트를 실행 순서대로 펼쳐 비교한다. 블록 다음에 그 블록의 C 블록 안을, 그다음에 아래 블록을 놓는다. 입력 칸에 끼운 블록은 넣지 않는다. `strict: true`이면 사이에 다른 블록이 없어야 한다.

### `inside`와 `underHat`

- `inside`는 `parent` 블록의 C 블록과 입력 칸 안 어디든(여러 겹 안쪽 포함) `child`가 있으면 통과다. `parent` 다음에 이어 붙인 블록은 안이 아니다.
- `underHat`은 `hat` 모자 블록 아래 스크립트 어디든(C 블록 안 포함) 블록이 있으면 통과다.

## 동적 검사

`actions`를 순서대로 실행한 뒤 `expect`를 모두 확인한다. 학생 화면과 따로, 보이지 않는 두 번째 실행 환경(VM과 렌더러)에서 실행하고 끝나면 없앤다. 학생이 작업 중인 에디터는 바뀌지 않는다. 소리는 나지 않는다.

```json
{ "type": "dynamic",
  "actions": [ { "do": "greenFlag" }, { "do": "keyPress", "key": "ArrowRight", "durationMs": 100 }, { "do": "wait", "ms": 300 } ],
  "expect": [ { "target": "sprite", "sprite": "@first", "property": "x", "op": "gt", "value": { "ref": "initial" } } ],
  "timeoutMs": 3000 }
```

### 액션

| `do` | 옵션 | 동작 |
| --- | --- | --- |
| `greenFlag` |  | 초록 깃발 클릭 |
| `keyPress` | `key`, `durationMs`(기본 100) | 키를 누르고 `durationMs` 뒤에 뗀다. `key`는 브라우저의 키 이름(`ArrowRight`, `a`, ` `)이나 스크래치의 키 이름(`right arrow`, `space`) |
| `clickSprite` | `sprite` | 그 스프라이트의 "이 스프라이트를 클릭했을 때"를 실행한다. 스프라이트가 없으면 검사 실패 |
| `mouseMove` | `x`, `y` | 마우스 포인터를 무대 좌표로 옮긴다 |
| `answer` | `text` | "묻고 기다리기"에 답을 입력한다 |
| `broadcast` | `message` | 메시지를 방송한다 |
| `wait` | `ms` | 기다린다. 실행 환경은 학생 화면과 같은 속도(초당 30프레임)로 돈다 |
| `stop` |  | 모두 멈춘다 |

### 확인 대상

| `target` | 고르는 옵션 | `property` | 값 |
| --- | --- | --- | --- |
| `sprite` | `sprite` | `x`, `y`, `direction`, `size`, `visible`, `costume`(모양 이름), `sayText`(말풍선 글, 없으면 빈 글), `touchingEdge` | |
| `variable` | `name`, `sprite`(선택) | 없음 | 변수 값 |
| `list` | `name`, `sprite`(선택) | `length`, `item`(+ `index`, 1부터) | |
| `stage` | | `backdrop`(배경 이름) | |
| `clones` | `sprite` | 없음 | 그 스프라이트의 복제본 수 |

| `music` (제안) | | `notes`(연주한 음의 MIDI 번호 목록), `beats`(각 음의 박자 목록), `tempo`(빠르기) | |

- `music`은 기획서에 아직 없는 제안이다. 작품을 불러온 뒤 음악 확장이 연주한 음을 기록한다(타악기는 넣지 않는다). 소리는 나지 않아도 박자만큼 기다리는 것은 학생 화면과 같다. 목록은 항목끼리 비교하고, `startsWith`(제안)는 목록이나 글이 주어진 값으로 시작하는지 본다. 예: `{ "target": "music", "property": "notes", "op": "startsWith", "value": [60, 62, 64] }`
- `sprite`는 정적 검사와 같이 이름, `@first`를 쓴다. 없는 스프라이트를 가리키면 그 조건은 실패다.
- `variable`과 `list`의 `name`은 `{ "ko", "en" }`로 줄 수 있다. `sprite`를 주면 그 스프라이트의 변수를 먼저, 다음에 무대의 변수를 찾는다. 주지 않으면 무대의 변수를 먼저, 다음에 스프라이트들의 변수를 찾는다.
- 비교는 정적 검사의 값 비교와 같다. `value`에 `{ "ref": "initial" }`을 쓰면 작품을 불러온 직후, 액션 전의 값과 비교한다.

### 실행 방법

- 검사마다(그리고 `runs`의 실행마다) 새 실행 환경에 작품을 다시 불러온다. 앞 검사의 상태가 다음 검사에 남지 않는다.
- `timeoutMs`(기본 5000)는 불러오기부터 확인까지의 시간이다. 넘으면 실행을 멈추고 실패로 처리한다. 무한 반복이 있는 작품도 이 시간 안에 끝난다.
- `runs`(기본 1)만큼 반복 실행한다. `passIf`가 `all`(기본)이면 모두, `any`면 하나라도 통과해야 한다. 결과가 정해지면 남은 실행은 하지 않는다.

### 한 스텝의 채점 순서

1. 에디터가 지금 작품의 프로젝트 JSON과 sb3를 스냅샷으로 만든다.
2. 정적 검사(와 동적 검사가 없는 `anyOf`)를 먼저 확인한다. 하나라도 실패하면 동적 검사는 건너뛴다(`skipped`).
3. 동적 검사를 순서대로 실행하고, 하나가 실패하면 나머지는 건너뛴다. `anyOf` 안에서는 통과하는 검사가 나오면 멈춘다.
4. `result`, 규칙별 결과, 스냅샷 sb3를 응답한다.

호스트 사이트의 제한 시간(`protocol.ts`의 `gradeTimeoutMs`)은 동적 검사마다 `timeoutMs × runs`를 더하고 5초를 더한 값이라, 채점이 그 안에 끝난다.

## 결과

`gradeStatic`은 `result`(`pass`, `fail`)와 규칙별 결과(`checkResults`)를 돌려준다. 규칙별 결과의 `detail`(예: `motion_gotoxy: found 1, need 2`)은 개발 중 확인용이고, 학생에게는 통과 또는 실패만 보인다.

규칙 자체를 읽을 수 없으면(모르는 `rule`이나 액션, 필수 옵션 누락, 잘못된 연산) 실패가 아니라 `GraderError`를 던진다. 작품을 채점용 실행 환경에 불러오지 못한 경우도 같다. `grade`는 이것을 `result: "error"`로 답하고, 학생에게는 "확인하지 못했어요. 다시 눌러 주세요"가 보이며 시도 횟수에 들어가지 않는다.

## 점검

```
npm test                          # 규칙별 통과·실패 단위 테스트 (Vitest). 동적 검사의 흐름은 가짜 실행 환경으로 확인한다
npm run check:grade               # 실제 에디터에서 grade 메시지 점검. 빌드와 npm run serve 필요
```

`check:grade`는 시나리오마다 통과해야 하는 작품과 실패해야 하는 작품을 채점한다. 작품은 에디터의 빈 프로젝트에 `grader/fixtures/build.ts`로 적은 스크립트를 넣어 만든다.

시험용 프로젝트는 `grader/fixtures/`에 있다. `arrow-keys.json`은 `vm.toJSON()`과 같은 형식으로 손으로 쓴 작품이고, `build.ts`는 테스트 안에서 스크립트를 짧게 적어 같은 형식의 작품을 만든다. 교안과 실제 채점 규칙은 비공개라 이 저장소에 넣지 않는다.
