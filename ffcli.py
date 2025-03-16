#!/usr/bin/env python3

import sys
import csv
import re
import time
import ssl
import subprocess
import email.utils
from types import SimpleNamespace
from functools import partial
import fcntl
import urllib.request
import urllib.error
import http.cookies
import http.cookiejar
import configparser
import os
import argparse
import asyncio
import json
import logging
import socket
import base64
import warnings

class Error(Exception):
    pass

def parse_json_object(data):
    try:
        data = json.loads(data)
    except (UnicodeDecodeError, json.JSONDecodeError):
        logging.exception('failed to parse data: %r', data)
        return
    if not isinstance(data, dict):
        logging.error('expected a dict, got %s', type(data))
        return
    return data

def parse_maybe_json(data):
    try:
        import ruamel.yaml
    except ImportError:
        try:
            data = json.loads(data)
        except json.JSONDecodeError:
            pass
    else:
        # replace # before yaml parsing so that it gets treated as part of the string
        c = '\x01'
        cjson = json.dumps(c).strip('"')
        safe = data.replace('#', c)
        try:
            data = ruamel.yaml.YAML(typ='safe', pure=True).load(safe)
        except ruamel.yaml.error.YAMLError:
            pass
        else:
            data = json.dumps(data).replace(cjson, '#')
            data = json.loads(data)
    return data

def get_free_port():
    with socket.socket() as s:
        s.bind(("", 0))
        return s.getsockname()[1]

class Response:
    def __init__(self, client, fn, args):
        self.queue = None
        self.task = asyncio.create_task(client._execute(fn, *args))

    async def get_queue(self):
        self.queue = self.queue or await self.task
        return self.queue

    def get_one(self):
        return anext(aiter(self.iter()))

    async def iter(self):
        queue = await self.get_queue()
        while item := await queue.get():
            data = item.get('data')
            if item.get('type') == 'error':
                raise Error(data)
            else:
                yield data

    async def get(self):
        async for x in self.iter():
            pass
        return x

    def __await__(self):
        return self.get().__await__()

    def __aiter__(self):
        return self.iter().__aiter__()

class RequestBuilder:
    def __init__(self, client, key):
        self.client = client
        self.key = key

    def __getattr__(self, key):
        return RequestBuilder(self.client, self.key + '.' + key)

    def __call__(self, *args, **kwargs):
        if kwargs:
            args += (kwargs,)
        return Response(self.client, self.key, args)

class FetchWrapper:
    def __init__(self, stream):
        self.stream = stream
        self.request = None
        self.response = None
        self.body = []

    def get_one(self):
        return anext(aiter(self.iter()))

    async def iter(self):
        is_web_request = True
        async for data in self.stream:
            if data is None:
                continue

            type = data['type']
            data = data['data']
            if type == 'sendHeaders':
                is_web_request = True
                self.request = data
            elif type == 'headersReceived':
                self.response = data
            elif not is_web_request and type == 'response':
                self.response = data
            elif type == 'responseBody':
                if isinstance(data, str):
                    data = base64.b64decode(data)
                self.body.append(data)

            yield type, data

    async def wait_for_response(self):
        while self.response is None:
            await self.get_one()

    async def status(self):
        await self.wait_for_response()
        return self.response.get('statusCode', self.response.get('status'))
    async def headers(self):
        await self.wait_for_response()
        if 'responseHeaders' in self.response:
            return {h['name']: h['value'] for h in self.response['responseHeaders']}
        return self.response['headers']

    async def read(self):
        for x in self.body:
            yield x
        self.body.clear()
        async for data in self.iter():
            for x in self.body:
                yield x
            self.body.clear()

class Subscription(Response):
    def __init__(self, client, event, num_events=None, loop=None, **kwargs):
        super().__init__(client, 'subscribe', (event, num_events, kwargs))
        self._id = None
        self._client = client
        self._loop = loop or asyncio.get_event_loop()

    async def id(self):
        while self._id is None:
            await self.get_one()
        return self._id

    async def events(self):
        await self.id()
        async for data in self.iter():
            if data is not None:
                yield data

    async def iter(self):
        async for data in super().iter():
            if self._id is None:
                self._id = data['subscriptionId']
            yield data

    def __del__(self):
        if self._id is not None and not self._loop.is_closed():
            self._loop.call_soon(lambda client, id: asyncio.create_task(client.unsubscribe(id).get()), self._client, self._id)

