import { browser } from './browser.mjs';
import { call_function } from './api/index.mjs';
import { port, subscribers } from './shared.mjs';

browser.runtime.onMessage.addListener(port.postMessage);
// handshake
port.postMessage({});
let received_handshake = false;

port.onMessage.addListener((msg) => {
    console.log(`Received: %j`, msg);

    if (!received_handshake) {
        received_handshake = true;
        browser.storage.local.set({handshake: msg});
        return;
    }

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
        delete msg.complete;
        try {
            let value = await call_function.bind(msg)(fn, ...(args || []));
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
            msg.complete = true;
            port.postMessage(msg);
        }
    })();

});
