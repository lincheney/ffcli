import { customPermissions, hasPermission } from '../permissions.mjs';
import { browser_fetch } from './fetch.mjs';
import { api as inTabApi } from './inTab.mjs';
import { api as subscribeApi } from './subscribe.mjs';
import { send } from '../shared.mjs';

async function _resolve_function(string) {
    const fn = (string || '').split('.');

    if (fn[0] == 'browser') {

        // do not allow access to storage or runtime.connectNative
        if (fn[1] == 'storage' || (fn[1] == 'runtime' && fn[2] == 'connectNative')) {
            return;
        }

        if (customPermissions.has(fn[1]) && ! await hasPermission(fn[1])) {
            return;
        }
    }

    return fn.reduce((x, y) => x && x[y], api);
}

export async function resolve_function(string, nofail) {
    const func = await _resolve_function(string);
    if (!nofail && typeof func !== 'function') {
        throw new Error(`no such function ${string}`);
    }
    return func;
}

export async function call_function(string, ...args) {
    return (await resolve_function(string)).bind(this)(...args);
}

export async function executeInTab(tabId, args, func) {
    if (tabId == 0) {
        tabId = (await call_function('browser.tabs.query', {active: true, currentWindow: true}))[0].id;
    }

    const result = await call_function('browser.scripting.executeScript', {
        injectImmediately: true,
        target: {tabId},
        args,
        func,
    });
    if (!result[0]) {
        return null;
    } else if (result[0].error) {
        throw result[0].error;
    } else {
        return result[0].result;
    }
}


const api = {
    status() { return true; },

    browser,

    ...subscribeApi,
    ...inTabApi,

    userAgent(tabId=null) {
        if (tabId) {
            return inTabApi.userAgent(tabId);
        }
        return window.navigator.userAgent;
    },

    fetch: browser_fetch,
};
