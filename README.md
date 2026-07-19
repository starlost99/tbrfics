# the stacks — an AO3 TBR catalog

A filterable, taggable to-be-read list for fanfic. Fics get filed in automatically
when you tap "Info" on the AO3 userscript button.

## Setup

1. Create a new **public** GitHub repo (e.g. `ao3-tbr`).
2. Upload `index.html`, the `css/` folder, and the `js/` folder to the repo root.
3. Go to **Settings → Pages**, set Source to your main branch, root folder. Save.
4. GitHub gives you a URL like `https://YOUR-USERNAME.github.io/ao3-tbr/` —
   wait a minute or two for it to go live.
5. Open `ao3-copy-fic-info.user.js`, set `CONFIG.tbrSiteUrl` to that exact URL
   (keep the trailing slash), and re-save it in Stay.

## How it works

- Tapping "Info" on an AO3 work page copies the fic info to your clipboard
  (as before) *and* opens the TBR site in a new tab with the fic's title,
  url, author, and summary in the URL.
- The page reads those params on load, adds a new card, saves it to
  `localStorage`, then cleans the URL so refreshing won't re-add it.
- Everything (cards + tags) lives in your browser's local storage on that
  site, so it persists across visits — but it's per-browser/device, not
  synced across devices.
- Add your own tags per card, filter by tag, search by title/author, remove
  cards you've read.
