const port = browser.runtime.connectNative("qianli");

function resolve_function(string) {
    return (string || '').split('.').reduce((x, y) => x && x[y], table);
}

function send(msg, data) {
    return port.postMessage({...msg, type: 'data', data});
}

async function executeInTab(tabId, args, func) {
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

const subscribers = {};

const table = {
    browser,

    userAgent() { return window.navigator.userAgent; },

    dom: {
        check(tabId, path, url=null) {
            return executeInTab(tabId, [path, url], (path, url) => {
                return (!url || window.location == url) && !!document.querySelector(path)
            });
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
        _getAll(key, tabId, path, url=null) {
            return executeInTab(tabId, [path, key, url], (path, key, url) => {
                try {
                    if (!url || window.location == url) {
                        return Array.from(document.querySelectorAll(path)).map(x => x[key])
                    }
                } catch(e) {
                    throw new Error(e);
                }
            });
        },
        _set(key, value, tabId, path, url=null) {
            return executeInTab(tabId, [path, value, key, url], (path, value, key, url) => {
                try {
                    if (!url || window.location == url) {
                        document.querySelector(path)[key] = value;
                        return true;
                    }
                } catch(e) {
                    throw new Error(e);
                }
            });
        },
        _call(key, tabId, path, url=null) {
            return executeInTab(tabId, [path, key, url], (path, key, url) => {
                try {
                    if (!url || window.location == url) {
                        return document.querySelector(path)[key]();
                    }
                } catch(e) {
                    throw new Error(e);
                }
            });
        },
        innerHTML(...args) { return table.dom._getAll.bind(this)('innerHTML', ...args); },
        innerText(...args) { return table.dom._getAll.bind(this)('innerText', ...args); },
        outerHTML(...args) { return table.dom._getAll.bind(this)('outerHTML', ...args); },
        nodeName(...args) { return table.dom._getAll.bind(this)('nodeName', ...args); },
        value(...args) { return table.dom._getAll.bind(this)('value', ...args); },
        setValue(...args) { return table.dom._set.bind(this)('value', ...args); },
        focus(...args) { return table.dom._call.bind(this)('focus', ...args); },
        click(...args) { return table.dom._call.bind(this)('click', ...args); },
        submit(...args) { return table.dom._call.bind(this)('submit', ...args); },
        attributes(tabId, path, url=null) {
            return executeInTab(tabId, [path, url], (path, url) => {
                if (!url || window.location == url) {
                    return document.querySelectorAll(path).map(x => {
                        const attributes = {};
                        for (const attr of x.attributes) {
                            attributes[attr.name] = attr.value;
                        }
                        return attributes;
                    });
                }
            });
        },
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

    tabs: {
        async onUpdated(filter) {
            const listener = (tabId, changeInfo, tab) => send(this, {tabId, changeInfo, tab});
            browser.tabs.onUpdated.addListener(listener, filter);
        },
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

        if (opts.tabId) {
            await executeInTab(opts.tabId, [this, url, opts, null], func);

        } else if (opts.cookieStoreId && opts.cookieStoreId != 'firefox-default') {
            const extUrl = browser.runtime.getURL("");
            const tabs = (await browser.tabs.query({cookieStoreId: opts.cookieStoreId})).filter(tab => tab.url.startsWith(extUrl));
            let tab = tabs.length > 0 ? tabs[0] : null;
            if (!tab) {
                tab = await browser.tabs.create({cookieStoreId: opts.cookieStoreId, active: false, url: browser.runtime.getURL("background.js")});
                await browser.tabs.hide(tab.id);
                // why do i need this
                await new Promise((resolve, reject) => setTimeout(resolve, 10));
            }
            await executeInTab(tab.id, [this, url, opts, null], func);

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
