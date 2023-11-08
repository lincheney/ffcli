const port = browser.runtime.connectNative("qianli");

function resolve_function(string) {
    return (string || '').split('.').reduce((x, y) => x && x[y], table);
}

function sleep(timeout) {
    return new Promise(resolve => setTimeout(resolve, timeout))
}

function send(msg, data) {
    return port.postMessage({...msg, type: 'data', data});
}

async function _executeInTab(tabId, args, func) {
    if (tabId == 0) {
        tabId = (await browser.tabs.query({active: true, currentWindow: true}))[0].id;
    }

    const result = await browser.scripting.executeScript({
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

async function executeInTab(msg, fn, tabId, ...args) {
    return _executeInTab(tabId, [msg, fn, args], async (msg, fn, args) => {

        function getNodes(path, filter) {
            try {
                filter = filter ?? {};
                if (!filter.url || window.location === filter.url) {
                    return Array.from(document.querySelectorAll(path));
                }
                return [];
            } catch(e) {
                throw new Error(e)
            }
        }

        const table = {
            dom: {

                get(key, ...args) {
                    return getNodes(...args).map(x => x[key]);
                },

                count(...args) {
                    return getNodes(...args).length;
                },

                set(key, value, ...args) {
                    const nodes = getNodes(...args);
                    for (const node of nodes) {
                        node[key] = value;
                    }
                    return nodes.length > 0;
                },

                call(key, ...args) {
                    const nodes = getNodes(...args);
                    return nodes.map(x => x[key]());
                },

                getAttributes(...args) {
                    return getNodes(...args).map(x => {
                        const attrs = {};
                        for (const attr of x.attributes) {
                            attrs[attr.name] = attr.value;
                        }
                        return attrs;
                    });
                },

                sendKey(key, ...args) {
                    const nodes = args.length > 0 ? getNodes(...args) : [document];
                    return nodes.map(x => x.dispatchEvent(new KeyboardEvent('keydown', {'key': key})));
                },

            },
        };

        function resolve_function(string) {
            return (string || '').split('.').reduce((x, y) => x && x[y], table);
        }

        const func = resolve_function(fn);
        if (typeof func != 'function') {
            throw new Error(`no such function ${fn}`);
        }

        let value = func.bind(msg)(...(args || []));
        if (value instanceof Promise) {
            value = await value;
        }
        if (value && !JSON.stringify(value)) {
            value = `[${typeof value}]`;
        }
        return value;
    }
)};

const subscribers = {};
const fetch_tabs = {};

const table = {
    status() { return true; },

    browser,

    userAgent() { return window.navigator.userAgent; },

    dom: {
        async check(...args) {
            return (await executeInTab(this, 'dom.count', ...args)) > 0;
        },
        async wait(timeout, ...args) {
            const interval = 500;
            for (let elapsed = 0; !timeout || elapsed < timeout; elapsed += interval) {
                if (await table.dom.check(...args)) {
                    return true;
                }
                await new Promise(resolve => setTimeout(resolve, interval));
            }
            return false;
        },
        count(...args) { return executeInTab(this, 'dom.count', ...args); },
        get(key, tabId, ...args) { return executeInTab(this, 'dom.get', tabId, key, ...args); },
        set(key, value, tabId, ...args) { return executeInTab(this, 'dom.get', tabId, key, value, ...args); },
        call(key, tabId, ...args) { return executeInTab(this, 'dom.call', tabId, key, ...args); },
        getAttributes(...args) { return executeInTab(this, 'dom.getAttributes', ...args); },
        sendKey(key, tabId, ...args) { return executeInTab(this, 'dom.sendKey', tabId, key, ...args); },
    },

    async subscribe(event, filter=null, numEvents=-1) {
        const ev = resolve_function(event);
        if (!ev || typeof ev.addListener != 'function') {
            throw new Error(`no such event ${event}`);
        }

        const subscriptionId = crypto.randomUUID();
        if (!subscribers[this._id]) {
            subscribers[this._id] = {}
        }
        const promise = new Promise((resolve, reject) => {
            subscribers[this._id][subscriptionId] = resolve;
        });
        send(this, {subscriptionId})

        console.log(numEvents);
        const listener = (...args) => {
            if (numEvents == 1) {
                table.unsubscribe.bind(this)(subscriptionId);
            }
            if (numEvents > 0) {
                numEvents -= 1;
                send(this, args);
            }
        }
        ev.addListener(listener, filter);
        await promise;
        ev.removeListener(listener);
    },
    unsubscribe(subid) {
        const subs = subscribers[this._id];
        subs[subid](); // resolves
        delete subs[subid];
    },

    async fetch(url, opts={}) {
        const func = async (msg, url, opts, send) => {
            send = send ?? ((msg, data) => browser.runtime.sendMessage({...msg, type: 'data', data}));
            const resp = await fetch(url, opts);

            const headers = {};
            resp.headers.forEach((value, key) => { headers[key] = value; });
            send(msg, {status: resp.status, headers});

            const body = resp.body?.getReader();
            while (body) {
                const chunk = await body.read();
                if (chunk.done) { break; };
                send(msg, {body: btoa(String.fromCharCode.apply(null, chunk.value))});
            }
        };

        opts.body = opts.body && atob(opts.body);

        if ((opts.tabId ?? null) !== null) {
            await _executeInTab(opts.tabId, [this, url, opts, null], func);

        } else if (opts.cookieStoreId && opts.cookieStoreId != 'firefox-default') {
            const extUrl = browser.runtime.getURL("");
            const tabs = (await browser.tabs.query({cookieStoreId: opts.cookieStoreId})).filter(tab => tab.url.startsWith(extUrl));
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
                browser.tabs.onUpdated.addListener(listener, {properties: ['status']});
                newtab = await browser.tabs.create({cookieStoreId: opts.cookieStoreId, active: false, url: browser.runtime.getURL("null")});
                await browser.tabs.hide(newtab.id);
                await promise;
                browser.tabs.onUpdated.removeListener(listener);
                tab = newtab;
            }

            // run a keepalive on the tab while not done
            // then close the time after an inactive timeout
            let done = false;
            fetch_tabs[tab.id] = Date.now();
            (async () => {
                const tabId = tab.id;
                const tabTimeout = 5 * 1000;
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
                        await browser.tabs.remove(tabId);
                        break;
                    }
                    await sleep(tabTimeout);
                }
            })();

            try {
                await _executeInTab(tab.id, [this, url, opts, null], func);
            } finally {
                done = true;
            }

        } else {
            await func(this, url, opts, send);
        }
    },
};

