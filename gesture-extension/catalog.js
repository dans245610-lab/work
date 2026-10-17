// Shared catalog: every gesture the engines can produce, every action the extension can run, presets and defaults.
// Used by the background worker, the popup and the settings page.

// [id, icon, label] grouped by the input that produces them. Left/right are always the user's own.
export const GROUPS = [
  ["Hands", "hands", [["palm", "🖐", "Open hand (all 5)"], ["one", "☝️", "1 finger"], ["two", "✌️", "2 fingers"], ["three", "3️⃣", "3 fingers"], ["four", "4️⃣", "4 fingers, thumb tucked"],
    ["thumbUp", "👍", "Thumbs up"], ["thumbDown", "👎", "Thumbs down"], ["ok", "👌", "OK sign"], ["rock", "🤘", "Rock / horns"], ["callme", "🤙", "Call me (thumb + pinky)"],
    ["fist", "✊", "Fist"], ["swipeLeft", "👈", "Swipe open hand to your left"], ["swipeRight", "👉", "Swipe open hand to your right"]]],
  ["Face", "face", [["raise", "🤨", "Eyebrows up"], ["frown", "😠", "Frown"], ["smile", "😁", "Big smile (hold)"], ["pucker", "😗", "Pucker / kiss"],
    ["jaw", "😮", "Mouth wide open"], ["mouthLeft", "😏", "Mouth to your left"], ["mouthRight", "😏", "Mouth to your right"],
    ["dblink", "😑", "Double blink"], ["longBlink", "😌", "Eyes shut 1 second"], ["winkLeft", "😉", "Wink left eye"], ["winkRight", "😉", "Wink right eye"]]],
  ["Head", "face", [["nod", "↕️", "Nod (yes)"], ["shake", "↔️", "Shake (no)"], ["tiltLeft", "↖️", "Tilt head left"], ["tiltRight", "↗️", "Tilt head right"],
    ["nodLeft", "↩️", "Nod left (quick turn and back)"], ["nodRight", "↪️", "Nod right (quick turn and back)"]]],
  ["Sounds", "mic", [["tap1", "👆", "1 desk tap"], ["tap2", "✌", "2 quick taps"], ["tap3", "🤟", "3 quick taps"], ["click", "🖊", "Pen click / finger snap"],
    ["whistle", "🎵", "Whistle a note"], ["whistleUp", "⤴️", "Whistle sliding up"], ["whistleDown", "⤵️", "Whistle sliding down"]]],
];
export const GESTURES = GROUPS.flatMap(([, , list]) => list);
export const GESTURE = Object.fromEntries(GESTURES.map(([id, icon, label]) => [id, { icon, label }]));
export const SOUND_IDS = new Set(GROUPS[3][2].map(([id]) => id));

// Actions: [id, label, group]. Groups only organise the dropdown.
export const ACTION_LIST = [
  ["none", "Nothing", ""],
  ["scrollDown", "Scroll down", "Page"], ["scrollUp", "Scroll up", "Page"], ["pageTop", "Top of page", "Page"], ["pageBottom", "Bottom of page", "Page"],
  ["nextTab", "Next tab", "Tabs"], ["prevTab", "Previous tab", "Tabs"], ["back", "Back", "Tabs"], ["forward", "Forward", "Tabs"], ["reload", "Reload", "Tabs"],
  ["zoomIn", "Zoom in", "Tabs"], ["zoomOut", "Zoom out", "Tabs"], ["zoomReset", "Reset zoom", "Tabs"],
  ["mediaToggle", "Play / pause video", "Media"], ["mediaForward", "Video +10 s", "Media"], ["mediaBack", "Video −10 s", "Media"], ["mediaMute", "Mute / unmute video", "Media"],
  ["key:ArrowRight", "Key → (next slide)", "Keys"], ["key:ArrowLeft", "Key ← (previous slide)", "Keys"], ["key:ArrowDown", "Key ↓", "Keys"], ["key:ArrowUp", "Key ↑", "Keys"],
  ["key: ", "Key Space", "Keys"], ["key:Enter", "Key Enter", "Keys"], ["key:Escape", "Key Esc", "Keys"],
  ["key:1", "Key 1 (AnkiWeb: Again)", "Keys"], ["key:2", "Key 2 (Hard)", "Keys"], ["key:3", "Key 3 (Good)", "Keys"], ["key:4", "Key 4 (Easy)", "Keys"],
  ["anki:next", "Anki: show answer / Good", "Anki desktop"], ["anki:1", "Anki: Again", "Anki desktop"], ["anki:2", "Anki: Hard", "Anki desktop"],
  ["anki:3", "Anki: Good", "Anki desktop"], ["anki:4", "Anki: Easy", "Anki desktop"], ["anki:undo", "Anki: Undo", "Anki desktop"],
  ["toggleWatching", "Pause / resume gestures", "Extension"],
];
export const ACTION = Object.fromEntries(ACTION_LIST.map(([id, label]) => [id, label]));

