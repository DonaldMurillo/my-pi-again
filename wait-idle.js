const net = require('net');
const path = require('path');
const sockPath = path.join(process.env.HOME, 'Library/Application Support/cmux/cmux.sock');

function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(sockPath);
    const id = Math.floor(Math.random() * 999999);
    sock.on('connect', () => {
      sock.write(JSON.stringify({method, params, id}) + '\n');
    });
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString();
      try { const resp = JSON.parse(buf); sock.end(); resolve(resp); } catch {}
    });
    sock.on('error', reject);
    setTimeout(() => { sock.end(); reject(new Error('timeout')); }, 5000);
  });
}

async function readScreen() {
  const r = await call('surface.read_text', {surface_id: 'D95F587A-6FD2-4130-8A50-B15A81009241'});
  return r.result?.text || '';
}

// Idle detection: Claude Code is idle when:
// - There's a "❯" line followed by an empty line and then the status bar
// - OR a "❯" at the end of a line with content (typed but not sent)
// We need to detect: response is done = "❯" line exists AND no spinner/activity indicator
function isIdle(text) {
  const lines = text.trimEnd().split('\n');
  const lastLines = lines.slice(-4);
  
  // Check for status bar line (contains ⏵⏵ or shift+tab)
  const hasStatusBar = lastLines.some(l => l.includes('⏵⏵') || l.includes('shift+tab'));
  
  // Check for "❯" prompt with empty content (waiting for input)
  const hasEmptyPrompt = lastLines.some(l => l.trim() === '❯' || l.trim().match(/^❯\s*$/));
  
  // Check for "❯" with typed content (user started typing)
  const hasTypedPrompt = lastLines.some(l => l.match(/^❯\s+\S/));
  
  if (hasStatusBar && hasEmptyPrompt) return 'idle_empty';
  if (hasStatusBar && hasTypedPrompt) return 'idle_typed';
  
  return 'busy';
}

async function main() {
  // Wait for current activity to finish
  for (let i = 0; i < 30; i++) {
    const text = await readScreen();
    const state = isIdle(text);
    if (state !== 'busy') {
      console.log('State:', state);
      console.log('Ready!');
      break;
    }
    console.log(`Waiting... (${i+1}) state=busy`);
    await new Promise(r => setTimeout(r, 3000));
  }
  
  // Send Escape to clear any typed prompt, then send our first test
  console.log('\nClearing any pending input...');
  await call('surface.send_key', {surface_id: 'D95F587A-6FD2-4130-8A50-B15A81009241', key: 'Escape'});
  await new Promise(r => setTimeout(r, 500));
  
  // Clear whatever was typed
  await call('surface.send_key', {surface_id: 'D95F587A-6FD2-4130-8A50-B15A81009241', key: 'Escape'});
  await new Promise(r => setTimeout(r, 500));
  
  const text = await readScreen();
  console.log('Screen after escape:');
  console.log(text.slice(-500));
}

main().catch(e => console.error(e));