browser.runtime.onMessage.addListener(port.postMessage);

port.onMessage.addListener((msg) => {
    console.log(`Received: %j`, msg);

    if (msg.type == 'disconnect') {
        // unsubscribe from everything
        const subs = subscribers[msg._id];
        if (subs) {
            for (const resolve of Object.values(subs)) {
                resolve();
            }
            delete subscribers[msg._id];
        }
        return;
    }

    (async() => {
        let { fn, args } = msg;
        delete msg.fn;
        delete msg.args;
        try {
            const func = resolve_function(fn);
            if (typeof func != 'function') {
                throw new Error(`no such function ${fn}`);
            }

            let value = func.bind(msg)(...(args || []));
            if (value instanceof Promise) {
                value = await value;
            }
            if (value && !JSON.stringify(value)) {
                value = `[${typeof value}]`;
            }
            msg.type = 'data';
            msg.data = value ?? null;
        } catch(e) {
            msg.type = 'error';
            msg.data = {error: e.toString()};
            if (e.stack) {
                msg.data.stack = e.stack.trim().split('\n');
            } else if (e.fileName && e.lineNumber) {
                msg.data.stack = [`${e.fileName}:${e.lineNumber}`];
            } else if (e.fileName) {
                msg.data.stack = [e.fileName];
            }
        } finally {
            port.postMessage(msg);
            delete msg.data;
            msg.type = 'complete';
            port.postMessage(msg);
        }
    })();

});
