const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

class HSLanguageServer {
    constructor() {
        this.diagnostics = new Map(); // uri -> diagnostics
        this.javaPath = 'java';
        this.hslJarPath = null;
        this.workspaceRoot = null;
    }

    async initialize(workspaceRoot) {
        this.workspaceRoot = workspaceRoot;
        
        // Find the HSL JAR file
        const hslDir = path.join(workspaceRoot, 'hsl');
        if (fs.existsSync(hslDir)) {
            // Look for built JAR in hsl/build/libs/ or hsl/target/
            const possibleJarPaths = [
                path.join(hslDir, 'build', 'libs', 'hsl-*-all.jar'), // Prefer shadow JAR with dependencies
                path.join(hslDir, 'build', 'libs', 'hsl-*.jar'),
                path.join(hslDir, 'target', 'hsl-*.jar'),
                path.join(hslDir, 'hsl.jar')
            ];
            
            for (const jarPattern of possibleJarPaths) {
                const files = this.findFiles(jarPattern);
                if (files.length > 0) {
                    this.hslJarPath = files[0];
                    console.log('[HSL Language Server] Found JAR:', this.hslJarPath);
                    break;
                }
            }
        }

        // Also try to find JAR in the extension directory
        if (!this.hslJarPath) {
            const extensionDir = path.dirname(__dirname);
            const possibleJarPaths = [
                path.join(extensionDir, 'hsl', 'build', 'libs', 'hsl-*-all.jar'), // Prefer shadow JAR with dependencies
                path.join(extensionDir, 'hsl', 'build', 'libs', 'hsl-*.jar'),
                path.join(extensionDir, 'hsl', 'target', 'hsl-*.jar'),
                path.join(extensionDir, 'hsl', 'hsl.jar')
            ];
            
            for (const jarPattern of possibleJarPaths) {
                const files = this.findFiles(jarPattern);
                if (files.length > 0) {
                    this.hslJarPath = files[0];
                    console.log('[HSL Language Server] Found JAR in extension dir:', this.hslJarPath);
                    break;
                }
            }
        }

        if (!this.hslJarPath) {
            console.warn('[HSL Language Server] Could not find HSL JAR file. Error checking will be disabled.');
        }
    }

    findFiles(pattern) {
        const glob = require('glob');
        try {
            return glob.sync(pattern);
        } catch (e) {
            return [];
        }
    }

    async checkFile(uri, content) {
        console.log('[HSL Language Server] Checking file:', uri);
        
        if (!this.hslJarPath) {
            console.log('[HSL Language Server] No JAR path found, skipping error check');
            return [];
        }

        const filePath = uri.replace('file://', '');
        
        // Only check .hsl files
        if (!filePath.endsWith('.hsl')) {
            console.log('[HSL Language Server] Not an HSL file, skipping');
            return [];
        }

        try {
            // Find the nearest HSL project root (directory containing build.toml)
            const projectDir = this.findProjectRoot(path.dirname(filePath));
            if (!projectDir) {
                console.log('[HSL Language Server] No build.toml found up the tree. Skipping diagnostics.');
                return [];
            }

            // Ensure file on disk matches current content (for accurate diagnostics)
            try {
                fs.writeFileSync(filePath, content, 'utf8');
            } catch (_) {
                // If we cannot write, continue with whatever is on disk
            }

            // Run the HSL compiler diagnostics at the project root
            const diagnostics = await this.runCompiler(projectDir, filePath);
            console.log('[HSL Language Server] Found diagnostics:', diagnostics.length);
            return diagnostics;
        } catch (error) {
            console.error('[HSL Language Server] Error checking file:', error);
            return [];
        }
    }

    findProjectRoot(startDir) {
        let dir = startDir;
        for (let i = 0; i < 20; i++) { // walk up at most 20 levels
            const buildPath = path.join(dir, 'build.toml');
            if (fs.existsSync(buildPath)) return dir;
            const parent = path.dirname(dir);
            if (parent === dir) break;
            dir = parent;
        }
        return null;
    }

