import { h, mount, field, toast, busy, pf, confirmDialog, modal } from '../ui.js';
import { GET, POST, PATCH, DEL } from '../api.js';
import { store } from '../store.js';

export async function settingsPage(el) {
  const [meta, connectors] = await Promise.all([store.metaInfo(true), store.connectorsList()]);
  const sys = meta.system;
  const name = h('input', { type: 'text', value: store.user.name || '' });
  const zones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [store.user.timezone];
  if (!zones.includes('UTC')) zones.unshift('UTC');
  const tz = h('select', zones.map((z) => h('option', { value: z, selected: z === store.user.timezone }, z)));
  const cur = h('input', { type: 'password', autocomplete: 'current-password' });
  const next = h('input', { type: 'password', autocomplete: 'new-password', placeholder: 'At least 8 characters' });

  const ok = (v, label, warn) => h('tr', h('td', label), h('td', v ? h('span.chip.ok', '✓') : h('span.chip.warn', 'Missing')), h('td.small.muted', v || warn));

  mount(el,
    h('div.page-head', h('div', h('h1', 'Settings'))),
    h('div.grid.cols-2.mb',
      h('div.card.pad.col', h('h2', 'Profile'), field('Name', name), field('Time zone', tz, 'Used for time-slot scheduling.'),
        h('div', h('button.btn.primary', { onclick: busy(async () => { store.user = (await PATCH('/api/auth/me', { name: name.value, timezone: tz.value })).user; toast('Profile saved', 'ok'); }) }, 'Save profile'))),
      h('div.card.pad.col', h('h2', 'Password'), field('Current password', cur), field('New password', next),
        h('div', h('button.btn', { onclick: busy(async () => { await POST('/api/auth/password', { current: cur.value, next: next.value }); cur.value = next.value = ''; toast('Password changed', 'ok'); }) }, 'Change password')))),
    h('div.card.mb', h('div.card-head', h('h2', 'Server status')),
      h('div.card-body',
        h('table.simple', h('tbody',
          ok(sys.ffmpeg, 'ffmpeg', 'Required for rendering. Install ffmpeg and set FFMPEG_PATH.'),
          ok(sys.ytdlp, 'yt-dlp', 'Optional. Needed to download from TikTok/YouTube/profile sources and social URL imports.'),
          ok(sys.font, 'Font for text overlays', 'Install DejaVu or set FONT_FILE to enable headlines and watermarks.'),
          h('tr', h('td', 'Public URL'), h('td', sys.publicUrlIsPublic ? h('span.chip.ok', '✓') : h('span.chip.warn', 'Local')),
            h('td.small.muted', h('span.mono', sys.publicBaseUrl), sys.publicUrlIsPublic ? '' : ' — Instagram, Facebook video and webhooks need a public https URL to fetch rendered videos.')),
          h('tr', h('td', 'Source checks'), h('td', h('span.chip', `${sys.pollIntervalMinutes} min`)), h('td.small.muted', 'POLL_INTERVAL_MINUTES')),
          h('tr', h('td', 'Folder root'), h('td'), h('td.small.mono', sys.folderRoot)),
          h('tr', h('td', 'Upload limit'), h('td'), h('td.small.muted', `${sys.maxUploadMb} MB`)),
          h('tr', h('td', 'Job queue'), h('td'), h('td.small.muted', `${meta.queue.pending || 0} pending · ${meta.queue.running || 0} running · ${meta.queue.failed || 0} failed (7 days)`)))))),
    h('div.card.mb', h('div.card-head', h('h2', 'Platform apps'), h('span.small.muted', 'OAuth credentials live in the server .env file')),
      h('div.card-body', { style: { overflowX: 'auto' } }, h('table.simple',
        h('thead', h('tr', h('th', 'Platform'), h('th', 'Status'), h('th', 'Redirect URI to register'))),
        h('tbody', connectors.filter((c) => c.auth === 'oauth2').map((c) => h('tr',
          h('td', h('span.row', pf(c.id, c.color, 'sm'), c.name)),
          h('td', c.oauthConfigured ? h('span.chip.ok', 'Configured') : h('span.chip', 'Not configured')),
          h('td', h('span.row', h('span.mono.ellipsis', c.redirectUri), h('button.btn.sm.ghost', { onclick: () => { navigator.clipboard?.writeText(c.redirectUri); toast('Copied'); } }, 'Copy'))))))),
        h('p.small.muted.mt', 'Create a developer app on each platform, add the redirect URI above, then set e.g. YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET in .env and restart. Until then you can use demo connections to try every workflow end-to-end.'))),
    h('div.card.pad', h('h2', { style: { color: 'var(--err)' } }, 'Danger zone'),
      h('p.small.muted.mt', 'Delete your account, connections, workflows, media and posts. Published posts stay on the platforms.'),
      h('button.btn.danger', { onclick: () => {
        const pw = h('input', { type: 'password', placeholder: 'Your password' });
        modal({ title: 'Delete account', body: h('div.col', h('p', 'This cannot be undone.'), field('Confirm with your password', pw)),
          foot: (close) => [h('button.btn', { onclick: close }, 'Cancel'), h('button.btn.danger', { onclick: busy(async () => { await DEL('/api/auth/me', { password: pw.value }); store.user = null; close(); location.hash = '#/login'; location.reload(); }) }, 'Delete everything')] });
      } }, 'Delete account')));
}
