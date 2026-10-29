import React from 'react';
import {getSaveState, subscribeSaveState} from './save-store';
import {pickProjectFile} from './project-file';

const LABELS = {ko: '불러오기', en: 'Load'};

// Rendered in the editor menu bar right of the Edit menu, styled by the menu bar like its other items.
// "Load" opens a project file from the student's computer (project-file.ts). Edit mode only, like Save.
class StudioLoadButton extends React.Component {
    constructor (props) {
        super(props);
        this.state = {enabled: getSaveState().enabled};
    }
    componentDidMount () {
        this.unsubscribe = subscribeSaveState(s => this.setState({enabled: s.enabled}));
    }
    componentWillUnmount () {
        this.unsubscribe();
    }
    render () {
        if (!this.state.enabled) return null;
        return (
            <div
                data-studio="load-button"
                className={this.props.className}
                onClick={pickProjectFile}
            >
                <img
                    src={this.props.iconSrc}
                    draggable={false}
                    width={20}
                    height={20}
                />
                <span className={this.props.labelClassName}>
                    {LABELS[this.props.locale] || LABELS.ko}
                </span>
            </div>
        );
    }
}

export default StudioLoadButton;