class Client:
    @classmethod
    def from_profile(cls, profile):
        path = profile
        if '/' not in path and not os.path.exists(path):
            conf = configparser.ConfigParser(interpolation=None)
            conf.read(os.path.expanduser('~/.mozilla/firefox/profiles.ini'))
            for v in conf.values():
                if 'Path' in v and (v.get('Name') == path or (not path and v.get('Default') == '1')):
                    path = os.path.join(os.path.expanduser('~/.mozilla/firefox/'), v.get('Path'))
                    break
        if not os.path.exists(os.path.join(path, 'ffcli.sock')):
            raise ValueError('invalid profile or not running: %s' % path)
        return cls(path)

    def __init__(self, profile_dir):
        self.sock_path = profile_dir + '/ffcli.sock'
        self.reader = None
        self.writer = None
        self.id = 0
        self.queues = {}
        self.running = False

    async def _connect(self):
        if not self.reader or not self.writer:
            self.reader, self.writer = await asyncio.open_unix_connection(self.sock_path, limit=float('inf'))
        return self.reader, self.writer

    async def __aenter__(self):
        await self._connect()
        asyncio.ensure_future(self._read_from_socket())
        return self

    async def __aexit__(self, *args):
        if self.writer:
            self.writer.close()
            await self.writer.wait_closed()

    async def start(self):
        if not self.running:
            self.running = asyncio.Future()
            await self.__aenter__()
            self.running.set_result(True)
        await self.running

    async def stop(self):
        if self.running:
            await self.__aexit__()

    async def _read_from_socket(self):
        reader, _ = await self._connect()
        while line := await reader.readline():
            if (data := parse_json_object(line)) is not None:
                if queue := self.queues.get(data.get('id')):
                    await queue.put(data)
                    if data.get('complete'):
                        await queue.put(None)
                        self.queues.pop(data.get('id'))

    async def _execute(self, fn, *args):
        self.id += 1
        _, writer = await self._connect()
        writer.write(json.dumps({'id': self.id, 'fn': fn, 'args': args}).encode('utf8'))
        writer.write(b'\n')
        await writer.drain()
        self.queues[self.id] = asyncio.Queue()
        return self.queues[self.id]

    def __getattr__(self, key):
        return RequestBuilder(self, key)

    def subscribe(self, event, num_events=None, args=None, **kwargs):
        kwargs = {**(args or {}), **kwargs}
        return Subscription(self, event, num_events, **kwargs)

    def fetch(self, url, method='GET', headers=(), body=b'', store_id=None, **kwargs):
        return FetchWrapper(Response(self, 'fetch', (url, {
            'method': method,
            'headers': headers,
            'body': base64.b64encode(body).decode('utf8') or None,
            'cookieStoreId': store_id,
            **kwargs
        })).iter())

    async def _fake_fetch(self, url, method='GET', headers=(), body=b'', redirect='follow', store_id=None, real_ua=False):
        loop = asyncio.get_event_loop()

        cookie_list = await self.browser.cookies.getAll({'url': url, 'storeId': store_id})
        user_agent = await self.get_user_agent(real=real_ua)

        request = urllib.request.Request(url, method=method, headers=headers, data=body)
        request.headers['user-agent'] = user_agent
        if cookie_list:
            request.headers["cookie"] = '; '.join(c['name']+'='+c['value'] for c in cookie_list)


        queue = asyncio.Queue()

        def thread():
            send = partial(loop.call_soon_threadsafe, queue.put_nowait)
            set_cookies = partial(loop.call_soon_threadsafe, self.browser.cookies.set)

            class Finish(Exception): pass

            class RequestHandler(urllib.request.BaseHandler):
                handler_order = 99999 # last
                def http_request(self, req):
                    headers = {k.title(): v for k, v in req.unredirected_hdrs.items()}
                    headers.update({k.title(): v for k, v in req.headers.items() if k.title() not in headers})

                    send({
                        'type': 'sendHeaders',
                        'data': dict(
                            url=req.type + '://' + req.host + req.selector,
                            method=method,
                            requestHeaders=[{'name': k, 'value': v} for k, v in headers.items()],
                        ),
                    })
                    return req
                https_request = http_request

            class ResponseHandler(urllib.request.HTTPRedirectHandler, urllib.request.HTTPDefaultErrorHandler):
                handler_order = 0 # first
                def http_response(self, req, response):
                    send({
                        'type': 'headersReceived',
                        'data': dict(
                            statusCode=response.status,
                            responseHeaders=[{'name': k, 'value': v} for k, v in response.headers.items()],
                        ),
                    })
                    # read the body
                    while data := response.read1():
                        send({'type': 'responseBody', 'data': data})

                    for c in response.headers.get_all('set-cookie') or ():
                        cookie = http.cookies.BaseCookie()
                        cookie.load(c)
                        attrs = list(cookie.values())[0]

                        if expires := attrs.get('expires'):
                            expires = email.utils.parsedate_tz(attrs.get('expires'))
                            expires = expires and email.utils.mktime_tz(expires)
                        elif (max_age := attrs.get('max-age')) and max_age.isdigit():
                            expires = time.time() + int(max_age)

                        set_cookies({
                            'domain': attrs.get('domain'),
                            'expirationDate': expires,
                            # 'firstPartyDomain': ...,
                            'httpOnly': 'httponly' in attrs,
                            'name': attrs.key,
                            'partitionKey': None,
                            'path': attrs.get('path'),
                            'sameSite': {
                                'none': 'no_restriction',
                                'lax': 'lax',
                                'strict': 'strict',
                            }.get(attrs.get('samesite', '').lower(), 'no_restriction'),
                            'secure': 'secure' in attrs,
                            'storeId': store_id,
                            'url': url,
                            'value': attrs.value,
                        })
                    return response
                https_response = http_response

                def http_error_default(self, req, *args):
                    pass

                if redirect != 'follow':
                    def redirect_request(self, *args):
                        raise Finish

            try:
                urllib.request.build_opener(RequestHandler, ResponseHandler).open(request)
            except Finish:
                pass

        fut = asyncio.ensure_future(loop.run_in_executor(None, thread))
        fut.add_done_callback(lambda f: queue.put_nowait(None))
        while data := await queue.get():
            yield data
        await fut

    def fake_fetch(self, *args, **kwargs):
        return FetchWrapper(self._fake_fetch(*args, **kwargs))

    async def get_user_agent(self, real=False, tab=None, url='https://google.com/404'):
        close_tab = False

        if real:
            tabs = await self.browser.tabs.query(discarded=False)
            # try to find a tab that is accessible
            for tab in tabs:
                if tab['url'].startswith('http') and not re.search('mozilla.net$|firefox.com$|mozilla.org$', tab['url']):
                    tab = tab['id']
                    break

            if not tab:
                # need to temporarily make a tab
                tab = await self.browser.tabs.create({})
                close_tab = tab = tab['id']
                await self.browser.tabs.hide(tab)
                # wait for it to load
                sub = await self.subscribe('browser.tabs.onUpdated', tabId=tab, properties=['url'], num_events=1)
                await self.browser.tabs.update(tab, url=url)
                async for x in sub.events():
                    pass

        try:
            return await self.userAgent(tab)
        finally:
            if close_tab:
                await self.browser.tabs.remove(close_tab)

