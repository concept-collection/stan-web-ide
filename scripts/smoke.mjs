// End-to-end smoke test: landing → sample project → .sample form view,
// Stan LSP diagnostics, server status. When the compile server (the app's
// default, the hosted stan-wasm-wasi instance) is reachable, also compiles
// + samples for real and checks the output files.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';

const root = new URL('..', import.meta.url).pathname;
const out = process.argv[2] ?? '.';
const previewProc = spawn('npx', ['vite', 'preview', '--port', '4173', '--strictPort'], { stdio: 'ignore', cwd: root });
for (let i = 0; i < 60; i++) {
	const up = await fetch('http://127.0.0.1:4173/').then(r => r.ok).catch(() => false);
	if (up) break;
	await new Promise((r) => setTimeout(r, 500));
}

// probing also wakes the fly.io machine if it was auto-stopped
const serverUrl = 'https://stan-wasm-wasi.fly.dev';
const haveServer = await fetch(`${serverUrl}/probe`).then(r => r.ok).catch(() => false);
console.log(haveServer ? `compile server detected at ${serverUrl} — running full e2e` : 'no compile server — UI checks only');

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
const explorerItem = (name) => page.locator('.mw-explorer-item-label').filter({ hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) });
const check = (name, ok) => console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}`);
// monaco renders spaces as U+00A0 — normalize before matching
const normalize = (text) => text.replace(/\u00a0/g, ' ');
const outputText = async () => normalize(await page.locator('.mw-output').innerText());
const waitForOutput = async (needle, timeout = 20000) => {
	const start = Date.now();
	while (Date.now() - start < timeout) {
		if ((await outputText()).includes(needle)) return true;
		await page.waitForTimeout(250);
	}
	return false;
};

try {
	await page.goto('http://127.0.0.1:4173/', { waitUntil: 'networkidle' });
	await page.waitForTimeout(1200);
	check('landing renders', await page.locator('.landing-empty').count() === 1);
	await page.screenshot({ path: out + '/s-landing.png' });

	// sample project → fit.sample opens as the form view
	await page.getByRole('button', { name: 'New sample project' }).click();
	await page.waitForTimeout(1800);
	check('URL has project route', /#\/project\/[a-z0-9]+/i.test(page.url()));
	check('fit.sample opens as form', await page.locator('.sample-editor h2', { hasText: 'fit.sample' }).count() === 1);
	check('form: stan file selected', await page.locator('.sample-editor select').first().inputValue() === 'linear.stan');
	check('form: num_chains = 4', await page.locator('.sample-params input').first().inputValue() === '4');
	check('run button enabled', await page.locator('.sample-run-button').isEnabled());
	await page.screenshot({ path: out + '/s-form.png' });

	// server status bar item
	await page.waitForTimeout(1500);
	const statusText = normalize(await page.locator('.mw-statusbar').innerText());
	check('server status item shows', statusText.includes('Stan server:'));
	check(`server status is ${haveServer ? 'connected' : 'offline'}`, statusText.includes(haveServer ? 'connected' : 'offline'));

	// Stan editor: highlighting + LSP diagnostics
	await explorerItem('linear.stan').click();
	await page.waitForTimeout(2500); // language server warm-up
	check('stan file opens in text editor', await page.locator('.view-lines').count() >= 1);
	check('no error markers on valid model', await page.locator('.squiggly-error').count() === 0);
	// introduce a syntax error and expect a marker
	await page.locator('.view-lines').first().click();
	await page.keyboard.press('Control+End');
	await page.keyboard.type('\nbroken');
	let sawMarker = false;
	for (let i = 0; i < 40 && !sawMarker; i++) {
		await page.waitForTimeout(250);
		sawMarker = await page.locator('.squiggly-error').count() > 0;
	}
	check('LSP reports syntax error', sawMarker);
	await page.screenshot({ path: out + '/s-lsp.png' });
	// revert
	for (let i = 0; i < 7; i++) await page.keyboard.press('Control+z');
	await page.waitForTimeout(1200);
	check('marker clears after undo', await page.locator('.squiggly-error').count() === 0);

	if (!haveServer) {
		// run without a server → helpful failure in the form status
		await page.locator('.mw-tab-label', { hasText: 'fit.sample' }).click();
		await page.waitForTimeout(400);
		await page.locator('.sample-run-button').click();
		let failed = false;
		for (let i = 0; i < 40 && !failed; i++) {
			await page.waitForTimeout(250);
			failed = await page.locator('.sample-run-status.error').count() === 1;
		}
		check('run without server fails with message', failed);
		await page.screenshot({ path: out + '/s-noserver.png' });
	} else {
		// ---- full e2e: compile + sample fit.sample ----
		await page.locator('.mw-tab-label', { hasText: 'fit.sample' }).click();
		await page.waitForTimeout(400);
		await page.locator('.sample-run-button').click();
		// progress bars should appear while sampling (4 chains) — the
		// sampling phase is sub-second for this model, so poll fast and use
		// the cheap form status (not the output panel) to detect completion
		let sawBars = 0;
		const start = Date.now();
		let done = false;
		while (Date.now() - start < 360_000 && !done) {
			sawBars = Math.max(sawBars, await page.locator('.sample-chain').count());
			done = (await page.locator('.sample-run-status').innerText().catch(() => '')).includes('completed');
			if (!done) await page.waitForTimeout(50);
		}
		check('fit.sample sampling completed', done && await waitForOutput('sampling completed'));
		check('per-chain progress bars shown (4)', sawBars === 4);
		await page.screenshot({ path: out + '/s-run-done.png' });

		// the results dashboard auto-opens on completion
		let dashboardVisible = false;
		for (let i = 0; i < 40 && !dashboardVisible; i++) {
			await page.waitForTimeout(250);
			dashboardVisible = await page.locator('.results-view:visible').count() === 1;
		}
		check('results dashboard auto-opens', dashboardVisible);
		check('dashboard summary has beta row', await page.locator('.results-view:visible .results-table td', { hasText: /^beta$/ }).count() === 1);
		// plotly loads lazily on the first plot tab
		await page.locator('.results-tab', { hasText: 'Trace plots' }).click();
		let plotsRendered = 0;
		for (let i = 0; i < 60 && plotsRendered < 10; i++) {
			await page.waitForTimeout(250);
			plotsRendered = await page.locator('.results-view:visible .js-plotly-plot').count();
		}
		check('trace plots render (11 params)', plotsRendered === 11);
		await page.screenshot({ path: out + '/s-dashboard.png' });

		// back on the form, the View results button now shows
		await page.locator('.mw-tab-label', { hasText: 'fit.sample' }).click();
		await page.waitForTimeout(400);
		check('View results button shows', await page.locator('.sample-results-button:visible').count() === 1);

		// output files in the explorer (fit.sample → fit.out/)
		await page.waitForTimeout(800);
		await explorerItem('fit.out').click();
		await page.waitForTimeout(400);
		check('chain_1.csv written', await explorerItem('chain_1.csv').count() === 1);
		check('summary.csv written', await explorerItem('summary.csv').count() === 1);
		// summary.csv opens as the CSV table view
		await explorerItem('summary.csv').click();
		await page.waitForTimeout(800);
		const summaryTable = page.locator('.csv-view:visible');
		check('summary opens as csv table', await summaryTable.locator('.csv-table').count() === 1);
		check('summary table has beta row', await summaryTable.locator('td', { hasText: /^beta$/ }).count() === 1);
		check('summary table meta shows rows', (await summaryTable.locator('.csv-view-meta').innerText()).includes('rows × 10 columns'));
		// click-to-sort by rhat
		await summaryTable.locator('th', { hasText: /^rhat/ }).click();
		await page.waitForTimeout(300);
		check('sort by rhat', (await summaryTable.locator('.csv-view-meta').innerText()).includes('sorted by rhat'));
		await page.screenshot({ path: out + '/s-summary.png' });
		// a draws file renders too (1000 rows)
		await explorerItem('chain_1.csv').click();
		await page.waitForTimeout(800);
		check('chain csv shows 1,000 rows', (await page.locator('.csv-view:visible .csv-view-meta').innerText()).includes('1,000 rows'));

		// form edit round-trip: bump quick.sample's num_samples, run, check
		// the recorded sampling_opts.json (proves form → YAML → runner)
		await explorerItem('quick.sample').click();
		await page.waitForTimeout(600);
		// scope to the visible pane: the fit.sample form stays in the DOM
		const quickForm = page.locator('.sample-editor:visible');
		const samplesInput = quickForm.locator('.sample-params input').nth(2);
		await samplesInput.fill('150');
		await samplesInput.blur();
		await page.waitForTimeout(300);
		check('form edit marks tab dirty', await page.locator('.mw-tab.dirty').count() >= 1);
		await quickForm.locator('.sample-run-button').click();
		check('quick.sample sampling completed', await waitForOutput('files to /quick.out', 120_000));
		// the quick.out dashboard auto-opens and reflects the form edit
		await page.waitForTimeout(1500);
		const quickSubtitle = normalize(await page.locator('.results-view:visible .results-subtitle').innerText());
		check('dashboard records form-edited num_samples', quickSubtitle.includes('150 samples'));
		await page.screenshot({ path: out + '/s-opts.png' });
	}

	if (haveServer) {
		// after a reload, the dashboard reopens from the persisted output folder
		await page.reload({ waitUntil: 'networkidle' });
		await page.waitForTimeout(2500);
		await explorerItem('fit.out').click();
		await page.waitForTimeout(400);
		await explorerItem('run.json').first().click();
		await page.waitForTimeout(1500);
		check('dashboard reopens after reload', await page.locator('.results-view:visible .results-table td', { hasText: /^beta$/ }).count() === 1);
	}

	// project lifecycle basics
	await page.getByTitle('Back to projects').click();
	await page.waitForTimeout(800);
	check('back on landing', await page.locator('.landing-project').count() === 1);
	await page.getByRole('button', { name: 'New project', exact: true }).click();
	await page.waitForTimeout(1500);
	check('empty project opens fit.sample form', await page.locator('.sample-editor').count() === 1);
	await page.goto('http://127.0.0.1:4173/#/project/nope1234', { waitUntil: 'networkidle' });
	await page.waitForTimeout(800);
	check('unknown id falls back to landing', await page.locator('.landing-header').count() === 1);

	if (errors.length) {
		console.log('page errors:');
		for (const e of errors.slice(0, 10)) console.log('  ' + e);
	} else {
		console.log('no page errors');
	}
} finally {
	await browser.close();
	previewProc.kill();
}
