/**
 * Only extensions bundled with the editor (pen, music, ...) may load. Custom extensions run arbitrary
 * JavaScript, so every URL, file or pasted code path is refused here, below all the UI that offers them.
 * Used for the student's VM and for every grading VM.
 */
export const lockExtensions = (vm: any): void => {
    const manager = vm.extensionManager;
    const loadExtensionURL = manager.loadExtensionURL.bind(manager);
    manager.loadExtensionURL = (url: string) => (manager.isBuiltinExtension(url) ?
        loadExtensionURL(url) :
        Promise.reject(new Error(`Custom extensions are disabled: ${url}`)));
};
