import { browser } from './browser.mjs';

export const port = browser.runtime.connectNative("ffcli");
export const subscribers = {};

export function sleep(timeout) {
    return new Promise(resolve => setTimeout(resolve, timeout))
}

export function send(msg, data) {
    return port.postMessage({...msg, type: 'data', data});
}
