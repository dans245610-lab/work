// Draws a hand-shape diagram (SVG string) from 21 normalised landmarks.
// Bones are drawn back-to-front by depth so curled fingers sit in front of / behind the palm correctly.
import { SHAPES } from "./handshape-data.js";

const FINGERS = [[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16], [17, 18, 19, 20]];
const WIDTH = [0.25, 0.21, 0.215, 0.2, 0.175];
const PALM = [0, 1, 2, 5, 9, 13, 17];

// Motion hints, in units of the hand, anchored at a fingertip.
const MOTION = {
  J: { tip: 20, d: "M0,0 L0,0.9 Q0,1.45 -0.55,1.3" },
  Z: { tip: 8, d: "M-0.5,-0.9 L0.5,-0.9 L-0.5,0 L0.5,0" },
};

export function handSVG(letter, { size = 120, skin = "#f3cba8", line = "#5b3a26", thumb = "#ffb36b", accent = "#ff6a00" } = {}) {
  const P = SHAPES[letter];
  if (!P) return "";
  const items = [];
  items.push({ z: avg(PALM.map(i => P[i][2])), svg: palm(P, skin, line) });
  FINGERS.forEach((f, fi) => {
    for (let k = 0; k < f.length - 1; k++) {
      const a = P[f[k]], b = P[f[k + 1]];
      const w = WIDTH[fi] * (1 - k * 0.06);
      const fill = fi === 0 ? thumb : skin;
      items.push({
        z: (a[2] + b[2]) / 2,
        svg: `<line x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}" stroke="${line}" stroke-width="${w + 0.07}" stroke-linecap="round"/>` +
             `<line x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}" stroke="${fill}" stroke-width="${w}" stroke-linecap="round"/>`,
      });
    }
  });
  items.sort((a, b) => b.z - a.z); // MediaPipe z: smaller = closer to the camera, so draw far first

  let extra = "";
  const mo = MOTION[letter];
  if (mo) {
    const [tx, ty] = P[mo.tip];
    extra = `<g transform="translate(${tx + (letter === "Z" ? 0 : 0.25)},${ty + (letter === "Z" ? -0.35 : 0.1)})">` +
      `<path d="${mo.d}" fill="none" stroke="${accent}" stroke-width="0.09" stroke-linecap="round" stroke-linejoin="round" marker-end="url(#ah-${letter})"/></g>`;
  }
  const pts = P.map(p => [p[0], p[1]]);
  if (mo) {
    const [tx, ty] = P[mo.tip];
    if (letter === "Z") pts.push([tx - 0.6, ty - 1.35], [tx + 0.65, ty - 0.25]);
    else pts.push([tx - 0.4, ty + 0.1], [tx + 0.4, ty + 1.65]);
  }
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  let x0 = Math.min(...xs) - 0.25, x1 = Math.max(...xs) + 0.25, y0 = Math.min(...ys) - 0.25, y1 = Math.max(...ys) + 0.25;
  const side = Math.max(x1 - x0, y1 - y0), cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const vb = [cx - side / 2, cy - side / 2, side, side].map(v => v.toFixed(3)).join(" ");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" width="${size}" height="${size}" role="img" aria-label="Hand shape for ${letter}">` +
    `<defs><marker id="ah-${letter}" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="4" markerHeight="4" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${accent}"/></marker></defs>` +
    items.map(i => i.svg).join("") + extra + `</svg>`;
}

function palm(P, skin, line) {
  const d = PALM.map((i, k) => `${k ? "L" : "M"}${P[i][0]},${P[i][1]}`).join(" ") + " Z";
  return `<path d="${d}" fill="${skin}" stroke="${line}" stroke-width="0.07" stroke-linejoin="round"/>` +
         `<path d="${d}" fill="${skin}" stroke="${skin}" stroke-width="0.12" stroke-linejoin="round" transform="translate(0,0)"/>`;
}
const avg = a => a.reduce((s, v) => s + v, 0) / a.length;
