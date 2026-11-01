import { h, mount, icon, toastErr, toast } from './ui.js';
import { GET, POST } from './api.js';
import { store } from './store.js';
import { authPage } from './pages/auth.js';
import { dashboardPage } from './pages/dashboard.js';
import { connectionsPage } from './pages/connections.js';
import { workflowsPage, workflowEditor } from './pages/workflows.js';
import { libraryPage } from './pages/library.js';
import { queuePage } from './pages/queue.js';
import { brandPage } from './pages/brand.js';
import { activityPage } from './pages/activity.js';
import { settingsPage } from './pages/settings.js';

const NAV = [
  ['#/', 'Dashboard', 'dashboard'],
  ['#/workflows', 'Workflows', 'workflows'],
  ['#/library', 'Library', 'library'],
  ['#/queue', 'Queue', 'queue'],
  ['#/connections', 'Connections', 'connections'],
  ['#/brand', 'Brand kits', 'brand'],
  ['#/activity', 'Activity', 'activity'],
  ['#/settings', 'Settings', 'settings'],
];

const ROUTES = [
  [/^\/$/, dashboardPage],
  [/^\/workflows$/, workflowsPage],
  [/^\/workflows\/new$/, (el) => workflowEditor(el, null)],
  [/^\/workflows\/(\d+)$/, (el, m) => workflowEditor(el, Number(m[1]))],
  [/^\/library$/, libraryPage],
  [/^\/queue$/, queuePage],
  [/^\/connections$/, connectionsPage],
  [/^\/brand$/, brandPage],
  [/^\/activity$/, activityPage],
  [/^\/settings$/, settingsPage],
];

const root = document.getElementById('app');
let shell = null;
let cleanup = null;

export function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [path, qs] = raw.split('?');
  return { path, params: new URLSearchParams(qs || '') };
}

function buildShell() {
  const main = h('main.main');
  const navEl = h('nav.nav');
  const reviewCount = h('span.count.hidden');
  const el = h('div.shell',
    h('aside.sidebar',
      h('div.brand', h('img', { src: '/favicon.svg', alt: '' }), 'Recast'),
      navEl,
      h('div.me', h('div.name', store.user.name || store.user.email), h('div.tiny', store.user.email),
        h('button', { onclick: async () => { await POST('/api/auth/logout'); store.user = null; store.invalidate(); location.hash = '#/login'; route(); } }, 'Sign out'))),
    h('div', h('div.mobile-bar', h('button', { onclick: () => el.classList.toggle('nav-open'), 'aria-label': 'Menu' }, '☰'), 'Recast'), main));
  for (const [href, label, ic] of NAV) {
    navEl.append(h('a', { href, 'data-href': href, onclick: () => el.classList.remove('nav-open') }, icon(ic), label, href === '#/queue' ? reviewCount : null));
  }
  el.addEventListener('click', (e) => { if (e.target === el) el.classList.remove('nav-open'); });
  return { el, main, navEl, reviewCount };
}

async function refreshBadges() {
  if (!shell) return;
  try {
    const { counts } = await GET('/api/posts?limit=1');
    const n = counts.needs_approval || 0;
    shell.reviewCount.textContent = n;
    shell.reviewCount.classList.toggle('hidden', !n);
    shell.reviewCount.title = `${n} post${n === 1 ? '' : 's'} waiting for review`;
  } catch { /* ignore */ }
}

export async function route() {
  if (cleanup) { try { cleanup(); } catch { /* ignore */ } cleanup = null; }
  const { path, params } = parseHash();
  if (!store.user) {
    try { store.user = (await GET('/api/auth/me')).user; } catch { store.user = null; }
  }
  if (!store.user) {
    shell = null;
    return authPage(root, path === '/signup' ? 'signup' : 'login');
  }
  if (path === '/login' || path === '/signup') { location.hash = '#/'; return; }
  if (!shell || !root.contains(shell.el)) { shell = buildShell(); mount(root, shell.el); }
  for (const a of shell.navEl.querySelectorAll('a')) {
    const href = a.dataset.href.slice(1);
    a.classList.toggle('active', href === '/' ? path === '/' : path.startsWith(href));
  }
  const found = ROUTES.map(([re, fn]) => [path.match(re), fn]).find(([m]) => m);
  const page = h('div');
  mount(shell.main, page);
  window.scrollTo(0, 0);
  if (!found) { mount(page, h('div.empty', h('h3', 'Page not found'), h('a', { href: '#/' }, 'Back to dashboard'))); return; }
  try {
    await store.connectorsList();
    const c = await found[1](page, found[0], params);
    if (typeof c === 'function') cleanup = c;
  } catch (e) {
    toastErr(e);
    mount(page, h('div.empty', h('h3', 'Something went wrong'), h('p', e.message)));
  }
  refreshBadges();
}

window.addEventListener('hashchange', route);
window.addEventListener('recast:unauthorized', () => { if (store.user) { store.user = null; toast('Your session expired — please sign in again'); location.hash = '#/login'; } });
setInterval(refreshBadges, 30000);
route();
