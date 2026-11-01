import { h, mount, pf, field, toastErr } from '../ui.js';
import { POST } from '../api.js';
import { store } from '../store.js';
import { route } from '../app.js';

export function authPage(root, mode) {
  const isSignup = mode === 'signup';
  const err = h('div.callout.err.hidden');
  const email = h('input', { type: 'email', required: true, autocomplete: 'email', placeholder: 'you@example.com' });
  const password = h('input', { type: 'password', required: true, minlength: 8, autocomplete: isSignup ? 'new-password' : 'current-password', placeholder: isSignup ? 'At least 8 characters' : '' });
  const name = h('input', { type: 'text', autocomplete: 'name', placeholder: 'Your name' });
  const submit = h('button.btn.primary.block', { type: 'submit' }, isSignup ? 'Create account' : 'Sign in');
  const form = h('form.col', {
    onsubmit: async (e) => {
      e.preventDefault();
      submit.disabled = true; err.classList.add('hidden');
      try {
        const body = { email: email.value, password: password.value };
        if (isSignup) Object.assign(body, { name: name.value, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
        store.user = (await POST(isSignup ? '/api/auth/signup' : '/api/auth/login', body)).user;
        location.hash = '#/';
        route();
      } catch (ex) { err.textContent = ex.message; err.classList.remove('hidden'); submit.disabled = false; }
    },
  },
  h('div', h('h1', isSignup ? 'Create your account' : 'Welcome back'), h('p.muted', isSignup ? 'Start repurposing in a couple of minutes.' : 'Sign in to your Recast workspace.')),
  err,
  isSignup ? field('Name', name) : null,
  field('Email', email),
  field('Password', password),
  submit,
  h('p.small.muted.center', isSignup ? ['Already have an account? ', h('a', { href: '#/login' }, 'Sign in')] : ['New here? ', h('a', { href: '#/signup' }, 'Create an account')]));

  const flow = (a, b) => h('div.flow', pf(a[0], a[1]), h('span', '→'), ...b.map(([p, c]) => pf(p, c, 'sm')));
  mount(root, h('div.auth',
    h('section.pitch',
      h('div.row', h('img', { src: '/favicon.svg', alt: '', width: 34, height: 34 }), h('strong', { style: { fontSize: '20px', color: '#fff' } }, 'Recast')),
      h('h1', 'Post once. Show up everywhere.'),
      h('p', 'Recast watches your channels, reformats each new video for every platform, adds your branding, writes the captions, and publishes on your schedule.'),
      flow(['tiktok', '#111'], [['youtube', '#ff0033'], ['instagram', '#e1306c'], ['facebook', '#1877f2'], ['linkedin', '#0a66c2'], ['x', '#000']]),
      h('ul',
        h('li', '⚡', h('span', h('b', 'Automatic workflows. '), 'New TikToks, YouTube uploads, podcast episodes or files become posts on every network.')),
        h('li', '🎬', h('span', h('b', 'Smart reformatting. '), '9:16, 1:1, 4:5 or 16:9 with blur-fill, trims, end-card removal and burned-in captions.')),
        h('li', '🎨', h('span', h('b', 'Your brand. '), 'Logo, watermark, caption style, intros and outros applied consistently.')),
        h('li', '🗓️', h('span', h('b', 'Scheduling & approvals. '), 'Publish instantly, after a delay, in time slots, or after you review.')))),
    h('section.form', h('div.card', form))));
  (isSignup ? name : email).focus();
}
