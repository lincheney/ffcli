# firefox-cli

firefox cli

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

## Example interacting with jq + socat

```bash
jq -nc '{id: 1, fn: "browser.windows.getAll", args: []}' | socat - unix:///path/to/unix.sock | jq
```
