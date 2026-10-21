// The runtime dynamic checks run in: a second VM with a renderer on a canvas nobody sees.
// It is made for one run and thrown away, so the student's editor is never touched.
import VM from 'scratch-vm';
import Renderer from 'scratch-render';
import storage from '@gui/lib/storage';
import type {CreateRuntime, GradingRuntime, Reading} from '../grader/index';
import {variants} from '../grader/compare';
import {lockExtensions} from './extensions';

const STAGE_WIDTH = 480;
const STAGE_HEIGHT = 360;

type Target = any;

const sayText = (target: Target): string => {
    const state = target.getCustomState('Scratch.looks');
    return state && state.text != null ? String(state.text) : '';
};

const costumeName = (target: Target): string | undefined => target.getCostumes()[target.currentCostume]?.name;

export const createGradingRuntime = (sb3: ArrayBuffer): CreateRuntime => async () => {
    const vm = new VM();
    lockExtensions(vm);
    vm.attachStorage(storage);
    // A renderer is required: without one, loops do not wait for redraws and run far too fast,
    // and "touching" checks have nothing to test against (docs/spike.md).
    const canvas = document.createElement('canvas');
    canvas.width = STAGE_WIDTH;
    canvas.height = STAGE_HEIGHT;
    const renderer = new Renderer(canvas);
    vm.attachRenderer(renderer);
    // No audio engine: the grading VM is silent.
    let disposed = false;
    const dispose = () => {
        if (disposed) return;
        disposed = true;
        vm.stopAll();
        vm.quit();
        renderer.gl?.getExtension('WEBGL_lose_context')?.loseContext();
    };
    try {
        await vm.loadProject(sb3.slice(0));
    } catch (e) {
        dispose();
        throw e;
    }
    vm.start();

    const runtime = vm.runtime;
    const sprites = (): Target[] => runtime.targets.filter((target: Target) => target.isOriginal && !target.isStage);
    const findSprite = (name: string | undefined): Target | undefined => {
        if (name === undefined || name === '@first') return sprites()[0];
        if (name === '@stage') return runtime.getTargetForStage();
        return sprites().find(target => target.getName() === name);
    };
    const findVariable = (reading: Reading, type: '' | 'list') => {
        const names = variants(reading.name).map(String);
        const stage = runtime.getTargetForStage();
        const sprite = reading.sprite === undefined ? undefined : findSprite(reading.sprite);
        if (reading.sprite !== undefined && !sprite) return undefined;
        const order = sprite ? [sprite, stage] : [stage, ...sprites()];
        for (const target of order) {
            const variable = Object.values(target.variables as Record<string, Target>)
                .find(candidate => candidate.type === type && names.includes(candidate.name));
            if (variable) return variable;
        }
        return undefined;
    };

    const grading: GradingRuntime = {
        greenFlag: () => vm.greenFlag(),
        key: (key, isDown) => vm.postIOData('keyboard', {key, isDown}),
        clickSprite: name => {
            const target = findSprite(name);
            if (!target || target.isStage) return false;
            runtime.startHats('event_whenthisspriteclicked', null, target);
            return true;
        },
        mouseMove: (x, y) => vm.postIOData('mouse', {
            x: x + STAGE_WIDTH / 2, y: STAGE_HEIGHT / 2 - y, canvasWidth: STAGE_WIDTH, canvasHeight: STAGE_HEIGHT
        }),
        answer: text => runtime.emit('ANSWER', text),
        // Hats compare broadcast names in upper case.
        broadcast: message => runtime.startHats('event_whenbroadcastreceived', {BROADCAST_OPTION: message.toUpperCase()}),
        stop: () => vm.stopAll(),
        read: reading => {
            switch (reading.target) {
            case 'sprite': {
                const target = findSprite(reading.sprite);
                if (!target || target.isStage) return undefined;
                switch (reading.property) {
                case 'x': return target.x;
                case 'y': return target.y;
                case 'direction': return target.direction;
                case 'size': return target.size;
                case 'visible': return target.visible;
                case 'costume': return costumeName(target);
                case 'sayText': return sayText(target);
                case 'touchingEdge': return target.isTouchingEdge();
                default: return undefined;
                }
            }
            case 'variable': return findVariable(reading, '')?.value;
            case 'list': {
                const list = findVariable(reading, 'list');
                if (!list) return undefined;
                if (reading.property === 'length') return list.value.length;
                if (reading.property === 'item' && typeof reading.index === 'number') return list.value[reading.index - 1];
                return undefined;
            }
            case 'stage':
                return reading.property === 'backdrop' ? costumeName(runtime.getTargetForStage()) : undefined;
            case 'clones': {
                const target = findSprite(reading.sprite);
                if (!target || target.isStage) return undefined;
                return runtime.targets.filter((clone: Target) => !clone.isOriginal && clone.sprite === target.sprite).length;
            }
            default:
                return undefined;
            }
        },
        dispose
    };
    return grading;
};
