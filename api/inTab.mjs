import { executeInTab } from './index.mjs';

export async function executeApi(msg, fn, tabId, ...args) {
    return executeInTab(tabId, [msg, tabId, fn, args], async (msg, tabId, fn, args) => {

        function getNodes(path, filter) {
            try {
                filter = filter ?? {};
                if (!filter.url || window.location.href === filter.url) {
                    return Array.from(document.querySelectorAll(path));
                }
                return [];
            } catch(e) {
                throw new Error(e)
            }
        }

        const table = {
            userAgent() { return window.navigator.userAgent; },

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
                    const props = {bubbles: true, composed: true, cancelable: true}
                    const keyProps = {key, code: key, charCode: key.charCodeAt(0), keyCode: key.charCodeAt(0), which: key.charCodeAt(0), ...props};
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
        const {tabId=0, ...rest} = args.pop() ?? {};
        args.push(...Array(numArgs - args.length)); // make sure this has numArgs, even if args is originally shorter
        return executeApi(this, fn, tabId, ...args, path, rest);
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
    call: 1,
    sendKey: 1,
})) {
    api.dom[k] = makeApi('dom.' + k, v);
}
