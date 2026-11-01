import { h, mount, pf, statusChip, fmtDuration, fmtBytes, fmtDate, timeAgo, modal, field, toast, toastErr, busy, confirmDialog, emptyState, icon, seg, select, toLocalInput } from '../ui.js';
import { GET, POST, PATCH, DEL, upload } from '../api.js';
import { store } from '../store.js';
import { openPost } from './queue.js';

export async function libraryPage(el) {
  const connections = await store.connectionsList(true);
  const sources = connections.filter((c) => c.roles.source);
  const state = { q: '', connection: '', status: '' };
  const gridEl = h('div');
  const uploadsEl = h('div.col');
  let timer;

  const render = async () => {
    const qs = new URLSearchParams(Object.entries(state).filter(([, v]) => v));
    const { media, total } = await GET(`/api/media?${qs}&limit=120`);
    mount(gridEl, media.length
      ? [h('div.small.muted.mb', `${total} item${total === 1 ? '' : 's'}`), h('div.grid.auto-sm', media.map(card))]
      : h('div.card', emptyState('Your library is empty', 'Upload videos or audio, import from a URL, or let a workflow pull content from your sources.')));
    clearTimeout(timer);
    if (media.some((m) => ['queued', 'downloading', 'uploading'].includes(m.status))) timer = setTimeout(render, 3000);
  };

  const card = (m) => {
    const conn = connections.find((c) => c.id === m.connection_id);
    const meta = conn ? store.connector(conn.platform) : null;
    return h('div.card.media-card', { onclick: () => openMedia(m.id, render) },
      h('div.poster',
        m.thumb_url ? h('img', { src: m.thumb_url, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }) : icon(m.kind === 'audio' ? 'audio' : 'play'),
        m.duration ? h('span.dur', fmtDuration(m.duration)) : null,
        m.status !== 'ready' ? h('span.st', statusChip(m.status)) : null),
      h('div.meta', h('div.title', m.title || 'Untitled'),
        h('div.row.small.muted', { style: { marginTop: '6px' } }, meta ? pf(conn.platform, meta.color, 'sm') : null,
          h('span.ellipsis.grow', conn?.platform === 'upload' ? 'Upload' : conn?.label || conn?.account_name || ''), h('span.tiny', timeAgo(m.source_published_at || m.created_at)))));
  };

  const doUpload = async (files) => {
    for (const file of files) {
      const bar = h('div');
      const row = h('div.card.pad.row', icon('upload'), h('div.grow', h('div.ellipsis', file.name), h('div.progress', bar)), h('span.small.muted', fmtBytes(file.size)));
      uploadsEl.append(row);
      try {
        await upload('/api/media/upload', file, { onProgress: (p) => { bar.style.width = `${Math.round(p * 100)}%`; if (p >= 1) row.querySelector('.progress').classList.add('indet'); } });
        toast(`Uploaded ${file.name}`, 'ok');
      } catch (e) { toastErr(e); }
      row.remove();
      render();
    }
  };
  const fileInput = h('input', { type: 'file', multiple: true, accept: 'video/*,audio/*', class: 'hidden', onchange: (e) => { doUpload([...e.target.files]); e.target.value = ''; } });
  const drop = h('div.dropzone', icon('upload'), ' Drag & drop video or audio files here, or ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); fileInput.click(); } }, 'browse'));
  for (const ev of ['dragenter', 'dragover']) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); });
  for (const ev of ['dragleave', 'drop']) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); });
  drop.addEventListener('drop', (e) => doUpload([...e.dataTransfer.files]));

  const search = h('input', { type: 'text', placeholder: 'Search titles & descriptions', style: { maxWidth: '280px' }, oninput: (e) => { state.q = e.target.value; clearTimeout(search._t); search._t = setTimeout(render, 250); } });

  mount(el,
    h('div.page-head', h('div', h('h1', 'Library'), h('div.sub', 'Everything Recast has imported, plus your uploads.')),
      h('div.right.row', h('button.btn', { onclick: () => importDialog(render) }, icon('link'), 'Import URL'), h('button.btn.primary', { onclick: () => fileInput.click() }, icon('upload'), 'Upload'))),
    fileInput, drop, uploadsEl,
    h('div.row.wrap.mt.mb', search,
      select([['', 'All sources'], ...sources.map((c) => [c.id, `${store.connector(c.platform).name}${c.platform === 'upload' ? '' : ' — ' + (c.label || c.account_name)}`])], '', (v) => { state.connection = v; render(); }, { style: { maxWidth: '260px' } }),
      select([['', 'Any status'], ['ready', 'Ready'], ['remote', 'Not imported'], ['error', 'Errors']], '', (v) => { state.status = v; render(); }, { style: { maxWidth: '180px' } })),
    gridEl);
  await render();
  return () => clearTimeout(timer);
}

