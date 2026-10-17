// Ping-pong ticker. Hidden pages (like the extension's offscreen document) never run requestAnimationFrame and
// their own timers can be throttled; a worker's messages keep arriving. The page asks for each next tick only
// after finishing the current one, so ticks never pile up on a slow machine.
let id = 0;
onmessage = e => { clearTimeout(id); if (e.data >= 0) id = setTimeout(() => postMessage(0), e.data); };
