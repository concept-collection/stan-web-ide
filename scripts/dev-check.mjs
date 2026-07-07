// Quick dev-server sanity check (expects `npx vite` already running on 3000):
// project opens, LSP diagnostics work, a full run completes if a compile
// server is up. Not part of `npm run smoke`.
import { chromium } from 'playwright';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
const check = (name, ok) => console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}`);

try {
	await page.goto('http://127.0.0.1:3000/', { waitUntil: 'networkidle' });
	await page.waitForTimeout(2000);
	await page.getByRole('button', { name: 'New sample project' }).click();
	await page.waitForTimeout(2500);
	check('dev: form view opens', await page.locator('.sample-editor').count() >= 1);

	// run first (the LSP check below leaves the model file edited);
	// probing also wakes the fly.io machine if it was auto-stopped
	const haveServer = await fetch('https://stan-wasm-wasi.fly.dev/probe').then(r => r.ok).catch(() => false);
	if (haveServer) {
		await page.locator('.sample-run-button').click();
		let done = false;
		const start = Date.now();
		while (Date.now() - start < 360_000 && !done) {
			done = ((await page.locator('.mw-output').innerText()).replace(/\u00a0/g, ' ')).includes('sampling completed');
			if (!done) await page.waitForTimeout(400);
		}
		check('dev: full run completes', done);
	}

	await page.locator('.mw-explorer-item-label').filter({ hasText: /^linear\.stan$/ }).click();
	await page.waitForTimeout(4000);
	await page.locator('.view-lines').first().click();
	await page.keyboard.press('Control+End');
	await page.keyboard.type('\nbroken');
	let sawMarker = false;
	for (let i = 0; i < 60 && !sawMarker; i++) {
		await page.waitForTimeout(250);
		sawMarker = await page.locator('.squiggly-error').count() > 0;
	}
	check('dev: LSP diagnostics', sawMarker);
	console.log(errors.length ? 'page errors:\n  ' + errors.slice(0, 6).join('\n  ') : 'no page errors');
} finally {
	await browser.close();
}
