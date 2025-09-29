const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

/**
 * Parse the actions.hsl file to build a map of action name -> { doc, signature, line, character }
 */
function parseActionsFile(actionsFilePath) {
    const fileContent = fs.readFileSync(actionsFilePath, 'utf8');
    const lines = fileContent.split(/\r?\n/);

    /** @type {Record<string, {doc:string, signature:string, line:number, character:number}>} */
    const actionsIndex = {};

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();

        if (trimmed.startsWith('fn ')) {
            // Extract signature and name
            const signature = trimmed; // keep as-is for hover
            const afterFn = trimmed.slice(3); // text after 'fn '
            const nameMatch = /([A-Za-z_][A-Za-z0-9_]*)/.exec(afterFn);
            if (!nameMatch) continue;
            const actionName = nameMatch[1];
            const charIndex = line.indexOf(actionName);

            // Collect consecutive '//' doc comment lines immediately above
            let docLines = [];
            let j = i - 1;
            while (j >= 0) {
                const prev = lines[j];
                const prevTrim = prev.trim();
                if (prevTrim.startsWith('//')) {
                    // stop if there is a blank line separating blocks? We continue as long as comments are consecutive
                    docLines.push(prevTrim.replace(/^\/\/\s?/, ''));
                    j--;
                    continue;
                }
                if (prevTrim === '') {
                    // allow empty lines within the comment block (keep as blank in doc)
                    docLines.push('');
                    j--;
                    continue;
                }
                break;
            }
            docLines.reverse();
            const doc = docLines.join('\n').trim();

            actionsIndex[actionName] = {
                doc,
                signature,
                line: i,
                character: Math.max(0, charIndex)
            };
        }
    }

    return actionsIndex;
}

/**
 * Simple word extraction respecting HSL identifiers
 */
function getWordAtPosition(document, position) {
    const wordRange = document.getWordRangeAtPosition(position, /[A-Za-z_][A-Za-z0-9_]*/);
    if (!wordRange) return { text: '', range: null };
    return { text: document.getText(wordRange), range: wordRange };
}

/** @type {vscode.Disposable[]} */
let disposables = [];
let actionsIndex = {};
let actionsFilePath = '';

function activate(context) {
    actionsFilePath = context.asAbsolutePath('actions.hsl');
    if (!fs.existsSync(actionsFilePath)) {
        console.warn('[HSL] actions.hsl not found at extension root. Hover/definition for actions disabled.');
        return;
    }

    const buildIndex = () => {
        try {
            actionsIndex = parseActionsFile(actionsFilePath);
        } catch (err) {
            console.error('[HSL] Failed to parse actions.hsl:', err);
            actionsIndex = {};
        }
    };

    buildIndex();

    // Watch for changes to actions.hsl to refresh index
    const watcher = fs.watch(actionsFilePath, { persistent: false }, () => {
        buildIndex();
    });
    context.subscriptions.push({ dispose: () => watcher.close() });

    // Hover provider
    disposables.push(
        vscode.languages.registerHoverProvider('hsl-source', {
            provideHover(document, position) {
                const { text: name } = getWordAtPosition(document, position);
                const info = actionsIndex[name];
                if (!info) return null;

                const md = new vscode.MarkdownString();
                md.isTrusted = true;
                const parts = [];
                if (info.signature) {
                    parts.push('```hsl');
                    parts.push(info.signature);
                    parts.push('```');
                }
                if (info.doc) {
                    parts.push(info.doc);
                }
                md.value = parts.join('\n');
                return new vscode.Hover(md);
            }
        })
    );

    // Definition provider (go to actions.hsl definition)
    disposables.push(
        vscode.languages.registerDefinitionProvider('hsl-source', {
            provideDefinition(document, position) {
                const { text: name } = getWordAtPosition(document, position);
                const info = actionsIndex[name];
                if (!info) return null;
                const uri = vscode.Uri.file(actionsFilePath);
                const targetPos = new vscode.Position(info.line, info.character);
                return new vscode.Location(uri, targetPos);
            }
        })
    );

    context.subscriptions.push(...disposables);
}

function deactivate() {
    disposables.forEach(d => {
        try { d.dispose(); } catch (_) {}
    });
    disposables = [];
}

module.exports = {
    activate,
    deactivate
};


