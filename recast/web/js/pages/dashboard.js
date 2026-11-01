import { h, mount, pf, statusChip, fmtDate, timeAgo, emptyState, icon } from '../ui.js';
import { GET } from '../api.js';
import { store } from '../store.js';
import { openPost } from './queue.js';

export async function dashboardPage(el) {
  const d = await GET('/api/dashboard');
  const c = d.counts;
  const stat = (label, value, sub, href) => h('a.card.stat', { href, style: { color: 'inherit', textDecoration: 'none' } }, h('div.label', label), h('div.value', value), sub ? h('div.small.muted', sub) : null);

  const s = d.setup;
  const steps = [
    [s.connections > 0, 'Connect a platform', 'Link TikTok, YouTube, Instagram… or add a demo connection to try things out.', '#/connections'],
    [s.workflows > 0, 'Create a workflow', 'Pick a source and where its videos should be published.', '#/workflows/new'],
    [s.brandLogo, 'Add your logo', 'Set up a brand kit so every video carries your branding.', '#/brand'],
    [s.media > 0, 'Upload or import a video', 'Drop a file in the Library or let a workflow pull one in.', '#/library'],
  ];
  const doneCount = steps.filter((x) => x[0]).length;
  const checklist = doneCount < steps.length ? h('div.card.pad.mb',
    h('div.row', h('h2', 'Get set up'), h('span.chip.accent', `${doneCount}/${steps.length}`)),
    h('div.checklist.mt', steps.map(([done, t, sub, href], i) => h(`div.item${done ? '.done' : ''}`,
      h('div.dot', done ? '✓' : i + 1), h('div.grow', h('div.t', { style: { fontWeight: 600 } }, t), h('div.small.muted', sub)),
      done ? null : h('a.btn.sm', { href }, 'Start'))))) : null;

  const max = Math.max(1, ...d.series.map((x) => x.count));
  const chart = h('div.card.pad',
    h('div.row', h('h2', 'Published per day'), h('span.right.small.muted', 'last 14 days')),
    h('div.bars', d.series.map((x) => h(`div.bar${x.count ? '.has' : ''}`, { style: { height: `${(x.count / max) * 100}%` }, 'data-tip': `${x.day}: ${x.count}` }))),
    h('div.bar-labels', d.series.map((x, i) => h('span', i % 2 === 0 ? x.day.slice(5).replace('-', '/') : ''))),
    d.byPlatform.length ? h('div.chips.mt', d.byPlatform.map((p) => h('span.chip', pf(p.platform, store.connector(p.platform).color, 'sm'), `${store.connector(p.platform).name}: ${p.n}`))) : null);

  const postRow = (p) => h('div.list-item.click', { onclick: () => openPost(p.id) },
    h('div.thumb', p.media?.thumb_url ? h('img', { src: p.media.thumb_url, alt: '' }) : icon(p.media?.kind === 'audio' ? 'audio' : 'play')),
    h('div.grow', h('div.ellipsis', { style: { fontWeight: 600 } }, p.title || p.media?.title || 'Untitled'),
      h('div.row.small.muted', pf(p.platform, p.color, 'sm'), h('span.ellipsis', p.connection?.account_name || p.platform_name),
        h('span', '·'), h('span', p.status === 'published' ? timeAgo(p.published_at) : p.scheduled_at ? fmtDate(p.scheduled_at) : timeAgo(p.created_at)))),
    statusChip(p.status));

  mount(el,
    h('div.page-head', h('div', h('h1', `Hi${store.user.name ? ', ' + store.user.name.split(' ')[0] : ''} 👋`), h('div.sub', 'Here is what your workflows have been up to.')),
      h('div.right.row', h('a.btn', { href: '#/library' }, icon('upload'), 'Upload'), h('a.btn.primary', { href: '#/workflows/new' }, icon('plus'), 'New workflow'))),
    checklist,
    h('div.grid.cols-4.mb',
      stat('Published this week', c.published_week, `${c.published_total} all time`, '#/queue?tab=published'),
      stat('Scheduled', c.scheduled, c.processing ? `${c.processing} processing` : 'queued to publish', '#/queue'),
      stat('Needs review', c.review, 'waiting for approval', '#/queue?tab=review'),
      stat('Failed', c.failed, c.failed ? 'retry from the queue' : 'all good', '#/queue?tab=failed')),
    h('div.grid.cols-2.mb', chart,
      h('div.card', h('div.card-head', h('h2', 'Up next'), h('a.right.small', { href: '#/queue' }, 'Open queue')),
        d.upcoming.length ? h('div.list', d.upcoming.map(postRow)) : emptyState('Nothing queued', 'New content from your sources will show up here.'))),
    h('div.grid.cols-2',
      h('div.card', h('div.card-head', h('h2', 'Recent results')),
        d.recent.length ? h('div.list', d.recent.map(postRow)) : emptyState('No posts yet', 'Published and failed posts appear here.')),
      h('div.card', h('div.card-head', h('h2', 'Activity'), h('a.right.small', { href: '#/activity' }, 'View all')),
        d.activity.length ? h('div.list', d.activity.map((a) => h('div.list-item', h('span.lvl', { class: a.level }), h('div.grow.small', a.message), h('span.tiny.faint', timeAgo(a.created_at)))))
          : emptyState('No activity yet', 'Connect a platform to get started.'))));
}
