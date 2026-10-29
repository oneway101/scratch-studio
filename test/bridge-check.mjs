// Stage 1 checks: the bridge (protocol.ts) against a cross-origin host page.
// Needs a build (npm run build) and the servers from dev/serve.mjs (npm run serve).
//   npm run check
import {createRequire} from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from '@playwright/test';

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
        record(name, false, String(error && error.message || error).slice(0, 300));
    }
};
const assert = (cond, message) => {
    if (!cond) throw new Error(message);
};

const editProject = async (sb3, edit) => {
    const zip = await JSZip.loadAsync(sb3);
    const project = JSON.parse(await zip.file('project.json').async('string'));
    edit(project);
    zip.file('project.json', JSON.stringify(project));
    return zip.generateAsync({type: 'nodebuffer'});
};

// Adds "when right arrow pressed -> move 10" to the first sprite.
const addScript = sb3 => editProject(sb3, project => {
    const sprite = project.targets.find(t => !t.isStage);
    Object.assign(sprite.blocks, {
        k1: {opcode: 'event_whenkeypressed', next: 'k2', parent: null, inputs: {},
            fields: {KEY_OPTION: ['right arrow', null]}, shadow: false, topLevel: true, x: 40, y: 40},
        k2: {opcode: 'motion_movesteps', next: null, parent: 'k1', inputs: {STEPS: [1, [4, '10']]},
            fields: {}, shadow: false, topLevel: false}
    });
});

// Declares an extension that is not bundled with the editor, as a project made elsewhere could.
// The VM finds extensions from block opcodes, so the project needs a block from it.
const addCustomExtension = sb3 => editProject(sb3, project => {
    const sprite = project.targets.find(t => !t.isStage);
    sprite.blocks.e1 = {opcode: 'evil_hello', next: null, parent: null, inputs: {}, fields: {},
        shadow: false, topLevel: true, x: 40, y: 300};
    project.extensions = [...(project.extensions || []), 'evil'];
    project.extensionURLs = {evil: 'https://example.com/evil.js'};
});

const browser = await chromium.launch();
const context = await browser.newContext({viewport: {width: 1440, height: 900}});
const page = await context.newPage();
const hosts = new Map();
page.on('request', request => {
    const host = new URL(request.url()).host;
    hosts.set(host, (hosts.get(host) || 0) + 1);
});

await page.goto(`${HOST}/`);
await page.waitForFunction(() => window.host.readyAt !== null, null, {timeout: 120000});
const editor = page.frames().find(f => f.url().startsWith(EDITOR));

// The checks read editor state through TurboWarp's Redux store, which is only reachable from the editor's origin.
const vmEval = fn => editor.evaluate(`(${fn})(window.ReduxStore.getState().scratchGui.vm)`);
const request = (type, payload) => page.evaluate(([t, p]) => window.host.request(t, p), [type, payload]);
// Resolves with the error reply as "code: message", or 'answered' when the editor did not refuse.
const requestError = (type, payload) => page.evaluate(([t, p]) => window.host.request(t, p)
    .then(() => 'answered', e => e.message), [type, payload]);
const clearEvents = () => page.evaluate(() => {
    window.host.events.length = 0;
});
const eventsOf = type => page.evaluate(t => window.host.events.filter(e => e.type === t), type);
const sendBytes = (type, bytes) => page.evaluate(([t, b]) => window.host.request(t, {sb3: new Uint8Array(b).buffer}),
    [type, Array.from(bytes)]);
const opcodes = () => vmEval(vm => Object.values(JSON.parse(vm.toJSON()).targets.find(t => !t.isStage).blocks)
    .map(b => b.opcode));

await attempt('01 다른 출처의 iframe에서 ready 수신', async () => {
    const readyMs = await page.evaluate(() => Math.round(window.host.readyAt));
    return {hostOrigin: HOST, editorOrigin: new URL(editor.url()).origin, readyMs};
});

await attempt('02 init: 한국어 편집 모드', async () => {
    await request('init', {locale: 'ko', mode: 'edit'});
    await editor.waitForSelector('.blocklyFlyoutLabelText', {timeout: 30000});
    const locale = await editor.evaluate(() => window.ReduxStore.getState().locales.locale);
    const label = await editor.evaluate(() => document.querySelector('.blocklyFlyoutLabelText').textContent);
    assert(locale === 'ko' && label === '동작', `locale=${locale} label=${label}`);
    return {locale, firstToolboxLabel: label};
});