    async runCompiler(projectDir, filePath) {
        return new Promise((resolve) => {
            const diagnostics = [];
            
            console.log('[HSL Language Server] Running compiler with JAR:', this.hslJarPath);
            console.log('[HSL Language Server] Project directory:', projectDir);
            console.log('[HSL Language Server] File to check:', filePath);
            
            // Run Java with HSL JAR using the diagnostics command (JSON stdout)
            const args = [
                '-jar', this.hslJarPath,
                'diagnostics'
            ];

            console.log('[HSL Language Server] Command:', this.javaPath, args.join(' '));

            const process = spawn(this.javaPath, args, {
                cwd: projectDir, // Run from the project directory
                stdio: ['pipe', 'pipe', 'pipe']
            });

            let stdout = '';
            let stderr = '';

            process.stdout.on('data', (data) => {
                stdout += data.toString();
            });

            process.stderr.on('data', (data) => {
                stderr += data.toString();
            });

            process.on('close', (code) => {
                console.log('[HSL Language Server] Compiler exit code:', code);
                console.log('[HSL Language Server] stdout:', stdout);
                console.log('[HSL Language Server] stderr:', stderr);
                
                // diagnostics command always emits JSON diagnostics to stdout
                const parsed = this.parseDiagnosticsJson(stdout, filePath);
                console.log('[HSL Language Server] Parsed diagnostics:', parsed);
                resolve(parsed);
            });

            process.on('error', (error) => {
                console.error('[HSL Language Server] Failed to start compiler:', error);
                resolve([]);
            });

            // Set a timeout to prevent hanging
            setTimeout(() => {
                console.log('[HSL Language Server] Compiler timeout, killing process');
                process.kill();
                resolve([]);
            }, 10000); // 10 second timeout
        });
    }

    parseDiagnosticsJson(stdout, filePath) {
        try {
            const payload = JSON.parse(stdout);
            if (!Array.isArray(payload)) return [];

            const diagnostics = [];

            for (const entry of payload) {
                const severity = entry.type === 'ERROR' ? 1 : 2; // 1=Error, 2=Warning
                const message = `${entry.type.toLowerCase()}[${entry.code}]: ${entry.title}`;
                const fullMessage = [message]
                    .concat((entry.notes || []).map(n => `Note: ${n}`))
                    .join('\n');
                const entryFile = typeof entry.file === 'string' ? entry.file : undefined;

                // Each entry.errors is a list, each has tokens[]; create a diagnostic per token span
                const errorsList = Array.isArray(entry.errors) ? entry.errors : [];
                for (const err of errorsList) {
                    const tokens = Array.isArray(err.tokens) ? err.tokens : [];
                    if (tokens.length === 0) continue;

                    // Highlight the first token span; optionally merge spans if multiple tokens exist
                    const tok = tokens[0];
                    const meta = tok.meta || {};
                    const lineZero = Math.max(0, (meta.lineNumber || 1) - 1);
                    const startChar = Math.max(0, meta.lineIndex || 0);
                    const length = Math.max(1, (meta.endIndex || startChar) - (meta.beginIndex || startChar));

                    diagnostics.push({
                        severity,
                        range: {
                            start: { line: lineZero, character: startChar },
                            end: { line: lineZero, character: startChar + length }
                        },
                        message,
                        fullMessage,
                        source: 'HSL Compiler',
                        code: String(entry.code),
                        filePath: entryFile
                    });
                }
            }

            return diagnostics;
        } catch (e) {
            console.error('[HSL Language Server] Failed to parse diagnostics JSON:', e);
            return [];
        }
    }

    getDiagnostics(uri) {
        return this.diagnostics.get(uri) || [];
    }

    setDiagnostics(uri, diagnostics) {
        this.diagnostics.set(uri, diagnostics);
    }

    clearDiagnostics(uri) {
        this.diagnostics.delete(uri);
    }
}

module.exports = HSLanguageServer;
