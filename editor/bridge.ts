// The editor side of the host site <-> editor contract (protocol.ts).
// The editor never calls the site's API: everything goes through these messages.
import {selectLocale} from '@gui/reducers/locales';
import {setPlayer} from '@gui/reducers/mode';
import {setProjectChanged, setProjectUnchanged} from '@gui/reducers/project-changed';
import {openLoadingProject, closeLoadingProject} from '@gui/reducers/modals';
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
    on (event: 'PROJECT_CHANGED', listener: () => void): void;
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
    // Which version of the project the site holds. editVersion goes up with every edit and when a file
    // replaces the project; exportedVersion is the version the site last took with exportProject or
    // grade (or opened with loadProject). A "saved" status only clears the changed state when the two
    // match, so a save of an older version cannot hide newer changes.
    let editVersion = 0;
    let exportedVersion = 0;
    vm.on('PROJECT_CHANGED', () => {
        if (!loading) editVersion++;
    });

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

    // Bumped when a file the student is opening must not replace the project any more (openFile).
    let fileGeneration = 0;

    const applyMode = (next: Mode) => {
        // Leaving edit mode cancels a file still being opened, also if the site comes back to edit.
        if (mode === 'edit' && next !== 'edit') fileGeneration++;
        mode = next;
        store.dispatch(setPlayer(next === 'player'));
        setSaveState({enabled: next === 'edit'});
    };

    // The VM takes the project when saveProjectSb3 is called and compresses it afterwards: the sb3 is
    // the project at that version, whatever is edited while it compresses.
    const exportSb3WithVersion = async (): Promise<{sb3: ArrayBuffer; version: number}> => {
        const version = editVersion;
        const blob = await vm.saveProjectSb3();
        return {sb3: blob instanceof ArrayBuffer ? blob : await blob.arrayBuffer(), version};
    };
    const exportSb3 = async (): Promise<ArrayBuffer> => (await exportSb3WithVersion()).sb3;

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

    // Project loads run one at a time, so a file that fails to load can put back the project it
    // replaced without undoing a project the site opened in the meantime. Exports go through the same
    // queue: while a project loads, the VM has already cleared the old one, and an export would be empty.
    let projectQueue: Promise<unknown> = Promise.resolve();
    const queueProject = <T>(work: () => Promise<T>): Promise<T> => {
        const run = projectQueue.then(work, work);
        projectQueue = run.catch(() => {});
        return run;
    };

    // While a file replaces the project, the GUI's loading screen covers the editor and keys are held
    // back, so nothing the student does falls between the backup and the replacement.
    const lockEditing = () => {
        const holdKey = (e: KeyboardEvent) => {
            e.preventDefault();
            e.stopPropagation();
        };
        window.addEventListener('keydown', holdKey, true);
        store.dispatch(openLoadingProject());
        return () => {
            window.removeEventListener('keydown', holdKey, true);
            store.dispatch(closeLoadingProject());
        };
    };

    // A file from the student's computer replaces the project like the site's loadProject does, but it
    // is not what the site has saved: it is left changed, so the site saves it as it saves any edit.
    // The file is cancelled, and the project left as it was, when the site opens a project or leaves
    // edit mode before the file has loaded. That is checked after each wait and once more after the load.
    let openingFile = false;
    let openedFileName: string | null = null; // the name "Save to your computer" uses
    const openFile = async (file: File): Promise<'loaded' | 'cancelled' | 'notReady' | 'failed'> => {
        const generation = fileGeneration;
        const cancelled = () => generation !== fileGeneration || mode !== 'edit';
        let project: ArrayBuffer;
        try {
            project = await file.arrayBuffer();
        } catch {
            return cancelled() ? 'cancelled' : 'failed';
        }
        return queueProject(async () => {
            if (cancelled()) return 'cancelled';
            const unlock = lockEditing();
            try {
                return await replaceWithFile(file, project, cancelled);
            } finally {
                unlock();
            }
        });
    };
    const replaceWithFile = async (file: File, project: ArrayBuffer, cancelled: () => boolean) => {
        // A project that fails partway through loading can leave the VM half replaced. The backup is
        // taken again if an edit came in while it was being made, so putting it back loses nothing.
        let previous: ArrayBuffer | null = null;
        try {
            for (let attempt = 0; attempt < 3 && !previous; attempt++) {
                const backup = await exportSb3WithVersion();
                if (backup.version === editVersion) previous = backup.sb3;
            }
        } catch {
            // reported as notReady below
        }
        if (cancelled()) return 'cancelled';
        if (!previous) return 'notReady';
        const backup = previous;
        const wasChanged = store.getState().scratchGui.projectChanged;
        const putBack = async () => {
            await loadQuietly(() => vm.loadProject(backup)).catch(() => {});
            store.dispatch(wasChanged ? setProjectChanged() : setProjectUnchanged());
        };
        try {
            vm.quit();
            await loadQuietly(() => vm.loadProject(project));
        } catch {
            await putBack();
            return cancelled() ? 'cancelled' : 'failed';
        }
        if (cancelled()) {
            await putBack();
            return 'cancelled';
        }
        vm.renderer.draw();
        editVersion++;
        openedFileName = file.name;
        // A project that was already changed raises no projectChanged of its own, but the site still has
        // to learn that this is a different project to save.
        const alreadyReported = lastChanged;
        store.dispatch(setProjectChanged());
        if (alreadyReported) sendEvent('projectChanged', {});
        return 'loaded';
    };
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
        let result;
        try {
            result = await openFile(file);
        } catch {
            result = 'failed';
        } finally {
            openingFile = false;
        }
        if (result === 'notReady' || result === 'failed') alert(text[result]); // eslint-disable-line no-alert
    });
    installProjectDrop(() => mode === 'edit', () => store.getState().locales.locale);

    // A copy for the student's computer. It does not touch the site's save status.
    setProjectDownloadHandler(async () => {
        if (mode !== 'edit') return;
        const locale = store.getState().locales.locale;
        try {
            saveFile(projectFileName(openedFileName, locale), await queueProject(exportSb3));
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
            fileGeneration++;
            await queueProject(async () => {
                await loadQuietly(() => (sb3 === null ? loadEmptyProject() : vm.loadProject(sb3)));
                store.dispatch(setProjectUnchanged());
                exportedVersion = editVersion;
                openedFileName = null;
            });
            return {payload: {}};
        },
        exportProject: async () => {
            const {sb3, version} = await queueProject(exportSb3WithVersion);
            exportedVersion = version;
            return {payload: {sb3}, transfer: [sb3]};
        },
        captureStage: () => queueProject(() => new Promise(resolve => {
            vm.renderer.requestSnapshot(dataUri => {
                const png = dataUriToBuffer(dataUri);
                resolve({payload: {png}, transfer: [png]});
            });
            vm.renderer.draw();
        })),
        grade: async ({checks}) => {
            // The snapshot: the project JSON and the sb3 are taken before anything awaits. The site may
            // save this sb3, so it counts as an export.
            const {json, sb3, version} = await queueProject(async () => {
                const snapshot = vm.toJSON();
                return {json: snapshot, ...await exportSb3WithVersion()};
            });
            exportedVersion = version;
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
            if (status === 'saved') {
                if (editVersion === exportedVersion) store.dispatch(setProjectUnchanged());
                // The save was of an older version: the project stays changed and the site saves again.
                else if (store.getState().scratchGui.projectChanged) sendEvent('projectChanged', {});
            }
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
