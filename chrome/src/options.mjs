import { browser } from './browser.mjs';
import { customPermissions, optionalPermissions } from "./permissions.mjs"

document.addEventListener("DOMContentLoaded", async () => {

    const permissions = document.querySelector("#permissions");

    for (const perm of customPermissions) {
        permissions.innerHTML += `
            <div>
              <input type="checkbox" id="${perm}" name="${perm}" />
              <label for="${perm}">${perm}</label>
            </div>
        `;
    }

    const settings = await browser.storage.local.get({permissions: []});
    for (const checkbox of document.querySelectorAll('#permissions input[type="checkbox"]')) {
        checkbox.checked = settings.permissions.includes(checkbox.id);
    }

    // chrome doesn't have a builtin page to check optional permissions
    // so we need to make our own
    if (!!chrome) {
        const optional = document.querySelector("#optional-permissions");
        optional.style.display = '';
        const allowed = [];
        const perms = Array.from(optionalPermissions).map(perm => [perm, {permissions: [perm]}]);
        perms.push(["all_urls", {origins: ["https://*/*"]}]);

        for (const [name, perm] of perms) {
            try {
                allowed.push([name, perm, await chrome.permissions.contains(perm)]);
            } catch {
                continue
            }
            optional.innerHTML += `
                <div>
                  <input type="checkbox" id="${name}" name="${name}" />
                  <label for="${name}">${name}</label>
                </div>
            `;
        }

        for (const [name, perm, allow] of allowed) {
            let checkbox = document.querySelector(`input[name="${name}"]`)
            checkbox.checked = allow;
            checkbox.addEventListener('change', async e => {
                if (checkbox.checked) {
                    let granted = await chrome.permissions.request(perm);
                    if (!granted) {
                        checkbox.checked = false;
                    }
                } else {
                    await chrome.permissions.remove(perm);
                }
            });
        }

    }
});

document.querySelector("form").addEventListener("submit", e => {
    e.preventDefault();

    browser.storage.local.set({
        permissions: Array.from(document.querySelectorAll('#permissions input[type="checkbox"]')).filter(x => x.checked).map(x => x.id)
    }).then(() => {
        const message = document.getElementById('message');
        message.style.display = 'initial';
        setTimeout(() => {
            message.style.display = 'none';
        }, 3000);
    });
});
