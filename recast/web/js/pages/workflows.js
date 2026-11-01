import { h, mount, pf, statusChip, timeAgo, modal, field, toast, busy, confirmDialog, emptyState, icon, seg, select, toggle, fmtDate } from '../ui.js';
import { GET, POST, PUT, PATCH, DEL } from '../api.js';
import { store } from '../store.js';
import { buildPostText } from '/shared/templates.js';

// ---------------- List ----------------
export async function workflowsPage(el) {
  const listEl = h('div.col');
  const render = async () => {
    const { workflows } = await GET('/api/workflows');
    if (!workflows.length) {
      mount(listEl, h('div.card', emptyState('No workflows yet', 'A workflow watches a source (like your TikTok or a podcast feed) and publishes each new item to your destinations.',
        h('a.btn.primary', { href: '#/workflows/new' }, icon('plus'), 'Create your first workflow'))));
      return;
    }
    mount(listEl, workflows.map((w) => {
      const src = w.source ? store.connector(w.source.platform) : null;
      return h('div.card',
        h('div.card-body.row.wrap.gap-lg',
          toggle(w.enabled, busy(async (on) => { await PATCH(`/api/workflows/${w.id}`, { enabled: on }); toast(on ? 'Workflow enabled' : 'Workflow paused'); })),
          h('div.grow', { style: { minWidth: '220px' } },
            h('a', { href: `#/workflows/${w.id}`, style: { color: 'inherit' } }, h('h3', w.name)),
            h('div.row.wrap.small.muted', { style: { marginTop: '6px' } },
              src ? pf(w.source.platform, src.color, 'sm') : null, h('span', w.source?.label || w.source?.account_name || src?.name),
              h('span.flow-arrow', '→'),
              h('span.stack', w.destinations.map((d) => pf(d.connection?.platform || '', store.connector(d.connection?.platform).color, 'sm'))),
              h('span', w.destinations.map((d) => d.connection?.label || d.connection?.account_name || store.connector(d.connection?.platform).name).join(', '))),
            w.source?.status_message ? h('div.tiny', { style: { color: 'var(--warn)', marginTop: '4px' } }, w.source.status_message) : null),
          h('div.chips',
            h('span.chip.ok', `${w.stats.published} published`),
            w.stats.pending ? h('span.chip.info', `${w.stats.pending} in progress`) : null,
            w.stats.review ? h('span.chip.warn', `${w.stats.review} to review`) : null,
            w.stats.failed ? h('a.chip.err', { href: `#/queue?tab=failed` }, `${w.stats.failed} failed`) : null),
          h('div.row.wrap',
            h('button.btn.sm', { onclick: busy(async () => { const r = await POST(`/api/workflows/${w.id}/run`); toast(r.message); }) }, icon('refresh'), 'Run now'),
            h('button.btn.sm', { onclick: () => backfillDialog(w, render) }, 'Repurpose existing'),
            h('a.btn.sm', { href: `#/workflows/${w.id}` }, 'Edit'),
            h('button.btn.sm.danger', {
              onclick: busy(async () => {
                if (!(await confirmDialog('Delete workflow?', `“${w.name}” will stop running. Queued posts from it are canceled; published posts are kept.`, { danger: true, okLabel: 'Delete' }))) return;
                await DEL(`/api/workflows/${w.id}`); toast('Workflow deleted'); render();
              }),
            }, 'Delete'))),
        h('div.tiny.faint', { style: { padding: '0 18px 12px' } },
          w.source?.platform === 'upload' ? 'Runs whenever you upload or import to the Library' : `Source checked ${timeAgo(w.source?.last_polled_at)}`,
          w.stats.lastPublished ? ` · last published ${timeAgo(w.stats.lastPublished)}` : '', ` · only content published after ${fmtDate(w.cutoffAt)} is picked up automatically`));
    }));
  };
  mount(el, h('div.page-head', h('div', h('h1', 'Workflows'), h('div.sub', 'Automations that turn every new piece of content into posts everywhere.')),
    h('a.btn.primary.right', { href: '#/workflows/new' }, icon('plus'), 'New workflow')), listEl);
  await render();
}

