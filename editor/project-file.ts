// Opening a project file from the student's computer: the menu bar "Load" button and dropping a file
// on the editor. The bridge decides whether the file may replace the project (edit mode only) and loads it.
import type {Locale} from './protocol';

/** The host site's upload limit. A bigger project would open here and then fail to save. */
export const MAX_PROJECT_BYTES = 20 * 1024 * 1024;
const ACCEPT = '.sb,.sb2,.sb3';

export const isProjectFileName = (name: string): boolean => /\.sb[23]?$/i.test(name);

const TEXT = {
    ko: {
        replace: (name: string) => `"${name}" 파일을 불러올까요? 지금 작품이 이 파일로 바뀝니다.`,
        notProject: '스크래치 작품 파일(.sb3)만 불러올 수 있어요.',
        tooLarge: '파일이 너무 커서 불러올 수 없어요. 20MB까지 불러올 수 있어요.',
        failed: '이 파일을 열 수 없어요. 스크래치 작품 파일인지 확인해 주세요.',
        drop: '여기에 놓으면 작품을 불러와요'
    },
    en: {
        replace: (name: string) => `Load "${name}"? It will replace the current project.`,
        notProject: 'Only Scratch project files (.sb3) can be loaded.',
        tooLarge: 'This file is too large to load. The limit is 20MB.',
        failed: 'This file could not be opened. Check that it is a Scratch project file.',
        drop: 'Drop here to load the project'
    }
};
export const projectFileText = (locale: string) => TEXT[locale as Locale] || TEXT.ko;

let onFile = (_file: File): void => {};
export const setProjectFileHandler = (fn: (file: File) => void): void => {
    onFile = fn;
};

let input: HTMLInputElement | null = null;
/** Opens the file chooser. One hidden input is reused, since a cancelled chooser never reports back. */
export const pickProjectFile = (): void => {
    if (!input) {
        input = document.createElement('input');
        input.type = 'file';
        input.accept = ACCEPT;
        input.style.display = 'none';
        input.addEventListener('change', () => {
            const file = input!.files && input!.files[0];
            input!.value = '';
            if (file) onFile(file);
        });
        document.body.appendChild(input);
    }
    input.click();
};

/**
 * Files dropped anywhere on the editor go to the handler, except where TurboWarp's drag-drop addon takes
 * them (sprite and stage panes, costume and sound lists, list monitors). The addon claims a drop by
 * calling preventDefault, and these listeners are on window so they run after it.
 */
export const installProjectDrop = (canDrop: () => boolean, locale: () => string): void => {
    const overlay = document.createElement('div');
    overlay.dataset.studio = 'project-drop';
    Object.assign(overlay.style, {
        position: 'fixed', inset: '0', zIndex: '2000', display: 'none', pointerEvents: 'none',
        alignItems: 'center', justifyContent: 'center', background: 'rgba(133, 92, 214, .18)',
        border: '4px dashed #855CD6', color: '#5a3aa8', fontSize: '24px', fontWeight: '700'
    });
    document.body.appendChild(overlay);

    // dragover keeps firing while the file is over the editor, so the overlay hides once it stops.
    let hideTimer: ReturnType<typeof setTimeout> | undefined;
    const hide = () => {
        clearTimeout(hideTimer);
        overlay.style.display = 'none';
    };
    const hasFiles = (e: DragEvent) => Boolean(e.dataTransfer && e.dataTransfer.types.includes('Files'));

    window.addEventListener('dragover', e => {
        if (!hasFiles(e) || e.defaultPrevented) {
            hide();
            return;
        }
        // Without this the browser would open the dropped file in place of the editor.
        e.preventDefault();
        if (!canDrop()) {
            e.dataTransfer!.dropEffect = 'none';
            return;
        }
        e.dataTransfer!.dropEffect = 'copy';
        overlay.textContent = projectFileText(locale()).drop;
        overlay.style.display = 'flex';
        clearTimeout(hideTimer);
        hideTimer = setTimeout(hide, 200);
    });
    window.addEventListener('drop', e => {
        hide();
        if (!hasFiles(e) || e.defaultPrevented) return;
        e.preventDefault();
        const file = e.dataTransfer!.files[0];
        if (file && canDrop()) onFile(file);
    });
};
