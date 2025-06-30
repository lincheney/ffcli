# API

These are the APIs available in `ffcli`.

* `status(): true`
    * returns `true`
* `browser`
    * [web extension APIs](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Browser_support_for_JavaScript_APIs)
    * the following are not supported:
        * `browser.runtime.connectNative`
        * `browser.storage.*`
* `userAgent(tabId?: number): string`
    * returns the user agent
    * args:
        * `tabId` - get the user agent from this tab instead
            * this is useful if you have another addon that modifies the user agent inside tabs
* `dom`
    * `dom.check(path: string, filter?: Object): bool`
        * returns `true` if matching nodes exist
        * args:
            * `path` - [css selector](https://developer.mozilla.org/en-US/docs/Web/API/Document/querySelectorAll)
            * `filter` - an object with these optional fields:
                * `tabId` - use this tab, otherwise will use the current tab
                * `url` - match iff the tab has this url
                * `ref` - match the node with this ref
                * `parent` - match the node with this parent ref
                * `target` - an [injection target](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/scripting/InjectionTarget), e.g. to target specific frames
    * `dom.count(path: string, filter?: Object): number`
        * returns the number of matching nodes
    * `dom.wait(path: string, {timeout: number = 0, ...filter?: Object}): bool`
        * returns `true` when a matching node is found, otherwise `false` if the timeout is reached
        * args:
            * `timeout` - wait at most this many milliseconds
    * `dom.get(path: string, keys: string? | Array<string?>, filter?: Object): unknown[]`
        * returns an array of values for the property `key` of *each* matching node
        * args:
            * `keys` - the properties to get
                * if `null`, returns the node ref which can be used later to refer to the same node
                * if the resulting property is a function, the function is called and the result is returned
                * if `keys` is an array, makes an array containing each property
        * example: get the `href` of all links: `dom.get('a', 'href')`
    * `dom.set(path: string, key: string, value: any, filter?: Object): bool`
        * sets the property `key` to `value` for each matching node
        * returns `true` iff matching nodes are found
        * args:
            * `key` - the property to set
            * `value` - the value to set it to
    * `dom.call(path: string, key: string, args: any[], filter?: Object): unknown`
        * returns an array of return values from calling `key()` on each matching node
        * args:
            * `key` - the function to call
            * `args` - arguments to the function
        * example: click buttons: `dom.call('button', 'click', [])`
    * `dom.getAttributes(path: string, filter?: Object): object[]`
        * returns an array of attributes of matching nodes
    * `dom.sendKey(path: string, key: string, code?: number, filter?: Object)`
        * sends a `keydown` event at matching nodes
        * args:
            * `key` - the [key to send](https://developer.mozilla.org/en-US/docs/Web/API/KeyboardEvent/key)
            * `code` - the key code to send, if not given is (inaccurately) computed from `key.charCodeAt(0)`
    * `dom.dispatchEvent(path: string, type: string, eventType?: string, options: object, filter?: Object): unknown`
        * calls `dispatchEvent` with an event `new Event(type, options)`
        * if `eventType` is given, then a `new ${eventType}Event` is created, e.g. to make a `MouseEvent`, pass in `Mouse`
        * example: `dom.dispatchEvent('button', 'focus', {})`
    * `dom.getComputedStyle(path: string, filter?: Object): unknown`
        * returns the result of `getComputedStyle` as an `Object`
* `subscribe(event: string, numEvents: number, ...args)`
    * *streams* events back to the client, as if from `event.addListener(...)`
        * the first message *always* contains the `subscriptionId`; this can be used to unsubscribe
        * following messages contain an array of values as received by the listener
    * args:
        * `event` - an "event" e.g. `browser.tabs.onUpdated`
        * `args` - additional arguments that are passed to `event.addListener()`. See [documentation for the event](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Browser_support_for_JavaScript_APIs).
    * example: listen to url changes: `dom.subscribe('browser.tabs.onUpdated', {tabId: 123, properties: ['url']})`
        * this will call `browser.tabs.onUpdated.addListener(LISTENER, {tabId: 123, properties: ['url'])`
        * then events streamed will look like `[tabId: number, changeInfo: object, tab: object]` (see [here](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/tabs/onUpdated#listener))
* `unsubscribe(id: string)`
    * halts a `subscribe(...)`
* `fetch(url: string, {body?: string, tabId?: number, cookieStoreId?: number, ...options})`
    * calls [fetch](https://developer.mozilla.org/en-US/docs/Web/API/fetch)
    * *streams* messages back to the client
        * the first message contains:
            * `status` - response status code
            * `headers` - response headers
            * `url` - response URL (e.g. if there was a redirect)
            * `redirected` - if the request was redirected
        * the following messages contain:
            * `body` - base64 encoded chunk of the body
    * args:
        * `url` - the url
        * `tabId` - execute the `fetch` from this tab
        * `cookieStoreId` - execute the `fetch` from a tab in this container
        * `options` - other options to [fetch](https://developer.mozilla.org/en-US/docs/Web/API/fetch#options)
            * you can use this to set the method, headers etc.
