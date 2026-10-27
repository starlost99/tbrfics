(function () {
  'use strict';

  // Point this at your deployed Cloudflare Worker (see worker.js) to enable
  // one-tap refreshing. Leave blank and the refresh button just opens the
  // fic on AO3 instead, so you can re-tap "Info" there.
  const CONFIG = {
    refreshApiUrl: '', // e.g. 'https://tbr-refresh.YOUR-NAME.workers.dev'
  };

  const STORE_KEY = 'tbr-stacks-v1';
  const SHELVES_STORE_KEY = 'tbr-stacks-shelves-v1';
  const SHELF_COLORS_STORE_KEY = 'tbr-stacks-shelf-colors-v1';
  let entries = loadEntries();
  let shelves = loadShelves(); // array of shelf names, in creation order — a fic lives on at most one
  let shelfColors = loadShelfColors(); // { shelfName: paletteKey } — only set when the person picks one explicitly

  // ---- Filter state ----
  let activeTags = new Set();      // your own custom tags — OR match
  let activeRatings = new Set();   // AO3 rating — OR match
  let statusFilter = 'all';        // 'all' | 'complete' | 'wip'
  let starFilter = 0;              // 0 = no filter, else "at least N stars"
  let ratedFilter = 'all';         // 'all' | 'rated' | 'unrated'
  let wordMin = null;
  let wordMax = null;
  let activeAoTags = new Set();    // fandom/relationship/character/freeform — AND match
  let aoTagQuery = '';
  let sortBy = 'dateAdded-desc';   // shared between Catalog and Shelves
  let pinnedId = null;             // fic re-filed via "Info" — shown first until search/sort/filters change

  // ---- View state ----
  let view = 'catalog';   // 'catalog' | 'shelves'
  let towerShelf = null;   // null = whole tower; 'unshelved' | shelf name = that shelf's close-up
  let shelvesMode = 'rail'; // 'rail' (original bookshelf) | 'tower' (Booktower-style stacked shelves)
  let activeShelf = null; // 'unshelved' | a shelf name | null (nothing pulled down yet)
  const SHELF_VIEW_KEY = 'tbr-stacks-shelf-view-v1';
  let shelfView = (() => { try { return localStorage.getItem(SHELF_VIEW_KEY) === 'cards' ? 'cards' : 'list'; } catch (e) { return 'list'; } })(); // 'list' (compact rows) | 'cards' (full cards)
  let expandedRows = new Set(); // entry ids currently expanded to show full card details in the Shelves view
  let colorPickerOpen = false;  // whether the swatch picker is open for the active shelf

  function loadEntries() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      parsed.forEach(migrateShelfField);
      return parsed;
    } catch (e) {
      return [];
    }
  }

  // Searchable text per card, built once and reused on every keystroke.
  // Dropped whenever the data is saved, so edits are always picked up.
  let haystackCache = new WeakMap();

  // ---- Cloud sync hooks (see sync.js) ----
  const DIRTY_KEY = 'tbr-stacks-dirty';
  const SYNC_USER_KEY = 'tbr-stacks-sync-user';
  function snapshot() { return { entries, shelves, shelfColors }; }
  function markDirty() {
    localStorage.setItem(DIRTY_KEY, '1');
    if (window.StacksCloud) window.StacksCloud.queuePush(snapshot);
  }

  function saveEntries() {
    haystackCache = new WeakMap();
    localStorage.setItem(STORE_KEY, JSON.stringify(entries));
    markDirty();
  }

  function loadShelves() {
    try {
      const raw = localStorage.getItem(SHELVES_STORE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      return [];
    }
  }

  function saveShelves() {
    localStorage.setItem(SHELVES_STORE_KEY, JSON.stringify(shelves));
    markDirty();
  }

  function loadShelfColors() {
    try {
      const raw = localStorage.getItem(SHELF_COLORS_STORE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (e) {
      return {};
    }
  }

  function saveShelfColors() {
    localStorage.setItem(SHELF_COLORS_STORE_KEY, JSON.stringify(shelfColors));
    markDirty();
  }

  // A fic can now live on any number of shelves — [] means unshelved.
  // Older cards used a single `shelf` string; migrateShelfField upgrades
  // those in place the first time they're loaded or imported.
  function entryShelves(entry) {
    return entry.shelves || [];
  }

  function migrateShelfField(entry) {
    if (!Array.isArray(entry.shelves)) {
      entry.shelves = entry.shelf ? [entry.shelf] : [];
    }
    delete entry.shelf;
    return entry;
  }

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function splitParam(params, key) {
    const raw = params.get(key);
    return raw ? raw.split(',').map(t => t.trim()).filter(Boolean) : [];
  }

  // ---- Pick up new fic from URL params (from the AO3 "Info" button) ----
  // Same rule as the userscript: one address per AO3 work, whichever page
  // (chapter, ?view_adult, #comments…) it was filed from.
  function normalizeWorkUrl(href) {
    if (!href) return '';
    const m = href.match(/^https?:\/\/(?:www\.)?archiveofourown\.(?:org|com|net)\/works\/(\d+)/);
    return m ? 'https://archiveofourown.org/works/' + m[1] : href;
  }

  function ingestFromURL() {
    const params = new URLSearchParams(window.location.search);
    const title = params.get('title');
    if (!title) return;

    const url = normalizeWorkUrl(params.get('url') || '');
    const authors = params.get('authors') || 'Anonymous';
    const summary = params.get('summary') || '';
    const tagsParam = params.get('tags');
    const tags = tagsParam ? tagsParam.split(',').map(t => t.trim()).filter(Boolean) : [];

    // Structured AO3 metadata (added in userscript v1.1)
    const rating = splitParam(params, 'rating');
    const warnings = splitParam(params, 'warnings');
    const category = splitParam(params, 'category');
    const fandoms = splitParam(params, 'fandoms');
    const relationships = splitParam(params, 'relationships');
    const characters = splitParam(params, 'characters');
    const freeform = splitParam(params, 'freeform');
    const wordsParam = params.get('words');
    const words = wordsParam ? parseInt(wordsParam, 10) : null;
    const kudosParam = params.get('kudos');
    const kudos = kudosParam ? parseInt(kudosParam, 10) : null;
    const chapters = params.get('chapters') || '';
    const completeParam = params.get('complete');
    const complete = completeParam === '1' ? true : completeParam === '0' ? false : null;

    // Date uploaded (one-shots) / date the last chapter was posted (chaptered
    // fics) — AO3's "Published:" and "Updated:"/"Completed:" rows, as plain
    // YYYY-MM-DD strings.
    const published = params.get('published') || '';
    const updated = params.get('updated') || '';

    // Legacy fallback: older userscript versions sent one flat aoTags list
    const aoTagsParam = params.get('aoTags');
    const aoTags = aoTagsParam ? aoTagsParam.split(',').map(t => t.trim()).filter(Boolean) : [];

    const dupe = url && entries.find(e => normalizeWorkUrl(e.url) === url);
    if (!dupe) {
      entries.unshift({
        id: uid(),
        title,
        url,
        authors,
        summary,
        tags,
        notes: '',
        shelves: [],
        stars: null,
        rating,
        warnings,
        category,
        fandoms,
        relationships,
        characters,
        freeform,
        words,
        kudos,
        chapters,
        complete,
        published,
        updated,
        aoTags, // kept for any entries filed under the old userscript
        dateAdded: new Date().toISOString(),
      });
      saveEntries();
    } else {
      // Fic's already on file — re-tapping "Info" on AO3 means the person
      // wants the latest chapters/word count/etc. Refresh AO3-sourced
      // fields only; leave their own tags, notes, stars, and shelf alone.
      const prevChapters = dupe.chapters;
      pinnedId = dupe.id;
      Object.assign(dupe, {
        url, title, authors, summary,
        rating, warnings, category,
        fandoms, relationships, characters, freeform,
        words, kudos, chapters, complete,
        published, updated,
      });
      saveEntries();
      pendingToast = chapters && chapters !== prevChapters
        ? `Updated "${title}" — now ${chapters} chapters`
        : `Refreshed "${title}"`;
    }

    // Clean the URL so refreshing doesn't re-add / re-run the query
    const cleanUrl = window.location.origin + window.location.pathname;
    window.history.replaceState({}, '', cleanUrl);
  }

  // ---- Toast ----
  let pendingToast = null;
  let toastEl = null;
  function showToast(message) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'toast';
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = message;
    requestAnimationFrame(() => toastEl.classList.add('visible'));
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => toastEl.classList.remove('visible'), 2400);
  }

  // ---- Rendering ----
  const grid = document.getElementById('cardGrid');
  const template = document.getElementById('cardTemplate');
  const emptyState = document.getElementById('emptyState');
  const upNextSection = document.getElementById('upNextSection');
  const upNextGrid = document.getElementById('upNextGrid');
  const upNextCount = document.getElementById('upNextCount');
  const upNextHint = document.getElementById('upNextHint');
  const upNextDetails = document.getElementById('upNextDetails');
  try { upNextDetails.open = localStorage.getItem('tbr-stacks-upnext-open') === '1'; } catch (e) {}
  upNextDetails.addEventListener('toggle', () => {
    try { localStorage.setItem('tbr-stacks-upnext-open', upNextDetails.open ? '1' : '0'); } catch (e) {}
  });
  const entryCount = document.getElementById('entryCount');
  const tagRail = document.getElementById('tagRail');
  const searchInput = document.getElementById('searchInput');
  const ratingRail = document.getElementById('ratingRail');
  const statusRail = document.getElementById('statusRail');
  const starRail = document.getElementById('starRail');
  const wordMinInput = document.getElementById('wordMinInput');
  const wordMaxInput = document.getElementById('wordMaxInput');
  const sortSelect = document.getElementById('sortSelect');
  const aoTagSearch = document.getElementById('aoTagSearch');
  const aoTagRail = document.getElementById('aoTagRail');
  const filterCount = document.getElementById('filterCount');
  const clearFiltersBtn = document.getElementById('clearFiltersBtn');
  const filterPanel = document.getElementById('filterPanel');
  const viewTabs = document.querySelectorAll('.view-tab');
  const controlsCollapse = document.getElementById('controlsCollapse');
  const catalogView = document.getElementById('catalogView');
  const shelvesView = document.getElementById('shelvesView');
  const bookshelfRail = document.getElementById('bookshelfRail');
  const shelfContents = document.getElementById('shelfContents');
  const libraryView = document.getElementById('libraryView');
  const libraryGrid = document.getElementById('libraryGrid');
  const libraryEmptyState = document.getElementById('libraryEmptyState');
  const bookInfoDialog = document.getElementById('bookInfoDialog');
  const bookInfoContent = document.getElementById('bookInfoContent');
  document.getElementById('closeBookInfo').addEventListener('click', () => bookInfoDialog.close());
  bookInfoDialog.addEventListener('click', (e) => {
    if (e.target === bookInfoDialog) bookInfoDialog.close(); // click on backdrop
  });

  // Cover gradients — fixed pastel hex pairs rather than the app's CSS vars,
  // since covers should keep their own cute identity regardless of
  // light/dark mode. Text sits directly on top in --ink, since these are
  // light enough for that to stay legible without a scrim.
  const COVER_PALETTE = [
    ['#FBD9E4', '#F5C2D6'], // pink
    ['#FDE2CE', '#FAD0B0'], // peach
    ['#FBEFC6', '#F6E2A0'], // butter
    ['#D8F0E0', '#BFE6CE'], // mint
    ['#D9EAF7', '#BFDCF0'], // sky
    ['#E6DFF7', '#D6C9F0'], // lavender
    ['#F0DFF2', '#E3C9EA'], // lilac
    ['#E3EFD9', '#CFE3C0'], // sage
    ['#F7D9DE', '#F0C2CB'], // rose
    ['#FBE3E9', '#F5CBD8'], // blush
    ['#FBF3E4', '#F5E7CB'], // cream
    ['#E1E4F7', '#CBD0F0'], // periwinkle
  ];

  function coverGradientFor(entry) {
    const [from, to] = COVER_PALETTE[hashString(entry.id || entry.title || '') % COVER_PALETTE.length];
    return `linear-gradient(155deg, ${from}, ${to})`;
  }

  const SPINE_PALETTE = [
    { key: 'rose', label: 'Rose', color: 'var(--rose-deep)' },
    { key: 'blush', label: 'Blush', color: '#E39CB2' },
    { key: 'coral', label: 'Coral', color: 'var(--coral)' },
    { key: 'peach', label: 'Peach', color: '#E8956B' },
    { key: 'gold', label: 'Gold', color: 'var(--gold)' },
    { key: 'sage', label: 'Sage', color: '#6E9B6E' },
    { key: 'mint', label: 'Mint', color: '#6FB89A' },
    { key: 'sky', label: 'Sky', color: '#5C8DBF' },
    { key: 'lavender', label: 'Lavender', color: '#9B87C4' },
    { key: 'plum', label: 'Plum', color: '#8C5E83' },
    { key: 'ink', label: 'Ink', color: 'var(--ink)' },
  ];

  function paletteColor(key) {
    const found = SPINE_PALETTE.find(p => p.key === key);
    return found ? found.color : null;
  }

  // Explicit user picks take priority; otherwise fall back to a stable
  // hash-based pick so untouched shelves still look varied.
  function spineColorForShelf(name) {
    const explicit = paletteColor(shelfColors[name]);
    if (explicit) return explicit;
    return SPINE_PALETTE[hashString(name) % SPINE_PALETTE.length].color;
  }

  function hashString(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
    return h;
  }

  function allTags() {
    const set = new Set();
    entries.forEach(e => (e.tags || []).forEach(t => set.add(t)));
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }

  function entryAoTags(entry) {
    return [].concat(
      entry.fandoms || [], entry.relationships || [], entry.characters || [], entry.freeform || [],
      entry.aoTags || [] // legacy flat list, kept matchable so old cards stay filterable
    );
  }

  // Clicking any tag on a card: clear other filters and search for just that tag
  function filterByTag(kind, tag) {
    activeTags.clear();
    activeRatings.clear();
    activeAoTags.clear();
    statusFilter = 'all';
    starFilter = 0;
    ratedFilter = 'all';
    wordMin = null;
    wordMax = null;
    wordMinInput.value = '';
    wordMaxInput.value = '';
    aoTagQuery = '';
    aoTagSearch.value = '';
    searchInput.value = '';

    if (kind === 'custom') {
      activeTags.add(tag);
      document.getElementById('myTagsPanel').open = true; // keep the active tag visible
    } else {
      activeAoTags.add(tag);
      filterPanel.open = true; // AO3 tags live inside the collapsible panel — open it so the match is visible
    }

    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function allAoTags() {
    const set = new Set();
    entries.forEach(e => entryAoTags(e).forEach(t => set.add(t)));
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }

  function allRatings() {
    const set = new Set();
    entries.forEach(e => {
      const r = e.rating && e.rating[0];
      if (r) set.add(r);
    });
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }

  function renderTagDatalist() {
    const list = document.getElementById('tagList');
    list.innerHTML = '';
    allTags().forEach(tag => {
      const opt = document.createElement('option');
      opt.value = tag;
      list.appendChild(opt);
    });
  }

  function renderTagRail() {
    tagRail.innerHTML = '';
    allTags().forEach(tag => {
      const chip = document.createElement('button');
      chip.className = 'tag-chip' + (activeTags.has(tag) ? ' active' : '');
      chip.textContent = tag;
      chip.addEventListener('click', () => {
        activeTags.has(tag) ? activeTags.delete(tag) : activeTags.add(tag);
        render();
      });
      tagRail.appendChild(chip);
    });
  }

  function renderRatingRail() {
    ratingRail.innerHTML = '';
    allRatings().forEach(rating => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'tag-chip' + (activeRatings.has(rating) ? ' active' : '');
      chip.textContent = rating;
      chip.addEventListener('click', () => {
        activeRatings.has(rating) ? activeRatings.delete(rating) : activeRatings.add(rating);
        render();
      });
      ratingRail.appendChild(chip);
    });
    if (allRatings().length === 0) {
      ratingRail.innerHTML = '<p class="filter-empty">no rated fics filed yet</p>';
    }
  }

  function renderStatusRail() {
    statusRail.innerHTML = '';
    [['all', 'All'], ['complete', 'Complete'], ['wip', 'WIP']].forEach(([value, label]) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'tag-chip' + (statusFilter === value ? ' active' : '');
      chip.textContent = label;
      chip.addEventListener('click', () => {
        statusFilter = value;
        render();
      });
      statusRail.appendChild(chip);
    });
  }

  function renderRatedToggle() {
    const el = document.getElementById('ratedToggle');
    el.innerHTML = '';
    [['all', 'All'], ['rated', 'Rated'], ['unrated', 'Unrated']].forEach(([value, label]) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tag-chip' + (ratedFilter === value ? ' active' : '');
      btn.textContent = label;
      btn.addEventListener('click', () => {
        ratedFilter = value;
        render();
      });
      el.appendChild(btn);
    });
  }

  function renderStarFilterRail() {
    starRail.innerHTML = '';
    [1, 2, 3, 4, 5].forEach(n => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'tag-chip' + (starFilter === n ? ' active' : '');
      chip.textContent = '★'.repeat(n) + '+';
      chip.title = `${n} star${n === 1 ? '' : 's'} and up`;
      chip.addEventListener('click', () => {
        starFilter = starFilter === n ? 0 : n;
        render();
      });
      starRail.appendChild(chip);
    });
  }

  function renderAoTagRail() {
    aoTagRail.innerHTML = '';
    const query = aoTagQuery.trim().toLowerCase();
    const candidates = allAoTags().filter(t =>
      activeAoTags.has(t) || !query || t.toLowerCase().includes(query)
    );
    // Always show active tags; cap the rest so the list stays scannable
    const shown = candidates.slice(0, 40);
    shown.forEach(tag => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'tag-chip' + (activeAoTags.has(tag) ? ' active' : '');
      chip.textContent = tag;
      chip.addEventListener('click', () => {
        activeAoTags.has(tag) ? activeAoTags.delete(tag) : activeAoTags.add(tag);
        render();
      });
      aoTagRail.appendChild(chip);
    });
    if (shown.length === 0) {
      aoTagRail.innerHTML = '<p class="filter-empty">no matching tags</p>';
    } else if (candidates.length > shown.length) {
      const more = document.createElement('p');
      more.className = 'filter-empty';
      more.textContent = `+${candidates.length - shown.length} more — keep typing to narrow down`;
      aoTagRail.appendChild(more);
    }
  }

  function activeFilterCount() {
    return activeTags.size + activeRatings.size + activeAoTags.size +
      (statusFilter !== 'all' ? 1 : 0) +
      (starFilter > 0 ? 1 : 0) +
      (ratedFilter !== 'all' ? 1 : 0) +
      (wordMin !== null ? 1 : 0) +
      (wordMax !== null ? 1 : 0);
  }

  function renderFilterCount() {
    const n = activeFilterCount();
    filterCount.hidden = n === 0;
    filterCount.textContent = n === 0 ? '' : String(n);
  }

  function matchesFilters(entry, query) {
    if (activeTags.size > 0 && !(entry.tags || []).some(t => activeTags.has(t))) return false;

    if (activeRatings.size > 0) {
      const r = (entry.rating && entry.rating[0]) || '';
      if (!activeRatings.has(r)) return false;
    }

    if (statusFilter === 'complete' && entry.complete !== true) return false;
    if (statusFilter === 'wip' && entry.complete !== false) return false;

    if (starFilter > 0 && (entry.stars || 0) < starFilter) return false;
    if (ratedFilter === 'rated' && !entry.stars) return false;
    if (ratedFilter === 'unrated' && entry.stars) return false;

    if (wordMin !== null && (entry.words === null || entry.words === undefined || entry.words < wordMin)) return false;
    if (wordMax !== null && (entry.words === null || entry.words === undefined || entry.words > wordMax)) return false;

    if (activeAoTags.size > 0) {
      const tags = entryAoTags(entry);
      const hasAll = Array.from(activeAoTags).every(t => tags.includes(t));
      if (!hasAll) return false;
    }

    if (!query) return true;
    let haystack = haystackCache.get(entry);
    if (haystack === undefined) {
      haystack = [
        entry.title, entry.authors, entry.summary, entry.notes,
        ...(entry.tags || []), ...entryAoTags(entry),
      ].join(' ').toLowerCase();
      haystackCache.set(entry, haystack);
    }
    return haystack.includes(query);
  }

  // Sorts a copy of the given list according to the current sortBy value.
  // Shared by both the Catalog grid and the Shelves row list so switching
  // the sort order stays consistent across views.
  function sortEntries(list) {
    const sorted = list.slice();
    switch (sortBy) {
      case 'dateAdded-asc':
        sorted.sort((a, b) => new Date(a.dateAdded || 0) - new Date(b.dateAdded || 0));
        break;
      case 'title-asc':
        sorted.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
        break;
      case 'title-desc':
        sorted.sort((a, b) => (b.title || '').localeCompare(a.title || ''));
        break;
      case 'words-desc':
        sorted.sort((a, b) => (b.words ?? -1) - (a.words ?? -1));
        break;
      case 'words-asc':
        sorted.sort((a, b) => (a.words ?? Infinity) - (b.words ?? Infinity));
        break;
      case 'kudos-desc':
        sorted.sort((a, b) => (b.kudos ?? -1) - (a.kudos ?? -1));
        break;
      case 'stars-desc':
        sorted.sort((a, b) => (b.stars || 0) - (a.stars || 0));
        break;
      case 'published-desc':
        sorted.sort((a, b) => new Date(b.published || 0) - new Date(a.published || 0));
        break;
      case 'published-asc':
        sorted.sort((a, b) => new Date(a.published || 0) - new Date(b.published || 0));
        break;
      case 'dateAdded-desc':
      default:
        sorted.sort((a, b) => new Date(b.dateAdded || 0) - new Date(a.dateAdded || 0));
        break;
    }
    return pinFirst(sorted);
  }

  // Puts the just-refreshed fic at the very top, whatever the sort order.
  function pinFirst(list) {
    if (!pinnedId) return list;
    const i = list.findIndex(e => e.id === pinnedId);
    if (i <= 0) return list;
    const copy = list.slice();
    copy.unshift(copy.splice(i, 1)[0]);
    return copy;
  }

  function extractOrSection(summary) {
    const match = summary.match(/\bor[:,\-–—]\s*/i);
    if (!match) return summary;
    return summary.slice(match.index).trim();
  }

  function formatDate(iso) {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  // AO3's Published/Updated/Completed dates come through as plain
  // "YYYY-MM-DD" strings. Parsing those directly with `new Date()` treats
  // them as UTC midnight, which can shift the displayed day backward in
  // negative-UTC-offset timezones — so parse the parts as a local date instead.
  function formatSimpleDate(dateStr) {
    if (!dateStr) return '';
    const [y, m, d] = dateStr.split('-').map(Number);
    if (!y || !m || !d) return '';
    return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function formatWords(n) {
    if (n === null || n === undefined || isNaN(n)) return '';
    return n.toLocaleString() + (n === 1 ? ' word' : ' words');
  }

  // Reading time at 215 wpm — a commonly cited average adult silent
  // reading speed, used elsewhere for this kind of estimate.
  const READING_WPM = 215;
  function formatReadTime(words) {
    if (!words) return '';
    const minutes = Math.max(1, Math.round(words / READING_WPM));
    if (minutes < 60) return minutes === 1 ? '1 min read' : `${minutes} min read`;
    const hours = Math.floor(minutes / 60);
    const rem = minutes % 60;
    return rem === 0 ? `${hours}h read` : `${hours}h ${rem}m read`;
  }

  function formatCount(n) {
    if (n === null || n === undefined || isNaN(n)) return '';
    return n.toLocaleString();
  }

  // Normalizes an AO3 rating string to a short CSS-friendly class suffix
  function ratingClass(rating) {
    const r = rating.toLowerCase();
    if (r.includes('general')) return 'general';
    if (r.includes('teen')) return 'teen';
    if (r.includes('mature')) return 'mature';
    if (r.includes('explicit')) return 'explicit';
    return 'notrated';
  }

  function render() {
    const query = searchInput.value.trim().toLowerCase();
    const visible = sortEntries(entries.filter(e => matchesFilters(e, query)));

    // "Up next" fics live in their own section above the grid, whatever the
    // filters/search say, and are left out of the main grid so they don't repeat.
    const queue = upNextList();
    const queued = new Set(queue.map(e => e.id));
    upNextGrid.innerHTML = '';
    queue.forEach(entry => upNextGrid.appendChild(buildCard(entry)));
    upNextSection.hidden = entries.length === 0;
    upNextCount.textContent = queue.length ? `${queue.length} / ${UP_NEXT_MAX}` : '';
    upNextHint.hidden = queue.length > 0;

    grid.innerHTML = '';
    visible.filter(e => !queued.has(e.id)).forEach(entry => grid.appendChild(buildCard(entry)));

    if (typeof populateSurpriseTags === 'function') populateSurpriseTags();
    emptyState.hidden = entries.length !== 0;
    entryCount.textContent = visible.length === entries.length
      ? `${entries.length} card${entries.length === 1 ? '' : 's'} on file`
      : `${visible.length} of ${entries.length} cards`;

    renderTagRail();
    renderTagDatalist();
    renderRatingRail();
    renderStatusRail();
    renderStarFilterRail();
    renderRatedToggle();
    renderAoTagRail();
    renderFilterCount();

    renderBookshelf();
    if (view === 'shelves') renderShelfContents();
    renderTower();
    renderLibrary();
  }

  // ---- Tower (step 1: read-only) ----
  // Every shelf is a plank; every fic on it is a little book spine coloured
  // by its AO3 rating and sized by word count. Tapping a spine opens the card.
  const TOWER_RATINGS = [
    ['general', 'General'], ['teen', 'Teen'], ['mature', 'Mature'],
    ['explicit', 'Explicit'], ['notrated', 'Not rated'],
  ];

  function spineHeightForWords(words) {
    const w = Number(words) || 0;
    if (!w) return 40;
    // 34px for a short one-shot up to 56px for a doorstop, log-scaled
    const t = Math.min(1, Math.max(0, (Math.log10(w) - 3) / 3));
    return Math.round(34 + t * 22);
  }

  // Titles on the tower books: tiny vertical lettering. Height follows the title
  // (long ones wrap onto up to 3 lines and, past that, end in an ellipsis — the full
  // title is on tap / hover). Thickness still follows word count.
  const towerMeasure = document.createElement('canvas').getContext('2d');
  const TOWER_FONT = 8, TOWER_ROW_H = 90, TOWER_INNER = 76;
  function towerBookFit(title, words) {
    towerMeasure.font = `600 ${TOWER_FONT}px Fraunces, Georgia, serif`;
    const w = Math.ceil(towerMeasure.measureText(title).width * 1.06) + 2;
    const room = TOWER_INNER - 8;                         // slack so words can break
    const lines = Math.min(3, Math.max(1, Math.ceil(w / room)));
    let text = title;
    if (w > lines * room) text = title.slice(0, Math.max(3, Math.floor(title.length * lines * room / w) - 1)).trim() + '…';
    const h = lines === 1 ? Math.min(TOWER_ROW_H - 2, Math.max(40, w + 14)) : TOWER_ROW_H - 2;
    const n = Number(words) || 0;
    const t = n ? Math.min(1, Math.max(0, (Math.log10(n) - 3) / 3)) : 0.3;
    const width = Math.round(Math.max(14 + t * 8, lines * 9.3 + 8));
    return { text, lines, h, width };
  }

  function buildTowerFloor(label, members, color, shelfKey) {
    const floor = document.createElement('section');
    floor.className = 'tower-floor';
    if (color) floor.style.setProperty('--shelf-color', color);

    const room = document.createElement('div');
    room.className = 'tower-room';

    const plate = document.createElement('div');
    plate.className = 'tower-plate';
    const name = document.createElement('span');
    name.className = 'tower-plate-name';
    name.textContent = label;
    const count = document.createElement('span');
    count.className = 'tower-plate-count';
    count.textContent = `${members.length} book${members.length === 1 ? '' : 's'}`;
    plate.appendChild(name);
    plate.appendChild(count);
    room.appendChild(plate);

    const caseEl = document.createElement('div');
    caseEl.className = 'tower-case';
    const books = document.createElement('div');
    books.className = 'tower-books';
    members.forEach(entry => {
      const rating = (entry.rating && entry.rating[0]) || '';
      const book = document.createElement('button');
      book.type = 'button';
      book.className = 'tower-book';
      book.title = entry.title || 'Untitled';
      book.setAttribute('aria-label', entry.title || 'Untitled');
      const body = document.createElement('span');
      body.className = `tower-book-body tower-book-${ratingClass(rating)}`;
      const fit = towerBookFit(entry.title || 'Untitled', entry.words);
      body.style.height = fit.h + 'px';
      book.style.width = fit.width + 'px';
      const lab = document.createElement('span');
      lab.className = 'tower-book-label' + (fit.lines > 1 ? ' wrap' : '');
      lab.textContent = fit.text;
      if (fit.lines > 1) lab.style.maxHeight = (fit.h - 8) + 'px';
      body.appendChild(lab);
      book.appendChild(body);
      book.addEventListener('click', () => openBookInfo(entry));
      books.appendChild(book);
    });
    caseEl.appendChild(books);
    room.appendChild(caseEl);
    floor.appendChild(room);
    room.classList.add('tower-room-open');
    room.title = `Open ${label}`;
    room.addEventListener('click', (e) => {
      if (e.target.closest('.tower-book')) return; // spines open the card instead
      towerShelf = shelfKey;
      renderTower();
      window.scrollTo({ top: 0 });
    });
    return floor;
  }

  function renderTower() {
    const tower = document.getElementById('tower');
    const legend = document.getElementById('towerLegend');
    if (!tower || !legend) return;
    tower.innerHTML = '';
    legend.innerHTML = '';

    const query = searchInput.value.trim().toLowerCase();
    const shown = sortEntries(entries.filter(e => matchesFilters(e, query)));

    // A shelf that was renamed/deleted can't stay open
    if (towerShelf && towerShelf !== 'unshelved' && !shelves.includes(towerShelf)) towerShelf = null;
    const shelfView = document.getElementById('towerShelfView');
    shelfView.hidden = !towerShelf;
    tower.hidden = !!towerShelf;
    legend.hidden = !!towerShelf;
    if (towerShelf) {
      renderTowerShelf(shelfView, shown);
      return;
    }

    const roof = document.createElement('div');
    roof.className = 'tower-roof';
    roof.innerHTML = '<div class="tower-roof-cone"></div><div class="tower-roof-brim"></div>';
    tower.appendChild(roof);

    shelves.forEach(name => {
      const members = shown.filter(e => entryShelves(e).includes(name));
      tower.appendChild(buildTowerFloor(name, members, spineColorForShelf(name), name));
    });

    // Empty floor with the "add a shelf" button, like the spine's "+" in the rail
    const addFloor = document.createElement('section');
    addFloor.className = 'tower-floor';
    const addRoom = document.createElement('div');
    addRoom.className = 'tower-room tower-room-empty';
    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'btn-solid tower-add';
    addBtn.textContent = '+ Add shelf';
    addBtn.addEventListener('click', () => addShelf());
    addRoom.appendChild(addBtn);
    addFloor.appendChild(addRoom);
    tower.appendChild(addFloor);

    // Ground floor: books without a shelf (the rail's "unshelved" spine)
    const loose = shown.filter(e => entryShelves(e).length === 0);
    tower.appendChild(buildTowerFloor('Unshelved', loose, null, 'unshelved'));

    const base = document.createElement('div');
    base.className = 'tower-base';
    base.innerHTML = '<div class="tower-door"></div>';
    tower.appendChild(base);
    const grass = document.createElement('div');
    grass.className = 'tower-grass';
    tower.appendChild(grass);

    TOWER_RATINGS.forEach(([key, label]) => {
      const item = document.createElement('span');
      item.className = 'tower-legend-item';
      const sw = document.createElement('i');
      sw.className = `tower-book-${key}`;
      item.appendChild(sw);
      item.appendChild(document.createTextNode(label));
      legend.appendChild(item);
    });
  }

  // Close-up of one shelf: a big bookcase with every fic shown as the same
  // cover card the Library uses (rating, title, author, words, read time, stars).
  function renderTowerShelf(host, shown) {
    host.innerHTML = '';
    const isLoose = towerShelf === 'unshelved';
    const members = isLoose
      ? shown.filter(e => entryShelves(e).length === 0)
      : shown.filter(e => entryShelves(e).includes(towerShelf));

    const bar = document.createElement('div');
    bar.className = 'tshelf-bar';
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'btn-ghost tshelf-back';
    back.textContent = '← Tower';
    back.addEventListener('click', () => { towerShelf = null; renderTower(); });
    const title = document.createElement('h2');
    title.className = 'tshelf-title';
    title.textContent = isLoose ? 'Unshelved' : towerShelf;
    const count = document.createElement('span');
    count.className = 'tshelf-count';
    count.textContent = `${members.length} book${members.length === 1 ? '' : 's'}`;
    bar.appendChild(back);
    bar.appendChild(title);
    bar.appendChild(count);
    host.appendChild(bar);

    const stage = document.createElement('div');
    stage.className = 'tshelf-stage';
    stage.style.setProperty('--shelf-color', isLoose ? 'var(--rose)' : spineColorForShelf(towerShelf));

    // The wall behind the bookcase. Its look comes from CSS variables
    // (--wall-color / --wall-pattern / --wall-image), and .tshelf-wall-tools is the
    // spot reserved for the background customisation controls.
    const wall = document.createElement('div');
    wall.className = 'tshelf-wall';
    wall.setAttribute('aria-hidden', 'true');
    const wallTools = document.createElement('div');
    wallTools.className = 'tshelf-wall-tools';
    wallTools.hidden = true;
    const bookcase = document.createElement('div');
    bookcase.className = 'tshelf-bookcase';

    const cornice = document.createElement('div');
    cornice.className = 'tshelf-cornice';
    const bodyEl = document.createElement('div');
    bodyEl.className = 'tshelf-case';

    if (members.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'tshelf-empty';
      empty.textContent = isLoose
        ? 'Nothing unshelved — everything has a home.'
        : 'Nothing here yet — use a card\'s shelf picker to file a fic on this shelf.';
      bodyEl.appendChild(empty);
      const slot = document.createElement('div');
      slot.className = 'tshelf-slot tshelf-slot-empty';
      bodyEl.appendChild(slot);
    }
    members.forEach(entry => {
      const slot = document.createElement('div');
      slot.className = 'tshelf-slot';
      slot.appendChild(buildBookCover(entry, true));
      bodyEl.appendChild(slot);
    });

    bookcase.appendChild(cornice);
    bookcase.appendChild(bodyEl);
    stage.appendChild(wall);
    stage.appendChild(wallTools);
    stage.appendChild(bookcase);
    host.appendChild(stage);
  }

  function setShelvesMode(mode) {
    shelvesMode = mode;
    document.querySelectorAll('[data-shelves-mode]').forEach(b => {
      b.classList.toggle('active', b.dataset.shelvesMode === mode);
    });
    document.getElementById('towerWrap').hidden = mode !== 'tower';
    document.getElementById('railWrap').hidden = mode !== 'rail';
    if (mode === 'tower') renderTower();
  }
  document.querySelectorAll('[data-shelves-mode]').forEach(b => {
    b.addEventListener('click', () => setShelvesMode(b.dataset.shelvesMode));
  });

  // ---- Shelves view ----

  function spineWidth(key) {
    return 30 + (hashString(key) % 5) * 4; // 30–46px, stable per shelf name
  }

  // Full titles on the spines: measure the title, then make the spine tall enough
  // (or wrap it onto extra lines when it would get too tall).
  const spineMeasure = document.createElement('canvas').getContext('2d');
  function measureSpineTitle(text) {
    const rootPx = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    spineMeasure.font = `600 ${rootPx * 0.8}px Fraunces, Georgia, serif`;
    return Math.ceil(spineMeasure.measureText(text).width * 1.06) + 4; // a little slack for letter-spacing
  }
  const SPINE_CHROME = 70;      // top band + padding above the title, count badge + padding below
  const SPINE_MAX_H = 240;

  function renderBookshelf() {
    if (!bookshelfRail) return;
    bookshelfRail.innerHTML = '';

    const items = [{ key: 'unshelved', label: 'Unshelved', special: true }]
      .concat(shelves.map(name => ({ key: name, label: name })));

    items.forEach(item => {
      const count = item.special
        ? entries.filter(e => entryShelves(e).length === 0).length
        : entries.filter(e => entryShelves(e).includes(item.key)).length;

      const spine = document.createElement('button');
      spine.type = 'button';
      spine.className = 'spine' + (item.special ? ' spine-unshelved' : '') + (activeShelf === item.key ? ' active' : '');
      if (!item.special) {
        spine.style.background = spineColorForShelf(item.key);
      }
      const baseH = item.special ? 132 : 124 + (hashString(item.key + 'h') % 5) * 8;
      const textW = measureSpineTitle(item.label);
      const capAvail = SPINE_MAX_H - SPINE_CHROME;
      const lines = Math.max(1, Math.ceil(textW / capAvail));
      const lineLen = lines === 1 ? textW : Math.ceil(textW / lines) + 26;   // slack so words can break
      const spineH = Math.max(baseH, Math.min(SPINE_MAX_H, lineLen + SPINE_CHROME));
      spine.style.setProperty('--spine-w', (spineWidth(item.key) + (lines - 1) * 15) + 'px');
      spine.style.setProperty('--spine-h', spineH + 'px');
      spine.style.setProperty('--i', String(bookshelfRail.children.length));
      spine.title = `${item.label} (${count})`;
      spine.addEventListener('click', () => {
        activeShelf = item.key;
        colorPickerOpen = false;
        renderBookshelf();
        renderShelfContents();
      });

      const label = document.createElement('span');
      label.className = 'spine-label';
      label.textContent = item.label;
      if (lines > 1) {
        label.classList.add('wrap');
        label.style.maxHeight = (spineH - SPINE_CHROME) + 'px';
      }
      spine.appendChild(label);

      const badge = document.createElement('span');
      badge.className = 'spine-count';
      badge.textContent = String(count);
      spine.appendChild(badge);

      bookshelfRail.appendChild(spine);
    });

    const addSpine = document.createElement('button');
    addSpine.type = 'button';
    addSpine.className = 'spine spine-add';
    addSpine.title = 'Add a new shelf';
    addSpine.textContent = '+';
    addSpine.addEventListener('click', addShelf);
    bookshelfRail.appendChild(addSpine);
  }

  if (document.fonts && document.fonts.status !== 'loaded') {
    document.fonts.ready.then(() => { renderBookshelf(); if (shelvesMode === 'tower') renderTower(); });
  }

  function renderShelfContents() {
    if (!shelfContents) return;
    shelfContents.innerHTML = '';

    if (!activeShelf) {
      const hint = document.createElement('p');
      hint.className = 'shelf-hint';
      hint.textContent = 'Tap a spine to pull that shelf down.';
      shelfContents.appendChild(hint);
      return;
    }

    const isUnshelved = activeShelf === 'unshelved';
    const shelfMembers = isUnshelved
      ? entries.filter(e => entryShelves(e).length === 0)
      : entries.filter(e => entryShelves(e).includes(activeShelf));

    const query = searchInput.value.trim().toLowerCase();
    const list = sortEntries(shelfMembers.filter(e => matchesFilters(e, query)));

    const header = document.createElement('div');
    header.className = 'shelf-header';

    const heading = document.createElement('h2');
    heading.textContent = isUnshelved ? 'Unshelved' : activeShelf;
    header.appendChild(heading);

    const count = document.createElement('span');
    count.className = 'shelf-count';
    count.textContent = list.length === shelfMembers.length
      ? `${shelfMembers.length} card${shelfMembers.length === 1 ? '' : 's'}`
      : `${list.length} of ${shelfMembers.length} cards`;
    header.appendChild(count);

    if (!isUnshelved) {
      const actions = document.createElement('div');
      actions.className = 'shelf-actions';

      const idx = shelves.indexOf(activeShelf);

      const moveLeftBtn = document.createElement('button');
      moveLeftBtn.type = 'button';
      moveLeftBtn.className = 'btn-ghost shelf-action-btn';
      moveLeftBtn.textContent = '←';
      moveLeftBtn.title = 'Move this shelf earlier';
      moveLeftBtn.disabled = idx <= 0;
      moveLeftBtn.addEventListener('click', () => moveShelf(activeShelf, -1));

      const moveRightBtn = document.createElement('button');
      moveRightBtn.type = 'button';
      moveRightBtn.className = 'btn-ghost shelf-action-btn';
      moveRightBtn.textContent = '→';
      moveRightBtn.title = 'Move this shelf later';
      moveRightBtn.disabled = idx === -1 || idx >= shelves.length - 1;
      moveRightBtn.addEventListener('click', () => moveShelf(activeShelf, 1));

      const colorBtn = document.createElement('button');
      colorBtn.type = 'button';
      colorBtn.className = 'btn-ghost shelf-action-btn';
      colorBtn.textContent = 'Color';
      colorBtn.addEventListener('click', () => {
        colorPickerOpen = !colorPickerOpen;
        renderShelfContents();
      });

      const renameBtn = document.createElement('button');
      renameBtn.type = 'button';
      renameBtn.className = 'btn-ghost shelf-action-btn';
      renameBtn.textContent = 'Rename';
      renameBtn.addEventListener('click', () => renameShelf(activeShelf));

      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'btn-ghost shelf-action-btn';
      deleteBtn.textContent = 'Delete';
      deleteBtn.addEventListener('click', () => deleteShelf(activeShelf));

      actions.appendChild(moveLeftBtn);
      actions.appendChild(moveRightBtn);
      actions.appendChild(colorBtn);
      actions.appendChild(renameBtn);
      actions.appendChild(deleteBtn);
      header.appendChild(actions);
    }

    const viewToggle = document.createElement('div');
    viewToggle.className = 'shelf-view-toggle';
    viewToggle.setAttribute('role', 'group');
    viewToggle.setAttribute('aria-label', 'Shelf view');
    if (isUnshelved) viewToggle.style.marginLeft = 'auto';
    [['list', 'List'], ['cards', 'Cards']].forEach(([mode, label]) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = label;
      btn.className = shelfView === mode ? 'active' : '';
      btn.setAttribute('aria-pressed', String(shelfView === mode));
      btn.title = mode === 'list' ? 'Compact list' : 'Full cards';
      btn.addEventListener('click', () => {
        if (shelfView === mode) return;
        shelfView = mode;
        try { localStorage.setItem(SHELF_VIEW_KEY, mode); } catch (e) { /* ignore */ }
        renderShelfContents();
      });
      viewToggle.appendChild(btn);
    });
    // sits right after the card count, before the Color/Rename/Delete actions
    const actionsEl = header.querySelector('.shelf-actions');
    if (actionsEl) { actionsEl.style.marginLeft = '0'; viewToggle.style.marginLeft = 'auto'; header.insertBefore(viewToggle, actionsEl); }
    else header.appendChild(viewToggle);

    shelfContents.appendChild(header);

    if (!isUnshelved && colorPickerOpen) {
      shelfContents.appendChild(buildColorRow(activeShelf));
    }

    if (list.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'shelf-hint';
      if (shelfMembers.length === 0) {
        empty.textContent = isUnshelved
          ? 'Nothing unshelved — everything has a home.'
          : 'Nothing filed here yet — use a card\'s shelf picker to add one.';
      } else {
        empty.textContent = 'Nothing on this shelf matches your current filters.';
      }
      shelfContents.appendChild(empty);
      return;
    }

    if (shelfView === 'cards') {
      const cardsGrid = document.createElement('div');
      cardsGrid.className = 'card-grid shelf-card-grid';
      list.forEach(entry => cardsGrid.appendChild(buildCard(entry)));
      shelfContents.appendChild(cardsGrid);
      return;
    }

    const rowList = document.createElement('div');
    rowList.className = 'shelf-row-list';
    list.forEach(entry => rowList.appendChild(buildShelfRow(entry)));
    shelfContents.appendChild(rowList);
  }

  // Compact pill-style row for a fic pulled down from a shelf. Tap it to
  // unroll the full catalog card (tags, notes, summary, AO3 tags, etc.)
  // right underneath; tap again to collapse. The thumbnail and title links
  // still navigate to AO3 as normal instead of toggling.
  // Row of tappable color swatches for the active shelf's spine.
  function buildColorRow(name) {
    const row = document.createElement('div');
    row.className = 'shelf-color-row';

    const currentKey = shelfColors[name] || null;

    SPINE_PALETTE.forEach(({ key, label, color }) => {
      const swatch = document.createElement('button');
      swatch.type = 'button';
      swatch.className = 'color-swatch' + (currentKey === key ? ' active' : '');
      swatch.style.background = color;
      swatch.title = label;
      swatch.setAttribute('aria-label', label);
      swatch.addEventListener('click', () => {
        shelfColors[name] = key;
        saveShelfColors();
        colorPickerOpen = false;
        renderBookshelf();
        renderShelfContents();
      });
      row.appendChild(swatch);
    });

    return row;
  }

  function buildShelfRow(entry) {
    const wrap = document.createElement('div');
    wrap.className = 'shelf-row-wrap';

    const isOpen = expandedRows.has(entry.id);

    const row = document.createElement('div');
    row.className = 'shelf-row' + (isOpen ? ' open' : '');
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.setAttribute('aria-expanded', String(isOpen));

    const hasUrl = !!entry.url;
    const thumb = document.createElement(hasUrl ? 'a' : 'span');
    thumb.className = 'shelf-row-thumb';
    if (hasUrl) {
      thumb.href = entry.url;
      thumb.target = '_blank';
      thumb.rel = 'noopener';
    }
    thumb.style.background = SPINE_PALETTE[hashString(entry.title || entry.id) % SPINE_PALETTE.length].color;
    thumb.textContent = (entry.title || '?').trim().charAt(0).toUpperCase();
    row.appendChild(thumb);

    const main = document.createElement('div');
    main.className = 'shelf-row-main';

    const top = document.createElement('div');
    top.className = 'shelf-row-top';

    const title = document.createElement('a');
    title.className = 'shelf-row-title';
    title.textContent = entry.title;
    if (hasUrl) {
      title.href = entry.url;
      title.target = '_blank';
      title.rel = 'noopener';
    } else {
      title.removeAttribute('href');
      title.style.pointerEvents = 'none';
    }
    top.appendChild(title);

    const rating = (entry.rating && entry.rating[0]) || '';
    if (rating) {
      const chip = document.createElement('span');
      chip.className = `shelf-row-rating badge badge-rating-${ratingClass(rating)}`;
      chip.textContent = rating;
      top.appendChild(chip);
    }
    main.appendChild(top);

    const byline = document.createElement('p');
    byline.className = 'shelf-row-byline';
    byline.textContent = `by ${entry.authors || 'Anonymous'}`;
    main.appendChild(byline);

    const meta = document.createElement('div');
    meta.className = 'shelf-row-meta';

    const wordsText = formatWords(entry.words);
    if (wordsText) {
      const span = document.createElement('span');
      span.textContent = wordsText;
      meta.appendChild(span);
    }

    const readTimeText = formatReadTime(entry.words);
    if (readTimeText) {
      const span = document.createElement('span');
      span.textContent = readTimeText;
      meta.appendChild(span);
    }

    const kudosText = formatCount(entry.kudos);
    if (kudosText) {
      const span = document.createElement('span');
      span.className = 'shelf-row-kudos';
      span.textContent = `♥ ${kudosText}`;
      meta.appendChild(span);
    }

    if (entry.chapters) {
      const span = document.createElement('span');
      if (entry.complete) span.className = 'shelf-row-complete';
      span.textContent = entry.complete ? `${entry.chapters} · complete` : entry.chapters;
      meta.appendChild(span);
    }

    if (entry.stars) {
      const span = document.createElement('span');
      span.className = 'shelf-row-stars';
      const full = Math.floor(entry.stars);
      const half = entry.stars % 1 !== 0;
      span.textContent = '★'.repeat(full) + (half ? '½' : '') + ` ${entry.stars}`;
      meta.appendChild(span);
    }

    if (meta.children.length) main.appendChild(meta);
    row.appendChild(main);

    const chevron = document.createElement('span');
    chevron.className = 'shelf-row-chevron';
    chevron.setAttribute('aria-hidden', 'true');
    chevron.textContent = '⌄';
    row.appendChild(chevron);

    row.addEventListener('click', (e) => {
      if (e.target.closest('a')) return; // let the thumb/title links navigate normally
      toggleShelfRow(entry.id);
    });
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggleShelfRow(entry.id);
      }
    });

    wrap.appendChild(row);

    if (isOpen) {
      const detail = document.createElement('div');
      detail.className = 'shelf-row-detail';
      detail.appendChild(buildCard(entry));
      wrap.appendChild(detail);
    }

    return wrap;
  }

  function toggleShelfRow(id) {
    if (expandedRows.has(id)) expandedRows.delete(id);
    else expandedRows.add(id);
    renderShelfContents();
  }

  function addShelf() {
    const name = prompt('Name this shelf:');
    if (name === null) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    if (!shelves.includes(trimmed)) {
      shelves.push(trimmed);
      saveShelves();
    }
    activeShelf = trimmed;
    render();
  }

  function renameShelf(oldName) {
    const name = prompt('Rename shelf:', oldName);
    if (name === null) return;
    const trimmed = name.trim();
    if (!trimmed || trimmed === oldName) return;
    if (shelves.includes(trimmed)) {
      alert('A shelf with that name already exists.');
      return;
    }
    shelves = shelves.map(s => (s === oldName ? trimmed : s));
    if (shelfColors[oldName]) {
      shelfColors[trimmed] = shelfColors[oldName];
      delete shelfColors[oldName];
      saveShelfColors();
    }
    entries.forEach(e => {
      const idx = entryShelves(e).indexOf(oldName);
      if (idx !== -1) e.shelves[idx] = trimmed;
    });
    saveShelves();
    saveEntries();
    activeShelf = trimmed;
    render();
  }

  function deleteShelf(name) {
    if (!confirm(`Delete "${name}"? Fics on it move to Unshelved.`)) return;
    shelves = shelves.filter(s => s !== name);
    if (shelfColors[name]) {
      delete shelfColors[name];
      saveShelfColors();
    }
    entries.forEach(e => {
      e.shelves = entryShelves(e).filter(s => s !== name);
    });
    saveShelves();
    saveEntries();
    activeShelf = 'unshelved';
    colorPickerOpen = false;
    render();
  }

  function moveShelf(name, direction) {
    const idx = shelves.indexOf(name);
    const target = idx + direction;
    if (idx === -1 || target < 0 || target >= shelves.length) return;
    [shelves[idx], shelves[target]] = [shelves[target], shelves[idx]];
    saveShelves();
    renderBookshelf();
    renderShelfContents();
  }

  // ---- Up next: pin 1–3 fics to the top of the Catalog ----
  const UP_NEXT_MAX = 3;
  function upNextList() {
    return entries
      .filter(e => e.upNext)
      .sort((a, b) => a.upNext - b.upNext)
      .slice(0, UP_NEXT_MAX);
  }

  function setupUpNext(node, entry) {
    const btn = node.querySelector('.stub-pin');
    const paint = () => {
      const on = !!entry.upNext;
      btn.textContent = on ? 'up next ✓' : '＋ up next';
      btn.classList.toggle('active', on);
      btn.title = on ? 'Remove from Up next' : 'Pin to Up next (max 3)';
      btn.setAttribute('aria-pressed', String(on));
    };
    paint();
    btn.addEventListener('click', () => {
      if (entry.upNext) {
        entry.upNext = null;
        showToast(`Took "${entry.title}" off Up next`);
      } else {
        if (entries.filter(e => e.upNext).length >= UP_NEXT_MAX) {
          showToast(`Up next is full — unpin one of your ${UP_NEXT_MAX} first`);
          return;
        }
        entry.upNext = Date.now();
        showToast(`"${entry.title}" is up next`);
      }
      paint();
      saveEntries();
      render();
    });
  }

  function buildCard(entry) {
    const node = template.content.cloneNode(true);
    const card = node.querySelector('.card');
    card.dataset.id = entry.id;
    if (entry.id === pinnedId) card.classList.add('card-pinned');

    node.querySelector('.stub-date').textContent = formatDate(entry.dateAdded);
    node.querySelector('.stub-remove').addEventListener('click', () => removeEntry(entry.id));

    const refreshBtn = node.querySelector('.stub-refresh');
    if (entry.url) {
      refreshBtn.addEventListener('click', () => refreshEntry(entry.id, refreshBtn));
    } else {
      refreshBtn.disabled = true;
      refreshBtn.title = 'No AO3 link saved for this card';
    }

    const titleLink = node.querySelector('.card-title a');
    titleLink.textContent = entry.title;
    if (entry.url) {
      titleLink.href = entry.url;
    } else {
      titleLink.removeAttribute('target');
      titleLink.style.pointerEvents = 'none';
      titleLink.style.backgroundImage = 'none';
    }

    node.querySelector('.card-authors').textContent = entry.authors;
    node.querySelector('.card-summary').textContent = extractOrSection(entry.summary);

    buildBadges(node, entry);

    const tagsWrap = node.querySelector('.card-tags');
    (entry.tags || []).forEach(tag => tagsWrap.appendChild(buildPill(entry.id, tag)));

    setupTagInput(node, entry);
    setupNotes(node, entry);
    setupShelfPicker(node, entry);
    setupUpNext(node, entry);
    setupStarRating(node, entry);
    setupAoTags(node, entry);

    return node;
  }

  // 5-star widget with half-star precision. Click position along the row
  // decides the value (snapped to the nearest 0.5); clicking the exact
  // current rating again clears it back to unrated.
  function setupStarRating(node, entry) {
    const widget = node.querySelector('.star-rating');
    const fg = node.querySelector('.star-row-fg');
    const valueLabel = node.querySelector('.star-value');

    function paint() {
      const stars = entry.stars || 0;
      fg.style.width = (stars / 5 * 100) + '%';
      widget.setAttribute('aria-valuenow', String(stars));
      valueLabel.textContent = stars ? `${stars}★` : 'unrated';
    }
    paint();

    function valueFromClientX(clientX) {
      const rect = widget.getBoundingClientRect();
      const fraction = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      return Math.round(fraction * 10) / 2; // snap to nearest 0.5 across 0–5
    }

    function setStars(value) {
      entry.stars = value || null;
      saveEntries();
      render();
    }

    widget.addEventListener('click', (e) => {
      const val = valueFromClientX(e.clientX);
      setStars(val === (entry.stars || 0) ? 0 : val);
    });

    widget.addEventListener('keydown', (e) => {
      let stars = entry.stars || 0;
      if (e.key === 'ArrowRight' || e.key === 'ArrowUp') stars = Math.min(5, stars + 0.5);
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') stars = Math.max(0, stars - 0.5);
      else if (e.key === 'Home') stars = 0;
      else if (e.key === 'End') stars = 5;
      else return;
      e.preventDefault();
      setStars(stars);
    });
  }

  // Lets a card be filed onto any number of shelves at once (or none, i.e. Unshelved)
  function setupShelfPicker(node, entry) {
    const details = node.querySelector('.shelf-picker');
    const summary = node.querySelector('.shelf-picker-summary');
    const list = node.querySelector('.shelf-picker-list');

    function paintSummary() {
      const current = entryShelves(entry);
      summary.textContent = current.length ? current.join(', ') : 'Unshelved';
    }

    function paintList() {
      list.innerHTML = '';

      if (shelves.length === 0) {
        const hint = document.createElement('p');
        hint.className = 'shelf-picker-hint';
        hint.textContent = 'No shelves yet — add one from the Shelves tab.';
        list.appendChild(hint);
        return;
      }

      shelves.forEach(name => {
        const label = document.createElement('label');
        label.className = 'shelf-picker-item';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = entryShelves(entry).includes(name);
        checkbox.addEventListener('change', () => {
          const current = new Set(entryShelves(entry));
          if (checkbox.checked) current.add(name); else current.delete(name);
          entry.shelves = Array.from(current);
          saveEntries();
          paintSummary();
          renderBookshelf();
          if (view === 'shelves') renderShelfContents();
        });

        const text = document.createElement('span');
        text.textContent = name;

        label.appendChild(checkbox);
        label.appendChild(text);
        list.appendChild(label);
      });
    }

    paintSummary();
    paintList();

    // Shelves can change elsewhere (added/renamed/deleted) while this card's
    // picker sits closed — refresh the checkbox list each time it opens.
    details.addEventListener('toggle', () => {
      if (details.open) paintList();
    });
  }

  // Freeform note per card. Saves as you type (debounced) without a full
  // re-render, so the textarea never loses focus/cursor position mid-edit.
  function autoGrow(textarea) {
    textarea.style.height = 'auto';
    textarea.style.height = textarea.scrollHeight + 'px';
  }

  function setupNotes(node, entry) {
    const notesInput = node.querySelector('.notes-input');
    notesInput.value = entry.notes || '';

    // Grow to fit existing content once it's actually in the DOM
    requestAnimationFrame(() => autoGrow(notesInput));

    let saveTimer = null;
    notesInput.addEventListener('input', () => {
      autoGrow(notesInput);
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        entry.notes = notesInput.value;
        saveEntries();
      }, 400);
    });
    notesInput.addEventListener('blur', () => {
      clearTimeout(saveTimer);
      entry.notes = notesInput.value;
      saveEntries();
    });
  }

  // Rating / word count / chapter progress / category chips
  function buildBadges(node, entry) {
    const wrap = node.querySelector('.card-badges');
    const rating = (entry.rating && entry.rating[0]) || '';

    if (rating) {
      const badge = document.createElement('span');
      badge.className = `badge badge-rating badge-rating-${ratingClass(rating)}`;
      badge.textContent = rating;
      wrap.appendChild(badge);
    }

    (entry.category || []).forEach(cat => {
      const badge = document.createElement('span');
      badge.className = 'badge badge-category';
      badge.textContent = cat;
      wrap.appendChild(badge);
    });

    const wordsText = formatWords(entry.words);
    if (wordsText) {
      const badge = document.createElement('span');
      badge.className = 'badge badge-words';
      badge.textContent = wordsText;
      wrap.appendChild(badge);
    }

    const readTimeText = formatReadTime(entry.words);
    if (readTimeText) {
      const badge = document.createElement('span');
      badge.className = 'badge badge-readtime';
      badge.textContent = readTimeText;
      wrap.appendChild(badge);
    }

    const kudosText = formatCount(entry.kudos);
    if (kudosText) {
      const badge = document.createElement('span');
      badge.className = 'badge badge-kudos';
      badge.textContent = `♥ ${kudosText}`;
      wrap.appendChild(badge);
    }

    if (entry.chapters) {
      const badge = document.createElement('span');
      badge.className = 'badge badge-chapters' + (entry.complete ? ' badge-complete' : '');
      badge.textContent = entry.complete ? `${entry.chapters} · complete` : entry.chapters;
      wrap.appendChild(badge);
    }

    const isOneShot = entry.chapters === '1/1';
    const dateLabel = isOneShot ? 'Published' : (entry.complete ? 'Completed' : 'Updated');
    const dateValue = isOneShot ? entry.published : (entry.updated || entry.published);
    const dateText = formatSimpleDate(dateValue);
    if (dateText) {
      const badge = document.createElement('span');
      badge.className = 'badge badge-date';
      badge.textContent = `${dateLabel} ${dateText}`;
      wrap.appendChild(badge);
    }

    const hasWarnings = entry.warnings && entry.warnings.length &&
      !(entry.warnings.length === 1 && /no archive warnings apply/i.test(entry.warnings[0]));
    if (hasWarnings) {
      const badge = document.createElement('span');
      badge.className = 'badge badge-warning';
      badge.textContent = entry.warnings.join(', ');
      wrap.appendChild(badge);
    }

    if (wrap.children.length === 0) wrap.remove();
  }

  function setupTagInput(node, entry) {
    const tagInput = node.querySelector('.tag-input');
    const suggestBox = node.querySelector('.tag-suggestions');

    function closeSuggestions() {
      suggestBox.classList.remove('visible');
      suggestBox.innerHTML = '';
    }

    function showSuggestions() {
      const query = tagInput.value.trim().toLowerCase();
      const candidates = allTags().filter(
        t => !(entry.tags || []).includes(t) && (!query || t.toLowerCase().includes(query))
      );
      if (candidates.length === 0) { closeSuggestions(); return; }

      suggestBox.innerHTML = '';
      candidates.slice(0, 6).forEach(tag => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = tag;
        // mousedown fires before the input's blur, so the click registers
        btn.addEventListener('mousedown', (e) => {
          e.preventDefault();
          addTag(entry.id, tag);
          tagInput.value = '';
          closeSuggestions();
        });
        suggestBox.appendChild(btn);
      });
      suggestBox.classList.add('visible');
    }

    tagInput.addEventListener('focus', showSuggestions);
    tagInput.addEventListener('input', showSuggestions);
    tagInput.addEventListener('blur', () => setTimeout(closeSuggestions, 100));
    tagInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        addTag(entry.id, tagInput.value);
        tagInput.value = '';
        closeSuggestions();
      }
    });
  }

  // AO3's own tags, grouped by category. Falls back to the old flat
  // aoTags list for cards filed before the userscript split them out.
  function setupAoTags(node, entry) {
    const details = node.querySelector('.ao-tags');
    const list = node.querySelector('.ao-tags-list');
    makeSmoothDetails(details);

    const groups = [
      ['Fandom', entry.fandoms],
      ['Relationships', entry.relationships],
      ['Characters', entry.characters],
      ['Additional Tags', entry.freeform],
    ].filter(([, arr]) => arr && arr.length);

    if (groups.length === 0 && entry.aoTags && entry.aoTags.length) {
      groups.push(['Tags', entry.aoTags]);
    }

    if (groups.length === 0) {
      details.remove();
      return;
    }

    groups.forEach(([label, tags]) => {
      const heading = document.createElement('div');
      heading.className = 'ao-group-label';
      heading.textContent = label;
      list.appendChild(heading);

      const row = document.createElement('div');
      row.className = 'ao-group-row';
      tags.forEach(tag => {
        const pill = document.createElement('button');
        pill.type = 'button';
        pill.className = 'pill-ao';
        pill.textContent = tag;
        pill.title = `Show fics tagged "${tag}"`;
        pill.addEventListener('click', () => filterByTag('ao', tag));
        row.appendChild(pill);
      });
      list.appendChild(row);
    });
  }

  function buildPill(entryId, tag) {
    const pill = document.createElement('span');
    pill.className = 'pill';
    const label = document.createElement('span');
    label.textContent = tag;
    label.className = 'pill-label';
    label.title = `Show fics tagged "${tag}"`;
    label.addEventListener('click', () => filterByTag('custom', tag));
    const btn = document.createElement('button');
    btn.textContent = '✕';
    btn.title = `Remove tag "${tag}"`;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      removeTag(entryId, tag);
    });
    pill.appendChild(label);
    pill.appendChild(btn);
    return pill;
  }

  function addTag(entryId, raw) {
    const tag = raw.trim();
    if (!tag) return;
    const entry = entries.find(e => e.id === entryId);
    if (!entry.tags.includes(tag)) {
      entry.tags.push(tag);
      saveEntries();
      render();
    }
  }

  function removeTag(entryId, tag) {
    const entry = entries.find(e => e.id === entryId);
    entry.tags = entry.tags.filter(t => t !== tag);
    saveEntries();
    render();
  }

  function removeEntry(entryId) {
    const entry = entries.find(e => e.id === entryId);
    const label = entry ? `"${entry.title}"` : 'this fic';
    if (!window.confirm(`Remove ${label} from the stacks?`)) return;
    entries = entries.filter(e => e.id !== entryId);
    saveEntries();
    render();
  }

  // ---- Import / export ----
  // Export is a straight dump of everything in localStorage; import merges
  // by URL so re-importing the same backup (or a slightly older one) never
  // duplicates cards. Entries without a URL (manual adds) are always kept.
  function exportData() {
    const payload = {
      format: 'the-stacks',
      version: 1,
      exportedAt: new Date().toISOString(),
      entries,
      shelves,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `the-stacks-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showToast(`Exported ${entries.length} card${entries.length === 1 ? '' : 's'}`);
  }

  function importData(file) {
    const reader = new FileReader();
    reader.onload = () => {
      let data;
      try {
        data = JSON.parse(reader.result);
      } catch (e) {
        showToast("Couldn't read that file — not valid JSON");
        return;
      }

      const incomingEntries = Array.isArray(data.entries) ? data.entries
        : Array.isArray(data) ? data
        : null;
      if (!incomingEntries) {
        showToast("That file doesn't look like a stacks export");
        return;
      }
      const incomingShelves = Array.isArray(data.shelves) ? data.shelves : [];

      const existingUrls = new Set(entries.filter(e => e.url).map(e => e.url));
      const existingIds = new Set(entries.map(e => e.id));
      let added = 0, skipped = 0;

      incomingEntries.forEach(raw => {
        if (raw.url && existingUrls.has(raw.url)) { skipped++; return; }
        const id = raw.id && !existingIds.has(raw.id) ? raw.id : uid();
        existingIds.add(id);
        if (raw.url) existingUrls.add(raw.url);
        const pushed = Object.assign({}, raw, { id });
        migrateShelfField(pushed);
        entries.push(pushed);
        added++;
      });

      incomingShelves.forEach(name => {
        if (!shelves.includes(name)) shelves.push(name);
      });

      saveEntries();
      saveShelves();
      render();
      if (view === 'shelves') { renderBookshelf(); renderShelfContents(); }

      showToast(
        added === 0
          ? `Nothing new — all ${skipped} card${skipped === 1 ? '' : 's'} already on file`
          : `Imported ${added} card${added === 1 ? '' : 's'}${skipped ? ` (${skipped} already on file)` : ''}`
      );
    };
    reader.onerror = () => showToast("Couldn't read that file");
    reader.readAsText(file);
  }

  // Pull the latest chapters/word count/etc. for one card. If no worker
  // is configured (or the fetch fails), fall back to just opening the fic
  // on AO3 so the person can re-tap "Info" there instead.
  async function refreshEntry(entryId, btn) {
    const entry = entries.find(e => e.id === entryId);
    if (!entry || !entry.url) return;

    if (!CONFIG.refreshApiUrl) {
      window.open(entry.url, '_blank', 'noopener');
      return;
    }

    const original = btn.textContent;
    btn.textContent = '…';
    btn.disabled = true;

    try {
      const res = await fetch(`${CONFIG.refreshApiUrl}?url=${encodeURIComponent(entry.url)}`);
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || `Request failed (${res.status})`);

      const prevChapters = entry.chapters;
      Object.assign(entry, {
        title: data.title || entry.title,
        authors: data.authors || entry.authors,
        summary: data.summary || entry.summary,
        rating: data.rating || entry.rating,
        warnings: data.warnings || entry.warnings,
        category: data.category || entry.category,
        fandoms: data.fandoms || entry.fandoms,
        relationships: data.relationships || entry.relationships,
        characters: data.characters || entry.characters,
        freeform: data.freeform || entry.freeform,
        words: data.words != null ? data.words : entry.words,
        kudos: data.kudos != null ? data.kudos : entry.kudos,
        chapters: data.chapters || entry.chapters,
        complete: data.complete != null ? data.complete : entry.complete,
        published: data.published || entry.published,
        updated: data.updated || entry.updated,
      });
      saveEntries();
      render();
      showToast(
        data.chapters && data.chapters !== prevChapters
          ? `Updated "${entry.title}" — now ${data.chapters} chapters`
          : `"${entry.title}" is already up to date`
      );
    } catch (err) {
      btn.textContent = original;
      btn.disabled = false;
      showToast(`Couldn't refresh — ${err.message || 'AO3 request failed'}`);
    }
  }

  // ---- Library view ----
  // Same filtered/sorted entry list as Catalog — the controls panel is
  // shared across views, just collapsed by default here (see the view-tab
  // handler below), same as Shelves.

  // Cloth-bound cover colours for the shelf close-up: muted, in the app's rose/mauve/gold family.
  const CLOTH_COLORS = ['#A85D76', '#C97B92', '#8C5E83', '#7A5A73', '#B07A5E', '#9B87C4', '#B98748', '#B5707A'];
  const SHORT_RATING = { general: 'General', teen: 'Teen', mature: 'Mature', explicit: 'Explicit', notrated: 'Not rated' };

  function buildBookCover(entry, cloth) {
    const cover = document.createElement('button');
    cover.type = 'button';
    cover.className = 'book-cover' + (cloth ? ' book-cover-cloth' : '');
    if (cloth) {
      // cloth colour follows the fic's rating (see .cloth-* in style.css)
      cover.classList.add('cloth-' + ratingClass((entry.rating && entry.rating[0]) || ''));
      cover.title = entry.title || 'Untitled';
    } else {
      cover.style.backgroundImage = coverGradientFor(entry);
    }
    cover.addEventListener('click', () => openBookInfo(entry));

    const rating = entry.rating && entry.rating[0];
    if (rating) {
      const badge = document.createElement('span');
      badge.className = `book-rating badge badge-rating-${ratingClass(rating)}`;
      badge.textContent = cloth ? SHORT_RATING[ratingClass(rating)] : rating;
      cover.appendChild(badge);
    }

    const title = document.createElement('span');
    title.className = 'book-title';
    title.textContent = entry.title || 'Untitled';
    cover.appendChild(title);

    const spacer = document.createElement('span');
    spacer.className = 'book-spacer';
    cover.appendChild(spacer);

    const byline = document.createElement('span');
    byline.className = 'book-byline';
    byline.textContent = 'by ' + (entry.authors || 'Anonymous');
    cover.appendChild(byline);

    const meta = document.createElement('span');
    meta.className = 'book-meta';
    const metaBits = [];
    if (entry.words) metaBits.push(formatWords(entry.words));
    const readTimeText = formatReadTime(entry.words);
    if (readTimeText) metaBits.push(readTimeText);
    let metaText = metaBits.join(' · ');
    if (entry.stars) {
      const starText = '★'.repeat(Math.round(entry.stars));
      metaText = cloth && metaText ? metaText + '\n' + starText : [metaText, starText].filter(Boolean).join(' · ');
    }
    meta.textContent = metaText;
    cover.appendChild(meta);

    return cover;
  }

  // Clicking a cover opens the same full card used in Catalog/Shelves — all
  // its editing controls (stars, tags, notes, shelves, refresh) work as-is
  // since buildCard() binds directly to the real entry object.
  function openBookInfo(entry) {
    if (!bookInfoDialog) return;
    bookInfoContent.innerHTML = '';
    bookInfoContent.appendChild(buildCard(entry));
    bookInfoDialog.showModal();
  }

  function renderLibrary() {
    if (!libraryGrid) return;
    const query = searchInput.value.trim().toLowerCase();
    const visible = sortEntries(entries.filter(e => matchesFilters(e, query)));

    libraryGrid.innerHTML = '';
    visible.forEach(entry => libraryGrid.appendChild(buildBookCover(entry, true))); // cloth-bound covers, same as the shelf close-up

    libraryEmptyState.hidden = entries.length !== 0;
  }

  // ---- Search & filter wiring ----
  // Wait until you pause typing before re-drawing the list.
  let searchTimer = null;
  searchInput.addEventListener('input', () => {
    pinnedId = null;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(render, 150);
  });

  // ---- Surprise me: random fic from whatever your filters currently show ----
  // Narrow it with length / complete-only / one of your own tags (moods) / unrated-vs-any.
  const SURPRISE_KEY = 'tbr-stacks-surprise-v1';
  const surpriseSel = {
    length: document.getElementById('surpriseLength'),
    status: document.getElementById('surpriseStatus'),
    tag: document.getElementById('surpriseTag'),
    pool: document.getElementById('surprisePool'),
  };
  let surpriseTagWanted = '';
  try {
    const saved = JSON.parse(localStorage.getItem(SURPRISE_KEY) || '{}');
    if (saved.length) surpriseSel.length.value = saved.length;
    if (saved.status) surpriseSel.status.value = saved.status;
    if (saved.pool) surpriseSel.pool.value = saved.pool;
    surpriseTagWanted = saved.tag || '';
  } catch (e) { /* ignore */ }
  if (!surpriseSel.length.value) surpriseSel.length.value = 'any';
  if (!surpriseSel.status.value) surpriseSel.status.value = 'any';
  if (!surpriseSel.pool.value) surpriseSel.pool.value = 'unrated';

  function saveSurpriseOpts() {
    surpriseTagWanted = surpriseSel.tag.value;
    try {
      localStorage.setItem(SURPRISE_KEY, JSON.stringify({
        length: surpriseSel.length.value, status: surpriseSel.status.value,
        tag: surpriseSel.tag.value, pool: surpriseSel.pool.value,
      }));
    } catch (e) { /* ignore */ }
  }
  Object.values(surpriseSel).forEach(sel => sel.addEventListener('change', saveSurpriseOpts));

  // Keep the tag dropdown in step with your tags (called after every render)
  function populateSurpriseTags() {
    const sel = surpriseSel.tag;
    const want = sel.value || surpriseTagWanted;
    const tags = allTags();
    sel.innerHTML = '';
    const any = document.createElement('option');
    any.value = ''; any.textContent = 'Any of my tags';
    sel.appendChild(any);
    tags.forEach(t => {
      const o = document.createElement('option');
      o.value = t; o.textContent = t;
      sel.appendChild(o);
    });
    sel.value = tags.includes(want) ? want : '';
  }

  function surpriseLengthOk(e, mode) {
    if (mode === 'any') return true;
    const w = Number(e.words) || 0;
    if (!w) return false;               // no word count, can't say how long it is
    if (mode === 'quick') return w < 5000;
    if (mode === 'medium') return w >= 5000 && w < 20000;
    return w >= 20000;
  }

  let lastSurpriseId = null;
  document.getElementById('surpriseBtn').addEventListener('click', () => {
    if (view !== 'catalog') document.querySelector('.view-tab[data-view="catalog"]').click();
    const query = searchInput.value.trim().toLowerCase();
    const lengthMode = surpriseSel.length.value;
    const completeOnly = surpriseSel.status.value === 'complete';
    const tag = surpriseSel.tag.value;
    const unratedOnly = surpriseSel.pool.value === 'unrated';
    const custom = lengthMode !== 'any' || completeOnly || tag || !unratedOnly;
    // Anything on the "Reading" shelf and fics already Up next are always skipped;
    // your filters narrow it further.
    const onReadingShelf = e => entryShelves(e).some(s => s.trim().toLowerCase() === 'reading');
    const pool = entries.filter(e =>
      (!unratedOnly || !e.stars) && !e.upNext && !onReadingShelf(e) &&
      surpriseLengthOk(e, lengthMode) &&
      (!completeOnly || e.complete) &&
      (!tag || (e.tags || []).includes(tag)) &&
      matchesFilters(e, query));
    if (!pool.length) {
      showToast(entries.length
        ? (custom ? 'Nothing matches your Surprise options — try loosening them' : 'No unrated fics outside your Reading shelf match your filters')
        : 'File a fic first');
      return;
    }
    const choices = pool.length > 1 ? pool.filter(e => e.id !== lastSurpriseId) : pool;
    const pick = choices[Math.floor(Math.random() * choices.length)];
    lastSurpriseId = pick.id;
    pinnedId = pick.id; // pinned to the top until you search/sort/filter again
    render();
    window.scrollTo({ top: Math.max(0, grid.getBoundingClientRect().top + window.scrollY - 90), behavior: 'smooth' });
    showToast(`How about "${pick.title}"?`);
  });

  populateSurpriseTags();

  sortSelect.addEventListener('change', () => {
    pinnedId = null;
    sortBy = sortSelect.value;
    render();
  });

  wordMinInput.addEventListener('input', () => {
    wordMin = wordMinInput.value === '' ? null : Math.max(0, parseInt(wordMinInput.value, 10) || 0);
    render();
  });
  wordMaxInput.addEventListener('input', () => {
    wordMax = wordMaxInput.value === '' ? null : Math.max(0, parseInt(wordMaxInput.value, 10) || 0);
    render();
  });

  aoTagSearch.addEventListener('input', () => {
    aoTagQuery = aoTagSearch.value;
    renderAoTagRail();
  });

  function resetFilters(alsoSearch) {
    if (alsoSearch) searchInput.value = '';
    pinnedId = null;
    activeTags.clear();
    activeRatings.clear();
    activeAoTags.clear();
    statusFilter = 'all';
    starFilter = 0;
    ratedFilter = 'all';
    wordMin = null;
    wordMax = null;
    wordMinInput.value = '';
    wordMaxInput.value = '';
    aoTagQuery = '';
    aoTagSearch.value = '';
    render();
    if (view === 'shelves') { renderBookshelf(); renderShelfContents(); }
    if (view === 'library') renderLibrary();
  }
  clearFiltersBtn.addEventListener('click', () => resetFilters(false));

  // Tapping the "the stacks" title = start fresh (search + all filters)
  const titleEl = document.querySelector('.masthead h1');
  if (titleEl) {
    titleEl.setAttribute('role', 'button');
    titleEl.setAttribute('tabindex', '0');
    titleEl.addEventListener('click', () => {
      resetFilters(true);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
    titleEl.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); titleEl.click(); }
    });
  }

  // ---- Manual add dialog ----
  const dialog = document.getElementById('addDialog');
  document.getElementById('addManualBtn').addEventListener('click', () => dialog.showModal());
  document.getElementById('cancelAdd').addEventListener('click', () => dialog.close());
  document.getElementById('addForm').addEventListener('submit', () => {
    const title = document.getElementById('f_title').value.trim();
    if (!title) return;
    entries.unshift({
      id: uid(),
      title,
      url: document.getElementById('f_url').value.trim(),
      authors: document.getElementById('f_authors').value.trim() || 'Anonymous',
      summary: document.getElementById('f_summary').value.trim(),
      tags: document.getElementById('f_tags').value.split(',').map(t => t.trim()).filter(Boolean),
      notes: '',
      shelves: [],
      stars: null,
      rating: [],
      warnings: [],
      category: [],
      fandoms: [],
      relationships: [],
      characters: [],
      freeform: [],
      words: null,
      chapters: '',
      complete: null,
      published: '',
      updated: '',
      aoTags: [],
      dateAdded: new Date().toISOString(),
    });
    saveEntries();
    document.getElementById('addForm').reset();
    render();
  });

  // ---- View tabs ----
  viewTabs.forEach(btn => {
    btn.addEventListener('click', () => {
      view = btn.dataset.view;
      viewTabs.forEach(b => {
        b.classList.toggle('active', b.dataset.view === view);
        b.setAttribute('aria-selected', b.dataset.view === view ? 'true' : 'false');
      });
      catalogView.hidden = view !== 'catalog';
      shelvesView.hidden = view !== 'shelves';
      libraryView.hidden = view !== 'library';
      controlsCollapse.classList.toggle('shelves-mode', view !== 'catalog');
      controlsCollapse.open = view === 'catalog';
      if (view === 'shelves') {
        renderBookshelf();
        renderShelfContents();
      }
      if (view === 'library') renderLibrary();
    });
  });

  // ---- Import / export ----
  document.getElementById('exportBtn').addEventListener('click', exportData);
  const importInput = document.getElementById('importInput');
  document.getElementById('importBtn').addEventListener('click', () => importInput.click());
  importInput.addEventListener('change', () => {
    const file = importInput.files[0];
    if (file) importData(file);
    importInput.value = ''; // allow importing the same file again later
  });

  // ---- Scroll to top ----
  const toTopBtn = document.getElementById('toTopBtn');
  window.addEventListener('scroll', () => {
    toTopBtn.classList.toggle('visible', window.scrollY > 400);
  });
  toTopBtn.addEventListener('click', () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  // ---- Cloud sync on startup ----
  function applyRemote(d) {
    haystackCache = new WeakMap();
    entries = (d.entries || []).map(migrateShelfField);
    shelves = d.shelves || [];
    shelfColors = d.shelfColors || {};
    localStorage.setItem(STORE_KEY, JSON.stringify(entries));
    localStorage.setItem(SHELVES_STORE_KEY, JSON.stringify(shelves));
    localStorage.setItem(SHELF_COLORS_STORE_KEY, JSON.stringify(shelfColors));
  }

  // First sign-in on a device that already has local cards: union by URL/id.
  function mergeRemote(d) {
    const urls = new Set(entries.filter(e => e.url).map(e => e.url));
    const ids = new Set(entries.map(e => e.id));
    (d.entries || []).forEach(r => {
      if ((r.url && urls.has(r.url)) || ids.has(r.id)) return;
      entries.push(migrateShelfField(r));
    });
    (d.shelves || []).forEach(n => { if (!shelves.includes(n)) shelves.push(n); });
    shelfColors = Object.assign({}, d.shelfColors || {}, shelfColors);
  }

  async function syncOnStart() {
    const cloud = window.StacksCloud;
    if (!cloud || !cloud.enabled) return;
    const user = await cloud.start(snapshot);
    if (!user) return;
    try {
      const remote = await cloud.pull();
      const dirty = localStorage.getItem(DIRTY_KEY) === '1';
      const sameDevice = localStorage.getItem(SYNC_USER_KEY) === user.id;
      if (!remote) {
        await cloud.pushNow(snapshot);
      } else if (!sameDevice && entries.length) {
        mergeRemote(remote);
        saveEntries(); saveShelves(); saveShelfColors();
        await cloud.pushNow(snapshot);
      } else if (dirty) {
        await cloud.pushNow(snapshot); // offline edits win
      } else {
        applyRemote(remote);
      }
      localStorage.setItem(SYNC_USER_KEY, user.id);
      localStorage.removeItem(DIRTY_KEY);
    } catch (e) {
      cloud.setStatus('offline');
    }
  }

  // ---- Pull fresh data when you come back to the app ----
  let lastResumePull = 0;
  async function refreshFromCloud() {
    const cloud = window.StacksCloud;
    if (!cloud || !cloud.enabled || !cloud.signedIn() || cloud.busy()) return;
    if (localStorage.getItem(DIRTY_KEY) === '1') return;            // unsynced edits: never overwrite
    const a = document.activeElement;
    if (a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return;     // don't disturb typing
    if (document.querySelector('dialog[open]')) return;
    if (Date.now() - lastResumePull < 10000) return;                 // at most every 10s
    lastResumePull = Date.now();
    try {
      const remote = await cloud.pull();
      if (!remote) return;
      if (cloud.busy() || localStorage.getItem(DIRTY_KEY) === '1') return; // edited while fetching
      if (JSON.stringify(remote) === JSON.stringify(snapshot())) return;   // nothing new
      applyRemote(remote);
      render();
      if (view === 'shelves') { renderBookshelf(); renderShelfContents(); }
      if (view === 'library') renderLibrary();
      showToast('Updated from your account');
    } catch (e) { /* offline: keep what's on screen */ }
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshFromCloud(); });
  window.addEventListener('pageshow', e => { if (e.persisted) refreshFromCloud(); });

  // ---- Smooth accordion for <details> panels ----
  // Native <details> snaps open/shut. This intercepts the summary click and
  // animates the height (plus a soft staggered fade of the contents).
  const SMOOTH_EASE = 'cubic-bezier(0.22, 0.7, 0.2, 1)';
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  function makeSmoothDetails(details) {
    if (!details || details.dataset.smooth) return;
    const summary = details.querySelector(':scope > summary');
    if (!summary) return;
    details.dataset.smooth = '1';
    let anim = null;
    let closing = false;

    function finish(open) {
      details.open = open;
      details.classList.remove('is-closing');
      details.style.height = '';
      details.style.overflow = '';
      anim = null;
      closing = false;
    }

    function run(from, to, open) {
      details.style.overflow = 'hidden';
      anim = details.animate(
        { height: [from + 'px', to + 'px'] },
        { duration: open ? 420 : 300, easing: SMOOTH_EASE }
      );
      if (open) {
        Array.from(details.children).forEach((child, i) => {
          if (child === summary) return;
          child.animate(
            [{ opacity: 0, transform: 'translateY(-8px)' }, { opacity: 1, transform: 'none' }],
            { duration: 380, delay: 40 + i * 40, easing: SMOOTH_EASE, fill: 'backwards' }
          );
        });
      }
      anim.onfinish = () => finish(open);
      anim.oncancel = () => { anim = null; };
    }

    summary.addEventListener('click', (e) => {
      e.preventDefault();
      if (reduceMotion.matches) { details.open = !details.open; return; }
      const startH = details.offsetHeight;
      if (anim) anim.cancel();
      const wantOpen = anim ? closing : !details.open;
      if (!wantOpen) {
        closing = true;
        details.classList.add('is-closing');
        run(startH, summary.offsetHeight, false);
      } else {
        closing = false;
        details.classList.remove('is-closing');
        details.style.height = '';
        details.open = true;
        const endH = details.offsetHeight;
        run(startH, endH, true);
      }
    });
  }
  makeSmoothDetails(document.getElementById('myTagsPanel'));
  makeSmoothDetails(filterPanel);

  // ---- Init ----
  render(); // show the local cache immediately
  syncOnStart().finally(() => {
    lastResumePull = Date.now();
    ingestFromURL(); // after sync, so a new card lands on top of your cloud data
    render();
    if (view === 'shelves') { renderBookshelf(); renderShelfContents(); }
    if (view === 'library') renderLibrary();
    if (pendingToast) showToast(pendingToast);
  });
})();
