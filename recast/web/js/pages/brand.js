import { h, mount, field, toast, busy, confirmDialog, select, seg, icon, fmtDuration } from '../ui.js';
import { GET, POST, PATCH, DEL, upload } from '../api.js';
import { store } from '../store.js';

const POSITIONS = [['top-left', '↖ Top left'], ['top-right', '↗ Top right'], ['bottom-left', '↙ Bottom left'], ['bottom-right', '↘ Bottom right'], ['center', '• Center']];
const SIZES = { s: 11, m: 14, l: 17, xl: 21 };

export async function brandPage(el) {
  let kits = await store.brandKitList(true);
  let current = kits[0]?.id;
  const sideEl = h('div.col');
  const editorEl = h('div');

  const renderSide = () => mount(sideEl,
    kits.map((k) => h(`button.src-option${k.id === current ? '.on' : ''}`, { type: 'button', onclick: () => { current = k.id; renderSide(); renderEditor(); } },
      k.logo_url ? h('img', { src: k.logo_url, alt: '', style: { width: '36px', height: '36px', objectFit: 'contain', background: 'var(--panel-2)', borderRadius: '8px' } }) : h('span.pf', { style: { background: k.accent_color } }, k.name[0]?.toUpperCase()),
      h('div.grow.ellipsis', { style: { fontWeight: 600 } }, k.name))),
    h('button.btn', { onclick: busy(async () => { const r = await POST('/api/brand-kits', { name: `Brand kit ${kits.length + 1}` }); kits = await store.brandKitList(true); current = r.brandKit.id; renderSide(); renderEditor(); }) }, icon('plus'), 'New brand kit'));

  const renderEditor = async () => {
    const k = kits.find((x) => x.id === current);
    if (!k) { mount(editorEl, ''); return; }
    const d = structuredClone(k);
    d.caption_style = { size: 'm', color: '#ffffff', outline: '#000000', position: 'bottom', box: false, ...d.caption_style };
    const { media } = await GET('/api/media?status=ready&kind=video&limit=200');
    const videos = media.map((m) => [m.id, `${m.title.slice(0, 50)} (${fmtDuration(m.duration)})`]);

    // Live preview
    const phone = h('div.phone');
    const renderPreview = () => {
      const cs = d.caption_style;
      const logoW = Math.round(208 * d.logo_scale);
      const m = 10;
      const pos = { 'top-left': { left: m, top: m }, 'top-right': { right: m, top: m }, 'bottom-left': { left: m, bottom: m }, 'bottom-right': { right: m, bottom: m }, center: { left: `calc(50% - ${logoW / 2}px)`, top: '45%' } }[d.logo_position];
      const capPos = { top: { top: '22%' }, middle: { top: '48%' }, bottom: { bottom: '14%' } }[cs.position];
      mount(phone,
        h('div.hl', { style: { background: `${d.accent_color}d9` } }, 'Your hook headline'),
        d.logo_url ? h('img.logo', { src: d.logo_url, alt: '', style: { width: `${logoW}px`, opacity: d.logo_opacity, ...Object.fromEntries(Object.entries(pos).map(([a, b]) => [a, typeof b === 'number' ? `${b}px` : b])) } }) : null,
        d.watermark_text ? h('div.wm', { style: d.logo_position === 'bottom-left' ? { right: '10px', bottom: '10px' } : { left: '10px', bottom: '10px' } }, d.watermark_text) : null,
        h('div.cap', { style: { ...capPos, color: cs.color, fontSize: `${SIZES[cs.size]}px`, textShadow: cs.box ? 'none' : `-1.5px -1.5px 0 ${cs.outline}, 1.5px -1.5px 0 ${cs.outline}, -1.5px 1.5px 0 ${cs.outline}, 1.5px 1.5px 0 ${cs.outline}`, background: cs.box ? `${cs.outline}c0` : 'none', padding: cs.box ? '2px 6px' : 0 } }, 'This is how your captions look'));
    };
    renderPreview();
    const set = (path, v) => { const ks = path.split('.'); let o = d; while (ks.length > 1) o = o[ks.shift()]; o[ks[0]] = v; renderPreview(); };
    const range = (path, min, max, step) => h('input', { type: 'range', min, max, step, value: path.split('.').reduce((o, x) => o[x], d), oninput: (e) => set(path, Number(e.target.value)) });
    const color = (path) => h('input', { type: 'color', value: path.split('.').reduce((o, x) => o[x], d), oninput: (e) => set(path, e.target.value) });

    const logoInput = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', class: 'hidden', onchange: busy(async (e) => {
      const f = e.target.files[0]; if (!f) return;
      const r = await upload(`/api/brand-kits/${k.id}/logo`, f);
      d.logo_url = r.brandKit.logo_url; kits = await store.brandKitList(true); renderPreview(); renderSide(); toast('Logo uploaded', 'ok');
    }) });
    const introFile = h('input', { type: 'file', accept: 'video/*', class: 'hidden' });
    const uploadClip = (which) => {
      introFile.onchange = busy(async (e) => {
        const f = e.target.files[0]; if (!f) return;
        toast('Uploading…');
        const r = await upload('/api/media/upload', f, { headers: { 'X-Purpose': 'brand' } });
        await PATCH(`/api/brand-kits/${k.id}`, { [`${which}_media_id`]: r.media.id });
        kits = await store.brandKitList(true); renderEditor(); toast(`${which === 'intro' ? 'Intro' : 'Outro'} set`, 'ok');
      });
      introFile.click();
    };

    mount(editorEl, h('div.card.pad', h('div.row.top.wrap.gap-lg',
      h('div.col.grow', { style: { minWidth: '300px' } },
        field('Name', h('input', { type: 'text', value: d.name, oninput: (e) => { d.name = e.target.value; } })),
        h('div.section-title', 'Logo'),
        h('div.row.wrap', logoInput, h('button.btn.sm', { onclick: () => logoInput.click() }, icon('upload'), d.logo_url ? 'Replace logo' : 'Upload logo'),
          d.logo_url ? h('button.btn.sm.ghost', { onclick: busy(async () => { await DEL(`/api/brand-kits/${k.id}/logo`); d.logo_url = ''; kits = await store.brandKitList(true); renderPreview(); renderSide(); }) }, 'Remove') : null,
          h('span.tiny.faint', 'PNG with transparency works best')),
        field('Position', select(POSITIONS, d.logo_position, (v) => set('logo_position', v))),
        h('div.grid.cols-2', field('Size', range('logo_scale', 0.05, 0.5, 0.01)), field('Opacity', range('logo_opacity', 0.1, 1, 0.05))),
        field('Text watermark', h('input', { type: 'text', value: d.watermark_text, placeholder: '@yourhandle', oninput: (e) => set('watermark_text', e.target.value) })),
        h('div.row', field('Accent color', color('accent_color')), h('span.small.muted', 'Used for headline boxes and podcast audiograms.')),
        h('div.section-title', 'Captions'),
        h('div.row.wrap', field('Size', seg([['s', 'S'], ['m', 'M'], ['l', 'L'], ['xl', 'XL']], d.caption_style.size, (v) => set('caption_style.size', v))),
          field('Position', seg([['top', 'Top'], ['middle', 'Middle'], ['bottom', 'Bottom']], d.caption_style.position, (v) => set('caption_style.position', v)))),
        h('div.row.wrap', field('Text', color('caption_style.color')), field('Outline / box', color('caption_style.outline')),
          h('label.check', { style: { marginTop: '18px' } }, h('input', { type: 'checkbox', checked: d.caption_style.box, onchange: (e) => set('caption_style.box', e.target.checked) }), 'Boxed background')),
        h('div.section-title', 'Intro & outro'),
        introFile,
        ...['intro', 'outro'].map((which) => h('div.row.wrap',
          h('div.grow', field(which === 'intro' ? 'Intro clip' : 'Outro clip', select([['', 'None'], ...videos], d[`${which}_media_id`] || '', (v) => { d[`${which}_media_id`] = v ? Number(v) : null; }))),
          h('button.btn.sm', { style: { marginTop: '18px' }, onclick: () => uploadClip(which) }, 'Upload new'))),
        h('div.small.muted', 'Intros/outros are resized to each destination format and joined to the start/end of every video that uses this kit.'),
        h('div.row.mt', h('button.btn.primary', { onclick: busy(async () => {
          await PATCH(`/api/brand-kits/${k.id}`, {
            name: d.name, logo_position: d.logo_position, logo_scale: d.logo_scale, logo_opacity: d.logo_opacity, watermark_text: d.watermark_text, accent_color: d.accent_color,
            caption_style: d.caption_style, intro_media_id: d.intro_media_id || null, outro_media_id: d.outro_media_id || null,
          });
          kits = await store.brandKitList(true); renderSide(); toast('Brand kit saved', 'ok');
        }) }, 'Save brand kit'),
        kits.length > 1 ? h('button.btn.danger.right', { onclick: busy(async () => {
          if (!(await confirmDialog('Delete brand kit?', 'Workflows using it will publish without branding.', { danger: true, okLabel: 'Delete' }))) return;
          await DEL(`/api/brand-kits/${k.id}`); kits = await store.brandKitList(true); current = kits[0]?.id; renderSide(); renderEditor();
        }) }, 'Delete') : null)),
      h('div.col', { style: { alignItems: 'center' } }, h('div.small.muted', 'Preview'), phone, h('div.tiny.faint', { style: { maxWidth: '220px', textAlign: 'center' } }, 'Approximate — use “Preview a format” in the Library for a real render.')))));
  };

  mount(el, h('div.page-head', h('div', h('h1', 'Brand kits'), h('div.sub', 'Logos, watermarks, caption styles and intros applied to your videos.'))),
    h('div.row.top.wrap.gap-lg', h('div', { style: { width: '240px', flex: 'none' } }, sideEl), h('div.grow', { style: { minWidth: '300px' } }, editorEl)));
  renderSide();
  await renderEditor();
}
