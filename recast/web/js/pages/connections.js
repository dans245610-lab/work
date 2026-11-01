import { h, mount, pf, statusChip, timeAgo, modal, field, toast, toastErr, busy, confirmDialog, emptyState, icon } from '../ui.js';
import { GET, POST, PATCH, DEL } from '../api.js';
import { store } from '../store.js';
import { parseHash } from '../app.js';

export async function connectionsPage(el) {
  const { params } = parseHash();
  if (params.get('connected')) { toast(`Connected ${store.connector(params.get('connected')).name}`, 'ok'); history.replaceState(null, '', '#/connections'); }
  if (params.get('error')) { toastErr(new Error(params.get('error'))); history.replaceState(null, '', '#/connections'); }

  const connectors = await store.connectorsList();
  const listEl = h('div');
  const render = async () => {
    const conns = await store.connectionsList(true);
    mount(listEl, conns.length ? h('div.grid.auto', conns.map(connCard)) : emptyState('No connections', ''));
  };

  const connCard = (c) => {
    const meta = store.connector(c.platform);
    return h('div.card.pad.col',
      h('div.row',
        c.avatar_url ? h('img.avatar', { src: c.avatar_url, alt: '', referrerpolicy: 'no-referrer' }) : pf(c.platform, meta.color),
        h('div.grow', h('div.ellipsis', { style: { fontWeight: 650 } }, c.label || c.account_name || meta.name), h('div.small.muted.ellipsis', meta.name, c.label && c.account_name ? ` · ${c.account_name}` : '')),
        c.demo ? h('span.chip.warn', { title: 'Publishing is simulated; sources generate sample clips' }, 'Demo') : null,
        c.status === 'error' ? statusChip('error') : c.status === 'disabled' ? statusChip('disabled') : null),
      h('div.chips', meta.roles.source ? h('span.chip', 'Source') : null, meta.roles.destination ? h('span.chip', 'Destination') : null,
        c.workflow_count ? h('span.chip.accent', `${c.workflow_count} workflow${c.workflow_count > 1 ? 's' : ''}`) : null),
      c.status_message ? h('div.small', { style: { color: c.status === 'error' ? 'var(--err)' : 'var(--muted)' } }, c.status_message) : null,
      meta.roles.source && !c.system ? h('div.tiny.faint', `Last checked ${timeAgo(c.last_polled_at)}`) : null,
      c.system ? h('div.small.muted', 'Everything you upload or import in the Library. Use it as a workflow source to auto-publish new uploads.') : h('div.row.wrap',
        h('button.btn.sm', { onclick: busy(async () => { const r = await POST(`/api/connections/${c.id}/test`); toast(r.message, r.ok ? 'ok' : 'err'); render(); }) }, 'Test'),
        meta.roles.source ? h('button.btn.sm', { onclick: busy(async () => { await POST(`/api/connections/${c.id}/poll`); toast('Checking for new content…'); setTimeout(render, 2500); }) }, 'Check now') : null,
        h('button.btn.sm', { onclick: () => editConnection(c, meta, render) }, 'Edit'),
        meta.auth === 'oauth2' && !c.demo ? h('button.btn.sm', { onclick: busy(() => startOAuth(meta)) }, 'Reconnect') : null,
        h('button.btn.sm.danger', {
          onclick: busy(async () => {
            if (!(await confirmDialog('Remove connection?', `Workflows using ${c.account_name || meta.name} will be deleted, and queued posts to it will be removed.`, { danger: true, okLabel: 'Remove' }))) return;
            await DEL(`/api/connections/${c.id}`); toast('Connection removed'); render();
          }),
        }, 'Remove')));
  };

  const addCard = (meta) => {
    const actions = [];
    if (meta.auth === 'oauth2') {
      actions.push(h('button.btn.sm.primary', { disabled: !meta.oauthConfigured, title: meta.oauthConfigured ? '' : 'Add this platform\'s API keys to the server .env to enable', onclick: busy(() => startOAuth(meta)) }, 'Connect'));
      if (meta.demoAvailable) actions.push(h('button.btn.sm', { onclick: busy(async () => { await POST('/api/connections', { platform: meta.id, demo: true }); toast(`Demo ${meta.name} connection added`, 'ok'); render(); }) }, 'Add demo'));
    } else {
      actions.push(h('button.btn.sm.primary', { onclick: () => fieldsDialog(meta, render) }, 'Add'));
    }
    return h('div.card.pad.col',
      h('div.row', pf(meta.id, meta.color, 'lg'), h('div.grow', h('h3', meta.name), h('div.chips', { style: { marginTop: '4px' } }, meta.roles.source ? h('span.chip', 'Source') : null, meta.roles.destination ? h('span.chip', 'Destination') : null))),
      h('div.small.muted.grow', meta.description),
      meta.auth === 'oauth2' && !meta.oauthConfigured ? h('div.tiny.faint', 'Not configured on this server — see Settings → Platform apps.') : null,
      h('div.row.wrap', actions));
  };

  mount(el,
    h('div.page-head', h('div', h('h1', 'Connections'), h('div.sub', 'Accounts and feeds Recast can pull content from or publish to.'))),
    listEl,
    h('div.section-title.mt-lg', 'Add a connection'),
    h('div.grid.auto', connectors.filter((c) => !c.system).map(addCard)));
  await render();
}

async function startOAuth(meta) {
  const { url } = await GET(`/api/oauth/${meta.id}/start`);
  location.href = url;
}

function fieldsDialog(meta, done) {
  const inputs = {};
  const label = h('input', { type: 'text', placeholder: 'Optional nickname' });
  const body = h('div.col',
    h('p.muted.small', meta.description),
    ...meta.fields.map((f) => { inputs[f.key] = h('input', { type: f.type || 'text', placeholder: f.placeholder || '', required: !!f.required }); return field(f.label, inputs[f.key]); }),
    field('Label', label));
  modal({
    title: `Add ${meta.name}`, body,
    foot: (close) => [h('button.btn', { onclick: close }, 'Cancel'), h('button.btn.primary', {
      onclick: busy(async () => {
        const config = Object.fromEntries(Object.entries(inputs).map(([k, i]) => [k, i.value.trim()]));
        await POST('/api/connections', { platform: meta.id, config, label: label.value });
        toast(`${meta.name} added`, 'ok'); close(); done();
      }),
    }, 'Add connection')],
  });
}

function editConnection(c, meta, done) {
  const label = h('input', { type: 'text', value: c.label || '' });
  const inputs = {};
  const paused = h('input', { type: 'checkbox', checked: c.status === 'disabled' });
  modal({
    title: `Edit ${meta.name}`,
    body: h('div.col', field('Label', label),
      ...(meta.fields || []).map((f) => { inputs[f.key] = h('input', { type: f.type || 'text', value: c.config?.[f.key] || '' }); return field(f.label, inputs[f.key]); }),
      meta.roles.source ? h('label.check', paused, 'Pause checking this source') : null,
      h('div.tiny.faint', `Connected ${new Date(c.created_at).toLocaleDateString()} · ID ${c.account_id || '—'}`)),
    foot: (close) => [h('button.btn', { onclick: close }, 'Cancel'), h('button.btn.primary', {
      onclick: busy(async () => {
        const body = { label: label.value, status: paused.checked ? 'disabled' : 'active' };
        if (Object.keys(inputs).length) body.config = Object.fromEntries(Object.entries(inputs).map(([k, i]) => [k, i.value.trim()]));
        await PATCH(`/api/connections/${c.id}`, body);
        toast('Saved', 'ok'); close(); done();
      }),
    }, 'Save')],
  });
}
