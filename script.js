(function () {
  'use strict';

  const STORE_KEY = 'tbr-stacks-v1';
  const SHELVES_STORE_KEY = 'tbr-stacks-shelves-v1';
  let entries = loadEntries();
  let shelves = loadShelves(); // array of shelf names, in creation order — a fic lives on at most one

  // ---- Filter state ----
  let activeTags = new Set();      // your own custom tags — OR match
  let activeRatings = new Set();   // AO3 rating — OR match
  let statusFilter = 'all';        // 'all' | 'complete' | 'wip'
  let starFilter = 0;              // 0 = no filter, else "at least N stars"
  let wordMin = null;
  let wordMax = null;
  let activeAoTags = new Set();    // fandom/relationship/character/freeform — AND match
  let aoTagQuery = '';

  // ---- View state ----
  let view = 'catalog';   // 'catalog' | 'shelves'
  let activeShelf = null; // 'unshelved' | a shelf name | null (nothing pulled down yet)

  function loadEntries() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      return [];
    }
  }

  function saveEntries() {
    localStorage.setItem(STORE_KEY, JSON.stringify(entries));
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
  }

  // A fic with no shelf assignment lives on the always-present "unshelved" shelf
  function entryShelf(entry) {
    return entry.shelf || 'unshelved';
  }

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function splitParam(params, key) {
    const raw = params.get(key);
    return raw ? raw.split(',').map(t => t.trim()).filter(Boolean) : [];
  }

  // ---- Pick up new fic from URL params (from the AO3 "Info" button) ----
  function ingestFromURL() {
    const params = new URLSearchParams(window.location.search);
    const title = params.get('title');
    if (!title) return;

    const url = params.get('url') || '';
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
    const chapters = params.get('chapters') || '';
    const completeParam = params.get('complete');
    const complete = completeParam === '1' ? true : completeParam === '0' ? false : null;

    // Legacy fallback: older userscript versions sent one flat aoTags list
    const aoTagsParam = params.get('aoTags');
    const aoTags = aoTagsParam ? aoTagsParam.split(',').map(t => t.trim()).filter(Boolean) : [];

    const dupe = url && entries.find(e => e.url === url);
    if (!dupe) {
      entries.unshift({
        id: uid(),
        title,
        url,
        authors,
        summary,
        tags,
        notes: '',
        shelf: null,
        stars: null,
        rating,
        warnings,
        category,
        fandoms,
        relationships,
        characters,
        freeform,
        words,
        chapters,
        complete,
        aoTags, // kept for any entries filed under the old userscript
        dateAdded: new Date().toISOString(),
      });
      saveEntries();
    }

    // Clean the URL so refreshing doesn't re-add / re-run the query
    const cleanUrl = window.location.origin + window.location.pathname;
    window.history.replaceState({}, '', cleanUrl);
  }

  // ---- Rendering ----
  const grid = document.getElementById('cardGrid');
  const template = document.getElementById('cardTemplate');
  const emptyState = document.getElementById('emptyState');
  const entryCount = document.getElementById('entryCount');
  const tagRail = document.getElementById('tagRail');
  const searchInput = document.getElementById('searchInput');
  const ratingRail = document.getElementById('ratingRail');
  const statusRail = document.getElementById('statusRail');
  const starRail = document.getElementById('starRail');
  const wordMinInput = document.getElementById('wordMinInput');
  const wordMaxInput = document.getElementById('wordMaxInput');
  const aoTagSearch = document.getElementById('aoTagSearch');
  const aoTagRail = document.getElementById('aoTagRail');
  const filterCount = document.getElementById('filterCount');
  const clearFiltersBtn = document.getElementById('clearFiltersBtn');
  const filterPanel = document.getElementById('filterPanel');
  const viewTabs = document.querySelectorAll('.view-tab');
  const catalogView = document.getElementById('catalogView');
  const shelvesView = document.getElementById('shelvesView');
  const bookshelfRail = document.getElementById('bookshelfRail');
  const shelfContents = document.getElementById('shelfContents');

  const SPINE_PALETTE = ['var(--rose-deep)', 'var(--gold)', '#6E9B6E', '#5C8DBF', 'var(--coral)', 'var(--ink)'];

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
    wordMin = null;
    wordMax = null;
    wordMinInput.value = '';
    wordMaxInput.value = '';
    aoTagQuery = '';
    aoTagSearch.value = '';
    searchInput.value = '';

    if (kind === 'custom') {
      activeTags.add(tag);
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

    if (wordMin !== null && (entry.words === null || entry.words === undefined || entry.words < wordMin)) return false;
    if (wordMax !== null && (entry.words === null || entry.words === undefined || entry.words > wordMax)) return false;

    if (activeAoTags.size > 0) {
      const tags = entryAoTags(entry);
      const hasAll = Array.from(activeAoTags).every(t => tags.includes(t));
      if (!hasAll) return false;
    }

    if (!query) return true;
    const haystack = [
      entry.title, entry.authors, entry.summary, entry.notes,
      ...(entry.tags || []), ...entryAoTags(entry),
    ].join(' ').toLowerCase();
    return haystack.includes(query);
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

  function formatWords(n) {
    if (n === null || n === undefined || isNaN(n)) return '';
    return n.toLocaleString() + (n === 1 ? ' word' : ' words');
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
    const visible = entries.filter(e => matchesFilters(e, query));

    grid.innerHTML = '';
    visible.forEach(entry => grid.appendChild(buildCard(entry)));

    emptyState.hidden = entries.length !== 0;
    entryCount.textContent = visible.length === entries.length
      ? `${entries.length} card${entries.length === 1 ? '' : 's'} on file`
      : `${visible.length} of ${entries.length} cards`;

    renderTagRail();
    renderTagDatalist();
    renderRatingRail();
    renderStatusRail();
    renderStarFilterRail();
    renderAoTagRail();
    renderFilterCount();

    renderBookshelf();
    if (view === 'shelves') renderShelfContents();
  }

  // ---- Shelves view ----

  function spineWidth(key) {
    return 30 + (hashString(key) % 5) * 4; // 30–46px, stable per shelf name
  }

  function renderBookshelf() {
    if (!bookshelfRail) return;
    bookshelfRail.innerHTML = '';

    const items = [{ key: 'unshelved', label: 'Unshelved', special: true }]
      .concat(shelves.map(name => ({ key: name, label: name })));

    items.forEach(item => {
      const count = entries.filter(e => entryShelf(e) === item.key).length;

      const spine = document.createElement('button');
      spine.type = 'button';
      spine.className = 'spine' + (item.special ? ' spine-unshelved' : '') + (activeShelf === item.key ? ' active' : '');
      if (!item.special) {
        spine.style.background = SPINE_PALETTE[hashString(item.key) % SPINE_PALETTE.length];
      }
      spine.style.setProperty('--spine-w', spineWidth(item.key) + 'px');
      spine.title = `${item.label} (${count})`;
      spine.addEventListener('click', () => {
        activeShelf = item.key;
        renderBookshelf();
        renderShelfContents();
      });

      const label = document.createElement('span');
      label.className = 'spine-label';
      label.textContent = item.label;
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
    const list = entries.filter(e => entryShelf(e) === activeShelf);

    const header = document.createElement('div');
    header.className = 'shelf-header';

    const heading = document.createElement('h2');
    heading.textContent = isUnshelved ? 'Unshelved' : activeShelf;
    header.appendChild(heading);

    const count = document.createElement('span');
    count.className = 'shelf-count';
    count.textContent = `${list.length} card${list.length === 1 ? '' : 's'}`;
    header.appendChild(count);

    if (!isUnshelved) {
      const actions = document.createElement('div');
      actions.className = 'shelf-actions';

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

      actions.appendChild(renameBtn);
      actions.appendChild(deleteBtn);
      header.appendChild(actions);
    }

    shelfContents.appendChild(header);

    if (list.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'shelf-hint';
      empty.textContent = isUnshelved
        ? 'Nothing unshelved — everything has a home.'
        : 'Nothing filed here yet — use a card\'s shelf picker to add one.';
      shelfContents.appendChild(empty);
      return;
    }

    const grid = document.createElement('div');
    grid.className = 'card-grid';
    list.forEach(entry => grid.appendChild(buildCard(entry)));
    shelfContents.appendChild(grid);
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
    entries.forEach(e => { if (e.shelf === oldName) e.shelf = trimmed; });
    saveShelves();
    saveEntries();
    activeShelf = trimmed;
    render();
  }

  function deleteShelf(name) {
    if (!confirm(`Delete "${name}"? Fics on it move to Unshelved.`)) return;
    shelves = shelves.filter(s => s !== name);
    entries.forEach(e => { if (e.shelf === name) e.shelf = null; });
    saveShelves();
    saveEntries();
    activeShelf = 'unshelved';
    render();
  }

  function buildCard(entry) {
    const node = template.content.cloneNode(true);
    const card = node.querySelector('.card');
    card.dataset.id = entry.id;

    node.querySelector('.stub-date').textContent = formatDate(entry.dateAdded);
    node.querySelector('.stub-remove').addEventListener('click', () => removeEntry(entry.id));

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
    setupShelfSelect(node, entry);
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

  // Lets a card be moved onto a shelf (or back to Unshelved) from wherever it's shown
  function setupShelfSelect(node, entry) {
    const select = node.querySelector('.shelf-select');
    select.innerHTML = '';

    const unshelvedOpt = document.createElement('option');
    unshelvedOpt.value = '';
    unshelvedOpt.textContent = 'Unshelved';
    select.appendChild(unshelvedOpt);

    shelves.forEach(name => {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      select.appendChild(opt);
    });

    select.value = entry.shelf || '';

    select.addEventListener('change', () => {
      entry.shelf = select.value || null;
      saveEntries();
      renderBookshelf();
      if (view === 'shelves') renderShelfContents();
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

    if (entry.chapters) {
      const badge = document.createElement('span');
      badge.className = 'badge badge-chapters' + (entry.complete ? ' badge-complete' : '');
      badge.textContent = entry.complete ? `${entry.chapters} · complete` : entry.chapters;
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
    entries = entries.filter(e => e.id !== entryId);
    saveEntries();
    render();
  }

  // ---- Search & filter wiring ----
  searchInput.addEventListener('input', render);

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

  clearFiltersBtn.addEventListener('click', () => {
    activeTags.clear();
    activeRatings.clear();
    activeAoTags.clear();
    statusFilter = 'all';
    starFilter = 0;
    wordMin = null;
    wordMax = null;
    wordMinInput.value = '';
    wordMaxInput.value = '';
    aoTagQuery = '';
    aoTagSearch.value = '';
    render();
  });

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
      shelf: null,
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
      if (view === 'shelves') {
        renderBookshelf();
        renderShelfContents();
      }
    });
  });

  // ---- Scroll to top ----
  const toTopBtn = document.getElementById('toTopBtn');
  window.addEventListener('scroll', () => {
    toTopBtn.classList.toggle('visible', window.scrollY > 400);
  });
  toTopBtn.addEventListener('click', () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  // ---- Init ----
  ingestFromURL();
  render();
})();
