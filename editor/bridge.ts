// The editor side of the host site <-> editor contract (protocol.ts).
// The editor never calls the site's API: everything goes through these messages.
import {selectLocale} from '@gui/reducers/locales';
import {setPlayer} from '@gui/reducers/mode';
import {setProjectChanged, setProjectUnchanged} from '@gui/reducers/project-changed';
import storage from '@gui/lib/storage';
import {
    SOURCE, VERSION, LOCALES, SITE_REQUEST_TYPES,
    isStudioEnvelope, validateSiteRequest,
    type EditorEvents, type EditorEventType, type ErrorCode, type Locale, type Mode,
    type SiteRequests, type SiteRequestType
} from './protocol';
import {setSaveState, setSaveRequestHandler} from './save-store';
import {
    MAX_PROJECT_BYTES, isProjectFileName, projectFileText, projectFileName, saveFile,
    setProjectFileHandler, setProjectDownloadHandler, installProjectDrop
} from './project-file';
import {grade, GraderError} from '../grader/index';
import {createGradingRuntime} from './grading-runtime';

/** The parts of scratch-vm the bridge uses. */
export interface StudioVM {
    loadProject (project: ArrayBuffer | string): Promise<void>;
    quit (): void;
    saveProjectSb3 (): Promise<Blob | ArrayBuffer>;
    toJSON (): string;
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
    let loading = false; // see loadQuietly

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
        if (changed !== lastChanged && !loading) {
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

    // Replacing a project that has blocks makes Blockly fire delete and create events, some from a
    // timer after loadProject resolves, and the GUI takes them as edits. While the bridge loads a
    // project they are not sent as projectChanged; the caller then marks the project changed or not.
    const loadQuietly = async (load: () => Promise<void>) => {
        loading = true;
        try {
            await load();
            await new Promise(resolve => setTimeout(resolve, 0));
        } finally {
            loading = false;
        }
    };

    // A file from the student's computer replaces the project like the site's loadProject does, but it
    // is not what the site has saved: it is left changed, so the site saves it as it saves any edit.
    let openingFile = false;
    let openedFileName: string | null = null; // the name "Save to your computer" uses
    setProjectFileHandler(async file => {
        if (mode !== 'edit' || openingFile) return;
        const text = projectFileText(store.getState().locales.locale);
        if (!isProjectFileName(file.name)) {
            alert(text.notProject); // eslint-disable-line no-alert
            return;
        }
        if (file.size > MAX_PROJECT_BYTES) {
            alert(text.tooLarge); // eslint-disable-line no-alert
            return;
        }
        if (!confirm(text.replace(file.name))) return; // eslint-disable-line no-alert
        openingFile = true;
        // A project that fails partway through loading can leave the VM half replaced.
        const previous = await exportSb3();
        const wasChanged = store.getState().scratchGui.projectChanged;
        try {
            vm.quit();
            const project = await file.arrayBuffer();
            await loadQuietly(() => vm.loadProject(project));
            vm.renderer.draw();
            store.dispatch(setProjectChanged());
            openedFileName = file.name;
        } catch {
            await loadQuietly(() => vm.loadProject(previous)).catch(() => {});
            store.dispatch(wasChanged ? setProjectChanged() : setProjectUnchanged());
            alert(text.failed); // eslint-disable-line no-alert
        } finally {
            openingFile = false;
        }
    });
    installProjectDrop(() => mode === 'edit', () => store.getState().locales.locale);

    // A copy for the student's computer. It does not touch the site's save status.
    setProjectDownloadHandler(async () => {
        if (mode !== 'edit') return;
        const locale = store.getState().locales.locale;
        try {
            saveFile(projectFileName(openedFileName, locale), await exportSb3());
        } catch {
            alert(projectFileText(locale).saveFailed); // eslint-disable-line no-alert
        }
    });

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
            await loadQuietly(() => (sb3 === null ? loadEmptyProject() : vm.loadProject(sb3)));
            store.dispatch(setProjectUnchanged());
            openedFileName = null;
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
        grade: async ({checks}) => {
            // The snapshot: the project JSON and the sb3 are taken before anything awaits.
            const json = vm.toJSON();
            const sb3 = await exportSb3();
            try {
                const {result, checkResults} = await grade(json, checks, createGradingRuntime(sb3));
                return {payload: {result, checkResults, sb3}, transfer: [sb3]};
            } catch (error) {
                // A check that cannot run, or a project that will not load in the grading VM, is a
                // grading error: the site asks the student to try again and does not count the attempt.
                const message = error instanceof Error ? error.message : String(error);
                const checkResults = [{type: 'error', pass: false, detail: error instanceof GraderError ? message : `grading failed: ${message}`}];
                return {payload: {result: 'error', checkResults, sb3}, transfer: [sb3]};
            }
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
