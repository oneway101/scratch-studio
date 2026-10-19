// Automated stage 0 checks. Needs the servers from spike/serve.mjs.
//   npm run spike:check
import {createRequire} from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from '@playwright/test';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const JSZip = createRequire(path.join(root, 'vendor/scratch-gui/package.json'))('@turbowarp/jszip');

const out = path.join(root, 'spike/out');
fs.mkdirSync(out, {recursive: true});
const results = [];
const record = (name, ok, detail) => {
    results.push({name, ok, detail});
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail === undefined ? '' : JSON.stringify(detail)}`);
};
const attempt = async (name, fn) => {
    try {
        const detail = await fn();
        record(name, true, detail);
    } catch (error) {
        record(name, false, String(error && error.message || error).slice(0, 300));
    }
};
const assert = (cond, message) => { if (!cond) throw new Error(message); };

// Adds "when right arrow pressed -> move 10" and "when flag clicked -> forever change y by 1" to the first sprite.
const addScripts = async sb3 => {
    const zip = await JSZip.loadAsync(sb3);
    const project = JSON.parse(await zip.file('project.json').async('string'));
    const sprite = project.targets.find(t => !t.isStage);
    Object.assign(sprite.blocks, {
        k1: {opcode: 'event_whenkeypressed', next: 'k2', parent: null, inputs: {},
            fields: {KEY_OPTION: ['right arrow', null]}, shadow: false, topLevel: true, x: 40, y: 40},
        k2: {opcode: 'motion_movesteps', next: null, parent: 'k1', inputs: {STEPS: [1, [4, '10']]},
            fields: {}, shadow: false, topLevel: false},
        f1: {opcode: 'event_whenflagclicked', next: 'f2', parent: null, inputs: {}, fields: {},
            shadow: false, topLevel: true, x: 40, y: 200},
        f2: {opcode: 'control_forever', next: null, parent: 'f1', inputs: {SUBSTACK: [2, 'f3']},
            fields: {}, shadow: false, topLevel: false},
        f3: {opcode: 'motion_changeyby', next: null, parent: 'f2', inputs: {DY: [1, [4, '1']]},
            fields: {}, shadow: false, topLevel: false}
    });
    sprite.x = 0;
    sprite.y = 0;
    zip.file('project.json', JSON.stringify(project));
    return zip.generateAsync({type: 'nodebuffer'});
};

const browser = await chromium.launch();
const context = await browser.newContext({viewport: {width: 1440, height: 900}});
const page = await context.newPage();
const hosts = new Map();
page.on('request', request => {
    const host = new URL(request.url()).host;
    hosts.set(host, (hosts.get(host) || 0) + 1);
});
const consoleErrors = [];
page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 200)); });

const t0 = Date.now();
await page.goto('http://localhost:8602/');
await page.waitForFunction(() => window.host.readyAt !== null, null, {timeout: 120000});
const editor = page.frames().find(f => f.url().startsWith('http://localhost:8601'));
const spriteX = () => editor.evaluate(() => window.__studioVm.runtime.targets.find(t => !t.isStage).x);
// Block ids are rewritten when the project is serialized, so look for the opcode instead.
const hasKeyScript = () => editor.evaluate(() => Object.values(JSON.parse(window.__studioVm.toJSON())
    .targets.find(t => !t.isStage).blocks).some(b => b.opcode === 'event_whenkeypressed'));

await attempt('01 다른 출처의 iframe에서 ready 수신', async () => {
    const readyMs = await page.evaluate(() => Math.round(window.host.readyAt));
    return {hostOrigin: 'http://localhost:8602', editorOrigin: new URL(editor.url()).origin,
        readyMs, wallMs: Date.now() - t0};
});

await attempt('02 init: 한국어 편집 모드', async () => {
    await page.evaluate(() => window.host.request('init', {locale: 'ko', mode: 'edit'}));
    const locale = await editor.evaluate(() => window.ReduxStore.getState().locales.locale);
    await editor.waitForSelector('.blocklyFlyoutLabelText', {timeout: 30000});
    const label = await editor.evaluate(() => document.querySelector('.blocklyFlyoutLabelText').textContent);
    assert(locale === 'ko', `locale=${locale}`);
    return {locale, firstToolboxLabel: label};
});

let original;
await attempt('03 exportProject: sb3(zip) 수신', async () => {
    const bytes = await page.evaluate(async () => {
        const r = await window.host.request('exportProject');
        window.host.kept = r.sb3;
        return Array.from(new Uint8Array(r.sb3));
    });
    original = Buffer.from(bytes);
    assert(original[0] === 0x50 && original[1] === 0x4b, 'not a zip');
    fs.writeFileSync(path.join(out, 'default.sb3'), original);
    return {bytes: original.length};
});

await attempt('04 loadProject: 고친 sb3 열기 + 프로젝트 JSON 읽기', async () => {
    const modified = await addScripts(original);
    fs.writeFileSync(path.join(out, 'sample.sb3'), modified);
    await page.evaluate(async bytes => {
        await window.host.request('loadProject', {sb3: new Uint8Array(bytes).buffer});
    }, Array.from(modified));
    const info = await editor.evaluate(() => {
        const project = JSON.parse(window.__studioVm.toJSON());
        const sprite = project.targets.find(t => !t.isStage);
        return {opcodes: Object.values(sprite.blocks).map(b => b.opcode),
            changed: window.ReduxStore.getState().scratchGui.projectChanged};
    });
    assert(info.opcodes.includes('event_whenkeypressed'), 'script missing');
    assert(info.changed === false, 'projectChanged should be false after load');
    return info;
});

await attempt('05 projectChanged: 작품이 바뀌면 알림', async () => {
    await page.evaluate(() => { window.host.events.length = 0; });
    await editor.evaluate(() => window.__studioVm.runtime.emitProjectChanged());
    await page.waitForFunction(() => window.host.events.some(e => e.type === 'projectChanged'), null, {timeout: 5000});
    return {};
});

await attempt('06 키 입력 주입 + 스프라이트 좌표 읽기 (작업 중인 VM)', async () => {
    const before = await spriteX();
    await editor.evaluate(async () => {
        const vm = window.__studioVm;
        vm.postIOData('keyboard', {key: 'ArrowRight', isDown: true});
        await new Promise(r => setTimeout(r, 200));
        vm.postIOData('keyboard', {key: 'ArrowRight', isDown: false});
        await new Promise(r => setTimeout(r, 300));
    });
    const after = await spriteX();
    assert(after > before, `x ${before} -> ${after}`);
    return {before, after};
});

await attempt('07 초록 깃발 실행 + 멈추기', async () => {
    const y = () => editor.evaluate(() => window.__studioVm.runtime.targets.find(t => !t.isStage).y);
    const before = await y();
    await editor.evaluate(async () => {
        window.__studioVm.greenFlag();
        await new Promise(r => setTimeout(r, 500));
        window.__studioVm.stopAll();
    });
    const after = await y();
    assert(after > before, `y ${before} -> ${after}`);
    return {before, after};
});

await attempt('08 captureStage: PNG 수신', async () => {
    const bytes = await page.evaluate(async () => {
        const r = await window.host.request('captureStage');
        return Array.from(new Uint8Array(r.png));
    });
    const png = Buffer.from(bytes);
    assert(png[0] === 0x89 && png[1] === 0x50, 'not a png');
    fs.writeFileSync(path.join(out, 'stage.png'), png);
    return {bytes: png.length, width: png.readUInt32BE(16), height: png.readUInt32BE(20)};
});

const dynamicCheck = renderer => ({type: 'dynamic', renderer, actions: [
    {do: 'greenFlag'}, {do: 'keyPress', key: 'ArrowRight', durationMs: 200}, {do: 'wait', ms: 500}]});

await attempt('09 보이지 않는 두 번째 실행 환경 (렌더러 없이)', async () => {
    const before = await spriteX();
    const r = await page.evaluate(check => window.host.request('grade', {checks: [check]}), dynamicCheck(false));
    const run = r.checkResults.dynamic[0];
    const after = await spriteX();
    assert(run.final[0].x > run.initial[0].x, 'headless sprite did not move');
    assert(run.final[0].y > run.initial[0].y, 'headless forever loop did not run');
    assert(after === before, 'student VM changed during grading');
    return {headless: run, studentXUnchanged: true, staticOpcodes: Object.keys(r.checkResults.static.opcodes).length};
});

await attempt('10 두 번째 실행 환경 (렌더러 포함) 10회 반복 생성/제거', async () => {
    const times = [];
    let firstRun = null;
    for (let i = 0; i < 10; i++) {
        const r = await page.evaluate(check => window.host.request('grade', {checks: [check]}), dynamicCheck(true));
        const run = r.checkResults.dynamic[0];
        assert(run.final[0].x > run.initial[0].x, `run ${i}: sprite did not move`);
        times.push(run.totalMs);
        if (i === 0) firstRun = run;
    }
    const stageStillDraws = await page.evaluate(async () => (await window.host.request('captureStage')).png.byteLength > 0);
    assert(stageStillDraws, 'student stage lost its context');
    return {totalMsPerRun: times, firstRun, lostContextErrors: consoleErrors.filter(e => /context/i.test(e)).length};
});

await attempt('11 setMode: 실행 전용 화면 <-> 블록 보기 화면', async () => {
    const count = () => editor.evaluate(() => ({
        workspace: document.querySelectorAll('.blocklyWorkspace').length,
        canvas: document.querySelectorAll('canvas').length,
        saveUi: document.querySelectorAll('[data-studio=save]').length
    }));
    const edit = await count();
    await page.evaluate(() => window.host.request('setMode', {mode: 'player'}));
    await page.waitForTimeout(500);
    const player = await count();
    await page.screenshot({path: path.join(out, 'mode-player.png')});
    await page.evaluate(() => window.host.request('setMode', {mode: 'view'}));
    await editor.waitForSelector('.blocklyWorkspace', {timeout: 30000});
    await page.waitForTimeout(500);
    const view = await count();
    const scriptsKept = await hasKeyScript();
    await page.screenshot({path: path.join(out, 'mode-view.png')});
    await page.evaluate(() => window.host.request('setMode', {mode: 'edit'}));
    await page.waitForTimeout(500);
    assert(player.workspace === 0, 'player mode still shows blocks');
    assert(view.workspace > 0 && view.saveUi === 0, 'view mode wrong');
    assert(scriptsKept, 'project lost when switching modes');
    return {edit, player, view, scriptsKept};
});

await attempt('12 저장 버튼: saveRequested / setSaveStatus', async () => {
    await page.evaluate(() => { window.host.events.length = 0; });
    await editor.click('[data-studio=save-button]');
    await page.waitForFunction(() => window.host.events.some(e => e.type === 'saveRequested'), null, {timeout: 5000});
    const read = () => editor.evaluate(() => ({
        text: document.querySelector('[data-studio=save-status]').textContent,
        disabled: document.querySelector('[data-studio=save-button]').disabled,
        retry: document.querySelectorAll('[data-studio=save-retry]').length
    }));
    await page.evaluate(() => window.host.request('setSaveStatus', {status: 'saving'}));
    const saving = await read();
    await page.evaluate(() => window.host.request('setSaveStatus', {status: 'failed'}));
    const failed = await read();
    await page.evaluate(() => { window.host.events.length = 0; });
    await editor.click('[data-studio=save-retry]');
    await page.waitForFunction(() => window.host.events.some(e => e.type === 'saveRequested'), null, {timeout: 5000});
    await page.evaluate(() => window.host.request('setSaveStatus', {status: 'saved'}));
    const saved = await read();
    assert(saving.disabled && failed.retry === 1 && saved.retry === 0, 'save ui state wrong');
    await page.screenshot({path: path.join(out, 'mode-edit.png')});
    return {saving, failed, saved};
});

await attempt('13 언어 메뉴: 한국어/영어만 + localeChanged', async () => {
    await page.evaluate(() => { window.host.events.length = 0; });
    // Open the settings menu, then the language submenu, and read the items.
    const menuBar = editor.locator('[class*=menu-bar_main-menu]');
    await menuBar.getByText('설정', {exact: true}).first().click();
    await editor.getByText('언어', {exact: true}).first().click();
    const items = await editor.evaluate(() => Array.from(
        document.querySelectorAll('[class*=settings-menu_language-menu-item]')).map(e => e.textContent.trim()));
    await editor.getByText('English', {exact: true}).first().click();
    await page.waitForFunction(() => window.host.events.some(e => e.type === 'localeChanged'), null, {timeout: 5000});
    const event = await page.evaluate(() => window.host.events.find(e => e.type === 'localeChanged'));
    await editor.waitForFunction(() => document.querySelector('.blocklyFlyoutLabelText') &&
        /Motion/.test(document.querySelector('.blocklyFlyoutLabelText').textContent), null, {timeout: 30000});
    const scriptsKept = await hasKeyScript();
    assert(scriptsKept, 'project lost when switching language');
    assert(items.length === 2, `language items: ${items.join(',')}`);
    assert(event.payload.locale === 'en', 'wrong locale');
    return {items, event: event.payload, scriptsKept};
});

await attempt('14 init으로 언어 복원 시 localeChanged를 되돌려 보내지 않음', async () => {
    await page.evaluate(() => { window.host.events.length = 0; });
    await page.evaluate(() => window.host.request('init', {locale: 'ko', mode: 'edit'}));
    await page.waitForTimeout(500);
    const echoed = await page.evaluate(() => window.host.events.filter(e => e.type === 'localeChanged').length);
    assert(echoed === 0, 'echoed localeChanged');
    return {};
});

await attempt('15 사용자 확장 기능 차단', async () => {
    const allowed = await editor.evaluate(() => window.__studioVm.extensionManager.securityManager
        .canLoadExtensionFromProject('https://example.com/evil.js'));
    assert(allowed === false, 'custom extension allowed');
    return {canLoadExtensionFromProject: allowed};
});

await attempt('16 모르는 version / type 에는 error 응답', async () => {
    const unknownType = await page.evaluate(() => window.host.request('nope').catch(e => e.message));
    const badVersion = await page.evaluate(() => new Promise(resolve => {
        const frame = document.getElementById('editor');
        const listener = e => { if (e.data && e.data.requestId === 'v9') { removeEventListener('message', listener); resolve(e.data); } };
        addEventListener('message', listener);
        frame.contentWindow.postMessage({source: 'scratch-studio', version: 9, type: 'init', requestId: 'v9'}, 'http://localhost:8601');
    }));
    assert(/unknown_type/.test(unknownType) && badVersion.type === 'error', 'no error reply');
    return {unknownType, badVersion: badVersion.payload};
});

await attempt('17 스프라이트 라이브러리를 여는 동안의 요청 서버', async () => {
    hosts.clear();
    await editor.locator('[aria-label="스프라이트 고르기"]').first().click();
    await page.waitForTimeout(4000);
    await page.screenshot({path: path.join(out, 'library.png')});
    const opening = Object.fromEntries(hosts);
    hosts.clear();
    await editor.locator('[class*=library-item_library-item]').first().click();
    await page.waitForTimeout(4000);
    const sprites = await editor.evaluate(() => window.__studioVm.runtime.targets.filter(t => !t.isStage).length);
    return {whileBrowsing: opening, whenAdding: Object.fromEntries(hosts), spritesAfterAdding: sprites};
});

await page.close();

// Origin checks need pages on the origin that is not allowed.
await attempt('18 허용되지 않은 출처에서는 임베드 자체가 막힘 (frame-ancestors)', async () => {
    const bad = await context.newPage();
    await bad.goto('http://localhost:8603/');
    await bad.waitForTimeout(5000);
    const ready = await bad.evaluate(() => window.host.readyAt);
    const frames = bad.frames().map(f => f.url());
    await bad.close();
    assert(ready === null, 'editor became ready on a disallowed origin');
    return {frames};
});

await attempt('19 허용되지 않은 출처의 메시지는 무시됨 (헤더 없이도)', async () => {
    const bad = await context.newPage();
    await bad.goto('http://localhost:8603/?editor=http://localhost:8604');
    const frame = () => bad.frames().find(f => f.url().startsWith('http://localhost:8604'));
    await bad.waitForFunction(() => document.getElementById('editor').contentWindow.length >= 0);
    await bad.waitForTimeout(15000);
    const loaded = await frame().evaluate(() => Boolean(window.__studioVm));
    const ready = await bad.evaluate(() => window.host.readyAt);
    const reply = await bad.evaluate(() => Promise.race([
        window.host.request('exportProject').then(() => 'answered', e => e.message),
        new Promise(r => setTimeout(() => r('no reply in 5s'), 5000))]));
    await bad.close();
    assert(loaded, 'editor did not load on 8604');
    assert(ready === null && reply === 'no reply in 5s', `ready=${ready} reply=${reply}`);
    return {editorLoaded: loaded, ready, reply};
});

await attempt('20 CPU 6배 감속에서의 로딩 시간과 채점 중 끊김 (저사양 PC 대용 추정치)', async () => {
    const slow = await context.newPage();
    const cdp = await context.newCDPSession(slow);
    await cdp.send('Emulation.setCPUThrottlingRate', {rate: 6});
    const started = Date.now();
    await slow.goto('http://localhost:8602/');
    await slow.waitForFunction(() => window.host.readyAt !== null, null, {timeout: 180000});
    const readyMs = Date.now() - started;
    const frame = slow.frames().find(f => f.url().startsWith('http://localhost:8601'));
    await slow.evaluate(bytes => window.host.request('loadProject', {sb3: new Uint8Array(bytes).buffer}),
        Array.from(fs.readFileSync(path.join(out, 'sample.sb3'))));
    // Longest gap between animation frames in the editor while a dynamic check runs.
    await frame.evaluate(() => {
        window.__gaps = [];
        let last = performance.now();
        const tick = now => { window.__gaps.push(now - last); last = now; window.__raf = requestAnimationFrame(tick); };
        window.__raf = requestAnimationFrame(tick);
    });
    const r = await slow.evaluate(check => window.host.request('grade', {checks: [check]}), dynamicCheck(true));
    const gaps = await frame.evaluate(() => { cancelAnimationFrame(window.__raf); return window.__gaps; });
    await slow.close();
    return {readyMs, gradeTotalMs: r.checkResults.dynamic[0].totalMs, gradeLoadMs: r.checkResults.dynamic[0].loadMs,
        longestFrameGapMs: Math.round(Math.max(...gaps)), framesOver100ms: gaps.filter(g => g > 100).length};
});

await browser.close();
fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({results, consoleErrors}, null, 2));
const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
