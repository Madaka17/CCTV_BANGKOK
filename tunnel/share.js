#!/usr/bin/env node
/**
 * Keep the public link alive, and always know what it is.
 *
 * `cloudflared tunnel --url ...` opens a quick tunnel, whose hostname is random
 * and is issued fresh every time the process starts. That is the whole reason a
 * link handed out yesterday stops working: nothing crashed at Cloudflare's end,
 * the tunnel was simply restarted and the old name went with it. Quick tunnels
 * cannot be given a fixed name - that needs a domain on Cloudflare - so the next
 * best thing is to restart as rarely as possible and to make the current name
 * easy to find when it does change.
 *
 * So this:
 *   - waits for the web server, rather than letting cloudflared point at nothing
 *   - starts the tunnel and reads its hostname from cloudflared's own metrics
 *   - writes that hostname to tunnel/current-url.txt and prints it
 *   - restarts cloudflared if it dies, and says so, with the new link
 *
 *     node tunnel/share.js
 *     node tunnel/share.js --port 3000
 */

'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const PORT = Number(flag('--port', '3000'));
// Fixed, so the hostname can be read back. Left to itself cloudflared picks a
// random metrics port, which is fine for it and useless to us.
const METRICS = flag('--metrics', '127.0.0.1:20241');
const URL_FILE = path.join(__dirname, 'current-url.txt');

// Not on PATH in the usual Windows install, so look where the installer puts it
const CLOUDFLARED = flag('--cloudflared', process.platform === 'win32'
  ? 'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe'
  : 'cloudflared');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function reachable(url, timeoutMs = 3000) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForServer() {
  const local = `http://127.0.0.1:${PORT}/api/config`;
  if (await reachable(local)) return true;
  console.log(`waiting for the web server on :${PORT} - start it with "npm start"`);
  for (let i = 0; i < 60; i++) {
    await sleep(2000);
    if (await reachable(local)) return true;
  }
  return false;
}

/** The hostname cloudflared was issued, once it has one. */
async function currentHostname() {
  for (let i = 0; i < 45; i++) {
    try {
      const res = await fetch(`http://${METRICS}/quicktunnel`, { signal: AbortSignal.timeout(2000) });
      const body = await res.json();
      if (body && body.hostname) return body.hostname;
    } catch {
      // cloudflared has not opened its metrics port yet
    }
    await sleep(1000);
  }
  return null;
}

function announce(hostname) {
  const url = `https://${hostname}`;
  const now = new Date().toLocaleString('th-TH');
  fs.writeFileSync(URL_FILE, `${url}\n`);
  console.log('');
  console.log('  ' + '='.repeat(56));
  console.log(`  ลิงก์สำหรับแชร์:  ${url}`);
  console.log(`  เวลา:            ${now}`);
  console.log(`  เก็บไว้ที่:       ${URL_FILE}`);
  console.log('  ' + '='.repeat(56));
  console.log('');
}

function startTunnel() {
  const child = spawn(CLOUDFLARED, [
    'tunnel',
    '--url', `http://localhost:${PORT}`,
    '--metrics', METRICS,
    '--no-autoupdate'
  ], { stdio: ['ignore', 'inherit', 'inherit'] });

  child.on('error', (err) => {
    console.error(`could not start cloudflared (${CLOUDFLARED}): ${err.message}`);
    console.error('pass the path with --cloudflared if it lives somewhere else');
  });
  return child;
}

async function main() {
  if (!(await waitForServer())) {
    console.error(`nothing answering on :${PORT} after two minutes - giving up`);
    process.exit(1);
  }

  let attempt = 0;
  for (;;) {
    const child = startTunnel();
    const hostname = await currentHostname();
    if (hostname) {
      announce(hostname);
      attempt = 0;
    } else {
      console.error('cloudflared did not report a hostname');
    }

    const code = await new Promise((resolve) => child.on('exit', resolve));
    attempt++;
    // A fresh tunnel means a fresh hostname, so say plainly that the old link
    // is now dead rather than letting people wonder why it stopped
    console.error('');
    console.error(`cloudflared exited (code ${code}) - the link above no longer works.`);
    console.error(`restarting in ${Math.min(attempt * 5, 30)}s; a new link will be printed.`);
    await sleep(Math.min(attempt * 5, 30) * 1000);
  }
}

process.on('SIGINT', () => {
  console.log('\nstopped - the link is closed');
  process.exit(0);
});

main();