function backfillDialog(w, done) {
  const count = h('input', { type: 'number', min: 1, max: 50, value: 5 });
  modal({
    title: 'Repurpose existing content',
    body: h('div.col', h('p.muted', `Queue the most recent items from this workflow's source that it hasn't handled yet. They go through the same formatting, captions and schedule as new content.`),
      field('How many items?', count, 'Up to 50. Items not yet downloaded are imported first.')),
    foot: (close) => [h('button.btn', { onclick: close }, 'Cancel'), h('button.btn.primary', {
      onclick: busy(async () => {
        const r = await POST(`/api/workflows/${w.id}/backfill`, { count: Number(count.value) });
        toast(r.items ? `Queued ${r.posts} post${r.posts === 1 ? '' : 's'} from ${r.items} item${r.items === 1 ? '' : 's'}` : 'Nothing new to repurpose — check the source for content first', r.items ? 'ok' : '');
        close(); done?.();
      }),
    }, 'Queue posts')],
  });
}

// ---------------- Editor ----------------
const ASPECTS = [['original', 'Original'], ['9:16', '9:16'], ['1:1', '1:1'], ['4:5', '4:5'], ['16:9', '16:9']];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const SAMPLE = { title: 'How I edit a video in 60 seconds #editing', description: 'My fastest workflow, step by step 👇\nFollow @me for more #creator #tips', source_url: 'https://example.com/v/123', created_at: Date.now() };

