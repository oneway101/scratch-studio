// Stage 0 bridge: the postMessage contract from the spec (section 4), in its simplest working form.
import {selectLocale} from '@gui/reducers/locales';
import {setPlayer} from '@gui/reducers/mode';
import {setProjectUnchanged} from '@gui/reducers/project-changed';
import {setSaveState, setSaveRequestHandler} from './save-store';
import {staticSummary, runHeadless} from './grader-spike';

const SOURCE = 'scratch-studio';
const VERSION = 1;
const ALLOWED_ORIGINS = (process.env.STUDIO_ALLOWED_ORIGINS || '').split(',').filter(Boolean);

export const STUDIO_LOCALES = ['ko', 'en'];
window.__studioLocales = STUDIO_LOCALES;

const dataUriToBuffer = dataUri => {
    const binary = atob(dataUri.split(',')[1]);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
};

export const installBridge = (vm, store) => {
    let mode = 'edit';
    let parentOrigin = null;
    let lastLocale = store.getState().locales.locale;
    let lastChanged = store.getState().scratchGui.projectChanged;

    const send = (type, payload, requestId, transfer) => {
        if (!parentOrigin) return;
        window.parent.postMessage({source: SOURCE, version: VERSION, type, requestId, payload},
            parentOrigin, transfer || []);
    };

    store.subscribe(() => {
        const state = store.getState();
        if (state.locales.locale !== lastLocale) {
            lastLocale = state.locales.locale;
            send('localeChanged', {locale: lastLocale});
        }
        const changed = state.scratchGui.projectChanged;
        if (changed !== lastChanged) {
            lastChanged = changed;
            if (changed && mode === 'edit') send('projectChanged');
        }
    });

    setSaveRequestHandler(() => send('saveRequested'));

    const applyMode = next => {
        mode = next;
        store.dispatch(setPlayer(next === 'player'));
        setSaveState({enabled: next === 'edit'});
    };

    const exportSb3 = async () => {
        const blob = await vm.saveProjectSb3();
        return blob.arrayBuffer ? blob.arrayBuffer() : blob;
    };

    const handlers = {
        init: async ({locale, mode: nextMode}) => {
            if (STUDIO_LOCALES.includes(locale) && locale !== lastLocale) {
                lastLocale = locale; // do not echo our own change back as localeChanged
                store.dispatch(selectLocale(locale));
            }
            applyMode(nextMode || 'edit');
            return {};
        },
        loadProject: async ({sb3}) => {
            await vm.loadProject(sb3);
            store.dispatch(setProjectUnchanged());
            return {};
        },
        exportProject: async () => {
            const sb3 = await exportSb3();
            return {payload: {sb3}, transfer: [sb3]};
        },
        captureStage: () => new Promise(resolve => {
            vm.renderer.requestSnapshot(dataUri => {
                const png = dataUriToBuffer(dataUri);
                resolve({payload: {png}, transfer: [png]});
            });
            vm.renderer.draw();
        }),
        grade: async ({checks}) => {
            const sb3 = await exportSb3();
            const summary = staticSummary(vm);
            const dynamic = [];
            for (const check of checks || []) {
                if (check.type === 'dynamic') {
                    dynamic.push(await runHeadless(sb3.slice(0), check.actions, check.renderer));
                }
            }
            return {payload: {result: 'pass', checkResults: {static: summary, dynamic}, sb3}, transfer: [sb3]};
        },
        setMode: async ({mode: nextMode}) => {
            applyMode(nextMode);
            return {};
        },
        setSaveStatus: async ({status}) => {
            setSaveState({status});
            if (status === 'saved') store.dispatch(setProjectUnchanged());
            return {};
        }
    };

    window.addEventListener('message', async event => {
        if (!ALLOWED_ORIGINS.includes(event.origin)) return; // silently ignore other origins
        const message = event.data;
        if (!message || message.source !== SOURCE) return;
        parentOrigin = event.origin;
        if (message.version !== VERSION) {
            send('error', {code: 'unsupported_version', message: `version ${message.version}`}, message.requestId);
            return;
        }
        const handler = handlers[message.type];
        if (!handler) {
            send('error', {code: 'unknown_type', message: message.type}, message.requestId);
            return;
        }
        try {
            const result = await handler(message.payload || {});
            send(message.type, result.payload || {}, message.requestId, result.transfer);
        } catch (error) {
            send('error', {code: 'failed', message: String(error && error.message || error)}, message.requestId);
        }
    });

    // `ready` goes to every allowed origin; only the real parent receives it.
    for (const origin of ALLOWED_ORIGINS) {
        window.parent.postMessage({source: SOURCE, version: VERSION, type: 'ready'}, origin);
    }
};
