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
// The site saves an sb3 with the exportId exportProject (or grade) returned with it.
const exportSave = async () => (await request('exportProject')).exportId;
const setSaveStatus = (status, exportId) => request('setSaveStatus', {status, exportId});
// Saves the project as it is now, as the site does after an edit.
const markSaved = async () => setSaveStatus('saved', await exportSave());

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
    const noExportId = await requestError('setSaveStatus', {status: 'saved'});
    const unexported = await requestError('setSaveStatus', {status: 'saved', exportId: 1e9});
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
    assert([badLocale, badMode, badSb3, noExportId, unexported].every(m => /^invalid_payload/.test(m)),
        'invalid payload accepted');
    assert(/^unknown_type/.test(unknownType), unknownType);
    assert(badVersion.type === 'error' && badVersion.payload.code === 'unsupported_version', 'bad version');
    return {badLocale, badMode, badSb3, noExportId, unexported, unknownType,
        badVersion: badVersion.payload.code};
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
    // Again over a project that has blocks: Blockly's delete and create events come after the load.
    await clearEvents();
    await sendBytes('loadProject', modified);
    await page.waitForTimeout(500);
    const ops = await opcodes();
    const changed = await editor.evaluate(() => window.ReduxStore.getState().scratchGui.projectChanged);
    const events = (await eventsOf('projectChanged')).length;
    assert(ops.includes('event_whenkeypressed'), 'script missing');
    assert(changed === false && events === 0, `projectChanged after load: state=${changed} events=${events}`);
    return {opcodes: ops, changed, projectChangedEvents: events};
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
        await markSaved().catch(() => {});
        await request('setMode', {mode});
        await editor.evaluate(() => window.ReduxStore.dispatch({type: 'scratch-gui/project-changed/SET_PROJECT_CHANGED', changed: false}));
        await clearEvents();
        await touch();
        await settle();
        counts[mode] = (await eventsOf('projectChanged')).length;
    }
    await request('setMode', {mode: 'edit'});
    await markSaved();
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
        saveUi: document.querySelectorAll('[data-studio=save]').length,
        fileUi: document.querySelectorAll('[data-studio=file-menu]').length
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
    assert(edit.workspace > 0 && edit.saveUi === 1 && edit.fileUi === 1, 'edit mode wrong');
    assert(player.workspace === 0 && player.stage > 0 && player.saveUi === 0 && player.fileUi === 0, 'player mode wrong');
    assert(view.workspace > 0 && view.saveUi === 0 && view.fileUi === 0, 'view mode wrong');
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
    const exportId = await exportSave();
    await setSaveStatus('saving', exportId);
    const saving = await read();
    await setSaveStatus('failed', exportId);
    const failed = await read();
    await clearEvents();
    await editor.click('[data-studio=save-retry]');
    await page.waitForFunction(() => window.host.events.some(e => e.type === 'saveRequested'), null, {timeout: 5000});
    await markSaved();
    const saved = await read();
    await page.screenshot({path: path.join(out, 'mode-edit.png')});
    await request('setMode', {mode: 'view'});
    const inView = await requestError('setSaveStatus', {status: 'saving', exportId});
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