def with_client(fn):
    async def wrapped(args):
        async with Client.from_profile(args.profile) as client:
            return (await fn(client, args))
    return wrapped

class actions:
    @with_client
    async def do(client, args):
        async for data in getattr(client, args.fn)(*args.args).iter():
            print(json.dumps(data), flush=True)

    def status(args):
        args.fn = 'status'
        args.args = ()
        return actions.do(args)

    @with_client
    async def _crud(client, args):
        verb = dict(create='create', list='query', get='get', update='update', delete='remove')[args.CMD]
        fn = '.'.join(('browser', args.type, verb))

        fn = {
            'browser.cookies.query': 'browser.cookies.getAll',
            'browser.cookies.get': None,
            'browser.cookies.update': None,
            'browser.cookies.remove': None,
            'browser.bookmarks.query': 'browser.bookmarks.search',
            'browser.windows.query': 'browser.windows.getAll',
        }.get(fn, fn)
        if fn is None:
            raise NotImplementedError(args.cmd + ' ' + args.type)

        a = []

        if hasattr(args, 'id'):
            a.append(args.id)

        props = {}
        if hasattr(args, 'props'):
            props = dict(x.partition('=')[::2] for x in args.props)
            props = {k: parse_maybe_json(v) for k, v in props.items()}
            a.append(props)

        if not a:
            a.append({})

        request = getattr(client, fn)(*a)
        if args.CMD == 'list':
            for x in (await request):
                if all(x[k] == v for k, v in props.items()):
                    print(json.dumps(x), flush=True)
        else:
            print(json.dumps(await request), flush=True)

    create = _crud
    list = _crud
    get = _crud
    update = _crud
    delete = _crud

    @with_client
    async def user_agent(client, args, url='https://google.com/404'):
        print(await client.get_user_agent(real=args.real, tab=args.tab))

    @with_client
    async def curl(client, args):
        headers = dict(h.partition(': ')[::2] for h in args.header)
        store_id = None
        if args.container:
            store_id = (await client.browser.contextualIdentities.query({'name': args.container}))[0]['cookieStoreId']
        elif args.tab:
            store_id = (await client.browser.tabs.get(args.tab))['cookieStoreId']

        kwargs = dict(
            url=args.url,
            method=args.method or ('GET' if args.data is None else 'POST'),
            headers=headers,
            body=(args.data or '').encode('utf8'),
            store_id=store_id,
            real_ua=args.real_ua,
            redirect='follow' if args.location else 'manual',
        )
        if args.real_proxy:
            stream = client.fetch(tabId=args.tab, cache='no-store', **kwargs)
        else:
            stream = client.fake_fetch(**kwargs)

        # okk.....
        is_web_request = False
        outfile = None
        status = 0
        async for type, data in stream.iter():
            if type == 'sendHeaders':
                is_web_request = True
                if args.verbose:
                    print('>', data['method'], re.sub(r'\w+://[^/]*', '', data['url']), file=sys.stderr)
                    for h in data['requestHeaders']:
                        print('> ', h['name'], ': ', h['value'], sep='', file=sys.stderr)
                    print('>', file=sys.stderr)

            elif type == 'headersReceived':
                status = data['statusCode']
                if args.verbose:
                    print('<', data.get('statusLine', f'HTTP {data["statusCode"]}'), file=sys.stderr)
                    for h in data['responseHeaders']:
                        print('< ',h['name'], ': ', h['value'], sep='', file=sys.stderr)
                    print('<', file=sys.stderr)

            elif not is_web_request and type == 'response':
                status = data['status']
                if args.verbose:
                    print('< HTTP', data['status'], file=sys.stderr)
                    for k, v in data['headers'].items():
                        print('< ', k, ': ', v, sep='', file=sys.stderr)
                    print('<', file=sys.stderr)

            elif type == 'responseBody':
                if args.fail_with_body or not (args.fail and status >= 400):
                    if outfile is None:
                        outfile = open(args.output, 'wb') if args.output else sys.stdout.buffer
                    if isinstance(data, str):
                        data = base64.b64decode(data)
                    outfile.write(data)

        if outfile:
            outfile.close()

        if (args.fail or args.fail_with_body) and status >= 400:
            print('The requested URL returned error:', status, file=sys.stderr)
            return 22

    def _http_proxy_args(args, *mitm_args):
        mitm = [
            'mitmdump',
            '--listen-port', str(args.port),
            '--set', 'connection_strategy=lazy',
            # '--set', 'stream_large_bodies=0',
            '--set', 'firefox_profile_dir='+args.profile,
            '--scripts', os.path.join(os.path.dirname(os.path.realpath(__file__)), 'mitm_proxy.py'),
            *mitm_args,
        ]
        if args.real_proxy:
            mitm += ['--set', 'firefox_real_proxy=true']
        if args.real_ua:
            mitm += ['--set', 'firefox_real_ua=true']
        if args.container:
            mitm += ['--set', 'firefox_container='+args.container]
        for host in args.ignore_hosts or ():
            mitm += ['--ignore-hosts', host]
        for host in args.allow_hosts or ():
            mitm += ['--allow-hosts', host]
        return mitm

    async def http_proxy(args):
        mitm = actions._http_proxy_args(args)
        os.execvp(mitm[0], mitm)
        raise Exception('unreachable')

    async def with_http_proxy(args):
        args.port = args.port or get_free_port()
        mitm = actions._http_proxy_args(args, '--quiet')
        with subprocess.Popen(mitm) as proc:
            try:
                # wait to connect
                sock =  socket.socket()
                while result := sock.connect_ex(('127.0.0.1', args.port)):
                    if proc.poll() is not None:
                        print('Failed to start proxy', file=sys.stderr)
                        return proc.returncode or 1
                    time.sleep(1)
                sock.close()

                proxy = f'127.0.0.1:{args.port}'
                cert = os.path.expanduser('~/.mitmproxy/mitmproxy-ca.pem')
                env = {
                    **os.environ,
                    'http_proxy': proxy,
                    'https_proxy': proxy,
                    'HTTP_PROXY': proxy,
                    'HTTPS_PROXY': proxy,
                    'CURL_CA_BUNDLE': cert,
                    'AWS_CA_BUNDLE': cert,
                    'SSL_CERT_FILE': cert,
                }

                code = subprocess.call(args.args, env=env)
            finally:
                proc.terminate()
        return code

    @with_client
    async def screenshot(client, args):
        kwargs = {'format': args.format, 'scale': args.scale}

        if args.selector:
            root_rect = (await client.dom.call(':root', 'getBoundingClientRect'))[0]
            if args.selector == ':root':
                node_rect = root_rect
            else:
                node_rect = (await client.dom.call(args.selector, 'getBoundingClientRect'))[0]
            kwargs['rect'] = dict(
                x=node_rect['x'] - root_rect['x'],
                y=node_rect['y'] - root_rect['y'],
                width=node_rect['width'],
                height=node_rect['height'],
            )
            if kwargs['rect']['width'] * kwargs['rect']['height'] == 0:
                print(repr(args.selector), 'is not visible', file=sys.stderr)
                return 1

        data = await client.browser.tabs.captureTab(args.tab, kwargs)
        data = base64.b64decode(data.partition(',')[2])
        if os.isatty(sys.stdout.fileno()):
            proc = subprocess.run(['imv', '-'], input=data)
            return proc.returncode
        sys.stdout.buffer.write(data)

    @with_client
    async def import_cookies(client, args):
        if args.container:
            store_id = (await client.browser.contextualIdentities.query({'name': args.container}))[0]['cookieStoreId']

        cookies = http.cookiejar.MozillaCookieJar(args.file)
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            cookies.load(ignore_discard=True)

        for values in cookies._cookies.values():
            for values in values.values():
                for cookie in values.values():
                    await client.browser.cookies.set({
                        'domain': cookie.domain,
                        'expirationDate': cookie.expires,
                        # 'firstPartyDomain': ...,
                        'httpOnly': False,
                        'name': cookie.name,
                        'partitionKey': None,
                        'path': cookie.path,
                        'sameSite': 'no_restriction',
                        'secure': cookie.secure,
                        'storeId': store_id,
                        'url': f'https://{cookie.domain.lstrip(".")}{cookie.path}',
                        'value': cookie.value,
                    })

