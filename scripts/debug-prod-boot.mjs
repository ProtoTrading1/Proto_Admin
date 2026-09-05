import { Window } from 'happy-dom';

async function testBoot(label, htmlUrl, jsPath) {
  const window = new Window({ url: htmlUrl });
  const document = window.document;
  const errors = [];

  window.addEventListener('error', (e) => {
    errors.push({ type: 'error', msg: e.message, file: e.filename, line: e.lineno });
  });
  window.addEventListener('unhandledrejection', (e) => {
    errors.push({ type: 'rejection', msg: String(e.reason?.message || e.reason) });
  });

  document.body.innerHTML = '<div id="root"></div>';

  const mod = await import(jsPath);
  await new Promise((r) => setTimeout(r, 500));

  const root = document.getElementById('root');
  console.log(`\n=== ${label} ===`);
  console.log('errors:', JSON.stringify(errors, null, 2));
  console.log('root innerHTML length:', root?.innerHTML?.length ?? 0);
  console.log('root preview:', root?.innerHTML?.slice(0, 200) ?? '');
}

const base = new URL('../dist/', import.meta.url);
await testBoot('local dist bundle', 'http://localhost:4175/', new URL('../dist/assets/index-BLl2iKxZ.js', import.meta.url).href);
