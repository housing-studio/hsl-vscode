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
    const lineText = document.lineAt(position.line).text;
    const regex = /([A-Za-z_][A-Za-z0-9_]*)\s*::\s*([A-Za-z_][A-Za-z0-9_]*)/g;
    let m;
    while ((m = regex.exec(lineText)) !== null) {
        const lhsStart = m.index;
        const lhsEnd = lhsStart + m[1].length;
        const rhsStart = m.index + m[0].length - m[2].length;
        const rhsEnd = rhsStart + m[2].length;
        const ch = position.character;
        if (ch >= rhsStart && ch <= rhsEnd) {
            return { fullToken: m[0], lhs: m[1], rhs: m[2], inRhs: true, inLhs: false };
        }
        if (ch >= lhsStart && ch <= lhsEnd) {
            return { fullToken: m[0], lhs: m[1], rhs: m[2], inRhs: false, inLhs: true };
        }
        if (ch > lhsEnd && ch < rhsEnd) {
            // Hovering the '::' separator or spaces defaults to member context
            return { fullToken: m[0], lhs: m[1], rhs: m[2], inRhs: true, inLhs: false };
        }
    }
    // Detect pattern 'Enum::' with no member typed yet (cursor after ::)
    const pending = /([A-Za-z_][A-Za-z0-9_]*)\s*::\s*$/.exec(lineText.slice(0, position.character));
    if (pending) {
        return { fullToken: pending[0], lhs: pending[1], rhs: '', inRhs: true, inLhs: false, pendingRhs: true };
    }
    const range = document.getWordRangeAtPosition(position, /[A-Za-z_][A-Za-z0-9_]*/);
    if (!range) return { fullToken: '', lhs: '', rhs: '', inRhs: false, inLhs: false };
    const word = document.getText(range);
    return { fullToken: word, lhs: '', rhs: '', inRhs: false, inLhs: false };
}

/** @type {vscode.Disposable[]} */
let disposables = [];
let actionsIndex = {};
let actionsFilePath = '';
let conditionsIndex = {};
let conditionsFilePath = '';
let typesIndex = {}; // name -> { kind, doc, signature, filePath, line, character }
let enumMembersIndex = {}; // enumName -> memberName -> { doc, filePath, line, character }

// Cache for file modification times to avoid re-parsing unchanged files
let fileCache = new Map(); // filePath -> { mtime, data }

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
        // Parse actions and conditions with caching
        try {
            actionsIndex = fs.existsSync(actionsFilePath) ? parseHslFileCached(actionsFilePath) : {};
        } catch (err) {
            console.error('[HSL] Failed to parse actions.hsl:', err);
            actionsIndex = {};
        }
        try {
            conditionsIndex = fs.existsSync(conditionsFilePath) ? parseHslFileCached(conditionsFilePath) : {};
        } catch (err) {
            console.error('[HSL] Failed to parse conditions.hsl:', err);
            conditionsIndex = {};
        }

        // Rebuild std types index (enums, structs, and enum members) with caching
        typesIndex = {};
        enumMembersIndex = {};
        const stdRoot = path.join('hsl-std', 'hypixel');
        const stdAbs = context.asAbsolutePath(stdRoot);
        if (fs.existsSync(stdAbs)) {
            const files = listHslFiles(stdAbs);
            for (const file of files) {
                try {
                    indexTypesInFileCached(file);
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
                const { fullToken, lhs, rhs, inRhs, inLhs } = getPossiblyQualifiedToken(document, position);

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

                // Qualified token handling: prefer member when hovering RHS, type when hovering LHS
                if (lhs && rhs) {
                    if (inRhs && enumMembersIndex[lhs] && enumMembersIndex[lhs][rhs]) {
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
                    if (inLhs && typesIndex[lhs]) {
                        const t = typesIndex[lhs];
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
                }

                // Type hover for enums/structs by bare token
                if (typesIndex[token]) {
                    const t = typesIndex[token];
                    const md = new vscode.MarkdownString();
                    md.isTrusted = true;
                    const parts = [];
                    if (t.doc) {
                        parts.push(t.doc);
                    }
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
                const { lhs, rhs, inRhs, inLhs } = getPossiblyQualifiedToken(document, position);

                // functions
                const infoA = actionsIndex[token];
                const infoC = conditionsIndex[token];
                if (infoA || infoC) {
                    const info = infoA || infoC;
                    const uri = vscode.Uri.file(infoA ? actionsFilePath : conditionsFilePath);
                    const targetPos = new vscode.Position(info.line, info.character);
                    return new vscode.Location(uri, targetPos);
                }

                // enum member (only when hovering RHS)
                if (lhs && rhs && inRhs && enumMembersIndex[lhs] && enumMembersIndex[lhs][rhs]) {
                    const em = enumMembersIndex[lhs][rhs];
                    const uri = vscode.Uri.file(em.filePath);
                    const targetPos = new vscode.Position(em.line, em.character || 0);
                    return new vscode.Location(uri, targetPos);
                }

                // type (bare token or LHS of qualified)
                if ((inLhs && lhs && typesIndex[lhs]) || typesIndex[token]) {
                    const typeInfo = (inLhs && lhs && typesIndex[lhs]) ? typesIndex[lhs] : typesIndex[token];
                    const uri = vscode.Uri.file(typeInfo.filePath);
                    const targetPos = new vscode.Position(typeInfo.line, typeInfo.character || 0);
                    return new vscode.Location(uri, targetPos);
                }
                return null;
            }
        })
    );

    // Completion provider for actions, conditions, types, and enum members
    disposables.push(
        vscode.languages.registerCompletionItemProvider('hsl-source', {
            provideCompletionItems(document, position) {
                /** @type {vscode.CompletionItem[]} */
                const items = [];

                const { lhs, rhs, pendingRhs } = getPossiblyQualifiedToken(document, position);

                // If we're after 'Enum::', only suggest that enum's members
                if ((pendingRhs || (lhs && rhs !== undefined)) && lhs && enumMembersIndex[lhs]) {
                    for (const [memberName, em] of Object.entries(enumMembersIndex[lhs])) {
                        const item = new vscode.CompletionItem(memberName, vscode.CompletionItemKind.EnumMember);
                        item.detail = `${lhs} member`;
                        if (em.doc) item.documentation = em.doc;
                        // Insert just the member name when completing after 'Enum::'
                        item.insertText = memberName;
                        items.push(item);
                    }
                    return items;
                }

                // Actions and Conditions as function calls
                for (const [name, info] of Object.entries(actionsIndex)) {
                    const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Function);
                    item.detail = 'action';
                    if (info.signature) item.documentation = new vscode.MarkdownString('```hsl\n' + info.signature + '\n```');
                    // Insert parentheses for functions
                    item.insertText = new vscode.SnippetString(`${name}($0)`);
                    items.push(item);
                }
                for (const [name, info] of Object.entries(conditionsIndex)) {
                    const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Function);
                    item.detail = 'condition';
                    if (info.signature) item.documentation = new vscode.MarkdownString('```hsl\n' + info.signature + '\n```');
                    item.insertText = new vscode.SnippetString(`${name}($0)`);
                    items.push(item);
                }

                // Types (enums, structs)
                for (const [name, t] of Object.entries(typesIndex)) {
                    const kind = t.kind === 'enum' ? vscode.CompletionItemKind.Enum : vscode.CompletionItemKind.Struct;
                    const item = new vscode.CompletionItem(name, kind);
                    item.detail = t.kind;
                    if (t.signature) item.documentation = new vscode.MarkdownString('```hsl\n' + t.signature + '\n```');
                    if (t.kind === 'enum') {
                        // For enums, help user complete 'Enum::'
                        item.insertText = new vscode.SnippetString(`${name}::$0`);
                        // After inserting Enum::, immediately trigger suggestions for members
                        item.command = { command: 'editor.action.triggerSuggest', title: 'Trigger Suggest' };
                    }
                    items.push(item);
                }

                // Enum members as qualified suggestions (Enum::Member) in general context
                for (const [enumName, members] of Object.entries(enumMembersIndex)) {
                    for (const memberName of Object.keys(members)) {
                        const label = `${enumName}::${memberName}`;
                        const item = new vscode.CompletionItem(label, vscode.CompletionItemKind.EnumMember);
                        item.detail = 'enum member';
                        item.insertText = label;
                        items.push(item);
                    }
                }

                return items;
            }
        }, ':', ':') // trigger also on ':' to help with Enum::Member
    );

    context.subscriptions.push(...disposables);
}

