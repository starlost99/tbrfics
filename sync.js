(function () {
  'use strict';
  const cfg = window.STACKS_CONFIG || {};
  const enabled = !!(cfg.supabaseUrl && cfg.supabaseKey && window.supabase);
  const $ = id => document.getElementById(id);
  const accountBtn = $('accountBtn');
  const dlg = $('authDialog');
  let client = null, user = null, timer = null, pushing = false, pendingSnap = null;

  function setStatus(s) {
    accountBtn.classList.toggle('signed-in', s === 'ok');
    accountBtn.classList.toggle('offline', s === 'offline');
    accountBtn.textContent = !user ? 'Sign in' : s === 'offline' ? 'Offline' : s === 'saving' ? 'Saving…' : 'Synced';
  }

  async function pull() {
    const req = client.from('stacks').select('data').eq('user_id', user.id).maybeSingle();
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 6000));
    const { data, error } = await Promise.race([req, timeout]);
    if (error) throw error;
    return data ? data.data : null;
  }

  async function pushNow(getSnap) {
    if (!user) return;
    setStatus('saving');
    const { error } = await client.from('stacks').upsert({
      user_id: user.id, data: getSnap(), updated_at: new Date().toISOString(),
    });
    if (error) { setStatus('offline'); throw error; }
    localStorage.removeItem('tbr-stacks-dirty');
    setStatus('ok');
  }

  function queuePush(getSnap) {
    if (!user) return;
    pendingSnap = getSnap;
    clearTimeout(timer);
    timer = setTimeout(async () => {
      if (pushing) return queuePush(getSnap);
      pushing = true;
      try { await pushNow(pendingSnap); } catch (e) { /* stays dirty; retried on next change */ }
      pushing = false;
    }, 1500);
  }

  async function start(getSnap) {
    const { data } = await client.auth.getSession();
    user = data.session ? data.session.user : null;
    setStatus(user ? 'ok' : '');
    window.addEventListener('online', () => {
      if (user && localStorage.getItem('tbr-stacks-dirty') === '1') queuePush(getSnap);
    });
    return user;
  }

  // ---- UI ----
  function msg(t) { $('authMsg').textContent = t || ''; }
  function openDialog() {
    const signedIn = !!user;
    $('authTitle').textContent = signedIn ? 'Account' : 'Sign in';
    $('authNote').textContent = signedIn ? `Signed in as ${user.email}. Changes sync automatically.` : 'Sync your stacks across devices.';
    $('authFields').hidden = signedIn;
    $('authSubmit').hidden = signedIn;
    $('authSignUp').hidden = signedIn;
    $('authSignOut').hidden = !signedIn;
    msg('');
    dlg.showModal();
  }

  accountBtn.addEventListener('click', () => {
    if (!enabled) { alert('Cloud sync isn\'t set up yet — fill in config.js first.'); return; }
    openDialog();
  });
  $('authCancel').addEventListener('click', () => dlg.close());

  async function auth(kind) {
    const email = $('authEmail').value.trim(), password = $('authPassword').value;
    if (!email || password.length < 6) { msg('Enter an email and a password (6+ characters).'); return; }
    msg('One moment…');
    const fn = kind === 'up' ? client.auth.signUp : client.auth.signInWithPassword;
    const { data, error } = await fn.call(client.auth, { email, password });
    if (error) { msg(error.message); return; }
    if (kind === 'up' && !data.session) { msg('Check your email to confirm, then sign in.'); return; }
    location.reload();
  }
  $('authForm').addEventListener('submit', e => { e.preventDefault(); auth('in'); });
  $('authSignUp').addEventListener('click', () => auth('up'));
  $('authSignOut').addEventListener('click', async () => {
    if (localStorage.getItem('tbr-stacks-dirty') === '1' && !confirm('Some changes haven\'t synced yet and would be lost. Sign out anyway?')) return;
    await client.auth.signOut();
    ['tbr-stacks-v1', 'tbr-stacks-shelves-v1', 'tbr-stacks-shelf-colors-v1', 'tbr-stacks-dirty', 'tbr-stacks-sync-user']
      .forEach(k => localStorage.removeItem(k));
    location.reload();
  });

  if (enabled) client = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey);

  window.StacksCloud = { enabled, start, pull, pushNow, queuePush, setStatus };
})();
