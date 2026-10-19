// Stage 0 only: proves a second, invisible VM can load a snapshot, run it, be read and be destroyed.
// The real grader (stages 2-3) replaces this file.
import VM from 'scratch-vm';
import Renderer from 'scratch-render';
import storage from '@gui/lib/storage';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

const readSprites = vm => vm.runtime.targets
    .filter(t => t.isOriginal && !t.isStage)
    .map(t => ({name: t.getName(), x: t.x, y: t.y, direction: t.direction}));

export const staticSummary = vm => {
    const project = JSON.parse(vm.toJSON());
    const opcodes = {};
    for (const target of project.targets) {
        for (const id of Object.keys(target.blocks)) {
            const block = target.blocks[id];
            if (block && block.opcode) opcodes[block.opcode] = (opcodes[block.opcode] || 0) + 1;
        }
    }
    return {targets: project.targets.map(t => t.name), opcodes};
};

export const runHeadless = async (sb3, actions, withRenderer) => {
    const t0 = performance.now();
    const vm = new VM();
    vm.attachStorage(storage);
    let canvas = null;
    if (withRenderer) {
        canvas = document.createElement('canvas');
        canvas.width = 480;
        canvas.height = 360;
        vm.attachRenderer(new Renderer(canvas));
    }
    // No audio engine attached: the grading VM is silent.
    await vm.loadProject(sb3);
    const loadMs = performance.now() - t0;
    const initial = readSprites(vm);
    vm.start();
    for (const action of actions) {
        if (action.do === 'greenFlag') vm.greenFlag();
        else if (action.do === 'keyPress') {
            vm.postIOData('keyboard', {key: action.key, isDown: true});
            await wait(action.durationMs || 100);
            vm.postIOData('keyboard', {key: action.key, isDown: false});
        } else if (action.do === 'wait') await wait(action.ms);
        else if (action.do === 'stop') vm.stopAll();
    }
    const final = readSprites(vm);
    vm.stopAll();
    vm.quit();
    if (vm.renderer && vm.renderer.gl) {
        const lose = vm.renderer.gl.getExtension('WEBGL_lose_context');
        if (lose) lose.loseContext();
    }
    return {initial, final, loadMs: Math.round(loadMs), totalMs: Math.round(performance.now() - t0),
        hadRenderer: Boolean(withRenderer)};
};
