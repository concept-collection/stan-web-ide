import { monaco } from 'minwebide';
import { conf, language } from './stanLanguageDef';

/**
 * Registers the Stan language (Monarch tokenizer + language configuration)
 * for .stan files, and maps .sample files to the built-in YAML language.
 * Called after registerBuiltinLanguages so these claims win.
 */
export function registerStanLanguage(): void {
	monaco.languages.register({
		id: 'stan',
		extensions: ['.stan'],
		aliases: ['Stan', 'stan'],
	});
	monaco.languages.setMonarchTokensProvider('stan', language);
	monaco.languages.setLanguageConfiguration('stan', conf);

	// .sample files are YAML; extend the built-in yaml language's claim
	monaco.languages.register({
		id: 'yaml',
		extensions: ['.sample'],
	});
}
