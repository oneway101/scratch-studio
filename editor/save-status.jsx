import React from 'react';
import {getSaveState, subscribeSaveState, requestSave} from './save-store';

const LABELS = {
    ko: {saved: '저장됨', saving: '저장 중', failed: '저장 실패', save: '저장하기', retry: '다시 시도'},
    en: {saved: 'Saved', saving: 'Saving', failed: 'Save failed', save: 'Save', retry: 'Retry'}
};

// Rendered inside the editor menu bar in place of TurboWarp's "Save to your computer".
class StudioSaveStatus extends React.Component {
    constructor (props) {
        super(props);
        this.state = getSaveState();
    }
    componentDidMount () {
        this.unsubscribe = subscribeSaveState(s => this.setState(s));
    }
    componentWillUnmount () {
        this.unsubscribe();
    }
    render () {
        if (!this.state.enabled) return null;
        const t = LABELS[this.props.locale] || LABELS.ko;
        const {status} = this.state;
        return (
            <div
                data-studio="save"
                style={{display: 'flex', alignItems: 'center', gap: '8px', color: '#fff', fontSize: '12px'}}
            >
                <span data-studio="save-status">{t[status]}</span>
                {status === 'failed' ? (
                    <button
                        data-studio="save-retry"
                        style={{background: 'transparent', border: 'none', color: '#fff',
                            textDecoration: 'underline', fontWeight: 700, cursor: 'pointer'}}
                        onClick={requestSave}
                    >{t.retry}</button>
                ) : null}
                <button
                    data-studio="save-button"
                    disabled={status === 'saving'}
                    style={{height: '32px', padding: '0 14px', borderRadius: '8px', color: '#fff',
                        fontWeight: 700, cursor: 'pointer', border: '1px solid rgba(255,255,255,.55)',
                        background: 'rgba(255,255,255,.14)'}}
                    onClick={requestSave}
                >{t.save}</button>
            </div>
        );
    }
}

export default StudioSaveStatus;
