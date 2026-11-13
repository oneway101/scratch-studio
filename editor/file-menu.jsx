import React from 'react';
import {connect} from 'react-redux';
import classNames from 'classnames';

import MenuLabel from '@gui/components/menu-bar/tw-menu-label.jsx';
import MenuBarMenu from '@gui/components/menu-bar/menu-bar-menu.jsx';
import {MenuItem, MenuSection} from '@gui/components/menu/menu.jsx';
import styles from '@gui/components/menu-bar/menu-bar.css';
import fileIcon from '@gui/components/menu-bar/icon--file.svg';
import dropdownCaret from '@gui/components/menu-bar/dropdown-caret.svg';
import {openFileMenu, closeFileMenu, fileMenuOpen} from '@gui/reducers/menus';
import {getSaveState, subscribeSaveState} from './save-store';
import {pickProjectFile, downloadProjectFile} from './project-file';

const LABELS = {
    ko: {file: '파일', load: '컴퓨터에서 불러오기', save: '컴퓨터에 저장하기'},
    en: {file: 'File', load: 'Load from your computer', save: 'Save to your computer'}
};

// Rendered in the editor menu bar in place of TurboWarp's File menu, which also has "New", "Save as"
// and saving through the File System Access API (not allowed in a cross-origin iframe).
// Both items work on project files on the student's computer (project-file.ts). Edit mode only, like Save.
class StudioFileMenu extends React.Component {
    constructor (props) {
        super(props);
        this.state = {enabled: getSaveState().enabled};
        this.handleLoad = this.handleLoad.bind(this);
        this.handleSave = this.handleSave.bind(this);
    }
    componentDidMount () {
        this.unsubscribe = subscribeSaveState(s => this.setState({enabled: s.enabled}));
    }
    componentWillUnmount () {
        this.unsubscribe();
    }
    handleLoad () {
        this.props.onClose();
        pickProjectFile();
    }
    handleSave () {
        this.props.onClose();
        downloadProjectFile();
    }
    render () {
        if (!this.state.enabled) return null;
        const t = LABELS[this.props.locale] || LABELS.ko;
        return (
            <MenuLabel
                open={this.props.open}
                onOpen={this.props.onOpen}
                onClose={this.props.onClose}
            >
                <img
                    src={fileIcon}
                    draggable={false}
                    width={20}
                    height={20}
                />
                <span
                    data-studio="file-menu"
                    className={styles.collapsibleLabel}
                >{t.file}</span>
                <img
                    src={dropdownCaret}
                    draggable={false}
                    width={8}
                    height={5}
                />
                <MenuBarMenu
                    className={classNames(styles.menuBarMenu)}
                    open={this.props.open}
                    place={this.props.isRtl ? 'left' : 'right'}
                >
                    <MenuSection>
                        <MenuItem onClick={this.handleLoad}>
                            <span data-studio="file-load">{t.load}</span>
                        </MenuItem>
                        <MenuItem onClick={this.handleSave}>
                            <span data-studio="file-save">{t.save}</span>
                        </MenuItem>
                    </MenuSection>
                </MenuBarMenu>
            </MenuLabel>
        );
    }
}

const mapStateToProps = state => ({
    open: fileMenuOpen(state)
});

const mapDispatchToProps = dispatch => ({
    onOpen: () => dispatch(openFileMenu()),
    onClose: () => dispatch(closeFileMenu())
});

export default connect(mapStateToProps, mapDispatchToProps)(StudioFileMenu);
