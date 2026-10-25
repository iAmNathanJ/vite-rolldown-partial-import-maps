import './slice.css';
import {defaults} from './settings.js';

export function settings() {
  return `settings: ${JSON.stringify(defaults)}`;
}