await attempt('03 잘못된 메시지에는 error 응답 (payload, version, type)', async () => {
    const badLocale = await requestError('init', {locale: 'ja', mode: 'edit'});
    const badMode = await requestError('setMode', {mode: 'teacher'});
    const badSb3 = await requestError('loadProject', {sb3: 'not a buffer'});
    const unknownType = await requestError('ready');
    const badVersion = await page.evaluate(() => new Promise(resolve => {
        const listener = e => {
            if (e.data && e.data.requestId === 'v9') {
                removeEventListener('message', listener);
                resolve(e.data);
            }
        };
        addEventListener('message', listener);
        window.host.post({source: 'scratch-studio', version: 9, type: 'init', requestId: 'v9', payload: {}});
    }));
    assert([badLocale, badMode, badSb3].every(m => /^invalid_payload/.test(m)), 'invalid payload accepted');
    assert(/^unknown_type/.test(unknownType), unknownType);
    assert(badVersion.type === 'error' && badVersion.payload.code === 'unsupported_version', 'bad version');
    return {badLocale, badMode, badSb3, unknownType, badVersion: badVersion.payload.code};
});

let original;
await attempt('04 exportProject: sb3(zip) 수신', async () => {
    const bytes = await page.evaluate(async () => Array.from(new Uint8Array((await window.host.request('exportProject')).sb3)));
    original = Buffer.from(bytes);
    assert(original[0] === 0x50 && original[1] === 0x4b, 'not a zip');
    return {bytes: original.length};
});

await attempt('05 loadProject: 고친 sb3 열기, 열고 나면 바뀌지 않은 상태', async () => {
    const modified = await addScript(original);
    fs.writeFileSync(path.join(out, 'sample.sb3'), modified);
    await sendBytes('loadProject', modified);
    const ops = await opcodes();
    const changed = await editor.evaluate(() => window.ReduxStore.getState().scratchGui.projectChanged);
    assert(ops.includes('event_whenkeypressed'), 'script missing');
    assert(changed === false, 'projectChanged should be false after load');
    return {opcodes: ops, changed};
});

await attempt('06 loadProject: sb3 null이면 빈 프로젝트', async () => {
    await request('loadProject', {sb3: null});
    const info = await vmEval(vm => ({
        sprites: vm.runtime.targets.filter(t => t.isOriginal && !t.isStage).length,
        blocks: JSON.parse(vm.toJSON()).targets.reduce((n, t) => n + Object.keys(t.blocks).length, 0)
    }));
    assert(info.sprites === 1 && info.blocks === 0, JSON.stringify(info));
    await sendBytes('loadProject', fs.readFileSync(path.join(out, 'sample.sb3')));
    return info;
});

await attempt('07 projectChanged: edit 모드에서만 알림', async () => {
    const touch = () => vmEval(vm => vm.runtime.emitProjectChanged());
    const settle = () => page.waitForTimeout(300);
    await clearEvents();
    await touch();
    await page.waitForFunction(() => window.host.events.some(e => e.type === 'projectChanged'), null, {timeout: 5000});
    const counts = {edit: (await eventsOf('projectChanged')).length};
    for (const mode of ['player', 'view']) {
        await request('setSaveStatus', {status: 'saved'}).catch(() => {});
        await request('setMode', {mode});
        await editor.evaluate(() => window.ReduxStore.dispatch({type: 'scratch-gui/project-changed/SET_PROJECT_CHANGED', changed: false}));
        await clearEvents();
        await touch();
        await settle();
        counts[mode] = (await eventsOf('projectChanged')).length;
    }
    await request('setMode', {mode: 'edit'});
    await request('setSaveStatus', {status: 'saved'});
    assert(counts.edit >= 1 && counts.player === 0 && counts.view === 0, JSON.stringify(counts));
    return counts;
});

await attempt('08 captureStage: 480x360 PNG 수신', async () => {
    const png = Buffer.from(await page.evaluate(async () =>
        Array.from(new Uint8Array((await window.host.request('captureStage')).png))));
    assert(png[0] === 0x89 && png[1] === 0x50, 'not a png');
    fs.writeFileSync(path.join(out, 'stage.png'), png);
    const size = {width: png.readUInt32BE(16), height: png.readUInt32BE(20)};
    assert(size.width === 480 && size.height === 360, JSON.stringify(size));
    return {bytes: png.length, ...size};
});