function importDialog(done) {
  const url = h('input', { type: 'url', placeholder: 'https://… (direct .mp4/.mp3 link, or a TikTok/YouTube/Instagram URL)' });
  const title = h('input', { type: 'text', placeholder: 'Optional — fetched automatically when possible' });
  modal({
    title: 'Import from URL',
    body: h('div.col', field('URL', url, 'Social links need yt-dlp installed on the server.'), field('Title', title)),
    foot: (close) => [h('button.btn', { onclick: close }, 'Cancel'), h('button.btn.primary', {
      onclick: busy(async () => { await POST('/api/media/import', { url: url.value.trim(), title: title.value.trim() }); toast('Import started'); close(); done(); }),
    }, 'Import')],
  });
}

// ---------------- Media detail ----------------
export async function openMedia(id, onChange) {
  const [{ media: m, posts }, connections, brandKits] = await Promise.all([GET(`/api/media/${id}`), store.connectionsList(), store.brandKitList()]);
  const title = h('input', { type: 'text', value: m.title });
  const desc = h('textarea', { rows: 4 });
  desc.value = m.description || '';
  const capInfo = h('span.small.muted');
  const refreshCaps = async () => {
    if (!m.has_captions) { capInfo.textContent = 'No captions attached'; return; }
    const { cues } = await GET(`/api/media/${id}/captions`);
    capInfo.textContent = `${cues.length} caption lines attached`;
  };
  refreshCaps();
  const capFile = h('input', { type: 'file', accept: '.srt,.vtt,text/vtt', class: 'hidden', onchange: busy(async (e) => {
    const f = e.target.files[0]; if (!f) return;
    const r = await fetch(`/api/media/${id}/captions`, { method: 'PUT', headers: { 'X-Requested-With': 'recast' }, body: await f.text() });
    const j = await r.json(); if (!r.ok) throw new Error(j.error);
    m.has_captions = true; toast(`Attached ${j.cues} caption lines`, 'ok'); refreshCaps();
  }) });

  const player = m.file_url
    ? (m.kind === 'audio' ? h('audio', { src: m.file_url, controls: true, style: { width: '100%' } }) : h('video.player', { src: m.file_url, controls: true, preload: 'metadata', playsinline: true }))
    : h('div.callout', m.status === 'error' ? `Download failed: ${m.error}` : 'This item has not been downloaded yet.');

  const postsEl = h('div.list', posts.length ? posts.map((p) => {
    const meta = store.connector(p.platform);
    return h('div.list-item.click', { onclick: () => openPost(p.id) }, pf(p.platform, meta.color, 'sm'), h('div.grow.small', meta.name, p.published_at ? ` · ${fmtDate(p.published_at)}` : p.scheduled_at ? ` · ${fmtDate(p.scheduled_at)}` : ''), statusChip(p.status));
  }) : h('div.small.muted', { style: { padding: '8px 0' } }, 'Not posted anywhere yet.'));

  const md = modal({
    title: 'Media', wide: true,
    body: h('div.grid.cols-2',
      h('div.col', player,
        h('div.chips', m.width ? h('span.chip', `${m.width}×${m.height}`) : null, m.duration ? h('span.chip', fmtDuration(m.duration)) : null, m.size ? h('span.chip', fmtBytes(m.size)) : null,
          h('span.chip', m.kind), statusChip(m.status)),
        m.source_url ? h('a.small', { href: m.source_url, target: '_blank', rel: 'noopener' }, icon('link'), ' Original post') : null,
        h('div.section-title', 'Posts'), postsEl),
      h('div.col',
        field('Title', title), field('Description', desc),
        h('div.row.wrap', h('button.btn.sm', { onclick: busy(async () => { await PATCH(`/api/media/${id}`, { title: title.value, description: desc.value }); toast('Saved', 'ok'); onChange?.(); }) }, 'Save details')),
        h('div.section-title', 'Captions (for burn-in)'),
        h('div.row.wrap', capInfo, capFile, h('button.btn.sm', { onclick: () => capFile.click() }, 'Upload .srt / .vtt'),
          h('button.btn.sm.ghost', { onclick: busy(async () => { await DEL(`/api/media/${id}/captions`); m.has_captions = false; refreshCaps(); }) }, 'Remove')),
        h('div.section-title', 'Actions'),
        h('div.row.wrap',
          h('button.btn.primary', { onclick: () => { md.close(); publishDialog(m, connections, brandKits, onChange); } }, 'Publish…'),
          m.status === 'ready' ? h('button.btn', { onclick: () => previewDialog(m, brandKits) }, 'Preview a format') : null,
          ['remote', 'error'].includes(m.status) ? h('button.btn', { onclick: busy(async () => { await POST(`/api/media/${id}/download`); toast('Import started'); md.close(); onChange?.(); }) }, 'Import now') : null,
          m.file_url ? h('a.btn', { href: `${m.file_url}?download=1` }, 'Download') : null,
          h('button.btn.danger', { onclick: busy(async () => {
            if (!(await confirmDialog('Delete media?', 'The file and every post made from it (including queued ones) will be removed. Published posts stay on the platforms.', { danger: true, okLabel: 'Delete' }))) return;
            await DEL(`/api/media/${id}`); toast('Deleted'); md.close(); onChange?.();
          }) }, 'Delete')))),
  });
}

