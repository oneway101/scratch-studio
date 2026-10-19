// Tiny shared store between the bridge and the menu bar save UI.
const listeners = new Set();
let state = {enabled: false, status: 'saved'};

export const getSaveState = () => state;
export const setSaveState = patch => {
    state = Object.assign({}, state, patch);
    listeners.forEach(fn => fn(state));
};
export const subscribeSaveState = fn => {
    listeners.add(fn);
    return () => listeners.delete(fn);
};

let onSaveRequested = () => {};
export const setSaveRequestHandler = fn => {
    onSaveRequested = fn;
};
export const requestSave = () => onSaveRequested();