await attempt('16 grade: 빈 채점 규칙은 통과, 작품(sb3)을 함께 돌려줌, 시험 페이지는 그 sb3와 exportId를 함께 보관 (자세한 점검은 npm run check:grade)', async () => {
    const reply = await page.evaluate(() => window.host.request('grade', {checks: []})
        .then(r => ({result: r.result, sb3: r.sb3.byteLength, exportId: r.exportId,
            keptSame: window.host.kept === r.sb3, keptId: window.host.exportId})));
    assert(reply.result === 'pass' && reply.sb3 > 0, JSON.stringify(reply));
    assert(reply.keptSame && reply.keptId === reply.exportId, `host kept: ${JSON.stringify(reply)}`);
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

await attempt('20 작품 파일 불러오기: 파일 메뉴와 끌어다 놓기, 불러오면 바뀐 상태, edit 모드에서만', async () => {
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
        await editor.click('[data-studio=file-menu]');
        const chooser = page.waitForEvent('filechooser');
        await editor.click('[data-studio=file-load]');
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
        await markSaved();
    }
});

await attempt('21 컴퓨터에 저장하기: 파일 메뉴로 sb3 다운로드, 연 파일 이름을 이어 씀, 사이트 저장 상태는 그대로', async () => {
    const onDialog = dialog => dialog.accept().catch(() => {});
    page.on('dialog', onDialog);
    const sample = fs.readFileSync(path.join(out, 'sample.sb3'));
    const save = async () => {
        await editor.click('[data-studio=file-menu]');
        const download = page.waitForEvent('download');
        await editor.click('[data-studio=file-save]');
        const file = await download;
        const zip = await JSZip.loadAsync(fs.readFileSync(await file.path()));
        const project = JSON.parse(await zip.file('project.json').async('string'));
        const ops = Object.values(project.targets.find(t => !t.isStage).blocks).map(b => b.opcode);
        return {name: file.suggestedFilename(), hasScript: ops.includes('event_whenkeypressed')};
    };
    try {
        await sendBytes('loadProject', sample);
        await clearEvents();
        const fromSite = await save();
        const changed = await editor.evaluate(() => window.ReduxStore.getState().scratchGui.projectChanged);
        const events = await page.evaluate(() => window.host.events.map(e => e.type));
        const status = await editor.evaluate(() => document.querySelector('[data-studio=save-status]').textContent);

        await editor.click('[data-studio=file-menu]');
        const chooser = page.waitForEvent('filechooser');
        await editor.click('[data-studio=file-load]');
        await (await chooser).setFiles({name: '우리 게임.sb2', mimeType: 'application/octet-stream', buffer: sample});
        await page.waitForTimeout(1500);
        const fromFile = await save();

        assert(fromSite.name === '내 작품.sb3' && fromSite.hasScript, `from site: ${JSON.stringify(fromSite)}`);
        assert(!changed && events.length === 0 && status === '저장됨', `site state: ${changed} ${events} ${status}`);
        assert(fromFile.name === '우리 게임.sb3' && fromFile.hasScript, `from file: ${JSON.stringify(fromFile)}`);
        return {fromSite, fromFile, siteEvents: events, saveStatus: status};
    } finally {
        page.off('dialog', onDialog);
        await sendBytes('loadProject', sample);
        await markSaved();
    }
});

// Opens a file through the File menu, with confirm and alert answered and recorded.
const withFileDialogs = async fn => {
    const dialogs = [];
    const onDialog = dialog => {
        dialogs.push(dialog.message());
        dialog.accept().catch(() => {});
    };
    page.on('dialog', onDialog);
    const pick = async (name, bytes) => {
        await editor.click('[data-studio=file-menu]');
        const chooser = page.waitForEvent('filechooser');
        await editor.click('[data-studio=file-load]');
        await (await chooser).setFiles({name, mimeType: 'application/x.scratch.sb3', buffer: bytes});
    };
    try {
        return await fn(pick, dialogs);
    } finally {
        page.off('dialog', onDialog);
        await sendBytes('loadProject', fs.readFileSync(path.join(out, 'sample.sb3')));
        await markSaved();
    }
};
const spriteX = () => vmEval(vm => vm.runtime.targets.find(t => t.isOriginal && !t.isStage).x);
const projectChangedState = () => editor.evaluate(() => window.ReduxStore.getState().scratchGui.projectChanged);
// Holds the next File.arrayBuffer() in the editor until the check settles it.
const holdFileRead = () => editor.evaluate(() => {
    const original = File.prototype.arrayBuffer;
    File.prototype.arrayBuffer = function () {
        File.prototype.arrayBuffer = original;
        return new Promise((resolve, reject) => {
            window.__studioRead = {resolve: () => original.call(this).then(resolve, reject), reject};
        });
    };
});
const waitForHeldRead = () => editor.waitForFunction(() => Boolean(window.__studioRead), null, {timeout: 10000});
const settleHeldRead = how => editor.evaluate(h => {
    const read = window.__studioRead;
    delete window.__studioRead;
    if (h === 'fail') read.reject(new Error('read failed'));
    else read.resolve();
}, how);

await attempt('22 파일을 읽는 동안 사이트가 작품을 열면 사이트 작품이 남음 (읽기 실패, 읽기 성공 모두)', async () => {
    const sample = fs.readFileSync(path.join(out, 'sample.sb3'));
    return withFileDialogs(async (pick, dialogs) => {
        const run = async how => {
            await sendBytes('loadProject', sample);
            await vmEval(vm => vm.runtime.targets.find(t => t.isOriginal && !t.isStage).setXY(123, 0));
            dialogs.length = 0;
            await holdFileRead();
            await pick('game.sb3', sample);
            await waitForHeldRead();
            await request('loadProject', {sb3: null});
            await settleHeldRead(how);
            await page.waitForTimeout(1500);
            return {x: await spriteX(), blocks: (await opcodes()).length, changed: await projectChangedState(),
                dialogs: dialogs.length};
        };
        const readFails = await run('fail');
        const readSucceeds = await run('succeed');
        // The site's empty project: x 0, no blocks, unchanged. Only the confirm dialog, no error.
        for (const r of [readFails, readSucceeds]) {
            assert(r.x === 0 && r.blocks === 0 && r.changed === false && r.dialogs === 1, JSON.stringify(r));
        }
        return {readFails, readSucceeds};
    });
});

await attempt('23 지금 작품을 백업하지 못하면 안내하고, 다음 불러오기는 다시 됨', async () => {
    const sample = fs.readFileSync(path.join(out, 'sample.sb3'));
    const marked = await editProject(sample, project => {
        project.targets.find(t => !t.isStage).blocks.m1 = {opcode: 'looks_hide', next: null, parent: null,
            inputs: {}, fields: {}, shadow: false, topLevel: true, x: 40, y: 260};
    });
    const errors = [];
    const onError = error => errors.push(String(error.message || error));
    page.on('pageerror', onError);
    try {
        return await withFileDialogs(async (pick, dialogs) => {
            await sendBytes('loadProject', sample);
            await vmEval(vm => {
                const original = vm.saveProjectSb3;
                vm.saveProjectSb3 = function () {
                    vm.saveProjectSb3 = original;
                    return Promise.reject(new Error('backup failed'));
                };
            });
            await pick('game.sb3', marked);
            await page.waitForTimeout(1500);
            const failed = {loaded: (await opcodes()).includes('looks_hide'), changed: await projectChangedState(),
                dialogs: [...dialogs]};
            dialogs.length = 0;
            await pick('game.sb3', marked);
            await page.waitForTimeout(1500);
            const retried = {loaded: (await opcodes()).includes('looks_hide'), changed: await projectChangedState(),
                dialogs: [...dialogs]};
            assert(!failed.loaded && !failed.changed && failed.dialogs.length === 2 && /다시 시도/.test(failed.dialogs[1]),
                `backup failure: ${JSON.stringify(failed)}`);
            assert(retried.loaded && retried.changed && retried.dialogs.length === 1, `retry: ${JSON.stringify(retried)}`);
            assert(errors.length === 0, `page errors: ${errors.join(' / ')}`);
            return {failed, retried};
        });
    } finally {
        page.off('pageerror', onError);
    }
});

// Holds the next file read, project backup or project load in the editor until releaseHeld().
const holdNext = stage => editor.evaluate(st => {
    const vm = window.ReduxStore.getState().scratchGui.vm;
    // install: inside vm.loadProject, after the old project is cleared and before the new one is in.
    const [owner, name] = st === 'read' ? [File.prototype, 'arrayBuffer'] :
        [vm, {backup: 'saveProjectSb3', load: 'loadProject', install: 'installTargets'}[st]];
    const original = owner[name];
    owner[name] = function (...args) {
        owner[name] = original;
        // The VM takes the project for a backup when it is called; only the compressing is held.
        const started = st === 'backup' ? original.apply(this, args) : null;
        return new Promise((resolve, reject) => {
            window.__studioHold = () => (started || original.apply(this, args)).then(resolve, reject);
        });
    };
}, stage);
// Holds the next loadProject of a VM other than the editor's: the grading VM, made by grade after it
// has taken its exportId and before it replies. Released with releaseHeld like holdNext.
const holdGradingLoad = () => editor.evaluate(() => {
    const editorVm = window.ReduxStore.getState().scratchGui.vm;
    const proto = Object.getPrototypeOf(editorVm);
    const original = proto.loadProject;
    proto.loadProject = function (...args) {
        if (this === editorVm) return original.apply(this, args);
        proto.loadProject = original;
        return new Promise((resolve, reject) => {
            window.__studioHold = () => original.apply(this, args).then(resolve, reject);
        });
    };
});
const waitForHeld = () => editor.waitForFunction(() => Boolean(window.__studioHold), null, {timeout: 10000});
const releaseHeld = () => editor.evaluate(() => {
    const release = window.__studioHold;
    delete window.__studioHold;
    release();
});
const backToEdit = async () => {
    await request('setMode', {mode: 'edit'});
    await editor.waitForSelector('.blocklyWorkspace', {timeout: 30000});
};

await attempt('24 불러오는 도중 edit 모드를 벗어나면 취소, 작품과 변경 상태 유지 (읽기·백업·로드 중, view·player, 갔다 돌아와도)', async () => {
    const sample = fs.readFileSync(path.join(out, 'sample.sb3'));
    const moved = await editProject(sample, project => {
        project.targets.find(t => !t.isStage).x = 123;
    });
    return withFileDialogs(async (pick, dialogs) => {
        const run = async (stage, modes) => {
            await sendBytes('loadProject', sample);
            await vmEval(vm => vm.runtime.targets.find(t => t.isOriginal && !t.isStage).setXY(0, 0));
            dialogs.length = 0;
            await holdNext(stage);
            await pick('moved.sb3', moved);
            await waitForHeld();
            for (const mode of modes) {
                await request('setMode', {mode});
                if (mode === 'edit') await editor.waitForSelector('.blocklyWorkspace', {timeout: 30000});
            }
            const menuHidden = modes.length === 0 || modes[modes.length - 1] === 'edit' ||
                await editor.evaluate(() => !document.querySelector('[data-studio=file-menu]') &&
                    !document.querySelector('[data-studio=save-button]'));
            await releaseHeld();
            await page.waitForTimeout(1500);
            const result = {x: await spriteX(), changed: await projectChangedState(), dialogs: dialogs.length, menuHidden};
            await backToEdit();
            return result;
        };
        // The holds themselves let a file load when nothing else happens.
        const control = await run('read', []);
        const cases = {
            'read → view': await run('read', ['view']),
            'read → player': await run('read', ['player']),
            'backup → view': await run('backup', ['view']),
            'backup → player': await run('backup', ['player']),
            'load → view': await run('load', ['view']),
            'read → view → edit': await run('read', ['view', 'edit'])
        };
        assert(control.x === 123 && control.changed === true, `control: ${JSON.stringify(control)}`);
        for (const [name, r] of Object.entries(cases)) {
            assert(r.x === 0 && r.changed === false && r.dialogs === 1 && r.menuHidden, `${name}: ${JSON.stringify(r)}`);
        }
        return {control, ...cases};
    });
});

const spriteName = () => vmEval(vm => vm.runtime.targets.find(t => t.isOriginal && !t.isStage).getName());

await attempt('25 백업하는 동안 한 편집은 불러오기가 실패해도 남음, 그동안 에디터는 잠김', async () => {
    const sample = fs.readFileSync(path.join(out, 'sample.sb3'));
    const evil = await addCustomExtension(sample);
    return withFileDialogs(async (pick, dialogs) => {
        await sendBytes('loadProject', sample);
        const before = await spriteName();
        dialogs.length = 0;
        await holdNext('backup');
        await pick('evil.sb3', evil);
        await waitForHeld();
        const locked = await editor.evaluate(() => window.ReduxStore.getState().scratchGui.modals.loadingProject);
        // An edit the VM takes after the backup started, as a drag that ends on the loading screen would.
        await vmEval(vm => vm.renameSprite(vm.runtime.targets.find(t => t.isOriginal && !t.isStage).id, 'edited'));
        await releaseHeld();
        await page.waitForTimeout(2000);
        const after = {name: await spriteName(), changed: await projectChangedState(), dialogs: [...dialogs],
            locked: await editor.evaluate(() => window.ReduxStore.getState().scratchGui.modals.loadingProject)};
        assert(after.name === 'edited' && after.changed === true, `edit lost: ${JSON.stringify(after)}`);
        assert(locked === true, 'editor was not locked while the backup was made');
        assert(after.dialogs.length === 2 && /열 수 없어요/.test(after.dialogs[1]) && after.locked === false,
            `after: ${JSON.stringify(after)}`);
        return {before, lockedDuringBackup: locked, after};
    });
});

await attempt('26 불러오는 중(이전 작품을 지운 뒤)의 exportProject는 불러오기가 끝난 작품을 돌려줌', async () => {
    const sample = fs.readFileSync(path.join(out, 'sample.sb3'));
    const moved = await editProject(sample, project => {
        project.targets.find(t => !t.isStage).x = 123;
    });
    return withFileDialogs(async pick => {
        await sendBytes('loadProject', sample);
        await holdNext('install');
        await pick('moved.sb3', moved);
        await waitForHeld();
        const midLoad = await vmEval(vm => vm.runtime.targets.length);
        await page.evaluate(() => {
            window.__export = window.host.request('exportProject').then(r => Array.from(new Uint8Array(r.sb3)));
            window.__exportDone = false;
            window.__export.then(() => {
                window.__exportDone = true;
            });
        });
        await page.waitForTimeout(1000);
        const answeredMidLoad = await page.evaluate(() => window.__exportDone);
        await releaseHeld();
        const bytes = await page.evaluate(() => window.__export);
        const zip = await JSZip.loadAsync(Buffer.from(bytes));
        const project = JSON.parse(await zip.file('project.json').async('string'));
        const sprite = project.targets.find(t => !t.isStage);
        const exported = {targets: project.targets.length, x: sprite && sprite.x};
        assert(midLoad === 0, `the VM was not cleared at the hold point: ${midLoad} targets`);
        assert(!answeredMidLoad, 'exportProject answered while the project was loading');
        assert(exported.targets >= 2 && exported.x === 123, `exported: ${JSON.stringify(exported)}`);
        return {targetsMidLoad: midLoad, answeredMidLoad, exported};
    });
});

await attempt('27 바뀐 작품을 파일로 바꿔도 projectChanged, 이전 버전의 saved는 새 작품의 변경 상태를 지우지 않음', async () => {
    const sample = fs.readFileSync(path.join(out, 'sample.sb3'));
    const moved = await editProject(sample, project => {
        project.targets.find(t => !t.isStage).x = 123;
    });
    return withFileDialogs(async pick => {
        await sendBytes('loadProject', sample);
        // An edit the site starts saving: projectChanged, exportProject, setSaveStatus saving.
        await clearEvents();
        await vmEval(vm => vm.runtime.emitProjectChanged());
        await page.waitForFunction(() => window.host.events.some(e => e.type === 'projectChanged'), null, {timeout: 5000});
        const older = await exportSave();
        await setSaveStatus('saving', older);
        // The student opens a file before that save is done.
        await clearEvents();
        await pick('moved.sb3', moved);
        await page.waitForTimeout(1500);
        const replaced = {events: (await eventsOf('projectChanged')).length, changed: await projectChangedState(),
            x: await spriteX()};
        // The older save finishes.
        await clearEvents();
        await setSaveStatus('saved', older);
        await page.waitForTimeout(300);
        const staleSaved = {changed: await projectChangedState(), events: (await eventsOf('projectChanged')).length};
        // The site saves again, this time the file's project.
        await markSaved();
        const saved = {changed: await projectChangedState()};
        assert(replaced.events === 1 && replaced.changed && replaced.x === 123, `replaced: ${JSON.stringify(replaced)}`);
        assert(staleSaved.changed === true && staleSaved.events === 1, `stale saved: ${JSON.stringify(staleSaved)}`);
        assert(saved.changed === false, `saved: ${JSON.stringify(saved)}`);
        return {replaced, staleSaved, saved};
    });
});

await attempt('28 사이트가 작품을 여는 도중 컴퓨터에 저장하면 파일 이름과 내용이 같은 작품에서 옴', async () => {
    const sample = fs.readFileSync(path.join(out, 'sample.sb3'));
    const siteProject = await editProject(sample, project => {
        project.targets.find(t => !t.isStage).x = 123;
    });
    return withFileDialogs(async pick => {
        await sendBytes('loadProject', sample);
        await pick('A.sb3', sample);
        await page.waitForTimeout(1500);
        // The site opens its project; the load is held after the VM cleared the file's project.
        await holdNext('install');
        await page.evaluate(b => {
            window.__siteLoad = window.host.request('loadProject', {sb3: new Uint8Array(b).buffer});
        }, Array.from(siteProject));
        await waitForHeld();
        await editor.click('[data-studio=file-menu]');
        const download = page.waitForEvent('download');
        await editor.click('[data-studio=file-save]');
        await page.waitForTimeout(500);
        await releaseHeld();
        await page.evaluate(() => window.__siteLoad);
        const file = await download;
        const zip = await JSZip.loadAsync(fs.readFileSync(await file.path()));
        const project = JSON.parse(await zip.file('project.json').async('string'));
        const saved = {name: file.suggestedFilename(), x: project.targets.find(t => !t.isStage).x};
        assert(saved.name === '내 작품.sb3' && saved.x === 123, `saved: ${JSON.stringify(saved)}`);
        return saved;
    });
});

await attempt('29 저장 응답은 그 내보내기에만 적용: 저장 중 채점, 순서가 바뀐 응답, 같은 작품의 겹친 저장, 받은 적 없는·아직 보내지 않은 exportId 거부', async () => {
    const sample = fs.readFileSync(path.join(out, 'sample.sb3'));
    const moved = await editProject(sample, project => {
        project.targets.find(t => !t.isStage).x = 123;
    });
    const edit = async () => {
        await vmEval(vm => vm.runtime.emitProjectChanged());
        await page.waitForTimeout(100);
    };
    const status = () => editor.evaluate(() => document.querySelector('[data-studio=save-status]').textContent);
    const state = async () => ({changed: await projectChangedState(), events: (await eventsOf('projectChanged')).length,
        status: await status(), retry: await editor.evaluate(() => document.querySelectorAll('[data-studio=save-retry]').length)});
    const gradeSave = () => page.evaluate(() => window.host.request('grade', {checks: []})
        .then(r => ({result: r.result, exportId: r.exportId})));
    return withFileDialogs(async pick => {
        // Project A is edited and the site starts saving it; the answer is held back.
        await sendBytes('loadProject', sample);
        await edit();
        const a = await exportSave();
        await setSaveStatus('saving', a);
        // The student opens project B from a file and grades it, which also hands the site an sb3.
        await pick('moved.sb3', moved);
        await page.waitForTimeout(1500);
        const graded = await gradeSave();
        // A's save finishes: B was never saved, so it stays changed and the site hears about it again.
        await clearEvents();
        await setSaveStatus('saved', a);
        await page.waitForTimeout(300);
        const afterA = await state();
        // The site saves the sb3 it got from grading, which is B as it is now.
        await clearEvents();
        await setSaveStatus('saved', graded.exportId);
        const afterGraded = await state();

        // Two saves overlap and the older one answers last.
        await edit();
        const b1 = await exportSave();
        await setSaveStatus('saving', b1);
        await edit();
        const b2 = await exportSave();
        await setSaveStatus('saving', b2);
        await setSaveStatus('saved', b2);
        await clearEvents();
        await setSaveStatus('saved', b1);
        await page.waitForTimeout(300);
        const lateOlder = await state();

        // Two saves overlap and the older one answers first, while the newer one is still saving.
        await edit();
        const c1 = await exportSave();
        await setSaveStatus('saving', c1);
        await edit();
        const c2 = await exportSave();
        await setSaveStatus('saving', c2);
        await clearEvents();
        await setSaveStatus('saved', c1);
        await page.waitForTimeout(300);
        const earlyOlder = await state();
        await setSaveStatus('saved', c2);
        const newerSaved = await state();

        // The same project handed out twice with no edit between (exportProject, then grade): the first
        // save's late failure does not undo the second one's success.
        await edit();
        const s1 = await exportSave();
        await setSaveStatus('saving', s1);
        const s2 = (await gradeSave()).exportId;
        await setSaveStatus('saving', s2);
        await setSaveStatus('saved', s2);
        await setSaveStatus('failed', s1);
        const lateFailure = await state();
        // Nor does it show while the second save of the same project is still going.
        await edit();
        const t1 = await exportSave();
        await setSaveStatus('saving', t1);
        const t2 = await exportSave();
        await setSaveStatus('saving', t2);
        await setSaveStatus('failed', t1);
        const earlyFailure = await state();
        await setSaveStatus('saved', t2);
        const sameSaved = await state();

        // An exportId the editor never returned is refused, right after a status too, and it does not
        // count as newer: the real answer still comes through.
        await edit();
        const g = await exportSave();
        await setSaveStatus('saving', g);
        const neverReturned = await requestError('setSaveStatus', {status: 'saved', exportId: g + 1});
        const afterRefused = await state();
        await setSaveStatus('saved', g);
        const afterG = await state();

        // grade takes its exportId with the snapshot, but the site has it only once the reply comes:
        // a status for it while grading still runs is refused. The grading VM is made after the
        // exportId is taken, so holding its loadProject holds grade after that point and before the reply.
        await edit();
        const h = await exportSave();
        await holdGradingLoad();
        await page.evaluate(() => {
            window.__heldGradeDone = false;
            window.__heldGrade = window.host.request('grade', {checks: [{type: 'dynamic',
                actions: [{do: 'wait', ms: 100}],
                expect: [{target: 'sprite', sprite: '@first', property: 'x', op: 'gt', value: -1000}]}]})
                .then(r => {
                    window.__heldGradeDone = true;
                    return r.exportId;
                });
        });
        await waitForHeld();
        const whileGrading = await requestError('setSaveStatus', {status: 'saved', exportId: h + 1});
        const afterWhileGrading = {...await state(), gradeDone: await page.evaluate(() => window.__heldGradeDone)};
        // An export taken while grading runs is newer than the grade, though its reply comes first:
        // the test host keeps it, not the grade's sb3 that arrives after.
        const newer = await page.evaluate(async () => {
            const r = await window.host.request('exportProject');
            window.__newerSb3 = r.sb3;
            return r.exportId;
        });
        await releaseHeld();
        const slowGraded = await page.evaluate(() => window.__heldGrade);
        const hostKept = await page.evaluate(() => ({exportId: window.host.exportId,
            keptNewer: window.host.kept === window.__newerSb3}));
        await setSaveStatus('saved', slowGraded);
        const afterSlowGraded = await state();

        assert(graded.result === 'pass' && graded.exportId > a, `graded: ${JSON.stringify(graded)}`);
        assert(afterA.changed === true && afterA.events === 1, `after A saved: ${JSON.stringify(afterA)}`);
        assert(afterGraded.changed === false && afterGraded.status === '저장됨', `after graded saved: ${JSON.stringify(afterGraded)}`);
        assert(lateOlder.changed === false && lateOlder.events === 0 && lateOlder.status === '저장됨',
            `late older saved: ${JSON.stringify(lateOlder)}`);
        assert(earlyOlder.changed === true && earlyOlder.events === 0 && earlyOlder.status === '저장 중',
            `early older saved: ${JSON.stringify(earlyOlder)}`);
        assert(newerSaved.changed === false && newerSaved.status === '저장됨', `newer saved: ${JSON.stringify(newerSaved)}`);
        assert(s2 > s1 && lateFailure.changed === false && lateFailure.status === '저장됨' && lateFailure.retry === 0,
            `late failure, same project: ${JSON.stringify(lateFailure)}`);
        assert(earlyFailure.changed === true && earlyFailure.status === '저장 중' && earlyFailure.retry === 0,
            `early failure, same project: ${JSON.stringify(earlyFailure)}`);
        assert(sameSaved.changed === false && sameSaved.status === '저장됨', `same project saved: ${JSON.stringify(sameSaved)}`);
        assert(/^invalid_payload/.test(neverReturned) && afterRefused.changed === true && afterRefused.status === '저장 중',
            `never returned: ${neverReturned} ${JSON.stringify(afterRefused)}`);
        assert(afterG.changed === false && afterG.status === '저장됨', `saved after a refused exportId: ${JSON.stringify(afterG)}`);
        // slowGraded === h + 1 shows the id was already taken while held, so only the unsent check refused it.
        assert(/^invalid_payload/.test(whileGrading) && afterWhileGrading.changed === true && !afterWhileGrading.gradeDone,
            `while grading: ${JSON.stringify({whileGrading, afterWhileGrading})}`);
        assert(newer === h + 2 && hostKept.exportId === newer && hostKept.keptNewer,
            `host kept after a late grade reply: ${JSON.stringify({h, newer, hostKept})}`);
        assert(slowGraded === h + 1 && afterSlowGraded.changed === false && afterSlowGraded.status === '저장됨',
            `after slow grade: ${JSON.stringify({h, slowGraded, afterSlowGraded})}`);
        return {exportIds: {a, graded: graded.exportId, b1, b2, c1, c2, s1, s2, t1, t2, g, h, slowGraded}, afterA,
            afterGraded, lateOlder, earlyOlder, newerSaved, lateFailure, earlyFailure, sameSaved, neverReturned,
            afterRefused, afterG, whileGrading, afterWhileGrading, newer, hostKept, afterSlowGraded};
    });
});

// Last on this page: it reloads the editor.
await attempt('30 에디터를 다시 불러오면 exportId는 1부터, 시험 페이지는 새 세션의 첫 내보내기를 보관', async () => {
    const before = await page.evaluate(async () => (await window.host.request('exportProject')).exportId);
    await page.evaluate(([url]) => {
        window.host.readyAt = null;
        document.getElementById('editor').src = url;
    }, [`${EDITOR}/index.html?reload`]);
    await page.waitForFunction(() => window.host.readyAt !== null, null, {timeout: 120000});
    const atReady = await page.evaluate(() => window.host.exportId);
    await request('init', {locale: 'ko', mode: 'edit'});
    const after = await page.evaluate(async () => {
        const r = await window.host.request('exportProject');
        return {exportId: r.exportId, hostId: window.host.exportId, keptIsIt: window.host.kept === r.sb3};
    });
    const saved = await page.evaluate(() => window.host.request('setSaveStatus',
        {status: 'saved', exportId: window.host.exportId}).then(() => 'answered', e => e.message));
    assert(before > 1 && atReady === 0, `before reload ${before}, host exportId at ready ${atReady}`);
    assert(after.exportId === 1 && after.hostId === 1 && after.keptIsIt, `after reload: ${JSON.stringify(after)}`);
    assert(saved === 'answered', `saved: ${saved}`);
    return {before, atReady, after, saved};
});

await page.close();

// Origin checks need pages on the origin that is not allowed.
await attempt('31 허용되지 않은 출처에서는 임베드 자체가 막힘 (frame-ancestors)', async () => {
    const bad = await context.newPage();
    await bad.goto('http://localhost:8603/');
    await bad.waitForTimeout(5000);
    const ready = await bad.evaluate(() => window.host.readyAt);
    const frames = bad.frames().map(f => f.url());
    await bad.close();
    assert(ready === null, 'editor became ready on a disallowed origin');
    return {frames};
});

await attempt('32 허용되지 않은 출처의 메시지는 무시됨 (헤더 없이도)', async () => {
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
