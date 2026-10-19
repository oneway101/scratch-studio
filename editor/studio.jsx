import '@gui/playground/import-first';

import React from 'react';
import {compose} from 'redux';

import AppStateHOC from '@gui/lib/app-state-hoc.jsx';
import TWStateManagerHOC from '@gui/lib/tw-state-manager-hoc.jsx';
import GUI from '@gui/containers/gui.jsx';
import render from '@gui/playground/app-target';
import {installBridge} from './bridge';

let vm = null;
let installed = false;

const onVmInit = _vm => {
    vm = _vm;
    window.__studioVm = vm; // stage 0 only, for the automated checks
};

const onProjectLoaded = () => {
    if (installed) return;
    installed = true;
    installBridge(vm, window.ReduxStore);
};

// Blocks every extension that is not bundled with the editor (custom URLs, files, pasted code).
const securityManager = {
    canLoadExtensionFromProject: () => Promise.resolve(false)
};

const WrappedGUI = compose(
    AppStateHOC,
    TWStateManagerHOC
)(GUI);

render(<WrappedGUI
    canSave={false}
    canEditTitle={false}
    canUseCloud={false}
    canChangeLanguage
    canManageFiles={false}
    backpackVisible={false}
    routingStyle="none"
    projectId="0"
    securityManager={securityManager}
    onVmInit={onVmInit}
    onProjectLoaded={onProjectLoaded}
/>);
