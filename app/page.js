import {format} from './common.js';

export function render(root) {
  root.innerHTML = `
    <p>${format('page loaded')}</p>
    <button id="editor">Open editor</button>
    <button id="settings">Load settings</button>
    <pre id="log"></pre>`;
  const log = (line) => root.querySelector('#log').append(`${line}\n`);
  root.querySelector('#editor').onclick = () =>
    import('./editor.js').then((m) => log(m.open()));
  root.querySelector('#settings').onclick = () =>
    import('./slice.js').then((m) => log(m.settings()));
}