function previewDialog(m, brandKits) {
  const t = { aspect: '9:16', fit: 'blur' };
  let brandKitId = brandKits[0]?.id || '';
  const out = h('div.center.muted.small', 'Renders the first few seconds at low quality.');
  modal({
    title: 'Preview a format',
    body: h('div.col',
      h('div.row.wrap', seg([['original', 'Original'], ['9:16', '9:16'], ['1:1', '1:1'], ['4:5', '4:5'], ['16:9', '16:9']], t.aspect, (v) => { t.aspect = v; }),
        seg([['blur', 'Blur'], ['crop', 'Crop'], ['pad', 'Bars']], t.fit, (v) => { t.fit = v; })),
      h('div.row.wrap', select([['', 'No brand kit'], ...brandKits.map((b) => [b.id, b.name])], brandKitId, (v) => { brandKitId = v; }, { style: { maxWidth: '220px' } }),
        h('label.check', h('input', { type: 'checkbox', onchange: (e) => { t.burnCaptions = e.target.checked; } }), 'Captions'),
        h('input', { type: 'text', placeholder: 'Hook headline', style: { maxWidth: '220px' }, oninput: (e) => { t.headline = e.target.value; } })),
      out),
    foot: (close) => [h('button.btn', { onclick: close }, 'Close'), h('button.btn.primary', {
      onclick: busy(async () => {
        mount(out, h('span.spinner'), ' Rendering…');
        try {
          const r = await POST(`/api/media/${m.id}/preview`, { transform: t, brandKitId: brandKitId ? Number(brandKitId) : null });
          mount(out, h('video.player', { src: r.url, controls: true, autoplay: true, loop: true, muted: true, playsinline: true, style: { maxHeight: '50vh' } }));
        } catch (e) { mount(out, ''); throw e; }
      }),
    }, 'Render preview')],
  });
}