export const PRESETS = {
  browse: { name: "Browsing", help: "👍/👎 scroll up/down · swipe = switch tab · ✌️ back · 🖐 play/pause video · 🤨 eyebrows scroll down · look at the bottom of the screen to keep scrolling · 👌 pauses gestures.",
    map: { thumbUp: "scrollUp", thumbDown: "scrollDown", swipeLeft: "nextTab", swipeRight: "prevTab", two: "back", palm: "mediaToggle", raise: "scrollDown", ok: "toggleWatching" } },
  reading: { name: "Reading (hands free)", help: "Eyebrows up or a nod scrolls down, shake scrolls up, tilt your head to change tab. Gaze scrolling on. Double blink pauses gestures.",
    map: { raise: "scrollDown", nod: "scrollDown", shake: "scrollUp", tiltLeft: "prevTab", tiltRight: "nextTab", dblink: "toggleWatching" } },
  video: { name: "Video", help: "🖐 play/pause · swipe left/right = −10 s / +10 s · ✊ mute · double desk tap play/pause · 👌 pauses gestures.",
    map: { palm: "mediaToggle", swipeLeft: "mediaBack", swipeRight: "mediaForward", fist: "mediaMute", tap2: "mediaToggle", ok: "toggleWatching" } },
  slides: { name: "Slides", help: "Swipe or nod left/right for previous/next slide (arrow keys). 👍 next, 👎 previous. Single desk tap = next.",
    map: { swipeLeft: "key:ArrowRight", swipeRight: "key:ArrowLeft", nodRight: "key:ArrowRight", nodLeft: "key:ArrowLeft", thumbUp: "key:ArrowRight", thumbDown: "key:ArrowLeft", tap1: "key:ArrowRight", ok: "toggleWatching" } },
  anki: { name: "Anki (desktop, via AnkiConnect)", help: "🖐 show answer / Good · hold up 1–4 fingers for Again/Hard/Good/Easy · 👈 swipe undo · nod = Good, shake = Again.",
    map: { palm: "anki:next", one: "anki:1", two: "anki:2", three: "anki:3", four: "anki:4", swipeLeft: "anki:undo", nod: "anki:3", shake: "anki:1", raise: "anki:next" } },
  ankiweb: { name: "AnkiWeb (in the browser)", help: "Same gestures as the Anki preset, sent as AnkiWeb's keys: Space shows the answer, 1–4 rate.",
    map: { palm: "key: ", one: "key:1", two: "key:2", three: "key:3", four: "key:4", nod: "key:3", shake: "key:1", raise: "key: " } },
  custom: { name: "Custom", help: "Your own mapping. Pick a preset to start again from it.", map: null },
};

export const DEFAULT_SETTINGS = {
  enabled: false,                 // camera/mic engine running
  watching: true,                 // gestures act (false = paused, only "Pause / resume gestures" works)
  inputs: { hands: true, face: true, gaze: true, mic: false },
  preset: "browse",
  map: PRESETS.browse.map,
  gaze: { scrollDown: true, scrollUp: false, speed: 500 },   // px per second while you look at the edge
  scrollAmount: 0.8,              // fraction of the window per scroll gesture
  toast: true,
  calibration: null,              // { face, hand, swipe, audio, report, at } from the wizard
  gazeModel: null,                // from the gaze calibration
};

export const fullMap = m => Object.fromEntries(GESTURES.map(([id]) => [id, (m && m[id]) || "none"]));
export async function loadSettings() {
  const s = await chrome.storage.local.get(null);
  return { ...DEFAULT_SETTINGS, ...s, inputs: { ...DEFAULT_SETTINGS.inputs, ...(s.inputs || {}) }, gaze: { ...DEFAULT_SETTINGS.gaze, ...(s.gaze || {}) } };
}
