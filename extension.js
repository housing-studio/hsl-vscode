const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

/**
 * Parse an HSL definition file (e.g., actions.hsl, conditions.hsl) to build a map of
 * name -> { doc, signature, line, character }
 */
function parseHslFile(filePath) {
    const fileContent = fs.readFileSync(filePath, 'utf8');
    const lines = fileContent.split(/\r?\n/);

    /** @type {Record<string, {doc:string, signature:string, line:number, character:number}>} */
    const index = {};

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();

        if (trimmed.startsWith('fn ')) {
            // Extract function name from first line
            const afterFn = trimmed.slice(3); // text after 'fn '
            const nameMatch = /([A-Za-z_][A-Za-z0-9_]*)/.exec(afterFn);
            if (!nameMatch) continue;
            const name = nameMatch[1];
            const charIndex = line.indexOf(name);

            // Collect multi-line signature until closing parenthesis
            let signatureLines = [line]; // use original line to preserve indentation
            let k = i + 1;
            let parenCount = (line.match(/\(/g) || []).length - (line.match(/\)/g) || []).length;
            while (k < lines.length && parenCount > 0) {
                const nextLine = lines[k];
                if (nextLine.trim() === '') break; // stop at empty line
                signatureLines.push(nextLine);
                parenCount += (nextLine.match(/\(/g) || []).length - (nextLine.match(/\)/g) || []).length;
                k++;
            }
            const signature = signatureLines.join('\n');

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

            index[name] = {
                doc,
                signature,
                line: i,
                character: Math.max(0, charIndex)
            };
        }
    }

    return index;
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
let conditionsIndex = {};
let conditionsFilePath = '';

function activate(context) {
    // Prefer submodule std paths with fallback to legacy root files
    const resolveStdPath = (relatives) => {
        for (const rel of relatives) {
            const abs = context.asAbsolutePath(rel);
            if (fs.existsSync(abs)) return abs;
        }
        // return first as default even if missing to keep URI stable
        return context.asAbsolutePath(relatives[0]);
    };

    actionsFilePath = resolveStdPath([
        path.join('hsl-std', 'hypixel', 'actions.hsl'),
        'actions.hsl'
    ]);
    conditionsFilePath = resolveStdPath([
        path.join('hsl-std', 'hypixel', 'conditions.hsl'),
        'conditions.hsl'
    ]);

    const buildIndex = () => {
        try {
            actionsIndex = fs.existsSync(actionsFilePath) ? parseHslFile(actionsFilePath) : {};
        } catch (err) {
            console.error('[HSL] Failed to parse actions.hsl:', err);
            actionsIndex = {};
        }
        try {
            conditionsIndex = fs.existsSync(conditionsFilePath) ? parseHslFile(conditionsFilePath) : {};
        } catch (err) {
            console.error('[HSL] Failed to parse conditions.hsl:', err);
            conditionsIndex = {};
        }
    };

    buildIndex();

    // Attempt to auto-initialize submodules if std files are missing
    let triedInit = false;
    const stdPathsMissing = () => !fs.existsSync(actionsFilePath) || !fs.existsSync(conditionsFilePath);
    const tryInitSubmodules = () => {
        if (triedInit) return;
        triedInit = true;
        try {
            const gitCmd = process.platform === 'win32' ? 'git.exe' : 'git';
            const child = cp.spawn(gitCmd, ['submodule', 'update', '--init', '--recursive'], {
                cwd: context.extensionPath,
                stdio: 'ignore'
            });
            child.on('close', () => {
                // Re-resolve paths and rebuild index after init attempt
                buildIndex();
            });
        } catch (e) {
            console.warn('[HSL] Failed to spawn git to initialize submodules:', e);
        }
    };
    if (stdPathsMissing()) {
        tryInitSubmodules();
    }

    // Watch for changes to actions.hsl and conditions.hsl to refresh index
    if (fs.existsSync(actionsFilePath)) {
        const watcherA = fs.watch(actionsFilePath, { persistent: false }, () => buildIndex());
        context.subscriptions.push({ dispose: () => watcherA.close() });
    } else {
        console.warn('[HSL] actions.hsl not found at extension root.');
    }
    if (fs.existsSync(conditionsFilePath)) {
        const watcherC = fs.watch(conditionsFilePath, { persistent: false }, () => buildIndex());
        context.subscriptions.push({ dispose: () => watcherC.close() });
    } else {
        console.warn('[HSL] conditions.hsl not found at extension root.');
    }

    // Hover provider
    disposables.push(
        vscode.languages.registerHoverProvider('hsl-source', {
            provideHover(document, position) {
                const { text: name } = getWordAtPosition(document, position);
                const info = actionsIndex[name] || conditionsIndex[name];
                if (!info) return null;

                const md = new vscode.MarkdownString();
                md.isTrusted = true;
                const parts = [];
                if (info.doc) {
                    parts.push(info.doc);
                }
                if (info.signature) {
                    parts.push('```hsl');
                    parts.push(info.signature);
                    parts.push('```');
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
                const infoA = actionsIndex[name];
                const infoC = conditionsIndex[name];
                if (!infoA && !infoC) return null;
                const info = infoA || infoC;
                const uri = vscode.Uri.file(infoA ? actionsFilePath : conditionsFilePath);
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
