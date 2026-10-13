# Hand-tracked browser apps (ideas & builds)

All run in the browser with the webcam and MediaPipe hand tracking. Open any `index.html` over https/localhost.

| App | Folder | What it does | Status |
|---|---|---|---|
| Fireball Hands | `fireball-hands/` | Fireball on each hand; ASL letters trigger 26 one-shot effects; letter guide + practice | Fun build |
| Air Guitar Hero | `air-guitar/` | Chord shapes with one hand, strum with the other; scored note highway | Fun build |
| Maestro | `conductor/` | Learn 2/4, 3/4, 4/4 conducting patterns; graded lessons; orchestra follows your beats | Fun build |
| Little Hands | `little-hands/` | Baby-sign practice (20 ASL signs), private, offline, production-ready | **Release candidate** |
| Hand Saber 3D | `sword/` | 3D light sabers from your fists (true 3D orientation + depth, smoothed); slice 3D fruit, blade clashes; original 2D at `sword/2d.html` | Fun build |
| Rune Caster | `runes/` | Draw runes in the air to cast spells; blast rune-wearing ghosts | Fun build |
| Secret Remote | `secret-remote/` | Hands-free Flappy: desk taps via the mic (single file) or eyebrow raise / double blink via the camera (face tracking, bundled offline) | Working demo |
| Hands-free Anki clicker | `secret-remote/anki-clicker.html` | 37 cues: hand, face, head and sound (taps, clicks, whistles) (finger count 1–4, thumbs, swipes, nod/shake, tilt, winks, smile…) with presets and per-user calibration, driving Anki reviews via AnkiConnect; built-in practice deck | Working demo |

## Ideas parked for later
- Hand Saber: enemies that block/parry, blade clash between two hands, saber duel with a friend over WebRTC.
- Rune Caster: spell combos (rune → rune), two-hand runes, a wizard duel, custom runes you record yourself.
- Shared: package the fun builds like Little Hands (self-hosted models, offline) so they can be published.
