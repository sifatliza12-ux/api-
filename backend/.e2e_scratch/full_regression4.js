process.env.FORGEFLOW_HEADLESS = 'true';
process.env.NODE_ENV = 'test';

const { runWorkflow } = require('../services/replayEngine');
const encode = (html) => `data:text/html,${encodeURIComponent(html)}`;

const run = async (name, steps, params) => {
  try {
    const result = await runWorkflow({ steps, parameterValues: params || {}, workflowId: `regress4-${name}`, extractionHint: null });
    const last = result.stepLog[result.stepLog.length - 1];
    console.log(`${name}: OK result=${last.result}`);
  } catch (err) {
    console.log(`${name}: THREW ${err.message}`);
  }
};

(async () => {
  await run('overlay_js_click_fallback', [
    { index: 0, type: 'navigation', value: encode(`<html><body><button id="target" onclick="window.__c='t'">Book</button><div style="position:fixed;inset:0;background:white;z-index:1000;"></div></body></html>`), meta: null },
    { index: 1, type: 'click', selector: '#target', locators: [{ strategy: 'css', value: '#target' }], value: '', meta: { tag: 'button' } }
  ]);

  await run('cookie_banner_dismiss', [
    { index: 0, type: 'navigation', value: encode(`<html><body><button id="target" onclick="window.__c='t'">Book</button><div id="cb" style="position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:1000;"><button aria-label="Accept all" onclick="document.getElementById('cb').remove()">Accept</button></div></body></html>`), meta: null },
    { index: 1, type: 'click', selector: '#target', locators: [{ strategy: 'css', value: '#target' }], value: '', meta: { tag: 'button' } }
  ]);

  const calHtml = `<html><body>
<div role="application"><div role="heading" id="cap"></div><button aria-label="Next month" id="next">Next</button><div role="grid" id="grid"></div></div>
<script>
let cur = new Date(2026,0,1);
const mn=['January','February','March','April','May','June','July','August','September','October','November','December'];
function render(delay){ document.getElementById('grid').innerHTML=''; setTimeout(()=>{
  document.getElementById('cap').textContent = mn[cur.getMonth()]+' '+cur.getFullYear();
  const days = new Date(cur.getFullYear(),cur.getMonth()+1,0).getDate();
  let h=''; for(let d=1;d<=days;d++){ const iso=cur.getFullYear()+'-'+String(cur.getMonth()+1).padStart(2,'0')+'-'+String(d).padStart(2,'0'); h+='<span data-date="'+iso+'" onclick="window.__p=\\''+iso+'\\'">'+d+'</span>'; }
  document.getElementById('grid').innerHTML=h;
}, delay||0); }
document.getElementById('next').addEventListener('click', ()=>{cur.setMonth(cur.getMonth()+1); render(200);});
render(0);
</script></body></html>`;
  await run('calendar_3_months_forward', [
    { index: 0, type: 'navigation', value: encode(calHtml), meta: null },
    { index: 1, type: 'calendar_date', selector: 'span', locators: null, value: '{{checkin}}', meta: null }
  ], { checkin: '2026-04-10' });

  await run('input_fill', [
    { index: 0, type: 'navigation', value: encode(`<html><body><input id="q" /></body></html>`), meta: null },
    { index: 1, type: 'input', selector: '#q', locators: [{ strategy: 'css', value: '#q' }], value: '{{query}}', meta: null }
  ], { query: 'hello world' });

  await run('duplicate_hidden_first', [
    { index: 0, type: 'navigation', value: encode(`<html><body><button class="a" style="display:none">Hidden</button><button class="a" onclick="window.__c='v'">Visible</button></body></html>`), meta: null },
    { index: 1, type: 'click', selector: '.a', locators: [{ strategy: 'css', value: '.a' }], value: '', meta: { tag: 'button' } }
  ]);

  await run('skip_link_offscreen', [
    { index: 0, type: 'navigation', value: encode(`<html><body><span style="position:absolute;top:-9999px;">Skip to main content</span><span onclick="window.__c='real'">Book Now</span></body></html>`), meta: null },
    { index: 1, type: 'click', selector: 'span', locators: null, value: '', meta: { tag: 'span' } }
  ]);

  // dynamic_click that DOESN'T race — the normal case, must still work
  await run('dynamic_click_normal_no_race', [
    { index: 0, type: 'navigation', value: encode(`<html><body><div role="listbox"><span role="option" onclick="window.__c='picked'">Paris, France</span></div></body></html>`), meta: null },
    { index: 1, type: 'dynamic_click', selector: 'span', locators: null, value: '{{dest}}', meta: null }
  ], { dest: 'Paris, France' });

  process.exit(0);
})();
