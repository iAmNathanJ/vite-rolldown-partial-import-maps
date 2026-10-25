import './editor.css';
import {format} from './common.js';
import {clamp} from './util.js';

export function open() {
  return format(`editor opened, clamp(42, 0, 10) = ${clamp(42, 0, 10)}`);
}
