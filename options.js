document.addEventListener("DOMContentLoaded", async () => {
    const settings = await browser.storage.local.get({permissions: []});
    for (const checkbox of document.querySelectorAll('input[type="checkbox"]')) {
        checkbox.checked = settings.permissions.includes(checkbox.id);
    }
});

document.querySelector("form").addEventListener("submit", e => {
    e.preventDefault();

    browser.storage.local.set({
        permissions: Array.from(document.querySelectorAll('input[type="checkbox"]')).filter(x => x.checked).map(x => x.id)
    }).then(() => {
        const message = document.getElementById('message');
        message.style.display = 'initial';
        setTimeout(() => {
            message.style.display = 'none';
        }, 3000);
    });
});
