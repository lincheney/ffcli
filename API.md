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
    * `dom.check(path: string, {tabId?: number, url?: string}): bool`
        * returns `true` if matching nodes exist
        * args:
            * `path` - [css selector](https://developer.mozilla.org/en-US/docs/Web/API/Document/querySelectorAll)
            * `tabId` - use this tab, otherwise will use the current tab
            * `url` - match iff the tab has this url
    * `dom.count(path: string, {tabId?: number, url?: string}): number`
        * returns the number of matching nodes
    * `dom.wait(path: string, {timeout: number = 0, tabId?: number, url?: string}): bool`
        * returns `true` when a matching node is found, otherwise `false` if the timeout is reached
        * args:
            * `timeout` - wait at most this many milliseconds
    * `dom.get(path: string, key: string, {tabId?: number, url?: string}): unknown[]`
        * returns an array of values for the property `key` of each matching node
        * args:
            * `key` - the property to get
        * example: get the `href` of all links: `dom.get('a', 'href')`
    * `dom.set(path: string, key: string, value: any, {tabId?: number, url?: string}): bool`
        * sets the property `key` to `value` for each matching node
        * returns `true` iff matching nodes are found
        * args:
            * `key` - the property to set
            * `value` - the value to set it to
    * `dom.call(path: string, key: string, {tabId?: number, url?: string}): unknown`
        * returns an array of return values from calling `key()` on each matching node
        * args:
            * `key` - the function to call
        * example: click buttons: `dom.call('button', 'click')`
    * `dom.getAttributes(path: string, {tabId?: number, url?: string}): object[]`
        * returns an array of attributes of matching nodes
    * `dom.sendKey(path: string, key: string, {tabId?: number, url?: string})`
        * sends a `keydown` event at matching nodes
        * args:
            * `key` - the [key to send](https://developer.mozilla.org/en-US/docs/Web/API/KeyboardEvent/key)
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
