import { browser } from '../browser.mjs';
import { executeInTab, call_function } from './index.mjs';

async function inTabHandler(msg, fn, args) {

    // START COMMON

    window.refs ??= {
        refs: new WeakMap(),
        objs: new Map(),

        set(obj) {
            let ref = window.refs.refs.get(obj);
            if (!ref) {
                ref = parseInt(Math.random().toString().replace(/^0\.0*/, ''));
                window.refs.refs.set(obj, ref);
                window.refs.objs.set(ref, new WeakRef(obj));
            }
            return ref;
        },
        get(ref) {
            const weak = window.refs.objs.get(ref);
            if (weak) {
                const strong = weak.deref();
                if (!strong) {
                    window.refs.objs.delete(ref);
                }
                return strong;
            }
        },
    };

    async function serialiseValue(func) {
        let value;
        try {
            value = func();
            if (value instanceof Promise) {
                value = await value;
            }
        } catch(e) {
            throw `${e.toString()}\n${e.stack.trim()}`;
        }

        let json = null;
        try {
            json = JSON.stringify(value);
        } catch (e) {}

        if (value && !json) {
            value = `[${typeof value}]`;
        } else if (typeof value === 'object' && value.__proto__ !== Object.prototype) {
            value = JSON.parse(json);
        }
        return value;
    }

    // END COMMON

    function pickNode() {

        if (!window.addedPickNodeCss) {
            const style = document.createElement('style');
            style.textContent = `
                .ffcli-picknode {
                    box-shadow: inset 0 0 9999px 9999px rgba(255, 0, 0, 0.2);
                    outline: 2px dashed red;
                }
                `;
            document.head.appendChild(style);
            window.addedPickNodeCss = true;
        }

        return new Promise(resolve => {
            let prevTarget = null;

            const onMouseMove = (event) => {
                event?.preventDefault();
                event?.stopPropagation();
                if (prevTarget) {
                    prevTarget.classList.remove('ffcli-picknode');
                }
                prevTarget = event.target;
                prevTarget.classList.add('ffcli-picknode');
            };
            const onClick = (event) => {
                event?.preventDefault();
                event?.stopPropagation();
                document.removeEventListener('click', onClick, false);
                document.removeEventListener('mousemove', onMouseMove, false);
                if (prevTarget) {
                    prevTarget.classList.remove('ffcli-picknode');
                }
                resolve([event.target]);
                return false;
            };

            document.addEventListener('click', onClick, false);
            document.addEventListener('mousemove', onMouseMove, false);

        });
    }

    async function getNodes(path, filter) {
        let nodes = [];
        try {
            filter = filter ?? {};
            if (!filter.url || window.location.href === filter.url) {
                if (filter.ref && !path && !filter.parent) {
                    let node = window.refs.get(filter.ref);
                    if (node) {
                        nodes = [node];
                    }
                } else {
                    let parent = document;
                    if (filter.parent) {
                        parent = window.refs.get(filter.parent)
                    }

                    if (path === ':document') {
                        nodes = Array.from(filter.parent ? [] : [document]);
                    } else if (path.match(/^:window(\.\w+)*$/)) {
                        nodes = Array.from(filter.parent ? [] : [resolve_value(path.slice(1), {window})]);
                    } else if (path === ':pick') {
                        nodes = filter.parent ? [] : await pickNode();
                    } else {
                        nodes = Array.from(parent ? parent.querySelectorAll(path) : []);
                    }

                    if (filter.ref) {
                        nodes = nodes.filter(x => window.refs.get(x) == filter.ref);
                    }
                }

                let attrs = filter.attrs ?? {};
                for (const [key, value] of Object.entries(attrs)) {
                    let regex = new RegExp(value);
                    nodes = nodes.filter(x => regex.test(x[key]));
                }

            }
            return nodes;
        } catch(e) {
            throw new Error(e)
        }
    }

    function prepare_for_serialization(value, node) {
        if (typeof value === 'function') {
            return value.bind(node)();
        } else if (value instanceof CSSStyleDeclaration) {
            const result = {};
            for (const prop of value) {
                result[prop] = value[prop];
            }
            return result;
        } else {
            return value;
        }
    }

    function getNodeValues(nodes, keys, manyKeys) {
        return nodes.map(n => {
            const values = keys.map(k => {
                let value = k ? n[k] : n;
                if (typeof value === 'undefined' && k === 'getComputedStyle') {
                    value = window.getComputedStyle(n);
                }
                value = prepare_for_serialization(value, n);

                if (value instanceof Element || value instanceof HTMLDocument || value instanceof Window) {
                    // make some refs
                    value = window.refs.set(value);
                }
                return value;
            });
            return manyKeys ? values : values[0];
        });
    }

    const table = {
        userAgent() { return window.navigator.userAgent; },

        localStorage: {
            length(...args) { return window.localStorage.length; },
            key(...args) { return window.localStorage.key(...args); },
            getItem(...args) { return window.localStorage.getItem(...args); },
            setItem(...args) { return window.localStorage.setItem(...args); },
            removeItem(...args) { return window.localStorage.removeItem(...args); },
            clear(...args) { return window.localStorage.clear(...args); },
            getAll(...args) { return window.localStorage; },
        },

        dom: {

            async get(path, keys, ...args) {
                const nodes = await getNodes(path, ...args);
                const manyKeys = Array.isArray(keys);
                if (!manyKeys) {
                    keys = [keys];
                }
                return getNodeValues(nodes, keys, manyKeys);
            },

            async shadowRootGet(path, shadowSelector, keys, ...args) {
                const nodes = [];
                for (const n of await getNodes(path, ...args)) {
                    if (n.shadowRoot) {
                        nodes.push(...n.shadowRoot.querySelectorAll(shadowSelector));
                    }
                }
                const manyKeys = Array.isArray(keys);
                if (!manyKeys) {
                    keys = [keys];
                }
                return getNodeValues(nodes, keys, manyKeys);
            },

            async count(...args) {
                return (await getNodes(...args)).length;
            },

            async set(path, key, value, ...args) {
                const nodes = await getNodes(path, ...args);
                for (const node of nodes) {
                    node[key] = value;
                }
                return nodes.length;
            },

            async defineProperty(path, key, prop, ...args) {
                const nodes = await getNodes(path, ...args);
                for (const node of nodes) {
                    Object.defineProperty(node, key, prop);
                }
                return nodes.length;
            },

            async call(path, key, fnArgs, ...args) {
                const nodes = await getNodes(path, ...args);
                if (fnArgs && !Array.isArray(fnArgs)) {
                    // you probably meant this to be the one argument rather than one per char
                    fnArgs = [fnArgs];
                }
                return nodes.map(x => {
                    let value = x[key](...(fnArgs || []));
                    if (value instanceof HTMLElement || value instanceof SVGElement || value instanceof HTMLDocument) {
                        // make some refs
                        value = window.refs.set(value);
                    }
                    return value;
                });
            },

            async getAttributes(...args) {
                return (await getNodes(...args)).map(x => {
                    const attrs = {};
                    for (const attr of x.attributes) {
                        attrs[attr.name] = attr.value;
                    }
                    return attrs;
                });
            },

            async getComputedStyle(...args) {
                return (await getNodes(...args)).map(x => prepare_for_serialization(window.getComputedStyle(x)));
            },

            async sendKey(path, key, code, ...args) {
                const props = {bubbles: true, composed: true, cancelable: true}
                const charCode = code ?? key.charCodeAt(0);
                const keyProps = {key, code: key, charCode, keyCode: charCode, which: charCode, ...props};
                const nodes = args.length > 0 ? await getNodes(path, ...args) : [document];
                return nodes.map(x => {
                    x.dispatchEvent(new FocusEvent('focus', props));
                    x.dispatchEvent(new KeyboardEvent('keydown', keyProps));
                    x.dispatchEvent(new KeyboardEvent('keyup', keyProps));
                    x.dispatchEvent(new KeyboardEvent('keypress', keyProps));
                    x.dispatchEvent(new KeyboardEvent('input', keyProps));
                    x.dispatchEvent(new InputEvent('input', props));
                    x.dispatchEvent(new InputEvent('change', props));
                    x.dispatchEvent(new FocusEvent('blur', props));
                });
            },

            async dispatchEvent(path, type, options, cls, ...args) {
                const nodes = await getNodes(path, ...args);
                const event_cls = window[`${cls ?? ''}Event`];
                return nodes.map(x => {
                    const event = new event_cls(type, options);
                    return x.dispatchEvent(event);
                });
            },

            async calcCssPath(path, ...args) {
                const nodes = await getNodes(path, ...args);
                return nodes.map(x => {
                    if (x instanceof Element) {
                        const parts = [];
                        while (x && x instanceof Element) {
                            const cls = Array.from(x.classList).join('.');
                            parts.unshift(x.tagName.toLowerCase() + (cls && '.' + cls) + (x.id && '#' + x.id));
                            x = x.parentNode;
                        }
                        return parts.join(' > ');
                    }
                });
            },

        },
    };

    function resolve_value(string, t=null) {
        return (string || '').split('.').reduce((x, y) => x && x[y], t ?? table);
    }

    const func = resolve_value(fn);
    if (typeof func != 'function') {
        throw new Error(`no such function ${fn}`);
    }

    return await serialiseValue(() => func.bind(msg)(...(args || [])));
}

