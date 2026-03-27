// some permissions can't be optional, so we use storage to manage those permissions
// https://extensionworkshop.com/documentation/develop/request-the-right-permissions/#request-permissions-at-runtime
// https://searchfox.org/mozilla-central/source/toolkit/components/extensions/ExtensionPermissionMessages.sys.mjs#32

import { browser } from './browser.mjs';

const allPermissions = [
    "activeTab",
    "alarms",
    "background",
    "bookmarks",
    "browserSettings",
    "browsingData",
    "captivePortal",
    "clipboardRead",
    "clipboardWrite",
    "contentSettings",
    "contextMenus",
    "contextualIdentities",
    "cookies",
    "debugger",
    "declarativeNetRequest",
    "declarativeNetRequestFeedback",
    "declarativeNetRequestWithHostAccess",
    "devtools",
    "dns",
    "downloads",
    "downloads.open",
    "find",
    "geolocation",
    "history",
    "identity",
    "idle",
    "management",
    "menus",
    "menus.overrideContext",
    // "nativeMessaging",
    "notifications",
    "pageCapture",
    "pkcs11",
    "privacy",
    "proxy",
    "scripting",
    "search",
    "sessions",
    // "storage",
    "tabHide",
    "tabs",
    "theme",
    "topSites",
    "webNavigation",
    "webRequest",
    "webRequestBlocking",
    "webRequestFilterResponse",
    "webRequestFilterResponse.serviceWorkerScript"
];

export const optionalPermissions = new Set([
    "bookmarks",
    "browserSettings",
    "browsingData",
    "clipboardRead",
    "clipboardWrite",
    "declarativeNetRequest",
    "declarativeNetRequestFeedback",
    "devtools",
    "downloads",
    "downloads.open",
    "find",
    "geolocation",
    "history",
    "management",
    "notifications",
    "pkcs11",
    "privacy",
    "proxy",
    "sessions",
    "tabs",
    "tabHide",
    "topSites",
    "webNavigation",
]);

export const customPermissions = new Set(allPermissions.filter(p => !p.includes('.') && !optionalPermissions.has(p)));
let cachedPermissions = null;
browser.storage.local.onChanged.addListener(changes => {
    if (changes.permissions) {
        cachedPermissions = new Set(changes.permissions.newValue);
    }
});

export async function hasPermission(perm) {
    cachedPermissions ??= new Set((await browser.storage.local.get({permissions: []})).permissions);
    return cachedPermissions.has(perm);
}
