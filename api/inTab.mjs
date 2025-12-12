import { browser } from '../browser.mjs';
import { executeInTab } from './index.mjs';

export async function executeApi(msg, fn, tabId, opts, ...args) {
    return executeInTab(tabId, opts, [msg, tabId, fn, args], async (msg, tabId, fn, args) => {

        window.nodes ??= {
            map: new WeakMap(),
            ref_map: new Map(),

            get_ref(obj) {
                return window.nodes.map.get(obj);
            },
            set_ref(obj) {
                let ref = window.nodes.get_ref(obj);
                if (!ref) {
                    ref = Math.random().toString();
                    window.nodes.map.set(obj, ref);
                    window.nodes.ref_map.set(ref, new WeakRef(obj));
                }
                return ref;
            },
            get_obj(ref) {
                const weak_ref = window.nodes.ref_map.get(ref);
                if (weak_ref) {
                    const strong_ref = weak_ref.deref();
                    if (!strong_ref) {
                        window.nodes.ref_map.delete(ref);
                    }
                    return strong_ref;
                }
            },
        };

        function getNodes(path, filter) {
            let nodes = [];
            try {
                filter = filter ?? {};
                if (!filter.url || window.location.href === filter.url) {
                    if (filter.ref && !path && !filter.parent) {
                        let node = window.nodes.get_obj(filter.ref);
                        if (node) {
                            nodes = [node];
                        }
                    } else {
                        let parent = document;
                        if (filter.parent) {
                            parent = window.nodes.get_obj(filter.parent)
                        }

                        nodes = Array.from(parent ? parent.querySelectorAll(path) : []);

                        if (filter.ref) {
                            nodes = nodes.filter(x => window.nodes.get_ref(x) == filter.ref);
                        }
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

                    if (value instanceof HTMLElement) {
                        // make some refs
                        value = window.nodes.set_ref(value);
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

                get(path, keys, ...args) {
                    const nodes = getNodes(path, ...args);
                    const manyKeys = Array.isArray(keys);
                    if (!manyKeys) {
                        keys = [keys];
                    }
                    return getNodeValues(nodes, keys, manyKeys);
                },

                shadowRootGet(path, shadowSelector, keys, ...args) {
                    const nodes = [];
                    for (const n of getNodes(path, ...args)) {
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

                count(...args) {
                    return getNodes(...args).length;
                },

                set(path, key, value, ...args) {
                    const nodes = getNodes(path, ...args);
                    for (const node of nodes) {
                        node[key] = value;
                    }
                    return nodes.length;
                },

                call(path, key, fnArgs, ...args) {
                    const nodes = getNodes(path, ...args);
                    return nodes.map(x => {
                        let value = x[key](...(fnArgs || []));
                        if (value instanceof HTMLElement) {
                            // make some refs
                            value = window.nodes.set_ref(value);
                        }
                        return value;
                    });
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

                getComputedStyle(...args) {
                    return getNodes(...args).map(x => prepare_for_serialization(window.getComputedStyle(x)));
                },

                sendKey(path, key, code, ...args) {
                    const props = {bubbles: true, composed: true, cancelable: true}
                    const charCode = code ?? key.charCodeAt(0);
                    const keyProps = {key, code: key, charCode, keyCode: charCode, which: charCode, ...props};
                    const nodes = args.length > 0 ? getNodes(path, ...args) : [document];
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

                dispatchEvent(path, type, options, cls, ...args) {
                    const nodes = getNodes(path, ...args);
                    const event_cls = window[`${cls ?? ''}Event`];
                    return nodes.map(x => {
                        const event = new event_cls(type, options);
                        return x.dispatchEvent(event);
                    });
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
        } else if (typeof value === 'object' && value.__proto__ !== Object.prototype) {
            value = JSON.parse(JSON.stringify(value));
        }
        return value;
    }
)};

function makeApi(fn, numArgs) {
    return function(...args) {
        if (args.length < numArgs + 1) {
            args.push(...Array(numArgs + 1 - args.length)); // make sure this has numArgs, even if args is originally shorter
        }
        const {tabId=0, target=null, ...rest} = args.pop() ?? {};
        return executeApi(this, fn, tabId, {target}, ...args, rest);
    }
}

export const api = {
    userAgent(tabId, opts) {
        return executeApi(this, 'userAgent', tabId, opts)
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
            return await api.dom.count(...args) > 0;
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
};

for (const [k, v] of Object.entries({
    count: 1,
    get: 2,
    shadowRootGet: 3,
    set: 3,
    call: 3,
    sendKey: 3,
    getAttributes: 1,
    getComputedStyle: 1,
    dispatchEvent: 4,
})) {
    api.dom[k] = makeApi('dom.' + k, v);
}
