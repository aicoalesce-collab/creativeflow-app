/**
 * Builds the UI contact sheet: every captured screen on one white page.
 *
 * The screenshots are PNGs (crisp, for actual design work). Embedding 6 MB of
 * PNG as base64 would push the page past what an artifact can carry, so this
 * re-encodes each one to JPEG through a headless Chromium canvas — no image
 * library needed, and the originals stay untouched in ui-shots/.
 *
 *   cd tests && node build-ui-sheet.mjs      (playwright resolves from here)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = path.join(ROOT, 'ui-shots');
const OUT = path.join(ROOT, 'ui-shots', 'creativeflow-ui-sheet.html');

const index = JSON.parse(fs.readFileSync(path.join(SHOTS, 'index.json'), 'utf8'));

const browser = await chromium.launch();
const page = await browser.newPage();

/** PNG -> JPEG data URI, capped in width. Quality tuned so a 1440px screenshot
 *  still reads at 100% zoom but the whole sheet stays portable. */
async function encode(file, maxW, quality) {
  const b64 = fs.readFileSync(path.join(SHOTS, file)).toString('base64');
  return page.evaluate(async ({ src, maxW, quality }) => {
    const img = new Image();
    img.src = src;
    await img.decode();
    const scale = Math.min(1, maxW / img.naturalWidth);
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * scale);
    c.height = Math.round(img.naturalHeight * scale);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return { uri: c.toDataURL('image/jpeg', quality), w: c.width, h: c.height };
  }, { src: 'data:image/png;base64,' + b64, maxW, quality });
}

const plates = [];
let n = 0;
for (const s of index) {
  n++;
  const phone = s.device === 'phone';
  const enc = await encode(s.file, phone ? 430 : 1240, phone ? 0.8 : 0.76);
  plates.push({ ...s, n, ...enc });
  process.stdout.write(`\r  encoding ${n}/${index.length}`);
}
await browser.close();
console.log('');

const esc = t => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const GROUPS = ['Sign in', 'Main tabs', 'Panels & menus', 'Modals', 'Review room', 'Other roles', 'Phone (390px)', 'Dark theme'];
const NOTE = {
  'Sign in': 'Two fields, no Google account, no password to forget. The only screen a signed-in device never sees again.',
  'Main tabs': 'The seven destinations in the left rail. Everything below the top bar is the tab; the shell never changes.',
  'Panels & menus': 'Overlays anchored to the top bar. Both close on Escape or an outside click.',
  'Modals': 'Centred dialogs over a scrim. The task dialog is the densest surface in the product and the best redesign candidate.',
  'Review room': 'A full-screen takeover with its own chrome — media on the left, the conversation on the right. Clients see this too, without an account.',
  'Other roles': 'The same shell with fewer doors. A member sees only their own work; an assigner opens on Review rather than a dashboard.',
  'Phone (390px)': 'The rail becomes a bottom bar and tables become card lists. Same code, no separate mobile build.',
  'Dark theme': 'One token block swaps the whole palette. Anything new has to work on both grounds.',
};

const byGroup = GROUPS.map(g => ({ g, items: plates.filter(p => p.group === g) })).filter(x => x.items.length);

const plateHtml = p => `
        <figure class="plate${p.device === 'phone' ? ' plate--phone' : ''}" id="plate-${p.n}">
          <figcaption class="cap">
            <span class="num">${String(p.n).padStart(2, '0')}</span>
            <span class="cap-t">${esc(p.title)}</span>
            <span class="chips">
              <span class="chip chip--role">${esc(p.role)}</span>
              <span class="chip">${p.device === 'phone' ? '390 × 844' : '1440 wide'}</span>
            </span>
          </figcaption>
          <div class="well">
            <img src="${p.uri}" width="${p.w}" height="${p.h}" alt="${esc(p.title)} — ${esc(p.role)}" loading="lazy">
          </div>
        </figure>`;

