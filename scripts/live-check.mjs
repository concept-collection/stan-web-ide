// Quick verification against the deployed GitHub Pages site.
import { chromium } from 'playwright';

const base = 'https://concept-collection.github.io/stan-web-ide/';
const out = process.argv[2] ?? '.';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
const check = (name, ok) => console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}`);

try {
	await page.goto(base, { waitUntil: 'networkidle' });
	// returning visitors unregister the old coi-serviceworker and reload once
	await page.waitForTimeout(3500);
	check('landing renders', await page.locator('.landing-header').count() === 1);
	await page.screenshot({ path: out + '/live-landing.png' });

	await page.getByRole('button', { name: 'New sample project' }).click();
	await page.waitForTimeout(2500);
	check('fit.sample opens as form', await page.locator('.sample-editor h2', { hasText: 'fit.sample' }).count() === 1);
	check('form: stan file selected', await page.locator('.sample-editor select').first().inputValue() === 'linear.stan');

	// Stan LSP diagnostics on the live bundle
	await page.locator('.mw-explorer-item-label').filter({ hasText: /^linear\.stan$/ }).click();
	await page.waitForTimeout(3000);
	await page.locator('.view-lines').first().click();
	await page.keyboard.press('Control+End');
	await page.keyboard.type('\nbroken');
	let sawMarker = false;
	for (let i = 0; i < 60 && !sawMarker; i++) {
		await page.waitForTimeout(250);
		sawMarker = await page.locator('.squiggly-error').count() > 0;
	}
	check('LSP diagnostics live', sawMarker);
	await page.screenshot({ path: out + '/live-ide.png' });

	// the status bar shows the compile server (default: the hosted
	// stan-wasm-wasi instance, reachable from any origin)
	const statusText = (await page.locator('.mw-statusbar').innerText()).replace(/\u00a0/g, ' ');
	check('server status item present', statusText.includes('Stan server:'));

	console.log(errors.length ? 'page errors:\n  ' + errors.slice(0, 8).join('\n  ') : 'no page errors');
} finally {
	await browser.close();
}