await attempt('09 setMode: 편집 / 실행 전용 / 블록 보기 전환, 작품 유지', async () => {
    const count = () => editor.evaluate(() => ({
        workspace: document.querySelectorAll('.blocklyWorkspace').length,
        stage: document.querySelectorAll('canvas').length,
        saveUi: document.querySelectorAll('[data-studio=save]').length
    }));
    const edit = await count();
    await request('setMode', {mode: 'player'});
    await page.waitForTimeout(500);
    const player = await count();
    await page.screenshot({path: path.join(out, 'mode-player.png')});
    await request('setMode', {mode: 'view'});
    await editor.waitForSelector('.blocklyWorkspace', {timeout: 30000});
    await page.waitForTimeout(500);
    const view = await count();
    await page.screenshot({path: path.join(out, 'mode-view.png')});
    await request('setMode', {mode: 'edit'});
    await editor.waitForSelector('.blocklyWorkspace', {timeout: 30000});
    const kept = (await opcodes()).includes('event_whenkeypressed');
    assert(edit.workspace > 0 && edit.saveUi === 1, 'edit mode wrong');
    assert(player.workspace === 0 && player.stage > 0 && player.saveUi === 0, 'player mode wrong');
    assert(view.workspace > 0 && view.saveUi === 0, 'view mode wrong');
    assert(kept, 'project lost when switching modes');
    return {edit, player, view, scriptsKept: kept};
});

await attempt('10 저장 버튼: saveRequested / setSaveStatus, edit 모드에서만', async () => {
    const read = () => editor.evaluate(() => ({
        text: document.querySelector('[data-studio=save-status]').textContent,
        disabled: document.querySelector('[data-studio=save-button]').disabled,
        retry: document.querySelectorAll('[data-studio=save-retry]').length
    }));
    await clearEvents();
    await editor.click('[data-studio=save-button]');
    await page.waitForFunction(() => window.host.events.some(e => e.type === 'saveRequested'), null, {timeout: 5000});
    await request('setSaveStatus', {status: 'saving'});
    const saving = await read();
    await request('setSaveStatus', {status: 'failed'});
    const failed = await read();
    await clearEvents();
    await editor.click('[data-studio=save-retry]');
    await page.waitForFunction(() => window.host.events.some(e => e.type === 'saveRequested'), null, {timeout: 5000});
    await request('setSaveStatus', {status: 'saved'});
    const saved = await read();
    await page.screenshot({path: path.join(out, 'mode-edit.png')});
    await request('setMode', {mode: 'view'});
    const inView = await requestError('setSaveStatus', {status: 'saving'});
    await request('setMode', {mode: 'edit'});
    assert(saving.disabled && failed.retry === 1 && saved.retry === 0 && !saved.disabled, 'save ui state wrong');
    assert(/^wrong_mode/.test(inView), inView);
    return {saving, failed, saved, setSaveStatusInView: inView};
});

await attempt('11 언어 메뉴: 한국어/영어만, localeChanged, init은 되돌려 보내지 않음', async () => {
    await clearEvents();
    const menuBar = editor.locator('[class*=menu-bar_main-menu]');
    await menuBar.getByText('설정', {exact: true}).first().click();
    await editor.getByText('언어', {exact: true}).first().click();
    const items = await editor.evaluate(() => Array.from(
        document.querySelectorAll('[class*=settings-menu_language-menu-item]')).map(e => e.textContent.trim()));
    await editor.getByText('English', {exact: true}).first().click();
    await page.waitForFunction(() => window.host.events.some(e => e.type === 'localeChanged'), null, {timeout: 5000});
    const event = (await eventsOf('localeChanged'))[0];
    await editor.waitForFunction(() => /Motion/.test(
        (document.querySelector('.blocklyFlyoutLabelText') || {}).textContent || ''), null, {timeout: 30000});
    const kept = (await opcodes()).includes('event_whenkeypressed');
    await clearEvents();
    await request('init', {locale: 'ko', mode: 'edit'});
    await page.waitForTimeout(500);
    const echoed = (await eventsOf('localeChanged')).length;
    assert(items.length === 2, `language items: ${items.join(',')}`);
    assert(event.payload.locale === 'en', 'wrong locale');
    assert(kept, 'project lost when switching language');
    assert(echoed === 0, 'init echoed localeChanged');
    return {items, event: event.payload, scriptsKept: kept, echoedAfterInit: echoed};
});