async def async_main(args):
    return await getattr(actions, args.CMD.replace('-', '_'))(args)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('-P', '--profile', default=os.environ.get('FIREFOX_PROFILE', ''))
    subparsers = parser.add_subparsers(dest='CMD', required=False)

    sub = subparsers.add_parser('do')
    sub.add_argument('fn')
    sub.add_argument('args', nargs='*', type=parse_maybe_json)

    sub = subparsers.add_parser('list')
    sub.add_argument('type')
    sub.add_argument('props', nargs='*', metavar='filter')

    sub = subparsers.add_parser('create')
    sub.add_argument('type')
    sub.add_argument('props', nargs='*')

    sub = subparsers.add_parser('get')
    sub.add_argument('type')
    sub.add_argument('id', type=parse_maybe_json)

    sub = subparsers.add_parser('update')
    sub.add_argument('type')
    sub.add_argument('id', type=parse_maybe_json)
    sub.add_argument('props', nargs='*')

    sub = subparsers.add_parser('delete')
    sub.add_argument('type')
    sub.add_argument('id', type=parse_maybe_json)

    sub = subparsers.add_parser('status')

    sub = subparsers.add_parser('user-agent')
    group = sub.add_mutually_exclusive_group()
    group.add_argument('--real', action='store_true')
    group.add_argument('--tab', type=int)

    sub = subparsers.add_parser('curl')
    sub.add_argument('url')
    sub.add_argument('-X', '--method', '--request')
    sub.add_argument('-H', '--header', default=[], action='append')
    sub.add_argument('-d', '--data')
    sub.add_argument('--data-raw', dest='data')
    sub.add_argument('-v', '--verbose', action='store_true')
    sub.add_argument('-o', '--output')
    sub.add_argument('-L', '--location', action='store_true')
    sub.add_argument('-s', '--silent', action='store_true') # not implemented
    sub.add_argument('-S', '--show-error', action='store_true') # not implemented
    sub.add_argument('--compressed', action='store_true') # not implemented
    group = sub.add_mutually_exclusive_group()
    group.add_argument('--fail', action='store_true')
    group.add_argument('--fail-with-body', action='store_true')
    sub.add_argument('--real-proxy', action='store_true')
    sub.add_argument('--real-ua', action='store_true')
    group = sub.add_mutually_exclusive_group()
    group.add_argument('-c', '--container')
    group.add_argument('-t', '--tab', type=int)

    sub = subparsers.add_parser('http-proxy')
    sub.add_argument('port', default=8080, type=int, nargs='?')
    sub.add_argument('--real-proxy', action='store_true')
    sub.add_argument('--real-ua', action='store_true')
    group = sub.add_mutually_exclusive_group()
    group.add_argument('--ignore-hosts', action='append')
    group.add_argument('--allow-hosts', action='append')
    group = sub.add_mutually_exclusive_group()
    group.add_argument('-c', '--container')

    sub = subparsers.add_parser('with-http-proxy')
    sub.add_argument('args', nargs='+')
    sub.add_argument('-p', '--port', type=int)
    sub.add_argument('--real-proxy', action='store_true')
    sub.add_argument('--real-ua', action='store_true')
    group = sub.add_mutually_exclusive_group()
    group.add_argument('--ignore-hosts', action='append')
    group.add_argument('--allow-hosts', action='append')
    group = sub.add_mutually_exclusive_group()
    group.add_argument('-c', '--container')

    sub = subparsers.add_parser('import-cookies')
    sub.add_argument('file')
    sub.add_argument('-c', '--container')

    sub = subparsers.add_parser('screenshot')
    sub.add_argument('tab', type=int, nargs='?')
    sub.add_argument('-f', '--format', choices=('jpeg', 'png'), default='png')
    sub.add_argument('--scale', type=float)
    group = sub.add_mutually_exclusive_group()
    group.add_argument('-s', '--selector', help='Screenshot just this css selector')
    group.add_argument('--full', dest='selector', action='store_const', const=':root', help='Screenshot full page')

    args = parser.parse_args()
    if not args.CMD:
        parser.print_help()
        return

    sys.exit(asyncio.run(async_main(args)))

if __name__ == '__main__':
    try:
        main()
    except (KeyboardInterrupt, BrokenPipeError):
        sys.stdout = None