function publishDialog(m, connections, brandKits, onChange) {
  const dests = connections.filter((c) => c.roles.destination);
  const picked = new Map();
  const listEl = h('div.col');
  let when = 'now';
  let at = toLocalInput(Date.now() + 3600_000);
  const render = () => mount(listEl, dests.length ? dests.map((c) => {
    const meta = store.connector(c.platform);
    const sel = picked.get(c.id);
    return h('div.dest',
      h('div.head', h('input', { type: 'checkbox', checked: !!sel, onchange: (e) => {
        if (e.target.checked) picked.set(c.id, { connectionId: c.id, transform: { ...meta.defaultTransform }, brandKitId: brandKits[0]?.id || null, caption: '', title: '' });
        else picked.delete(c.id);
        render();
      } }), pf(c.platform, meta.color, 'sm'), h('div.grow', meta.name, h('span.small.muted', ` · ${c.label || c.account_name}${c.demo ? ' (demo)' : ''}`))),
      sel ? h('div.body.col',
        h('div.row.wrap', seg([['original', 'Original'], ['9:16', '9:16'], ['1:1', '1:1'], ['4:5', '4:5'], ['16:9', '16:9']], sel.transform.aspect || 'original', (v) => { sel.transform.aspect = v; }),
          select([['', 'No brand kit'], ...brandKits.map((b) => [b.id, b.name])], sel.brandKitId || '', (v) => { sel.brandKitId = v ? Number(v) : null; }, { style: { maxWidth: '200px' } }),
          h('label.check', h('input', { type: 'checkbox', onchange: (e) => { sel.transform.burnCaptions = e.target.checked; } }), 'Burn captions')),
        meta.limits.titleMax ? h('input', { type: 'text', placeholder: `Title (default: ${m.title.slice(0, 40)}…)`, oninput: (e) => { sel.title = e.target.value; } }) : null,
        h('textarea', { rows: 3, placeholder: `Caption — leave empty to use the ${meta.name} default template`, oninput: (e) => { sel.caption = e.target.value; } })) : null);
  }) : h('div.callout.warn', 'Connect a destination account first.'));
  render();
  const atInput = h('input', { type: 'datetime-local', value: at, class: 'hidden', style: { maxWidth: '240px' }, onchange: (e) => { at = e.target.value; } });
  modal({
    title: `Publish “${m.title.slice(0, 50)}”`, wide: true,
    body: h('div.col', listEl, h('div.row.wrap', seg([['now', 'Publish now'], ['at', 'Schedule']], when, (v) => { when = v; atInput.classList.toggle('hidden', v !== 'at'); }), atInput)),
    foot: (close) => [h('button.btn', { onclick: close }, 'Cancel'), h('button.btn.primary', {
      onclick: busy(async () => {
        if (!picked.size) throw new Error('Pick at least one destination');
        const schedule = when === 'at' ? { mode: 'at', at: new Date(at).getTime() } : { mode: 'immediate' };
        const destinations = [...picked.values()].map((d) => ({
          connectionId: d.connectionId, transform: d.transform, brandKitId: d.brandKitId, schedule,
          ...(d.caption || d.title ? { caption: d.caption || undefined, title: d.title || undefined } : {}),
        }));
        const r = await POST(`/api/media/${m.id}/publish`, { destinations });
        toast(`Queued ${r.posts.length} post${r.posts.length > 1 ? 's' : ''}`, 'ok'); close(); onChange?.();
        location.hash = '#/queue';
      }),
    }, 'Queue posts')],
  });
}
