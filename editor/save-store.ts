// Tiny shared store between the bridge and the menu bar save UI.
import type {SaveStatus} from './protocol';

export interface SaveState {
    enabled: boolean;
    status: SaveStatus;
}

type Listener = (state: SaveState) => void;

const listeners = new Set<Listener>();
let state: SaveState = {enabled: false, status: 'saved'};

export const getSaveState = (): SaveState => state;
export const setSaveState = (patch: Partial<SaveState>): void => {
    state = {...state, ...patch};
    listeners.forEach(fn => fn(state));
};
export const subscribeSaveState = (fn: Listener): (() => void) => {
    listeners.add(fn);
    return () => {
        listeners.delete(fn);
    };
};

let onSaveRequested = (): void => {};
export const setSaveRequestHandler = (fn: () => void): void => {
    onSaveRequested = fn;
};
export const requestSave = (): void => onSaveRequested();
