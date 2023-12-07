# ffcli

This is a web extension to control firefox from the CLI.

This is *only* supported on firefox (not chromium etc)
and *only* on Unix (and possibly only Linux).

This web extension drops a Unix socket into your firefox profile directory.
Commands sent to that socket will be run by the web extension.
Notably, most of the commands you can run are
[web extension APIs supported in your browser](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Browser_support_for_JavaScript_APIs).

You may want to skip to look at [example usage](#example-usage).

## Installation

Prerequisites:
* firefox
* python 3

1. Download / git clone this repo
1. Create a native manifest:
    * the possible file paths are documented at https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Native_manifests#manifest_location
        * the "name" is `ffcli`
        * e.g. my one is `~/.mozilla/native-messaging-hosts/ffcli.json`
    * put the following contents in the file:
        ```json
        {
          "name": "ffcli",
          "description": "ffcli",
          "path": "/path/to/ffcli-server",
          "type": "stdio",
          "allowed_extensions": ["ffcli@lincheney"]
        }
        ```
        * replace `/path/to` with where you downloaded the repo
1. Download and install the web extension from one of the releases https://github.com/lincheney/ffcli/releases/
1. Confirm it is working:
    * run `/path/to/ffcli.py -P /path/to/firefox/profile status`
1. (Optional) install [ruamel.yaml](https://yaml.readthedocs.io/en/latest/install/)
1. (Optional) install [mitmproxy](https://docs.mitmproxy.org/stable/overview-installation/)

## Usage

You may wish to configure [permissions](#permissions) first.
Then you can interact [directly with the socket](#interacting-over-the-socket),
[using the CLI script](#using-the-cli),
or [scripting against the library](#using-the-library).

You may want to skip to look at [example usage](#example-usage).

### Using the CLI

Using the `ffcli.py` CLI is the most straightforward.

Running `./ffcli.py do COMMAND ARGS...` will send the command and arguments largely as-is to firefox.
All other CLI subcommands are higher level wrappers around possibly multiple commands.

By default, `ffcli.py` will attempt to infer your default firefox profile and connect to that.
You can select a specific firefox profile by passing either the name of the profile
or the path to the profile directory as an environment variable `FIREFOX_PROFILE=...`
or as a CLI flag `./ffcli.py --profile ...`.

You can run `./ffcli.py --help` for more usage help.

### Using the library

`ffcli.py` is also import-able as a python library.

You can use it as follows:
```python
import ffcli
async main():
    async with ffcli.Client.from_profile('default') as ff:
        tabs = await ff.browser.tabs.getAll()
```

### Interacting over the socket

You can also send commands directly to the unix socket without using the `ffcli.py` helper.

The socket receives and responds with [newline-delimited JSON](https://ndjson.org/).

Requests should be a JSON object with the keys:
* `fn`: a string indicating the command to run
* `args`: an array of arguments to the command
* `id`: (optional) an id for this request

If provided, the `id` is also set in the response.

Here is an example to list browser windows using `socat`:
```bash
echo '{"id": 1, "fn": "browser.windows.getAll", "args": []}' | socat - unix:///path/to/ffcli.sock
```

### Permissions

You may find that many commands do not work out of the box.
For example, if you attempt to list firefox containers by calling `browser.contextualIdentities.query`,
you may receive an error like `Error: no such function browser.contextualIdentities.query`.
This is you need to configure permissions to the `contextualIdentities` API first.

There are two kinds of permissions:
* firefox native permissions:
    * to manage these, go to `about:addons`, find the `ffcli` addon and go to its `Permissions` tab.
    * you will *not* be able to manage these permissions through the [permissions API](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/permissions)
* custom permissions:
    * there are a number of permissions that [could not be added as optional](https://extensionworkshop.com/documentation/develop/request-the-right-permissions/#request-permissions-at-runtime). Therefore, they are added as non-optional and `ffcli` controls their permissions instead.
    * to manage these, go to `about:addons`, find the `ffcli` addon and go to its `Preferences` tab.

Some commands do not require any permissions (e.g. `status`).

## RPC format

The format is simple.
The client sends and receives newline-delimited JSON objects.

Request objects have the following fields:
* `id` - any - id of the request
* `fn` - string - the function to call
* `args` - array - arguments to the function

The server responds with objects with the following fields:
* `id` - any - the same id as supplied in the request
* `type` - string - one of:
    * `data` - data returned from the function
    * `error` - error thrown from the function
* `data` - any - the data or error depending on the `type`
* `complete` - bool - the function call is complete

A server will respond with one *or more* responses.
The final response will have `complete` set to `true`.
This allows the server to *stream* data e.g. like a generator.

## Example Usage

* list tabs
    * by calling the web ext API: `./ffcli.py do browser.tabs.query {}`
    * using the helper: `./ffcli.py list tabs`
* getting the active tab: `./ffcli.py list tabs active=true`
* opening a tab:
    * that is empty: `./ffcli.py create tabs`
    * at a given url: `./ffcli.py create tabs url=https://google.com`
* listing containers: `./ffcli.py list contextualIdentities`
* creating a container: `./ffcli.py create contextualIdentities icon=fingerprint color=blue name=test`
* get all cookies in a container: `./ffcli.py do browser.cookies.getAll 'storeId: firefox-container-NNN'`
* take a screenshot
    * of the current viewport: `./ffcli.py screenshot`
    * of the entire page: `./ffcli.py screenshot --full`
    * of a specific tab: `./ffcli.py screenshot 123`
        * see tab ids first by running `./ffcli.py list tabs`
* subscribe to tab events: `./ffcli.py do subscribe browser.tabs.onUpdated`
* get the user agent: `./ffcli.py user-agent`
* make http requests using cookies and user agent from firefox
    * from `ffcli.py`: `./ffcli.py curl https://httpbin.org/anything -v`
    * from within the browser itself: `./ffcli.py curl https://httpbin.org/anything -v --real-proxy`
    * using cookies from a container: `./ffcli.py curl https://httpbin.org/anything -v --container XYZ`
    * by running under a mitmproxy: `./ffcli.py with-http-proxy -- curl https://httpbin.org/anything -v`
