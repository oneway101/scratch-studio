// Stage 3 checks: the grade message on the real editor, through the cross-origin host page.
// Needs a build (npm run build) and the servers from dev/serve.mjs (npm run serve).
//   npm run check:grade
// Every scenario grades a project that should pass and one that should fail.
import {createRequire} from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from '@playwright/test';
import {b, flag, project, sprite, whenKey} from '../grader/fixtures/build.ts';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const JSZip = createRequire(path.join(root, 'vendor/scratch-gui/package.json'))('@turbowarp/jszip');

const HOST = 'http://localhost:8602';
const EDITOR = 'http://localhost:8601';
const out = path.join(root, 'test/out');
fs.mkdirSync(out, {recursive: true});
const results = [];
const record = (name, ok, detail) => {
    results.push({name, ok, detail});
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail === undefined ? '' : JSON.stringify(detail)}`);
};
const attempt = async (name, fn) => {
    try {
        record(name, true, await fn());
    } catch (error) {
        record(name, false, String(error && error.message || error).slice(0, 400));
    }
};
const assert = (cond, message) => {
    if (!cond) throw new Error(message);
};

const browser = await chromium.launch();
const page = await (await browser.newContext({viewport: {width: 1440, height: 900}})).newPage();
const webglErrors = [];
page.on('console', message => {
    // Lost contexts and context limits, not the driver's performance notes.
    if (/CONTEXT_LOST|Too many active WebGL contexts|WebGL.*error/i.test(message.text())) webglErrors.push(message.text());
});
await page.goto(`${HOST}/`);
await page.waitForFunction(() => window.host.readyAt !== null, null, {timeout: 120000});
const editor = page.frames().find(f => f.url().startsWith(EDITOR));
const request = (type, payload) => page.evaluate(([t, p]) => window.host.request(t, p), [type, payload]);
const vmEval = fn => editor.evaluate(`(${fn})(window.ReduxStore.getState().scratchGui.vm)`);

await request('init', {locale: 'ko', mode: 'edit'});
await request('loadProject', {sb3: null});
// The empty project's sb3 gives real costumes; each scenario swaps in its own scripts.
const base = Buffer.from(await page.evaluate(async () => Array.from(new Uint8Array((await window.host.request('exportProject')).sb3))));

/**
 * An sb3 built from the empty project: the stage and its sprite keep their costumes and take the
 * scripts, variables and lists of `spec` (grader/fixtures/build.ts). Extra sprites copy the first one.
 * Every sprite gets a second costume ("second") so costume changes can be seen.
 */
const makeSb3 = async (sprites, stage = {}) => {
    const built = project(sprites, stage);
    const zip = await JSZip.loadAsync(base);
    const json = JSON.parse(await zip.file('project.json').async('string'));
    const template = json.targets.find(t => !t.isStage);
    const stageTarget = json.targets.find(t => t.isStage);
    const graft = (target, from) => Object.assign(target, {blocks: from.blocks, variables: from.variables, lists: from.lists});
    graft(stageTarget, built.targets[0]);
    template.costumes.push({...template.costumes[0], name: 'second'});
    json.targets = [stageTarget, ...built.targets.slice(1).map((from, i) =>
        graft({...structuredClone(template), name: from.name, layerOrder: i + 1}, from))];
    zip.file('project.json', JSON.stringify(json));
    return zip.generateAsync({type: 'nodebuffer'});
};

/** Loads the project in the student's editor and grades it. */
const gradeProject = async (sb3, checks) => {
    await page.evaluate(b => window.host.request('loadProject', {sb3: new Uint8Array(b).buffer}), Array.from(sb3));
    const started = Date.now();
    const reply = await request('grade', {checks});
    return {...reply, ms: Date.now() - started};
};
const dynamic = (actions, expectations, rest = {}) => ({type: 'dynamic', actions, expect: expectations, ...rest});
const cat = (property, op, value, rest = {}) => ({target: 'sprite', sprite: '@first', property, op, value, ...rest});

/** Grades the passing and the failing project with the same checks. */
const scenario = async (name, checks, passing, failing) => {
    await attempt(name, async () => {
        const good = await gradeProject(passing, checks);
        assert(good.result === 'pass', `passing project: ${good.result} ${JSON.stringify(good.checkResults)}`);
        const bad = await gradeProject(failing, checks);
        assert(bad.result === 'fail', `failing project: ${bad.result} ${JSON.stringify(bad.checkResults)}`);
        return {passMs: good.ms, failMs: bad.ms, fail: bad.checkResults.map(r => r.detail).join(' | ').slice(0, 120)};
    });
};

const empty = await makeSb3([sprite('Cat')]);

await scenario('01 keyPress: 오른쪽 키로 x 증가 (처음 값과 비교)',
    [dynamic([{do: 'greenFlag'}, {do: 'keyPress', key: 'ArrowRight', durationMs: 100}, {do: 'wait', ms: 200}],
        [cat('x', 'gt', {ref: 'initial'})], {timeoutMs: 3000})],
    await makeSb3([sprite('Cat', [[whenKey('right arrow'), b('motion_changexby', {inputs: {DX: 10}})]])]),
    await makeSb3([sprite('Cat', [[whenKey('left arrow'), b('motion_changexby', {inputs: {DX: 10}})]])]));

await scenario('02 greenFlag: 깃발을 누르면 (100, -50), 허용 오차 5',
    [dynamic([{do: 'greenFlag'}, {do: 'wait', ms: 200}],
        [cat('x', 'eq', 100, {tolerance: 5}), cat('y', 'eq', -50, {tolerance: 5})])],
    await makeSb3([sprite('Cat', [[flag(), b('motion_gotoxy', {inputs: {X: 103, Y: -52}})]])]),
    await makeSb3([sprite('Cat', [[flag(), b('motion_gotoxy', {inputs: {X: 0, Y: 0}})]])]));

await scenario('03 무한 반복: 학생 화면과 같은 속도 (렌더러 필요)',
    // 30 frames a second: about 15 steps in 0.5 s. Without a renderer the loop would run thousands.
    [dynamic([{do: 'greenFlag'}, {do: 'wait', ms: 500}], [cat('y', 'between', [5, 40])])],
    await makeSb3([sprite('Cat', [[flag(), b('motion_sety', {inputs: {Y: 0}}),
        b('control_forever', {substack: [b('motion_changeyby', {inputs: {DY: 1}})]})]])]),
    await makeSb3([sprite('Cat', [[flag(), b('motion_sety', {inputs: {Y: 0}}),
        b('control_forever', {substack: [b('motion_changeyby', {inputs: {DY: 10}})]})]])]));

await attempt('04 제한 시간: 무한 반복 작품도 timeoutMs에 끝나고 실패', async () => {
    const forever = await makeSb3([sprite('Cat', [[flag(), b('control_forever', {substack: [b('motion_turnright', {inputs: {DEGREES: 15}})]})]])]);
    const graded = await gradeProject(forever, [dynamic([{do: 'greenFlag'}, {do: 'wait', ms: 10000}], [cat('x', 'eq', 0)], {timeoutMs: 1000})]);
    assert(graded.result === 'fail' && /timed out after 1000ms/.test(graded.checkResults[0].detail), JSON.stringify(graded));
    assert(graded.ms < 3000, `took ${graded.ms}ms`);
    return {ms: graded.ms, detail: graded.checkResults[0].detail};
});

await scenario('05 clickSprite + sayText: 언어별 값 중 하나',
    [dynamic([{do: 'clickSprite', sprite: 'Cat'}, {do: 'wait', ms: 200}],
        [cat('sayText', 'contains', {ko: '야옹', en: 'meow'})])],
    await makeSb3([sprite('Cat', [[b('event_whenthisspriteclicked'), b('looks_say', {inputs: {MESSAGE: 'Meow!'}})]])]),
    await makeSb3([sprite('Cat', [[flag(), b('looks_say', {inputs: {MESSAGE: 'Meow!'}})]])]));

await scenario('06 answer: 묻고 기다리기에 답 입력',
    [dynamic([{do: 'greenFlag'}, {do: 'wait', ms: 300}, {do: 'answer', text: '42'}, {do: 'wait', ms: 300}],
        [cat('sayText', 'eq', 42)])],
    await makeSb3([sprite('Cat', [[flag(), b('sensing_askandwait', {inputs: {QUESTION: 'number?'}}),
        b('looks_say', {inputs: {MESSAGE: b('sensing_answer')}})]])]),
    await makeSb3([sprite('Cat', [[flag(), b('sensing_askandwait', {inputs: {QUESTION: 'number?'}}),
        b('looks_say', {inputs: {MESSAGE: 'thanks'}})]])]));

await scenario('07 broadcast + variable: 메시지를 받으면 점수 5',
    [dynamic([{do: 'broadcast', message: 'go'}, {do: 'wait', ms: 200}],
        [{target: 'variable', name: {ko: '점수', en: 'score'}, op: 'eq', value: 5}])],
    await makeSb3([sprite('Cat', [[b('event_whenbroadcastreceived', {fields: {BROADCAST_OPTION: 'go'}}),
        b('data_setvariableto', {fields: {VARIABLE: 'score'}, inputs: {VALUE: 5}})]])], {variables: ['score']}),
    await makeSb3([sprite('Cat', [[b('event_whenbroadcastreceived', {fields: {BROADCAST_OPTION: 'stop'}}),
        b('data_setvariableto', {fields: {VARIABLE: 'score'}, inputs: {VALUE: 5}})]])], {variables: ['score']}));

await scenario('08 mouseMove: 마우스 포인터 따라가기',
    [dynamic([{do: 'greenFlag'}, {do: 'mouseMove', x: 120, y: -60}, {do: 'wait', ms: 300}],
        [cat('x', 'eq', 120, {tolerance: 1}), cat('y', 'eq', -60, {tolerance: 1})])],
    await makeSb3([sprite('Cat', [[flag(), b('control_forever', {substack: [
        b('motion_goto', {inputs: {TO: {menu: 'motion_goto_menu', value: '_mouse_'}}})]})]])]),
    empty);

await scenario('09 clones: 복제본 3개',
    [dynamic([{do: 'greenFlag'}, {do: 'wait', ms: 500}], [{target: 'clones', sprite: 'Cat', op: 'eq', value: 3}])],
    await makeSb3([sprite('Cat', [[flag(), b('control_repeat', {inputs: {TIMES: 3}, substack: [
        b('control_create_clone_of', {inputs: {CLONE_OPTION: {menu: 'control_create_clone_of_menu', value: '_myself_'}}})]})]])]),
    await makeSb3([sprite('Cat', [[flag(), b('control_repeat', {inputs: {TIMES: 2}, substack: [
        b('control_create_clone_of', {inputs: {CLONE_OPTION: {menu: 'control_create_clone_of_menu', value: '_myself_'}}})]})]])]));

const listProject = items => makeSb3([sprite('Cat', [[flag(), b('data_deletealloflist', {fields: {LIST: 'bag'}}),
    ...items.map(item => b('data_addtolist', {fields: {LIST: 'bag'}, inputs: {ITEM: item}}))]])], {lists: ['bag']});
await scenario('10 list: 길이와 항목',
    [dynamic([{do: 'greenFlag'}, {do: 'wait', ms: 200}], [
        {target: 'list', name: 'bag', property: 'length', op: 'eq', value: 2},
        {target: 'list', name: 'bag', property: 'item', index: 1, op: 'eq', value: 'apple'}])],
    await listProject(['apple', 'pear']),
    await listProject(['pear', 'apple']));

await scenario('11 visible, size, direction, touchingEdge',
    [dynamic([{do: 'greenFlag'}, {do: 'wait', ms: 300}], [
        cat('visible', 'eq', false), cat('size', 'eq', 50), cat('direction', 'eq', -90), cat('touchingEdge', 'eq', true)])],
    await makeSb3([sprite('Cat', [[flag(), b('looks_setsizeto', {inputs: {SIZE: 50}}),
        b('motion_pointindirection', {inputs: {DIRECTION: -90}}), b('motion_setx', {inputs: {X: 240}}), b('looks_hide')]])]),
    await makeSb3([sprite('Cat', [[flag(), b('looks_setsizeto', {inputs: {SIZE: 50}}),
        b('motion_pointindirection', {inputs: {DIRECTION: -90}}), b('motion_setx', {inputs: {X: 0}}), b('looks_hide')]])]));

await scenario('12 costume: 모양 이름으로 비교',
    [dynamic([{do: 'greenFlag'}, {do: 'wait', ms: 200}], [cat('costume', 'ne', {ref: 'initial'})])],
    await makeSb3([sprite('Cat', [[flag(), b('looks_nextcostume')]])]),
    empty);

await scenario('13 runs + passIf any: 난수 작품',
    // x is 100 or 200 at random; one of 12 runs lands on 200 except with chance 1/4096.
    [dynamic([{do: 'greenFlag'}, {do: 'wait', ms: 100}], [cat('x', 'eq', 200)], {runs: 12, passIf: 'any', timeoutMs: 2000})],
    await makeSb3([sprite('Cat', [[flag(), b('motion_setx', {inputs: {X: b('operator_multiply', {
        inputs: {NUM1: b('operator_random', {inputs: {FROM: 1, TO: 2}}), NUM2: 100}})}})]])]),
    await makeSb3([sprite('Cat', [[flag(), b('motion_setx', {inputs: {X: 100}})]])]));

await scenario('14 여러 스프라이트: 이름으로 지정',
    [dynamic([{do: 'greenFlag'}, {do: 'wait', ms: 200}], [{target: 'sprite', sprite: 'Dog', property: 'x', op: 'eq', value: -100}])],
    await makeSb3([sprite('Cat'), sprite('Dog', [[flag(), b('motion_setx', {inputs: {X: -100}})]])]),
    await makeSb3([sprite('Cat', [[flag(), b('motion_setx', {inputs: {X: -100}})]]), sprite('Dog')]));

await attempt('15 정적 + 동적: 정적이 실패하면 동적은 건너뜀', async () => {
    const sb3 = await makeSb3([sprite('Cat', [[flag(), b('motion_setx', {inputs: {X: 100}})]])]);
    const checks = [{type: 'static', rule: 'hasBlock', opcode: 'motion_gotoxy'},
        dynamic([{do: 'greenFlag'}, {do: 'wait', ms: 200}], [cat('x', 'eq', 100)])];
    const graded = await gradeProject(sb3, checks);
    assert(graded.result === 'fail' && /skipped/.test(graded.checkResults[1].detail), JSON.stringify(graded.checkResults));
    const both = await gradeProject(sb3, [{type: 'static', rule: 'hasBlock', opcode: 'motion_setx'}, checks[1]]);
    assert(both.result === 'pass', JSON.stringify(both.checkResults));
    return {skipped: graded.checkResults[1].detail};
});

await attempt('16 학생 화면은 그대로이고 응답에 작품(sb3)이 옴', async () => {
    const sb3 = await makeSb3([sprite('Cat', [[flag(), b('motion_setx', {inputs: {X: 200}}), b('looks_say', {inputs: {MESSAGE: 'hi'}})]])]);
    await page.evaluate(b => window.host.request('loadProject', {sb3: new Uint8Array(b).buffer}), Array.from(sb3));
    const before = await vmEval(vm => ({x: vm.runtime.targets[1].x, json: vm.toJSON()}));
    const reply = await page.evaluate(async c => {
        const r = await window.host.request('grade', {checks: c});
        return {result: r.result, sb3: r.sb3.byteLength};
    }, [dynamic([{do: 'greenFlag'}, {do: 'wait', ms: 200}], [cat('x', 'eq', 200)])]);
    const after = await vmEval(vm => ({x: vm.runtime.targets[1].x, json: vm.toJSON(), targets: vm.runtime.targets.length}));
    assert(reply.result === 'pass' && reply.sb3 > 1000, JSON.stringify(reply));
    assert(after.x === before.x && after.json === before.json && after.targets === 2, `student x ${before.x} -> ${after.x}`);
    return {result: reply.result, sb3Bytes: reply.sb3, studentX: after.x};
});

await attempt('17 읽을 수 없는 규칙은 error (실패가 아님)', async () => {
    const graded = await gradeProject(empty, [dynamic([{do: 'fly'}], [cat('x', 'eq', 0)])]);
    assert(graded.result === 'error' && /unknown action/.test(graded.checkResults[0].detail), JSON.stringify(graded));
    const noChecks = await gradeProject(empty, []);
    assert(noChecks.result === 'pass', JSON.stringify(noChecks));
    return {detail: graded.checkResults[0].detail};
});

await attempt('18 연속 채점 20회: WebGL 오류 없음, 실행 환경 정리', async () => {
    const sb3 = await makeSb3([sprite('Cat', [[flag(), b('motion_setx', {inputs: {X: 10}})]])]);
    const check = dynamic([{do: 'greenFlag'}, {do: 'wait', ms: 50}], [cat('x', 'eq', 10)]);
    const times = [];
    for (let i = 0; i < 20; i++) {
        const graded = await gradeProject(sb3, [check]);
        assert(graded.result === 'pass', `run ${i}: ${JSON.stringify(graded.checkResults)}`);
        times.push(graded.ms);
    }
    assert(webglErrors.length === 0, webglErrors.slice(0, 3).join(' / '));
    return {medianMs: times.sort((a, b2) => a - b2)[10], maxMs: times[19]};
});

await browser.close();
fs.writeFileSync(path.join(out, 'grade-result.json'), JSON.stringify({results}, null, 2));
const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
