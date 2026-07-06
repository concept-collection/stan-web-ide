// Web worker running the Stan language server (stanc3 compiled to JS),
// which provides diagnostics, hover, completion, and formatting for .stan
// files. Speaks LSP over postMessage (vscode-languageserver's browser
// transport); the app side is the small client in lsp.ts.

import startLanguageServer from 'stan-language-server';
import { BrowserMessageReader, BrowserMessageWriter, createConnection } from 'vscode-languageserver/browser';

const reader = new BrowserMessageReader(self as unknown as Worker);
const writer = new BrowserMessageWriter(self as unknown as Worker);
const connection = createConnection(reader, writer);

// the connection types differ between the node and browser entry points of
// vscode-languageserver, but the runtime shape is the same
startLanguageServer(connection as unknown as Parameters<typeof startLanguageServer>[0]);