await attempt('12 메뉴 바: 고급 설정·문의하기·테마 메뉴 없음, 보라색', async () => {
    const menuText = await editor.evaluate(() => document.querySelector('[class*=menu-bar_menu-bar]').textContent);
    const background = await editor.evaluate(() =>
        getComputedStyle(document.querySelector('[class*=menu-bar_menu-bar]')).backgroundColor);
    const menuBar = editor.locator('[class*=menu-bar_main-menu]');
    await menuBar.getByText('설정', {exact: true}).first().click();
    const settingsItems = await editor.evaluate(() => Array.from(
        document.querySelectorAll('[class*=menu-bar_menu-bar-menu] [class*=menu_menu-item]'))
        .map(e => e.textContent.trim()).filter(Boolean));
    await menuBar.getByText('설정', {exact: true}).first().click();
    await menuBar.getByText('편집', {exact: true}).first().click();
    const editItems = await editor.evaluate(() => Array.from(
        document.querySelectorAll('[class*=menu-bar_menu-bar-menu] [class*=menu_menu-item]'))
        .map(e => e.textContent.trim()).filter(Boolean));
    await menuBar.getByText('편집', {exact: true}).first().click();
    assert(!/고급|TurboWarp/.test(menuText), `menu bar: ${menuText}`);
    // Only the language item (and its English / 한국어 submenu) is left.
    const others = settingsItems.filter(t => !/언어|English|한국어/.test(t));
    assert(others.length === 0, `settings items: ${settingsItems.join(',')}`);
    assert(!editItems.some(t => /고급/.test(t)), `edit items: ${editItems.join(',')}`);
    // TurboWarp's purple accent, hsla(260, 60%, 60%) = #855CD6
    assert(background === 'rgb(133, 92, 214)', background);
    return {background, settingsItems, editItems};
});

await attempt('13 확장 라이브러리: 사용자 확장과 갤러리 없음', async () => {
    hosts.clear();
    await editor.locator('[class*=gui_extension-button]').first().click();
    await editor.waitForSelector('[class*=library-item_library-item]', {timeout: 10000});
    await page.waitForTimeout(1500);
    const items = await editor.evaluate(() => Array.from(document.querySelectorAll('[class*=library-item_library-item]'))
        .map(e => e.querySelector('[class*=library-item_library-item-name]')?.textContent.trim()).filter(Boolean));
    await page.screenshot({path: path.join(out, 'extensions.png')});
    await page.keyboard.press('Escape');
    await editor.locator('[class*=modal_header-item-close], [aria-label="Close"], [aria-label="닫기"]').first().click()
        .catch(() => {});
    const gallery = hosts.get('extensions.turbowarp.org') || 0;
    assert(!items.some(name => /사용자 확장|Custom Extension|갤러리|Gallery/.test(name)), `items: ${items.join(',')}`);
    assert(gallery === 0, `gallery requests: ${gallery}`);
    return {items, galleryRequests: gallery};
});

await attempt('14 번들되지 않은 확장은 URL로도 불러올 수 없음, 펜은 됨', async () => {
    const custom = await vmEval(vm => vm.extensionManager.loadExtensionURL('https://example.com/evil.js')
        .then(() => 'loaded', e => e.message));
    const dataUrl = await vmEval(vm => vm.extensionManager.loadExtensionURL('data:text/javascript,1')
        .then(() => 'loaded', e => e.message));
    const pen = await vmEval(vm => vm.extensionManager.loadExtensionURL('pen')
        .then(() => vm.extensionManager.isExtensionLoaded('pen')));
    assert(/disabled/.test(custom) && /disabled/.test(dataUrl), `${custom} / ${dataUrl}`);
    assert(pen === true, 'pen did not load');
    return {custom, dataUrl, pen};
});

await attempt('15 번들되지 않은 확장이 든 작품은 열리지 않음', async () => {
    const evil = await addCustomExtension(original);
    const reply = await page.evaluate(b => window.host.request('loadProject', {sb3: new Uint8Array(b).buffer})
        .then(() => 'loaded', e => e.message), Array.from(evil));
    await sendBytes('loadProject', fs.readFileSync(path.join(out, 'sample.sb3')));
    assert(/^failed/.test(reply), reply);
    return {reply};
});