function deactivate() {
    disposables.forEach(d => {
        try { d.dispose(); } catch (_) {}
    });
    disposables = [];
}

// Cached parsing functions
function parseHslFileCached(filePath) {
    const stats = fs.statSync(filePath);
    const cached = fileCache.get(filePath);
    if (cached && cached.mtime >= stats.mtimeMs) {
        return cached.data;
    }
    const data = parseHslFile(filePath);
    fileCache.set(filePath, { mtime: stats.mtimeMs, data });
    return data;
}

function indexTypesInFileCached(filePath) {
    const stats = fs.statSync(filePath);
    const cached = fileCache.get(filePath + '.types');
    if (cached && cached.mtime >= stats.mtimeMs) {
        // Merge cached data
        Object.assign(typesIndex, cached.data.types);
        Object.assign(enumMembersIndex, cached.data.enumMembers);
        return;
    }
    const oldTypes = { ...typesIndex };
    const oldMembers = { ...enumMembersIndex };
    indexTypesInFile(filePath);
    const newTypes = {};
    const newMembers = {};
    for (const [k, v] of Object.entries(typesIndex)) {
        if (!oldTypes[k]) newTypes[k] = v;
    }
    for (const [k, v] of Object.entries(enumMembersIndex)) {
        if (!oldMembers[k]) newMembers[k] = v;
    }
    fileCache.set(filePath + '.types', { 
        mtime: stats.mtimeMs, 
        data: { types: newTypes, enumMembers: newMembers } 
    });
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
                // Allow empty lines within comment blocks
                docLines.push('');
                j--;
                continue;
            }
            break;
        }
        docLines.reverse();
        const result = docLines.join('\n').trim();
        return result;
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
            if (enumName === 'Location') {
                console.log(`[HSL] Location enum doc:`, JSON.stringify(doc));
            }

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
                
                // Member like: Name, or Name(args) - but not comments or empty lines
                const mm = /^([A-Za-z_][A-Za-z0-9_]*)\b/.exec(lt);
                if (mm) {
                    const member = mm[1];
                    const mdoc = getDocAbove(j);
                    const mchar = l.indexOf(member);
                    if (enumName === 'Location' && member === 'Spawn') {
                        console.log(`[HSL] Location::Spawn doc:`, JSON.stringify(mdoc));
                    }
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
