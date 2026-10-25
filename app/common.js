import './common.css';
import {upper} from './vendor.js';

export function format(text) {
  return `[${upper('app')}] ${text}`;
}
