#!/usr/bin/env python3

import sys
import csv
import time
import ssl
import email.utils
from types import SimpleNamespace
from functools import partial
import fcntl
import urllib.request
import urllib.error
import http.cookies
import configparser
import os
import argparse
import asyncio
import json
import logging
import base64
import ruamel.yaml

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
    # replace # before yaml parsing so that it gets treated as part of the string
    c = '\x01'
    cjson = json.dumps(c).strip('"')
    try:
        safe = data.replace('#', c)
        data = ruamel.yaml.safe_load(safe)
        data = json.dumps(data).replace(cjson, '#')
        data = json.loads(data)
    except ruamel.yaml.error.YAMLError:
        pass
    return data

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        return

class Response:
    def __init__(self, client, fn, args):
        self.client = client
        self.fn = fn
        self.args = args
        self.queue = None

    async def get_queue(self):
        self.queue = self.queue or await self.client._execute(self.fn, *self.args)
        return self.queue

    async def iter(self):
        queue = await self.get_queue()
        while item := await queue.get():
            data = item.get('data')
            if item.get('type') == 'error':
                raise Exception(data)
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

class Fetch(Response):
    def __init__(self, client, *args):
        super().__init__(client, 'fetch', args)
        self._status = None
        self._headers = None

    async def iter(self):
        async for data in super().iter():
            if isinstance(data, dict):
                if 'status' in data:
                    self._status = data['status']
                if 'headers' in data:
                    self._headers = data['headers']
            yield data

    def read_one(self):
        return anext(aiter(self.iter()))

    async def status(self):
        while self._status is None:
            await self.read_one()
        return self._status

    async def headers(self):
        while self._headers is None:
            await self.read_one()
        return self._headers

    async def read(self):
        async for data in self.iter():
            if isinstance(data, dict) and 'body' in data:
                return base64.b64decode(data['body'])
        return b''

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
        if not os.path.exists(os.path.join(path, 'qianli.sock')):
            raise ValueError('invalid profile or not running: %s' % path)
        return cls(path)

    def __init__(self, profile_dir):
        self.sock_path = profile_dir + '/qianli.sock'
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
                    if data.get('type') == 'complete':
                        await queue.put(None)
                        self.queues.pop(data.get('id'))
                    else:
                        await queue.put(data)

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

    async def fetch(self, url, method='GET', headers=(), body=b'', store_id=None, follow_redirect=False, **kwargs):
        return Fetch(self, url, {
            'method': method,
            'headers': headers,
            'body': base64.b64encode(body).decode('utf8') or None,
            'redirect': 'follow' if follow_redirect else 'manual',
            'cookieStoreId': store_id,
            **kwargs
        })

    async def fake_fetch(self, url, method='GET', headers=(), body=b'', follow_redirect=False, store_id=None):
        loop = asyncio.get_event_loop()

        cookie_list = await self.browser.cookies.getAll({'url': url, 'storeId': store_id})
        user_agent = await self.userAgent()

        opener = urllib.request.build_opener() if follow_redirect else urllib.request.build_opener(NoRedirect)
        request = urllib.request.Request(url, method=method, headers=headers, data=body)
        request.headers['user-agent'] = user_agent
        request.headers["cookie"] = '; '.join(c['name']+'='+c['value'] for c in cookie_list)
        try:
            response = await loop.run_in_executor(None, partial(opener.open, request))
        except urllib.error.HTTPError as e:
            response = e

        body = asyncio.Queue()
        fd = response.fp.fileno()
        fcntl.fcntl(fd, fcntl.F_SETFL, fcntl.fcntl(fd, fcntl.F_GETFL) | os.O_NONBLOCK)
        def callback():
            try:
                data = response.read1()
                body.put_nowait(data)
                if not data:
                    loop.remove_reader(fd)
            except ssl.SSLWantReadError:
                pass
        loop.add_reader(fd, callback)

        status = asyncio.Future()
        status.set_result(response.status)
        headers = asyncio.Future()
        headers.set_result(dict(response.headers.items()))

        for c in response.headers.get_all('set-cookie') or ():
            cookie = http.cookies.BaseCookie()
            cookie.load(c)
            attrs = list(cookie.values())[0]

            if expires := attrs.get('expires'):
                expires = email.utils.parsedate_tz(attrs.get('expires'))
                expires = expires and email.utils.mktime_tz(expires)
            elif (max_age := attrs.get('max-age')) and max_age.isdigit():
                max_age = int(max_age)
                expires = time.time() + max_age
            else:
                expires = None

            await self.browser.cookies.set({
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

        return SimpleNamespace(
            status=lambda: status,
            headers=lambda: headers,
            read=body.get,
        )

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

    @with_client
    async def _crud(client, args):
        verb = dict(create='create', list='query', get='get', update='update', delete='remove')[args.CMD]
        fn = '.'.join(('browser', args.type, verb))

        fn = {
            'browser.cookies.query': 'browser.cookies.getAll',
            'browser.cookies.get': None,
            'browser.cookies.update': None,
            'browser.cookies.remove': None,
        }.get(fn, fn)
        if fn is None:
            raise NotImplementedError(args.cmd + ' ' + args.type)

        a = []

        if hasattr(args, 'id'):
            a.append(args.id)

        if hasattr(args, 'props'):
            props = dict(x.partition('=')[::2] for x in args.props)
            props = {k: parse_maybe_json(v) for k, v in props.items()}
            a.append(props)

        if not a:
            a.append({})

        request = getattr(client, fn)(*a)
        if args.CMD == 'list':
            for x in (await request):
                print(json.dumps(x), flush=True)
        else:
            print(json.dumps(await request), flush=True)

    create = _crud
    list = _crud
    get = _crud
    update = _crud
    delete = _crud

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
            method=args.method,
            headers=headers,
            body=args.data.encode('utf8'),
            store_id=store_id,
            follow_redirect=args.location,
        )
        if args.real_proxy:
            response = await client.fetch(tabId=args.tab, **kwargs)
        else:
            response = await client.fake_fetch(**kwargs)

        status = await response.status()
        if args.verbose:
            print('< HTTP', status, file=sys.stderr)
            for k, v in (await response.headers()).items():
                print('< ', k, ': ', v, sep='', file=sys.stderr)
            print('<', file=sys.stderr)

        if not args.fail:
            while data := await response.read():
                sys.stdout.buffer.write(data)

        if (args.fail or args.fail_with_body) and status >= 400:
            print('The requested URL returned error:', status, file=sys.stderr)
            return 22

    async def http_proxy(args):
        mitm = [
            'mitmdump',
            '--listen-port', str(args.port),
            '--set', 'connection_strategy=lazy',
            '--set', 'stream_large_bodies=0',
            '--set', 'firefox_profile_dir='+args.profile,
            '--scripts', os.path.join(os.path.dirname(os.path.realpath(__file__)), 'mitm_proxy.py'),
        ]
        if args.real_proxy:
            mitm += ['--set', 'firefox_real_proxy=true']
        if args.container:
            mitm += ['--set', 'firefox_container='+args.container]
        os.execvp(mitm[0], mitm)
        raise Exception('unreachable')

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

    sub = subparsers.add_parser('curl')
    sub.add_argument('url')
    sub.add_argument('-X', '--method', '--request', default='GET')
    sub.add_argument('-H', '--header', default=[], action='append')
    sub.add_argument('-d', '--data', default='')
    sub.add_argument('-L', '--location', action='store_true')
    sub.add_argument('-v', '--verbose', action='store_true')
    sub.add_argument('--real-proxy', action='store_true')
    group = sub.add_mutually_exclusive_group()
    group.add_argument('--fail', action='store_true')
    group.add_argument('--fail-with-body', action='store_true')
    group = sub.add_mutually_exclusive_group()
    group.add_argument('-c', '--container')
    group.add_argument('-t', '--tab', type=int)

    sub = subparsers.add_parser('http-proxy')
    sub.add_argument('port', default=8080, type=int, nargs='?')
    sub.add_argument('--real-proxy', action='store_true')
    sub.add_argument('-c', '--container')

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