const html = `<title>CreativeFlow — UI contact sheet</title>
<style>
  :root{
    /* A gallery wall for someone else's interface: the page stays quiet so the
       screenshots carry every bit of colour. Neutrals are warm-biased to sit
       with the product's own palette rather than fight it. */
    --paper:#ffffff;
    --ink:#14140f;
    --muted:#7a776d;
    --rule:#e6e3da;
    --chip:#f4f1e9;
    --mark:#eb5b2d;          /* the product's accent — plate numbers and roles only */
    --well:#fbfaf7;
    --sans:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace;
    --measure:66ch;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--paper);color:var(--ink);font-family:var(--sans);
       font-size:16px;line-height:1.6;-webkit-font-smoothing:antialiased}
  img{max-width:100%;height:auto;display:block}

  .wrap{max-width:1400px;margin:0 auto;padding:0 32px 120px}

  /* ── masthead ─────────────────────────────────────────────── */
  header{padding:72px 0 34px;border-bottom:2px solid var(--ink)}
  .eyebrow{font-family:var(--mono);font-size:11px;letter-spacing:.22em;text-transform:uppercase;
           color:var(--mark);font-weight:600;margin:0 0 18px}
  h1{font-size:clamp(30px,4.6vw,54px);line-height:1.04;letter-spacing:-.025em;margin:0;
     font-weight:700;text-wrap:balance;max-width:19ch}
  .lede{margin:20px 0 0;max-width:var(--measure);color:var(--muted);font-size:17px}
  .facts{display:flex;flex-wrap:wrap;gap:0;margin:30px 0 0;font-family:var(--mono);font-size:12px;
         border-top:1px solid var(--rule)}
  .fact{padding:13px 26px 13px 0;margin-right:26px;border-right:1px solid var(--rule)}
  .fact:last-child{border-right:0}
  .fact b{display:block;font-weight:600;letter-spacing:.05em;font-variant-numeric:tabular-nums}
  .fact span{color:var(--muted);text-transform:uppercase;letter-spacing:.12em;font-size:10px}

  /* ── contents ─────────────────────────────────────────────── */
  .layout{display:grid;grid-template-columns:190px minmax(0,1fr);gap:56px;align-items:start}
  @media (max-width:1080px){.layout{grid-template-columns:1fr;gap:0}.toc{display:none}}
  .toc{position:sticky;top:28px;padding-top:44px}
  .toc h2{font-family:var(--mono);font-size:10px;letter-spacing:.18em;text-transform:uppercase;
          color:var(--muted);margin:0 0 14px;font-weight:600}
  .toc ol{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px}
  .toc a{display:flex;gap:10px;padding:6px 0;color:var(--ink);text-decoration:none;font-size:13.5px;
         border-bottom:1px solid transparent}
  .toc a:hover{color:var(--mark)}
  .toc a:focus-visible{outline:2px solid var(--mark);outline-offset:3px;border-radius:3px}
  .toc .i{font-family:var(--mono);font-size:11px;color:var(--muted);padding-top:2px;
          font-variant-numeric:tabular-nums}

  /* ── sections ─────────────────────────────────────────────── */
  section{padding-top:44px;scroll-margin-top:20px}
  .sec-h{display:flex;align-items:baseline;gap:14px;border-bottom:1px solid var(--ink);padding-bottom:10px}
  .sec-n{font-family:var(--mono);font-size:12px;color:var(--mark);font-weight:600;
         font-variant-numeric:tabular-nums}
  .sec-h h2{margin:0;font-size:23px;letter-spacing:-.015em;font-weight:700}
  .sec-h .count{margin-left:auto;font-family:var(--mono);font-size:11px;color:var(--muted);
                letter-spacing:.1em;text-transform:uppercase}
  .sec-note{margin:14px 0 0;max-width:var(--measure);color:var(--muted);font-size:15px}

  .plates{display:flex;flex-direction:column;gap:44px;margin-top:30px}
  .plates--phone{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:34px}

  /* ── plate ────────────────────────────────────────────────── */
  .plate{margin:0;scroll-margin-top:20px}
  .cap{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;padding:0 0 10px}
  .num{font-family:var(--mono);font-size:12px;font-weight:600;color:var(--mark);
       font-variant-numeric:tabular-nums}
  .cap-t{font-weight:600;font-size:15px;letter-spacing:-.008em}
  .chips{display:flex;gap:6px;margin-left:auto;flex-wrap:wrap}
  .chip{font-family:var(--mono);font-size:10px;letter-spacing:.09em;text-transform:uppercase;
        background:var(--chip);color:var(--muted);padding:3px 8px;border-radius:3px;white-space:nowrap}
  .chip--role{color:var(--ink)}
  .well{background:var(--well);border:1px solid var(--rule);border-radius:6px;padding:10px;
        overflow:hidden}
  .well img{border-radius:3px;box-shadow:0 1px 3px rgba(20,20,15,.10),0 8px 26px rgba(20,20,15,.06)}
  .plate--phone .well{padding:12px 12px 14px;display:flex;justify-content:center}
  .plate--phone .well img{max-height:620px;width:auto;object-fit:contain;object-position:top}

  footer{margin-top:88px;padding-top:24px;border-top:1px solid var(--rule);
         font-family:var(--mono);font-size:11.5px;color:var(--muted);letter-spacing:.04em;
         display:flex;flex-wrap:wrap;gap:8px 26px}

  @media print{
    .toc{display:none}.layout{grid-template-columns:1fr}
    .plate{break-inside:avoid}.well img{box-shadow:none}
  }
  @media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
</style>

<div class="wrap">
  <header>
    <p class="eyebrow">CreativeFlow v5.4.1 · UI audit</p>
    <h1>Every screen in the app, on one page.</h1>
    <p class="lede">Captured from the running build — real layouts, real data, every role and state.
      Plate numbers are stable: point at one and I'll know exactly which screen you mean.</p>
    <div class="facts">
      <div class="fact"><b>${plates.length}</b><span>plates</span></div>
      <div class="fact"><b>${byGroup.length}</b><span>sections</span></div>
      <div class="fact"><b>5</b><span>roles + guest</span></div>
      <div class="fact"><b>7</b><span>tabs</span></div>
      <div class="fact"><b>1440 / 390</b><span>widths</span></div>
    </div>
  </header>

  <div class="layout">
    <nav class="toc" aria-label="Contents">
      <h2>Contents</h2>
      <ol>
${byGroup.map((s, i) => `        <li><a href="#sec-${i + 1}"><span class="i">${String(i + 1).padStart(2, '0')}</span><span>${esc(s.g)}</span></a></li>`).join('\n')}
      </ol>
    </nav>

    <main>
${byGroup.map((s, i) => `      <section id="sec-${i + 1}">
        <div class="sec-h">
          <span class="sec-n">${String(i + 1).padStart(2, '0')}</span>
          <h2>${esc(s.g)}</h2>
          <span class="count">${s.items.length} plate${s.items.length === 1 ? '' : 's'}</span>
        </div>
        <p class="sec-note">${esc(NOTE[s.g] || '')}</p>
        <div class="plates${s.items[0].device === 'phone' ? ' plates--phone' : ''}">
${s.items.map(plateHtml).join('\n')}
        </div>
      </section>`).join('\n')}
    </main>
  </div>

  <footer>
    <span>CreativeFlow v5.4.1</span>
    <span>Captured from the built client against fixture data</span>
    <span>Full-resolution PNGs: ui-shots/</span>
  </footer>
</div>
`;

fs.writeFileSync(OUT, html, 'utf8');
const mb = (Buffer.byteLength(html) / 1048576).toFixed(2);
console.log(`${plates.length} plates -> ${path.relative(ROOT, OUT)} (${mb} MB)`);
