import { DEFAULT_SERVER_URL, getServerUrl, LOCAL_SERVER_DOCKER_COMMAND, setServerUrl } from './settings';
import './serverDialog.css';

/** Small modal to view/change the compile-server URL. */
export function showServerDialog(container: HTMLElement): void {
	const overlay = document.createElement('div');
	overlay.className = 'server-dialog-overlay';
	const close = () => overlay.remove();
	overlay.addEventListener('click', (event) => {
		if (event.target === overlay) {
			close();
		}
	});

	const box = document.createElement('div');
	box.className = 'server-dialog';
	overlay.appendChild(box);

	const title = document.createElement('h3');
	title.textContent = 'Stan compilation server';
	box.appendChild(title);

	const description = document.createElement('p');
	description.append(
		'Compiling Stan programs to WebAssembly needs a stan-wasm-server; sampling then runs locally in your browser. Run one on your machine with:',
	);
	box.appendChild(description);

	const command = document.createElement('p');
	const code = document.createElement('code');
	code.textContent = LOCAL_SERVER_DOCKER_COMMAND;
	command.appendChild(code);
	box.appendChild(command);

	const note = document.createElement('p');
	note.textContent = 'The server\'s CORS allowlist must include this page\'s origin.';
	box.appendChild(note);

	const input = document.createElement('input');
	input.type = 'text';
	input.value = getServerUrl();
	input.placeholder = DEFAULT_SERVER_URL;
	input.spellcheck = false;
	box.appendChild(input);

	const buttons = document.createElement('div');
	buttons.className = 'server-dialog-buttons';
	const makeButton = (label: string, className: string, handler: () => void) => {
		const button = document.createElement('button');
		button.textContent = label;
		if (className) {
			button.className = className;
		}
		button.addEventListener('click', handler);
		buttons.appendChild(button);
	};
	makeButton('Use default', '', () => {
		input.value = DEFAULT_SERVER_URL;
	});
	makeButton('Cancel', '', close);
	makeButton('Save', 'primary', () => {
		setServerUrl(input.value);
		close();
	});
	box.appendChild(buttons);

	input.addEventListener('keydown', (event) => {
		if (event.key === 'Enter') {
			setServerUrl(input.value);
			close();
		} else if (event.key === 'Escape') {
			close();
		}
	});

	container.appendChild(overlay);
	input.focus();
	input.select();
}
