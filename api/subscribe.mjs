import { send, subscribers } from '../shared.mjs';
import { resolve_function} from './index.mjs';

export const api = {
    async subscribe(event, numEvents=null, ...args) {
        if (numEvents === null) {
            numEvents = Infinity;
        }

        const ev = await resolve_function(event, true);
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

        const listener = (...args) => {
            if (numEvents == 1) {
                api.unsubscribe.bind(this)(subscriptionId);
            }
            if (numEvents > 0) {
                numEvents -= 1;
                send(this, args);
            }
        }
        ev.addListener(listener, ...args);
        await promise;
        ev.removeListener(listener);
    },

    unsubscribe(subid) {
        const subs = subscribers[this._id];
        subs[subid](); // resolves
        delete subs[subid];
    },
}
