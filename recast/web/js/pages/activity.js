import { h, mount, fmtDate, emptyState, seg } from '../ui.js';
import { GET } from '../api.js';

export async function activityPage(el) {
  let level = '';
  let rows = [];
  const listEl = h('div.card');
  const more = h('button.btn.hidden', { onclick: () => load(true) }, 'Load more');
  const load = async (append = false) => {
    const before = append && rows.length ? rows[rows.length - 1].id : '';
    const { activity } = await GET(`/api/activity?${new URLSearchParams({ ...(level ? { level } : {}), ...(before ? { before } : {}) })}`);
    rows = append ? rows.concat(activity) : activity;
    more.classList.toggle('hidden', activity.length < 100);
    mount(listEl, rows.length ? h('div.list', rows.map((a) => h('div.list-item', { style: { alignItems: 'flex-start' } },
      h('span.lvl', { class: a.level }), h('div.grow', a.message), h('span.small.faint', { style: { whiteSpace: 'nowrap' } }, fmtDate(a.created_at)))))
      : emptyState('Nothing here yet', 'Activity from your workflows will be logged here.'));
  };
  mount(el, h('div.page-head', h('div', h('h1', 'Activity'), h('div.sub', 'A log of everything Recast did on your behalf.')),
    h('div.right', seg([['', 'All'], ['success', 'Published'], ['error', 'Errors'], ['info', 'Info']], level, (v) => { level = v; load(); }))),
  listEl, h('div.center.mt', more));
  await load();
}