await attempt('16 grade: 빈 채점 규칙은 통과, 작품(sb3)을 함께 돌려줌 (자세한 점검은 npm run check:grade)', async () => {
    const reply = await page.evaluate(() => window.host.request('grade', {checks: []})
        .then(r => ({result: r.result, sb3: r.sb3.byteLength})));
    assert(reply.result === 'pass' && reply.sb3 > 0, JSON.stringify(reply));
    return reply;
});

await attempt('17 window.__studioVm 없음', async () => {
    const exposed = await editor.evaluate(() => 'window.__studioVm' in window || typeof window.__studioVm !== 'undefined');
    assert(!exposed, 'exposed');
    return {exposed};
});

await attempt('18 에디터가 iframe 높이를 채움', async () => {
    const size = await editor.evaluate(() => {
        const gui = document.querySelector('#app > *');
        return {frame: window.innerHeight, gui: Math.round(gui.getBoundingClientRect().height)};
    });
    assert(Math.abs(size.frame - size.gui) <= 2, JSON.stringify(size));
    return size;
});

await attempt('19 스프라이트·소리·배경 라이브러리의 요청 서버 (둘러볼 때, 하나 추가할 때)', async () => {
    const open = async (select, name) => {
        hosts.clear();
        await select();
        await editor.waitForSelector('[class*=library-item_library-item]', {timeout: 10000});
        await page.waitForTimeout(3000);
        await page.screenshot({path: path.join(out, `library-${name}.png`)});
        const browsing = Object.fromEntries(hosts);
        hosts.clear();
        await editor.locator('[class*=library-item_library-item]').first().click();
        await page.waitForTimeout(3000);
        return {browsing, adding: Object.fromEntries(hosts)};
    };
    const sprite = await open(() => editor.locator('[aria-label="스프라이트 고르기"]').first().click(), 'sprite');
    const backdrop = await open(() => editor.locator('[aria-label="배경 고르기"]').first().click(), 'backdrop');
    await editor.locator('[class*=react-tabs_react-tabs__tab]').getByText('소리', {exact: true}).first().click();
    const sound = await open(() => editor.locator('[aria-label="소리 고르기"]').first().click(), 'sound');
    await editor.locator('[class*=react-tabs_react-tabs__tab]').getByText('코드', {exact: true}).first().click();
    await sendBytes('loadProject', fs.readFileSync(path.join(out, 'sample.sb3')));
    const external = ({browsing, adding}) => Object.keys({...browsing, ...adding}).filter(h => !h.startsWith('localhost'));
    assert(external(sprite).length && external(backdrop).length && external(sound).length,
        `a library did not load: ${JSON.stringify({sprite, backdrop, sound})}`);
    return {sprite, backdrop, sound};
});

