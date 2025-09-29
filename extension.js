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

// Extract possibly qualified token like Enum::Member
function getPossiblyQualifiedToken(document, position) {
    const range = document.getWordRangeAtPosition(position, /[A-Za-z_][A-Za-z0-9_]*/);
    if (!range) return { fullToken: '', lhs: '', rhs: '' };
    const start = new vscode.Position(range.start.line, Math.max(0, range.start.character - 2));
    const end = new vscode.Position(range.end.line, range.end.character + 2);
    const surrounding = document.getText(new vscode.Range(start, end));
    const m = /([A-Za-z_][A-Za-z0-9_]*)\s*::\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(surrounding);
    if (m) return { fullToken: m[0], lhs: m[1], rhs: m[2] };
    const word = document.getText(range);
    return { fullToken: word, lhs: '', rhs: '' };
}

/** @type {vscode.Disposable[]} */
let disposables = [];
let actionsIndex = {};
let actionsFilePath = '';
let conditionsIndex = {};
let conditionsFilePath = '';
let typesIndex = {}; // name -> { kind, doc, signature, filePath, line, character }
let enumMembersIndex = {}; // enumName -> memberName -> { doc, filePath, line, character }

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

        // Rebuild std types index (enums, structs, and enum members)
        typesIndex = {};
        enumMembersIndex = {};
        const stdRoot = path.join('hsl-std', 'hypixel');
        const stdAbs = context.asAbsolutePath(stdRoot);
        if (fs.existsSync(stdAbs)) {
            const files = listHslFiles(stdAbs);
            for (const file of files) {
                try {
                    indexTypesInFile(file);
                } catch (e) {
                    console.warn('[HSL] Failed to index types in', file, e);
                }
            }
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

    // Watch std directory for changes
    const stdDir = context.asAbsolutePath(path.join('hsl-std', 'hypixel'));
    if (fs.existsSync(stdDir)) {
        try {
            const watcherStd = fs.watch(stdDir, { persistent: false, recursive: true }, () => buildIndex());
            context.subscriptions.push({ dispose: () => watcherStd.close() });
        } catch (_) {
            // Fallback: non-recursive watch, rebuild on top-level change
            try {
                const watcherStd2 = fs.watch(stdDir, { persistent: false }, () => buildIndex());
                context.subscriptions.push({ dispose: () => watcherStd2.close() });
            } catch (_) {}
        }
    }

    // Hover provider
    disposables.push(
        vscode.languages.registerHoverProvider('hsl-source', {
            provideHover(document, position) {
                const { text: token } = getWordAtPosition(document, position);
                const { fullToken, lhs, rhs } = getPossiblyQualifiedToken(document, position);

                // Prefer functions (actions/conditions)
                let info = actionsIndex[token] || conditionsIndex[token];
                if (info) {
                    const md = new vscode.MarkdownString();
                    md.isTrusted = true;
                    const parts = [];
                    if (info.doc) parts.push(info.doc);
                    if (info.signature) {
                        parts.push('```hsl');
                        parts.push(info.signature);
                        parts.push('```');
                    }
                    md.value = parts.join('\n');
                    return new vscode.Hover(md);
                }

                // Enum member hover like Location::Spawn
                if (lhs && rhs && enumMembersIndex[lhs] && enumMembersIndex[lhs][rhs]) {
                    const em = enumMembersIndex[lhs][rhs];
                    const md = new vscode.MarkdownString();
                    md.isTrusted = true;
                    const parts = [];
                    if (em.doc) parts.push(em.doc);
                    parts.push('```hsl');
                    parts.push(`${lhs}::${rhs}`);
                    parts.push('```');
                    md.value = parts.join('\n');
                    return new vscode.Hover(md);
                }

                // Type hover for enums/structs
                if (typesIndex[token]) {
                    const t = typesIndex[token];
                    const md = new vscode.MarkdownString();
                    md.isTrusted = true;
                    const parts = [];
                    if (t.doc) parts.push(t.doc);
                    if (t.signature) {
                        parts.push('```hsl');
                        parts.push(t.signature);
                        parts.push('```');
                    }
                    md.value = parts.join('\n');
                    return new vscode.Hover(md);
                }
                return null;
            }
        })
    );

    // Definition provider (go to actions.hsl definition)
    disposables.push(
        vscode.languages.registerDefinitionProvider('hsl-source', {
            provideDefinition(document, position) {
                const { text: token } = getWordAtPosition(document, position);
                const { lhs, rhs } = getPossiblyQualifiedToken(document, position);

                // functions
                const infoA = actionsIndex[token];
                const infoC = conditionsIndex[token];
                if (infoA || infoC) {
                    const info = infoA || infoC;
                    const uri = vscode.Uri.file(infoA ? actionsFilePath : conditionsFilePath);
                    const targetPos = new vscode.Position(info.line, info.character);
                    return new vscode.Location(uri, targetPos);
                }

                // enum member
                if (lhs && rhs && enumMembersIndex[lhs] && enumMembersIndex[lhs][rhs]) {
                    const em = enumMembersIndex[lhs][rhs];
                    const uri = vscode.Uri.file(em.filePath);
                    const targetPos = new vscode.Position(em.line, em.character || 0);
                    return new vscode.Location(uri, targetPos);
                }

                // type
                if (typesIndex[token]) {
                    const t = typesIndex[token];
                    const uri = vscode.Uri.file(t.filePath);
                    const targetPos = new vscode.Position(t.line, t.character || 0);
                    return new vscode.Location(uri, targetPos);
                }
                return null;
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

// Helpers: scan filesystem for .hsl files and index enums/structs
function listHslFiles(rootDir) {
    /** @type {string[]} */
    const results = [];
    const stack = [rootDir];
    while (stack.length) {
        const dir = stack.pop();
        if (!dir) continue;
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const e of entries) {
            const abs = path.join(dir, e.name);
            if (e.isDirectory()) {
                stack.push(abs);
            } else if (e.isFile() && e.name.endsWith('.hsl')) {
                results.push(abs);
            }
        }
    }
    return results;
}

function indexTypesInFile(filePath) {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split(/\r?\n/);

    // Parse consecutive doc comments above declarations
    const getDocAbove = (lineIndex) => {
        let docLines = [];
        let j = lineIndex - 1;
        while (j >= 0) {
            const t = lines[j].trim();
            if (t.startsWith('//')) {
                docLines.push(t.replace(/^\/\/\s?/, ''));
                j--;
                continue;
            }
            if (t === '') {
                docLines.push('');
                j--;
                continue;
            }
            break;
        }
        docLines.reverse();
        return docLines.join('\n').trim();
    };

    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        const t = raw.trim();
        if (t.startsWith('enum ')) {
            const m = /^enum\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(t);
            if (!m) continue;
            const enumName = m[1];
            const charIndex = raw.indexOf(enumName);
            const doc = getDocAbove(i);

            // capture full enum signature line(s) until '{' and matching '}'
            let sigLines = [raw];
            let k = i + 1;
            let brace = (raw.match(/\{/g) || []).length - (raw.match(/\}/g) || []).length;
            while (k < lines.length && brace > 0) {
                sigLines.push(lines[k]);
                const s = lines[k];
                brace += (s.match(/\{/g) || []).length - (s.match(/\}/g) || []).length;
                k++;
            }
            const signature = sigLines.join('\n');

            typesIndex[enumName] = { kind: 'enum', doc, signature, filePath, line: i, character: Math.max(0, charIndex) };

            // Parse enum members between first '{' and closing '}'
            enumMembersIndex[enumName] = enumMembersIndex[enumName] || {};
            let j = i + 1;
            while (j < lines.length) {
                const l = lines[j];
                const lt = l.trim();
                if (lt.startsWith('}')) break;
                if (lt.startsWith('//') || lt === '') { j++; continue; }
                // Member like: Name, or Name(args)
                const mm = /^([A-Za-z_][A-Za-z0-9_]*)\b/.exec(lt);
                if (mm) {
                    const member = mm[1];
                    const mdoc = getDocAbove(j);
                    const mchar = l.indexOf(member);
                    enumMembersIndex[enumName][member] = { doc: mdoc, filePath, line: j, character: Math.max(0, mchar) };
                }
                j++;
            }
        } else if (t.startsWith('struct ')) {
            const m = /^struct\s+([A-Za-z_][A-Za-z0-9_]*)(.*)$/.exec(t);
            if (!m) continue;
            const structName = m[1];
            const charIndex = raw.indexOf(structName);
            const doc = getDocAbove(i);
            // Capture signature possibly inline or multi-line
            let sigLines = [raw];
            let k = i + 1;
            // If struct has parentheses, collect until balanced or until '{...}' or end of line
            let paren = (raw.match(/\(/g) || []).length - (raw.match(/\)/g) || []).length;
            while (k < lines.length && (paren > 0)) {
                sigLines.push(lines[k]);
                const s = lines[k];
                paren += (s.match(/\(/g) || []).length - (s.match(/\)/g) || []).length;
                k++;
            }
            const signature = sigLines.join('\n');
            typesIndex[structName] = { kind: 'struct', doc, signature, filePath, line: i, character: Math.max(0, charIndex) };
        }
    }
}
