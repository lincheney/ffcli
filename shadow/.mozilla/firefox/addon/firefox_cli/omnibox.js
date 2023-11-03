function score(x, y) {
    let start = 0;
    let numbreaks = 0;
    for (const c of y) {
        const ix = x.indexOf(c, start);
        if (ix == -1) {
            return -1;
        } else if (ix > start+1) {
            numbreaks += 1;
        }
        start = ix + 1;
    }
    if (start < x.length) {
        numbreaks += 1;
    }
    return numbreaks;
};

browser.omnibox.setDefaultSuggestion({description: 'Search for containers and switch to them'});

let CONTAINERS = null;
browser.omnibox.onInputStarted.addListener(async () => {
    const x = [
        {cookieStoreId: 'firefox-default', name: 'default'},
        ...(await browser.contextualIdentities.query({})),
    ];
    CONTAINERS = x;
});


function filter_containers(text) {
    let containers = CONTAINERS ?? [];
    // add score
    if (text) {
        containers = containers.map(c => [score(c.name.toLowerCase(), text), c]);
        containers = containers.filter(c => c[0] >= 0).sort();
        containers = containers.map(c => c[1]);
    }
    return containers;
}

browser.omnibox.onInputChanged.addListener((text, suggest) => {
    suggest(filter_containers(text.trim()).map(c => ({content: c.name, description: `📦 ${c.name}`})));
});

browser.omnibox.onInputEntered.addListener(async (text, disposition) => {
    const containers = filter_containers(text.trim());
    if (containers) {
        const container = containers[0];

        const tabs = await browser.tabs.query({ currentWindow: true, active: true });

        let args = {cookieStoreId: container.cookieStoreId, index: tabs[0].index};
        if(tabs[0].url !== 'about:newtab') {
            args.url = tabs[0].url;
        }

        if (disposition === 'currentTab') {
            await browser.tabs.create({...args, active: true});
            await browser.tabs.remove(tabs[0].id);
        } else if (disposition === 'newForegroundTab') {
            await browser.tabs.create({...args, active: true});
        } else {
            await browser.tabs.create(args);
        }
    }
});