export async function workflowEditor(el, id) {
  const [connections, brandKits] = await Promise.all([store.connectionsList(true), store.brandKitList(true)]);
  const existing = id ? (await GET(`/api/workflows/${id}`)).workflow : null;
  const sources = connections.filter((c) => c.roles.source);
  const dests = connections.filter((c) => c.roles.destination);

  const wf = existing ? structuredClone(existing) : { name: '', enabled: true, sourceConnectionId: null, filters: {}, destinations: [] };
  let backfill = 0;
  let sample = SAMPLE;

  const sourceEl = h('div');
  const filtersEl = h('div');
  const destsEl = h('div');

  const loadSample = async () => {
    if (!wf.sourceConnectionId) return;
    try {
      const { media } = await GET(`/api/media?connection=${wf.sourceConnectionId}&limit=1`);
      sample = media[0] ? { ...media[0] } : SAMPLE;
    } catch { sample = SAMPLE; }
    renderDests();
  };

  const renderSource = () => mount(sourceEl,
    sources.length ? h('div.grid.auto-sm', sources.map((c) => {
      const meta = store.connector(c.platform);
      return h(`button.src-option${wf.sourceConnectionId === c.id ? '.on' : ''}`, { type: 'button', onclick: () => { wf.sourceConnectionId = c.id; if (!wf.name) nameInput.value = wf.name = `${c.label || c.account_name || meta.name} → everywhere`; renderSource(); loadSample(); } },
        c.avatar_url ? h('img.avatar', { src: c.avatar_url, alt: '' }) : pf(c.platform, meta.color),
        h('div.grow', h('div.ellipsis', { style: { fontWeight: 600 } }, c.label || c.account_name || meta.name), h('div.tiny.muted', meta.name, c.demo ? ' · demo' : '')));
    })) : emptyState('No sources yet', 'Connect a platform first.', h('a.btn', { href: '#/connections' }, 'Go to connections')),
    wf.sourceConnectionId && !connections.find((c) => c.id === wf.sourceConnectionId)?.demo && store.connector(connections.find((c) => c.id === wf.sourceConnectionId)?.platform).sourceNote
      ? h('div.callout.small.mt', store.connector(connections.find((c) => c.id === wf.sourceConnectionId).platform).sourceNote) : null);

  const f = wf.filters;
  const fInput = (key, attrs) => { const i = h('input', { ...attrs, value: f[key] ?? '', oninput: (e) => { f[key] = attrs.type === 'number' ? (e.target.value === '' ? undefined : Number(e.target.value)) : e.target.value; } }); return i; };
  mount(filtersEl, h('div.form-grid',
    field('Must include any of', fInput('includeKeywords', { type: 'text', placeholder: 'keyword, another' })),
    field('Skip if it includes', fInput('excludeKeywords', { type: 'text', placeholder: 'ad, sponsored' })),
    field('Required hashtags', fInput('requiredHashtags', { type: 'text', placeholder: '#repost' })),
    field('Min length (s)', fInput('minDuration', { type: 'number', min: 0 })),
    field('Max length (s)', fInput('maxDuration', { type: 'number', min: 0 })),
    field('Orientation', select([['any', 'Any'], ['portrait', 'Portrait only'], ['landscape', 'Landscape only'], ['square', 'Square only']], f.orientation || 'any', (v) => { f.orientation = v; }))));

  const addDest = (connId) => {
    const c = connections.find((x) => x.id === Number(connId));
    const meta = store.connector(c.platform);
    const options = Object.fromEntries((meta.destinationOptions || []).map((o) => [o.key, o.default]));
    wf.destinations.push({
      connectionId: c.id, brandKitId: brandKits[0]?.id || null, transform: { normalizeAudio: true, ...meta.defaultTransform },
      titleTemplate: meta.defaultTemplates.title, captionTemplate: meta.defaultTemplates.caption, schedule: { mode: 'immediate' }, options, _tab: 'format',
    });
    renderDests();
  };

  const renderDests = () => {
    const used = new Set(wf.destinations.map((d) => d.connectionId));
    const available = dests.filter((c) => !used.has(c.id) && c.id !== wf.sourceConnectionId);
    mount(destsEl,
      wf.destinations.map((d, i) => destPanel(d, i)),
      available.length ? h('div.row.wrap',
        select([['', '+ Add a destination…'], ...available.map((c) => [c.id, `${store.connector(c.platform).name} — ${c.label || c.account_name}${c.demo ? ' (demo)' : ''}`])], '', (v) => v && addDest(v), { style: { maxWidth: '420px' } }))
        : dests.length ? h('div.small.muted', 'All your destination accounts are already in this workflow.') : h('div.callout.warn', 'You have no destination accounts yet. ', h('a', { href: '#/connections' }, 'Connect one'), ' first.'));
  };

  const destPanel = (d, i) => {
    const c = connections.find((x) => x.id === d.connectionId) || d.connection || {};
    const meta = store.connector(c.platform);
    const body = h('div.body');
    d._tab ||= 'format';
    const tabs = [['format', 'Format'], ['text', 'Caption'], ['schedule', 'Schedule'], ...(meta.destinationOptions?.length ? [['platform', meta.name + ' options']] : [])];
    const tabsEl = h('div.subtabs');
    const renderTab = () => {
      mount(tabsEl, tabs.map(([k, l]) => h(`button${d._tab === k ? '.on' : ''}`, { type: 'button', onclick: () => { d._tab = k; renderTab(); } }, l)));
      mount(body, tabsEl, { format: formatTab, text: textTab, schedule: scheduleTab, platform: platformTab }[d._tab](d, meta));
    };
    renderTab();
    return h('div.dest',
      h('div.head', pf(c.platform, meta.color), h('div.grow', h('div', { style: { fontWeight: 650 } }, meta.name), h('div.tiny.muted', c.label || c.account_name, c.demo ? ' · demo' : '')),
        h('button.btn.sm.ghost.danger', { type: 'button', onclick: () => { wf.destinations.splice(i, 1); renderDests(); } }, 'Remove')),
      body);
  };

  const formatTab = (d, meta) => {
    const t = d.transform;
    const num = (key, attrs = {}) => h('input', { type: 'number', step: 'any', min: 0, ...attrs, value: t[key] ?? '', oninput: (e) => { t[key] = e.target.value === '' ? undefined : Number(e.target.value); } });
    const chk = (key, label, help) => h('label.check', { title: help || '' }, h('input', { type: 'checkbox', checked: key === 'normalizeAudio' ? t[key] !== false : !!t[key], onchange: (e) => { t[key] = e.target.checked; } }), label);
    return h('div.col',
      h('div.row.wrap.gap-lg',
        field('Aspect ratio', seg(ASPECTS, t.aspect || 'original', (v) => { t.aspect = v; })),
        field('Fill mode', seg([['blur', 'Blur fill'], ['crop', 'Crop'], ['pad', 'Bars']], t.fit || 'blur', (v) => { t.fit = v; }))),
      h('div.form-grid',
        field('Brand kit', select([['', 'None'], ...brandKits.map((b) => [b.id, b.name])], d.brandKitId || '', (v) => { d.brandKitId = v ? Number(v) : null; })),
        field('Max length (s)', num('maxDuration', { placeholder: meta.limits.maxDuration ? `${meta.limits.maxDuration} (platform max)` : 'no limit' })),
        field('Trim start (s)', num('trimStart', { placeholder: '0' })),
        field('Cut from end (s)', num('cutEnd', { placeholder: '0' }), 'e.g. 3–4s removes a TikTok end screen'),
        field('Speed', num('speed', { min: 0.25, max: 4, step: 0.05, placeholder: '1' }))),
      field('Hook headline (optional)', h('input', { type: 'text', value: t.headline || '', placeholder: 'Shown big at the top for the first seconds', oninput: (e) => { t.headline = e.target.value; } })),
      h('div.row.wrap.gap-lg',
        chk('burnCaptions', 'Burn in captions', 'Uses the captions file attached to the media in the Library'),
        chk('normalizeAudio', 'Normalize loudness'),
        chk('mute', 'Mute original audio'),
        chk('flip', 'Mirror video'),
        h('label.check', h('input', { type: 'checkbox', checked: t.quality === 'high', onchange: (e) => { t.quality = e.target.checked ? 'high' : 'standard'; } }), 'High quality')));
  };

  const textTab = (d, meta) => {
    const o = d.options;
    const previewEl = h('div.preview-box');
    const counter = h('div.counter');
    const update = () => {
      const { title, caption } = buildPostText(sample, { title_template: d.titleTemplate, caption_template: d.captionTemplate, options: o }, { platform: meta.name, account: '' }, meta.limits || {});
      mount(previewEl, meta.limits.titleMax ? h('div', h('strong', title)) : null, meta.limits.titleMax ? h('div.divider') : null, caption || h('span.faint', '(empty caption)'));
      const len = [...caption].length;
      counter.textContent = meta.limits.captionMax && meta.limits.captionMax < 50000 ? `${len} / ${meta.limits.captionMax} characters (long captions are trimmed automatically)` : `${len} characters`;
      counter.classList.toggle('over', !!meta.limits.captionMax && len > meta.limits.captionMax);
    };
    const titleIn = h('input', { type: 'text', value: d.titleTemplate || '', oninput: (e) => { d.titleTemplate = e.target.value; update(); } });
    const capIn = h('textarea', { rows: 4, oninput: (e) => { d.captionTemplate = e.target.value; update(); } });
    capIn.value = d.captionTemplate || '';
    let lastFocus = capIn;
    titleIn.addEventListener('focus', () => { lastFocus = titleIn; });
    capIn.addEventListener('focus', () => { lastFocus = capIn; });
    const insertVar = (v) => {
      const i = lastFocus; const s = i.selectionStart ?? i.value.length;
      i.value = i.value.slice(0, s) + `{{${v}}}` + i.value.slice(i.selectionEnd ?? s);
      i.dispatchEvent(new Event('input')); i.focus();
    };
    const optChk = (key, label) => h('label.check', h('input', { type: 'checkbox', checked: !!o[key], onchange: (e) => { o[key] = e.target.checked; update(); } }), label);
    update();
    return h('div.grid.cols-2',
      h('div.col',
        meta.limits.titleMax ? field('Title', titleIn) : null,
        field('Caption', capIn),
        h('div.chips', ['title', 'description', 'hashtags', 'first_line', 'source_url', 'date'].map((v) => h('span.chip.click', { onclick: () => insertVar(v) }, `{{${v}}}`))),
        h('div.form-grid',
          field('Add hashtags', h('input', { type: 'text', value: o.addHashtags || '', placeholder: '#shorts #fyp', oninput: (e) => { o.addHashtags = e.target.value; update(); } })),
          field('Remove hashtags', h('input', { type: 'text', value: o.removeHashtags || '', placeholder: '#tiktok #fyp', oninput: (e) => { o.removeHashtags = e.target.value; update(); } }))),
        h('div.row.wrap.gap-lg', optChk('stripSourceHashtags', 'Strip hashtags from source text'), optChk('stripMentions', 'Strip @mentions'))),
      h('div.col', h('div.small.muted', sample === SAMPLE ? 'Preview with a sample post' : `Preview using “${sample.title}”`), previewEl, counter));
  };

  const scheduleTab = (d) => {
    const s = d.schedule;
    const inner = h('div');
    const renderInner = () => {
      if (s.mode === 'delay') mount(inner, field('Wait (minutes)', h('input', { type: 'number', min: 1, value: s.minutes || 60, style: { maxWidth: '160px' }, oninput: (e) => { s.minutes = Number(e.target.value); } })));
      else if (s.mode === 'slots') {
        s.days ||= [1, 2, 3, 4, 5]; s.times ||= ['09:00', '17:00'];
        const timesEl = h('div.row.wrap');
        const renderTimes = () => mount(timesEl, s.times.map((t, i) => h('div.row', { style: { gap: '4px' } },
          h('input', { type: 'time', value: t, style: { width: '120px' }, onchange: (e) => { s.times[i] = e.target.value; } }),
          h('button.btn.sm.ghost', { type: 'button', onclick: () => { s.times.splice(i, 1); renderTimes(); } }, '×'))),
          h('button.btn.sm', { type: 'button', onclick: () => { s.times.push('12:00'); renderTimes(); } }, '+ Time'));
        renderTimes();
        mount(inner, h('div.col',
          h('div.row.wrap', DAYS.map((dn, i) => h('label.check', h('input', { type: 'checkbox', checked: s.days.includes(i), onchange: (e) => { s.days = e.target.checked ? [...s.days, i].sort() : s.days.filter((x) => x !== i); } }), dn))),
          timesEl,
          h('div.small.muted', `Each post takes the next free slot in your time zone (${store.user.timezone}). Change it in Settings.`)));
      } else mount(inner, h('div.small.muted', 'Posts go out as soon as rendering finishes.'));
    };
    renderInner();
    return h('div.col',
      seg([['immediate', 'Right away'], ['delay', 'After a delay'], ['slots', 'Time slots']], s.mode || 'immediate', (v) => { s.mode = v; renderInner(); }),
      inner,
      h('div.divider'),
      h('label.check', h('input', { type: 'checkbox', checked: !!d.options.requireApproval, onchange: (e) => { d.options.requireApproval = e.target.checked; } }), 'Hold for my approval before publishing'));
  };

  const platformTab = (d, meta) => h('div.form-grid', (meta.destinationOptions || []).map((o) => {
    if (o.type === 'select') return field(o.label, select(o.options.map((x) => [x, x]), d.options[o.key] ?? o.default, (v) => { d.options[o.key] = v; }), o.help);
    if (o.type === 'checkbox') return h('label.check', h('input', { type: 'checkbox', checked: d.options[o.key] ?? o.default, onchange: (e) => { d.options[o.key] = e.target.checked; } }), o.label);
    return field(o.label, h('input', { type: 'text', value: d.options[o.key] ?? o.default ?? '', oninput: (e) => { d.options[o.key] = e.target.value; } }), o.help);
  }));

  const nameInput = h('input', { type: 'text', value: wf.name, placeholder: 'e.g. TikTok → Shorts & Reels', oninput: (e) => { wf.name = e.target.value; } });
  const save = busy(async () => {
    const body = {
      name: wf.name, enabled: wf.enabled, sourceConnectionId: wf.sourceConnectionId, filters: wf.filters,
      destinations: wf.destinations.map(({ _tab, connection, ...d }) => d),
    };
    const r = existing ? await PUT(`/api/workflows/${existing.id}`, body) : await POST('/api/workflows', body);
    if (!existing && backfill > 0) {
      const b = await POST(`/api/workflows/${r.workflow.id}/backfill`, { count: backfill });
      if (b.posts) toast(`Also queued ${b.posts} post${b.posts > 1 ? 's' : ''} from existing content`);
    }
    toast(existing ? 'Workflow saved' : 'Workflow created — it runs automatically from now on', 'ok');
    location.hash = '#/workflows';
  });

  const step = (n, title, sub, content) => h('div.card.mb', h('div.card-head', h('span.chip.accent', String(n)), h('div', h('h2', title), sub ? h('div.small.muted', sub) : null)), h('div.card-body', content));

  mount(el,
    h('div.page-head', h('div', h('a.small', { href: '#/workflows' }, '← Workflows'), h('h1', existing ? 'Edit workflow' : 'New workflow'))),
    h('div.card.pad.mb.row.wrap', h('div.grow', field('Workflow name', nameInput)), h('label.check', toggle(wf.enabled, (v) => { wf.enabled = v; }), 'Enabled')),
    step(1, 'Source', 'Where new content comes from.', sourceEl),
    step(2, 'Filters', 'Optional: only repurpose items that match.', filtersEl),
    step(3, 'Destinations', 'Where it goes, and how it should look on each platform.', destsEl),
    existing ? null : step(4, 'Existing content', 'Workflows only pick up content published from now on. Want to start with some older items too?',
      field('Also repurpose my most recent', h('input', { type: 'number', min: 0, max: 50, value: 0, style: { maxWidth: '140px' }, oninput: (e) => { backfill = Number(e.target.value) || 0; } }), 'items from the source (0 = none)')),
    h('div.sticky-foot', h('a.btn', { href: '#/workflows' }, 'Cancel'), h('button.btn.primary', { onclick: save }, existing ? 'Save changes' : 'Create workflow')));

  renderSource();
  renderDests();
  if (wf.sourceConnectionId) loadSample();
}
