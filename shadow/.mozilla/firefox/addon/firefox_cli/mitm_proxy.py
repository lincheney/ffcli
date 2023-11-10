import asyncio
import os
import base64
from mitmproxy.http import Response
from mitmproxy.net.http import cookies
from mitmproxy import ctx
from typing import Optional

from firefox_cli import Client

sep = '-'*50

client = None
store_id = None

def done():
    if client:
        asyncio.ensure_future(client.stop())

def configure(updates):
    global client
    if 'firefox_profile_dir' in updates:
        if client:
            asyncio.ensure_future(client.stop())
        client = Client.from_profile(ctx.options.firefox_profile_dir)
    if 'firefox_container' in updates:
        store_id = None

def load(loader):
    loader.add_option(
        name="firefox_profile_dir",
        typespec=str,
        default='',
        help="Firefox profile directory",
    )
    loader.add_option(
        name="firefox_real_proxy",
        typespec=bool,
        default=False,
        help="Really proxy requests through firefox",
    )
    loader.add_option(
        name="firefox_container",
        typespec=Optional[str],
        default=None,
        help="Firefox container",
    )


async def request(flow):
    global store_id

    try:
        await client.start()

        if not store_id and ctx.options.firefox_container:
            store_id = (await client.browser.contextualIdentities.query({'name': ctx.options.firefox_container}))[0]['cookieStoreId']
        flow.metadata['firefox_real_proxy'] = ctx.options.firefox_real_proxy
        flow.metadata['firefox_store_id'] = store_id

        if ctx.options.firefox_real_proxy:
            response = client.fetch(flow.request.url, {
                'method': flow.request.method,
                'headers': dict(flow.request.headers.items()),
                'body': base64.b64encode(flow.request.content).decode('utf8') or None,
                'redirect': 'manual',
                'cookieStoreId': store_id,
            })
            body = b''
            while data := await response.read():
                body += data

            flow.response = Response.make(
                await response.status(),
                body,
                await response.headers(),
            )
        else:
            cookie_list = await client.browser.cookies.getAll({'url': flow.request.url, 'storeId': store_id})
            user_agent = await client.userAgent()
            flow.request.headers["cookie"] = '; '.join(c['name']+'='+c['value'] for c in cookie_list)
            flow.request.headers['user-agent'] = user_agent
    except:
        flow.response = Response.make(503)
        raise

async def response(flow):
    if not flow.metadata.get('firefox_real_proxy'):
        for name, (value, attrs) in flow.response.cookies.items(multi=True):
            await client.browser.cookies.set({
                'domain': attrs.get('Domain'),
                'expirationDate': cookies.get_expiration_ts(attrs),
                # 'firstPartyDomain': ...,
                'httpOnly': 'HttpOnly' in attrs,
                'name': name,
                'partitionKey': None,
                'path': attrs.get('path'),
                'sameSite': {
                    'none': 'no_restriction',
                    'lax': 'lax',
                    'strict': 'strict',
                }.get(attrs.get('sameSite', '').lower(), 'no_restriction'),
                'secure': 'secure' in attrs,
                'storeId': flow.metadata.get('firefox_store_id'),
                'url': flow.request.url,
                'value': value,
            })
