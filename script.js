(function () {
  'use strict';

  const STORE_KEY = 'tbr-stacks-v1';
  let entries = loadEntries();

  // ---- Filter state ----
  let activeTags = new Set();      // your own custom tags — OR match
  let activeRatings = new Set();   // AO3 rating — OR match
  let statusFilter = 'all';        // 'all' | 'complete' | 'wip'
  let wordMin = null;
  let wordMax = null;
  let activeAoTags = new Set();    // fandom/relationship/character/freeform — AND match
  let aoTagQuery = '';

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
  const wordMinInput = document.getElementById('wordMinInput');
  const wordMaxInput = document.getElementById('wordMaxInput');
  const aoTagSearch = document.getElementById('aoTagSearch');
  const aoTagRail = document.getElementById('aoTagRail');
  const filterCount = document.getElementById('filterCount');
  const clearFiltersBtn = document.getElementById('clearFiltersBtn');

  function allTags() {
    const set = new Set();
    entries.forEach(e => (e.tags || []).forEach(t => set.add(t)));
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }

  function entryAoTags(entry) {
    return [].concat(entry.fandoms || [], entry.relationships || [], entry.characters || [], entry.freeform || []);
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

    if (wordMin !== null && (entry.words === null || entry.words === undefined || entry.words < wordMin)) return false;
    if (wordMax !== null && (entry.words === null || entry.words === undefined || entry.words > wordMax)) return false;

    if (activeAoTags.size > 0) {
      const tags = entryAoTags(entry);
      const hasAll = Array.from(activeAoTags).every(t => tags.includes(t));
      if (!hasAll) return false;
    }

    if (!query) return true;
    const haystack = [
      entry.title, entry.authors, entry.summary,
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
    renderAoTagRail();
    renderFilterCount();
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
    setupAoTags(node, entry);

    return node;
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
        const pill = document.createElement('span');
        pill.className = 'pill-ao';
        pill.textContent = tag;
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
    const btn = document.createElement('button');
    btn.textContent = '✕';
    btn.title = `Remove tag "${tag}"`;
    btn.addEventListener('click', () => removeTag(entryId, tag));
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
