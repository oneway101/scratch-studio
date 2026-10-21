import '@gui/playground/import-first';

import React from 'react';
import {compose} from 'redux';

import AppStateHOC from '@gui/lib/app-state-hoc.jsx';
import TWStateManagerHOC from '@gui/lib/tw-state-manager-hoc.jsx';
import GUI from '@gui/containers/gui.jsx';
import render from '@gui/playground/app-target';
import {Theme, ACCENT_PURPLE, GUI_LIGHT, BLOCKS_THREE} from '@gui/lib/themes';
import {setTheme} from '@gui/reducers/theme';
import {installBridge} from './bridge';
import {lockExtensions} from './extensions';

// The menu bar is fixed to TurboWarp's purple accent on the light theme, whatever the system prefers.
const STUDIO_THEME = new Theme(ACCENT_PURPLE, GUI_LIGHT, BLOCKS_THREE);
const isStudioTheme = theme => theme.accent === STUDIO_THEME.accent &&
    theme.gui === STUDIO_THEME.gui && theme.blocks === STUDIO_THEME.blocks;

const lockTheme = store => {
    const enforce = () => {
        if (!isStudioTheme(store.getState().scratchGui.theme.theme)) store.dispatch(setTheme(STUDIO_THEME));
    };
    enforce();
    store.subscribe(enforce);
};

let vm = null;
let installed = false;

const onVmInit = _vm => {
    vm = _vm;
    lockExtensions(vm);
    lockTheme(window.ReduxStore);
};

const onProjectLoaded = () => {
    if (installed) return;
    installed = true;
    installBridge(vm, window.ReduxStore);
};

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
    canChangeTheme={false}
    canManageFiles={false}
    backpackVisible={false}
    routingStyle="none"
    projectId="0"
    theme={STUDIO_THEME}
    securityManager={securityManager}
    onVmInit={onVmInit}
    onProjectLoaded={onProjectLoaded}
/>);
