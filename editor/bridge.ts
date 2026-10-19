// The editor side of the host site <-> editor contract (protocol.ts).
// The editor never calls the site's API: everything goes through these messages.
import {selectLocale} from '@gui/reducers/locales';
import {setPlayer} from '@gui/reducers/mode';
import {setProjectUnchanged} from '@gui/reducers/project-changed';
import storage from '@gui/lib/storage';
import {
    SOURCE, VERSION, LOCALES, SITE_REQUEST_TYPES,
    isStudioEnvelope, validateSiteRequest,
    type EditorEvents, type EditorEventType, type ErrorCode, type Locale, type Mode,
    type SiteRequests, type SiteRequestType
} from './protocol';
import {setSaveState, setSaveRequestHandler} from './save-store';

/** The parts of scratch-vm the bridge uses. */
export interface StudioVM {
    loadProject (project: ArrayBuffer | string): Promise<void>;
    saveProjectSb3 (): Promise<Blob | ArrayBuffer>;
    renderer: {requestSnapshot (callback: (dataUri: string) => void): void; draw (): void};
}

interface GuiState {
    locales: {locale: string};
    scratchGui: {projectChanged: boolean};
}

/** The parts of the Redux store the bridge uses. */
export interface StudioStore {
    getState (): GuiState;
    dispatch (action: unknown): void;
    subscribe (listener: () => void): () => void;
}

/** Origins allowed to embed and talk to the editor, set at build time (STUDIO_ALLOWED_ORIGINS). */
export const ALLOWED_ORIGINS = (process.env.STUDIO_ALLOWED_ORIGINS || '').split(',')
    .map(origin => origin.trim())
    .filter(Boolean);

type Reply<T extends SiteRequestType> = {payload: SiteRequests[T]['reply']; transfer?: Transferable[]};
type Handlers = {
    [T in SiteRequestType]: (payload: SiteRequests[T]['payload']) => Promise<Reply<T>>;
};

class BridgeError extends Error {
    code: ErrorCode;
    constructor (code: ErrorCode, message: string) {
        super(message);
        this.code = code;
    }
}

const dataUriToBuffer = (dataUri: string): ArrayBuffer => {
    const binary = atob(dataUri.split(',')[1]);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
};

const isLocale = (locale: string): locale is Locale => (LOCALES as readonly string[]).includes(locale);

export const installBridge = (vm: StudioVM, store: StudioStore): void => {
    let mode: Mode = 'edit';
    let parentOrigin: string | null = null;
    let lastLocale = store.getState().locales.locale;
    let lastChanged = store.getState().scratchGui.projectChanged;

    const post = (message: object, origin: string, transfer: Transferable[] = []) => {
        window.parent.postMessage(message, origin, transfer);
    };

    const send = <T extends EditorEventType | SiteRequestType>(
        type: T,
        payload: object,
        requestId?: string,
        transfer?: Transferable[]
    ) => {
        if (!parentOrigin) return;
        post({source: SOURCE, version: VERSION, type, requestId, payload}, parentOrigin, transfer);
    };

    const sendEvent = <T extends EditorEventType>(type: T, payload: EditorEvents[T], requestId?: string) =>
        send(type, payload, requestId);

    store.subscribe(() => {
        const state = store.getState();
        if (state.locales.locale !== lastLocale) {
            lastLocale = state.locales.locale;
            if (isLocale(lastLocale)) sendEvent('localeChanged', {locale: lastLocale});
        }
        const changed = state.scratchGui.projectChanged;
        if (changed !== lastChanged) {
            lastChanged = changed;
            if (changed && mode === 'edit') sendEvent('projectChanged', {});
        }
    });

    setSaveRequestHandler(() => {
        if (mode === 'edit') sendEvent('saveRequested', {});
    });

    const applyMode = (next: Mode) => {
        mode = next;
        store.dispatch(setPlayer(next === 'player'));
        setSaveState({enabled: next === 'edit'});
    };

    const exportSb3 = async (): Promise<ArrayBuffer> => {
        const blob = await vm.saveProjectSb3();
        return blob instanceof ArrayBuffer ? blob : blob.arrayBuffer();
    };

    const loadEmptyProject = async () => {
        const asset = await storage.load(storage.AssetType.Project, '0', storage.DataFormat.JSON);
        await vm.loadProject(asset.data);
    };

    const handlers: Handlers = {
        init: async ({locale, mode: nextMode}) => {
            if (locale !== lastLocale) {
                lastLocale = locale; // do not echo our own change back as localeChanged
                store.dispatch(selectLocale(locale));
            }
            applyMode(nextMode);
            return {payload: {}};
        },
        loadProject: async ({sb3}) => {
            if (sb3 === null) await loadEmptyProject();
            else await vm.loadProject(sb3);
            store.dispatch(setProjectUnchanged());
            return {payload: {}};
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
        grade: async () => {
            throw new BridgeError('not_implemented', 'grading arrives in stages 2 and 3');
        },
        setMode: async ({mode: nextMode}) => {
            applyMode(nextMode);
            return {payload: {}};
        },
        setSaveStatus: async ({status}) => {
            if (mode !== 'edit') throw new BridgeError('wrong_mode', `setSaveStatus in ${mode} mode`);
            setSaveState({status});
            if (status === 'saved') store.dispatch(setProjectUnchanged());
            return {payload: {}};
        }
    };

    const handle = async <T extends SiteRequestType>(type: T, payload: unknown, requestId?: string) => {
        const problem = validateSiteRequest(type, payload);
        if (problem) {
            sendEvent('error', {code: 'invalid_payload', message: `${type}: ${problem}`}, requestId);
            return;
        }
        try {
            const handler = handlers[type] as (p: unknown) => Promise<Reply<T>>;
            const reply = await handler(payload ?? {});
            send(type, reply.payload, requestId, reply.transfer);
        } catch (error) {
            const code = error instanceof BridgeError ? error.code : 'failed';
            const message = error instanceof Error ? error.message : String(error);
            sendEvent('error', {code, message}, requestId);
        }
    };

    window.addEventListener('message', event => {
        // Other origins get nothing back, not even an error.
        if (!ALLOWED_ORIGINS.includes(event.origin) || event.source !== window.parent) return;
        const message: unknown = event.data;
        if (!isStudioEnvelope(message)) return;
        parentOrigin = event.origin;
        const requestId = typeof message.requestId === 'string' ? message.requestId : undefined;
        if (message.version !== VERSION) {
            sendEvent('error', {code: 'unsupported_version', message: `version ${message.version}`}, requestId);
            return;
        }
        if (!(SITE_REQUEST_TYPES as string[]).includes(message.type)) {
            sendEvent('error', {code: 'unknown_type', message: message.type}, requestId);
            return;
        }
        handle(message.type as SiteRequestType, message.payload, requestId);
    });

    // `ready` goes to every allowed origin; only the real parent receives it.
    for (const origin of ALLOWED_ORIGINS) {
        post({source: SOURCE, version: VERSION, type: 'ready', payload: {}}, origin);
    }
};
