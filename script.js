(function () {
  'use strict';

  const STORE_KEY = 'tbr-stacks-v1';
  let entries = loadEntries();
  let activeTags = new Set();

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

    const dupe = url && entries.find(e => e.url === url);
    if (!dupe) {
      entries.unshift({
        id: uid(),
        title,
        url,
        authors,
        summary,
        tags,
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

  function allTags() {
    const set = new Set();
    entries.forEach(e => e.tags.forEach(t => set.add(t)));
    return Array.from(set).sort((a, b) => a.localeCompare(b));
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

  function matchesFilters(entry, query) {
    const inTags = activeTags.size === 0 || entry.tags.some(t => activeTags.has(t));
    if (!inTags) return false;
    if (!query) return true;
    const haystack = (entry.title + ' ' + entry.authors).toLowerCase();
    return haystack.includes(query);
  }

  function extractOrSection(summary) {
    const match = summary.match(/\bor:\s*/i);
    if (!match) return summary;
    return summary.slice(match.index).trim();
  }

  function formatDate(iso) {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function render() {
    const query = searchInput.value.trim().toLowerCase();
    const visible = entries.filter(e => matchesFilters(e, query));

    grid.innerHTML = '';
    visible.forEach(entry => grid.appendChild(buildCard(entry)));

    emptyState.hidden = entries.length !== 0;
    entryCount.textContent = `${entries.length} card${entries.length === 1 ? '' : 's'} on file`;
    renderTagRail();
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

    const tagsWrap = node.querySelector('.card-tags');
    entry.tags.forEach(tag => tagsWrap.appendChild(buildPill(entry.id, tag)));

    const tagInput = node.querySelector('.tag-input');
    tagInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        addTag(entry.id, tagInput.value);
        tagInput.value = '';
      }
    });

    return node;
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

  // ---- Search ----
  searchInput.addEventListener('input', render);

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
      dateAdded: new Date().toISOString(),
    });
    saveEntries();
    document.getElementById('addForm').reset();
    render();
  });

  // ---- Init ----
  ingestFromURL();
  render();
})();