const inTabHandlerCommon = inTabHandler.toString().match(/START COMMON([\s\S]*)\/\/ END COMMON/)[1]

export async function executeApi(msg, fn, tabId, opts, ...args) {
    return executeInTab(tabId, opts, [msg, fn, args], inTabHandler);
};

function makeApi(fn, numArgs) {
    return function(...args) {
        if (args.length < numArgs + 1) {
            args.push(...Array(numArgs + 1 - args.length)); // make sure this has numArgs, even if args is originally shorter
        }
        const {tabId=0, target=null, world=null, ...rest} = args.pop() ?? {};
        return executeApi(this, fn, tabId, {target, world}, ...args, rest);
    }
}

export const api = {
    async userAgent(tabId, opts) {
        return (await executeApi(this, 'userAgent', tabId, opts))[0].result;
    },

    localStorage: {
        length: makeApi('localStorage.length', 0),
        key: makeApi('localStorage.key', 1),
        getItem: makeApi('localStorage.getItem', 1),
        setItem: makeApi('localStorage.setItem', 2),
        removeItem: makeApi('localStorage.removeItem', 1),
        clear: makeApi('localStorage.clear', 0),
        getAll: makeApi('localStorage.getAll', 0),
    },

    dom: {
        async check(...args) {
            return (await api.dom.count(...args)).some(x => x.result > 0);
        },
        async wait(path, {timeout=0, ...args}={}) {
            const interval = 500;
            for (let elapsed = 0; !timeout || elapsed < timeout; elapsed += interval) {
                if (await api.dom.check(path, args)) {
                    return true;
                }
                await new Promise(resolve => setTimeout(resolve, interval));
            }
            return false;
        },
    },

    async execjs(code, {tabId=0, target={}}={}) {
        if (tabId == 0) {
            tabId = (await call_function('browser.tabs.query', {active: true, currentWindow: true}))[0].id;
        }
        target.tabId ??= tabId;
        const preCode = `
(async function(func) {
    ${inTabHandlerCommon}
    return await serialiseValue(func);
})(async function() {
`;
        const results = await browser.userScripts.execute({
            js: [{code: `${preCode}${code}})`}],
            target,
        });
        for (const x of results) {
            if (x?.error instanceof SyntaxError) {
                x.error = `${x.error.toString()}\n   at ${x.error.fileName}:${x.error.lineNumber+1-preCode.split('\n').length}:${x.error.columnNumber}`;
            }
        }
        return results;
    },

};

for (const [k, v] of Object.entries({
    count: 1,
    get: 2,
    shadowRootGet: 3,
    set: 3,
    defineProperty: 3,
    call: 3,
    sendKey: 3,
    getAttributes: 1,
    getComputedStyle: 1,
    dispatchEvent: 4,
    calcCssPath: 1,
})) {
    api.dom[k] = makeApi('dom.' + k, v);
}