await attempt('20 작품 파일 불러오기: 버튼과 끌어다 놓기, 불러오면 바뀐 상태, edit 모드에서만', async () => {
    const dialogs = [];
    let answer = true;
    const onDialog = dialog => {
        dialogs.push(dialog.message());
        (answer ? dialog.accept() : dialog.dismiss()).catch(() => {});
    };
    page.on('dialog', onDialog);
    const sample = fs.readFileSync(path.join(out, 'sample.sb3'));
    const fromFile = await editProject(sample, project => {
        project.targets.find(t => !t.isStage).blocks.f1 = {opcode: 'looks_show', next: null, parent: null,
            inputs: {}, fields: {}, shadow: false, topLevel: true, x: 40, y: 200};
    });
    const hasMarker = async () => (await opcodes()).includes('looks_show');
    const changed = () => editor.evaluate(() => window.ReduxStore.getState().scratchGui.projectChanged);
    const reset = () => sendBytes('loadProject', sample);
    const pick = async (name, bytes) => {
        const chooser = page.waitForEvent('filechooser');
        await editor.click('[data-studio=load-button]');
        await (await chooser).setFiles({name, mimeType: 'application/x.scratch.sb3', buffer: bytes});
        await page.waitForTimeout(1500);
    };
    // A synthetic drag of a file over the code area, as the browser does for a real one.
    const drop = async (name, bytes) => {
        const overlay = await editor.evaluate(([n, b]) => {
            const transfer = new DataTransfer();
            transfer.items.add(new File([new Uint8Array(b)], n));
            const target = document.querySelector('.blocklyWorkspace');
            target.dispatchEvent(new DragEvent('dragover', {bubbles: true, cancelable: true, dataTransfer: transfer}));
            const shown = document.querySelector('[data-studio=project-drop]').style.display === 'flex';
            target.dispatchEvent(new DragEvent('drop', {bubbles: true, cancelable: true, dataTransfer: transfer}));
            return shown;
        }, [name, Array.from(bytes)]);
        await page.waitForTimeout(1500);
        return overlay;
    };
    try {
        await reset();
        await clearEvents();
        answer = false;
        await pick('game.sb3', fromFile);
        const declined = {loaded: await hasMarker(), changed: await changed()};

        answer = true;
        await pick('game.sb3', fromFile);
        await page.waitForFunction(() => window.host.events.some(e => e.type === 'projectChanged'), null, {timeout: 5000});
        const button = {loaded: await hasMarker(), changed: await changed()};

        await reset();
        const overlay = await drop('game.sb3', fromFile);
        const dropped = {loaded: await hasMarker(), changed: await changed(), overlay};

        await reset();
        dialogs.length = 0;
        await drop('cat.png', fromFile);
        const notProject = {loaded: await hasMarker(), dialogs: [...dialogs]};

        dialogs.length = 0;
        await drop('evil.sb3', await addCustomExtension(sample));
        const broken = {kept: (await opcodes()).includes('event_whenkeypressed'), changed: await changed(),
            dialogs: [...dialogs]};

        await request('setMode', {mode: 'view'});
        await editor.waitForSelector('.blocklyWorkspace', {timeout: 30000});
        dialogs.length = 0;
        await drop('game.sb3', fromFile);
        const inView = {loaded: await hasMarker(), dialogs: dialogs.length};
        await request('setMode', {mode: 'edit'});
        await editor.waitForSelector('.blocklyWorkspace', {timeout: 30000});

        assert(!declined.loaded && !declined.changed, `declined: ${JSON.stringify(declined)}`);
        assert(button.loaded && button.changed, `button: ${JSON.stringify(button)}`);
        assert(dropped.loaded && dropped.changed && dropped.overlay, `drop: ${JSON.stringify(dropped)}`);
        assert(!notProject.loaded && notProject.dialogs.length === 1, `not a project: ${JSON.stringify(notProject)}`);
        assert(broken.kept && !broken.changed && broken.dialogs.length === 2, `broken: ${JSON.stringify(broken)}`);
        assert(!inView.loaded && inView.dialogs === 0, `view mode: ${JSON.stringify(inView)}`);
        return {declined, button, dropped, notProject, broken, inView};
    } finally {
        page.off('dialog', onDialog);
        await reset();
        await request('setSaveStatus', {status: 'saved'});
    }
});

await page.close();

// Origin checks need pages on the origin that is not allowed.
await attempt('21 허용되지 않은 출처에서는 임베드 자체가 막힘 (frame-ancestors)', async () => {
    const bad = await context.newPage();
    await bad.goto('http://localhost:8603/');
    await bad.waitForTimeout(5000);
    const ready = await bad.evaluate(() => window.host.readyAt);
    const frames = bad.frames().map(f => f.url());
    await bad.close();
    assert(ready === null, 'editor became ready on a disallowed origin');
    return {frames};
});

await attempt('22 허용되지 않은 출처의 메시지는 무시됨 (헤더 없이도)', async () => {
    const bad = await context.newPage();
    await bad.goto('http://localhost:8603/?editor=http://localhost:8604');
    const frame = () => bad.frames().find(f => f.url().startsWith('http://localhost:8604'));
    await bad.waitForFunction(() => document.getElementById('editor').contentWindow.length >= 0);
    await bad.waitForTimeout(15000);
    const loaded = await frame().evaluate(() => Boolean(window.ReduxStore && window.ReduxStore.getState().scratchGui.vm));
    const ready = await bad.evaluate(() => window.host.readyAt);
    const reply = await bad.evaluate(() => Promise.race([
        window.host.request('exportProject').then(() => 'answered', e => e.message),
        new Promise(r => setTimeout(() => r('no reply in 5s'), 5000))]));
    await bad.close();
    assert(loaded, 'editor did not load on 8604');
    assert(ready === null && reply === 'no reply in 5s', `ready=${ready} reply=${reply}`);
    return {editorLoaded: loaded, ready, reply};
});

await browser.close();
fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({results}, null, 2));
const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
