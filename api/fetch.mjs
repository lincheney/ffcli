import { hasPermission } from '../permissions.mjs';
import { call_function, resolve_function, executeInTab } from './index.mjs';
import { send } from '../shared.mjs';

const fetch_tabs = {};

async function run_fetch(msg, url, opts, send) {
    send = send ?? ((msg, data) => browser.runtime.sendMessage({...msg, type: 'data', data}));
    const resp = await fetch(url, opts);

    const headers = {};
    resp.headers.forEach((value, key) => { headers[key] = value; });
    send(msg, {
        type: 'response',
        data: {
            type: resp.type,
            status: resp.status,
            statusText: resp.statusText,
            headers,
            url: resp.url,
            redirected: resp.redirected,
        }
    });

    const body = resp.body?.getReader();
    while (body) {
        const chunk = await body.read();
        if (chunk.done) { break; };
        send(msg, {type: 'responseBody', data: btoa(String.fromCharCode.apply(null, chunk.value))});
    }
};

async function webRequestWrapper(url, opts, filter, callback) {
    // try to use web request to track the request
    // otherwise just call fetch directly
    const webRequest = await resolve_function('browser.webRequest', true);
    if (!(webRequest && await hasPermission('webRequestBlocking'))) {
        return (await callback(url, opts));
    }

    // must end in slash
    const fakeUrl = new URL(url).origin + '/' + crypto.randomUUID() + '/';
    if (url.match('^.*://[^/]+$')) {
        url += '/';
    }

    const followRedirect = opts.redirect == 'follow';
    let requestId = null;
    const onBeforeRequest = (details) => {
        requestId = details.requestId;
        return {redirectUrl: url};
    };
    const onSendHeaders = (details) => {
        if (details.requestId === requestId) {
            send(this, {type: 'sendHeaders', data: details});
        }
    };
    const onHeadersReceived = (details) => {
        if (details.requestId === requestId) {
            send(this, {type: 'headersReceived', data: details});

            if (! (300 <= details.statusCode && details.statusCode < 400)) {
                // not a redirect -> remove all the listeners early
                // since these listeners may be expensive
                webRequest.onBeforeRequest.removeListener(onBeforeRequest);
                webRequest.onSendHeaders.removeListener(onSendHeaders);
                webRequest.onHeadersReceived.removeListener(onHeadersReceived);
            } else if (!followRedirect) {
                return {redirectUrl: browser.runtime.getURL("null")};
            }
        }
    };
    webRequest.onBeforeRequest.addListener(onBeforeRequest, {urls: [fakeUrl]}, ['blocking']);
    webRequest.onSendHeaders.addListener(onSendHeaders, {urls: [followRedirect ? '<all_urls>' : url]}, ['requestHeaders']);
    webRequest.onHeadersReceived.addListener(onHeadersReceived, {urls: [followRedirect ? '<all_urls>' : url]}, ['blocking', 'responseHeaders']);

    opts.redirect = 'follow';
    try {
        return await callback(fakeUrl, opts);
    } finally {
        webRequest.onBeforeRequest.removeListener(onBeforeRequest);
        webRequest.onSendHeaders.removeListener(onSendHeaders);
        webRequest.onHeadersReceived.removeListener(onHeadersReceived);
    }
};

export async function browser_fetch(url, opts={}) {

    opts.body = opts.body && atob(opts.body);

    console.debug("DEBUG(pried) \t%s\t= %o", "this", this);
    if ((opts.tabId ?? null) !== null) {
        await webRequestWrapper(url, opts, {tabId: opts.tabId}, async (url, opts) => {
            await executeInTab(opts.tabId, [this, url, opts, null], run_fetch);
        });

    } else if (opts.cookieStoreId && opts.cookieStoreId != 'firefox-default') {
        const extUrl = browser.runtime.getURL("");
        const tabs = (await call_function('browser.tabs.query', {cookieStoreId: opts.cookieStoreId})).filter(tab => tab.url.startsWith(extUrl));
        let tab = tabs.length > 0 ? tabs[0] : null;
        let newtab;
        if (!tab) {
            let resolver;
            const promise = new Promise(resolve => {resolver = resolve;});
            const listener = (tabId, changeInfo, tab) => {
                if (tabId == newtab.id && tab.status === 'complete') {
                    resolver();
                }
            };
            await call_function('browser.tabs.onUpdated.addListener', listener, {properties: ['status']});
            newtab = await call_function('browser.tabs.create', {cookieStoreId: opts.cookieStoreId, active: false, url: browser.runtime.getURL("null")});
            await call_function('browser.tabs.hide', newtab.id);
            await promise;
            await call_function('browser.tabs.onUpdated.removeListener', listener);
            tab = newtab;
        }

        // run a keepalive on the tab while not done
        // then close the time after an inactive timeout
        let done = false;
        fetch_tabs[tab.id] = Date.now();
        (async () => {
            const tabId = tab.id;
            const tabTimeout = 60 * 1000;
            while (true) {
                if (!done) {
                    // keepalive
                    fetch_tabs[tabId] = Date.now();
                } else if (!newtab) {
                    // someone else is tracking this tab
                    break;
                } else if (Date.now() >= fetch_tabs[tabId] + tabTimeout) {
                    // close
                    delete fetch_tabs[tabId];
                    await call_function('browser.tabs.remove', tabId);
                    break;
                }
                await sleep(tabTimeout);
            }
        })();

        try {
            await webRequestWrapper(url, opts, {tabId: tab.id}, async (url, opts) => {
                await executeInTab(tab.id, [this, url, opts, null], run_fetch);
            });
        } finally {
            done = true;
        }

    } else {
        await webRequestWrapper(url, opts, {tabId: -1}, async (url, opts) => {
            await run_fetch(this, url, opts, send);
        });
    }
};
