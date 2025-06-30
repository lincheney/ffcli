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
                    if (filter.ref && path === '' && !filter.parent) {
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

        const table = {
            userAgent() { return window.navigator.userAgent; },

            dom: {

                get(keys, ...args) {
                    const nodes = getNodes(...args);
                    const manyKeys = Array.isArray(keys);
                    if (!manyKeys) {
                        keys = [keys];
                    }

                    return nodes.map(n => {
                        const values = keys.map(k => {
                            let value = k ? n[k] : n;
                            if (typeof value === 'function') {
                                value = n[k]();
                            }
                            if (value instanceof HTMLElement) {
                                // make some refs
                                value = window.nodes.set_ref(value);
                            }
                            return value;
                        });
                        return manyKeys ? values : values[0];
                    });
                },

                count(...args) {
                    return getNodes(...args).length;
                },

                set(key, value, ...args) {
                    const nodes = getNodes(...args);
                    for (const node of nodes) {
                        node[key] = value;
                    }
                    return nodes.length;
                },

                call(key, fnArgs, ...args) {
                    const nodes = getNodes(...args);
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
                    return getNodes(...args).map(x => {
                        const result = {};
                        const style = window.getComputedStyle(x);
                        for (const prop of style) {
                            result[prop] = style[prop];
                        }
                        return result;
                    });
                },

                sendKey(key, code, ...args) {
                    const props = {bubbles: true, composed: true, cancelable: true}
                    const charCode = code ?? key.charCodeAt(0);
                    const keyProps = {key, code: key, charCode, keyCode: charCode, which: charCode, ...props};
                    const nodes = args.length > 0 ? getNodes(...args) : [document];
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

                dispatchEvent(type, options, cls, ...args) {
                    const nodes = getNodes(...args);
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
    return function(path, ...args) {
        args.push(...Array(numArgs - args.length + 1)); // make sure this has numArgs, even if args is originally shorter
        const {tabId=0, target=null, ...rest} = args.pop() ?? {};
        return executeApi(this, fn, tabId, {target}, ...args, path, rest);
    }
}

export const api = {
    userAgent(tabId) {
        return executeApi(this, 'userAgent', tabId)
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
    count: 0,
    get: 1,
    set: 2,
    call: 2,
    sendKey: 2,
    getAttributes: 0,
    getComputedStyle: 0,
    dispatchEvent: 3,
})) {
    api.dom[k] = makeApi('dom.' + k, v);
}
