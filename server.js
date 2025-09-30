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
            // Create a temporary HSL project directory
            const tempDir = path.join(this.workspaceRoot, '.hsl-temp');
            if (!fs.existsSync(tempDir)) {
                fs.mkdirSync(tempDir, { recursive: true });
            }
            
            // Create a build.toml file for the HSL project
            const buildTomlPath = path.join(tempDir, 'build.toml');
            if (!fs.existsSync(buildTomlPath)) {
                const buildTomlContent = `[package]
id = "temp-project"
name = "Temporary HSL Project"
author = "HSL Language Server"
description = "Temporary project for error checking"
version = "1.0.0"
`;
                fs.writeFileSync(buildTomlPath, buildTomlContent, 'utf8');
            }
            
            const tempFile = path.join(tempDir, path.basename(filePath));
            fs.writeFileSync(tempFile, content, 'utf8');
            console.log('[HSL Language Server] Created temp file:', tempFile);

            // Run the HSL compiler with error output
            const diagnostics = await this.runCompiler(tempDir, tempFile);
            console.log('[HSL Language Server] Found diagnostics:', diagnostics.length);
            
            // Clean up temp files
            try {
                fs.unlinkSync(tempFile);
                fs.unlinkSync(buildTomlPath);
            } catch (e) {
                // Ignore cleanup errors
            }

            return diagnostics;
        } catch (error) {
            console.error('[HSL Language Server] Error checking file:', error);
            return [];
        }
    }

    async runCompiler(projectDir, filePath) {
        return new Promise((resolve) => {
            const diagnostics = [];
            
            console.log('[HSL Language Server] Running compiler with JAR:', this.hslJarPath);
            console.log('[HSL Language Server] Project directory:', projectDir);
            console.log('[HSL Language Server] File to check:', filePath);
            
            // Run Java with HSL JAR
            const args = [
                '-jar', this.hslJarPath,
                'export' // Use export command which will show errors
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
                
                // If compiler failed (exit code 1), parse errors from stderr
                if (code === 1) {
                    const errors = this.parseCompilerErrors(stderr, filePath);
                    console.log('[HSL Language Server] Parsed errors:', errors);
                    resolve(errors);
                } else {
                    // Compilation succeeded, no errors
                    resolve([]);
                }
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

    parseCompilerErrors(errorOutput, filePath) {
        const diagnostics = [];
        const lines = errorOutput.split('\n');
        
        console.log('[HSL Language Server] Parsing error output:');
        console.log('Raw stderr:', errorOutput);
        
        let currentError = null;
        let errorLine = 0;
        let errorColumn = 0;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const trimmedLine = line.trim();
            
            // Remove ANSI color codes for easier parsing
            const cleanLine = line.replace(/\x1b\[[0-9;]*m/g, '');
            const cleanTrimmed = cleanLine.trim();
            
            console.log(`[HSL Language Server] Processing line ${i}: "${cleanLine}"`);
            
            // Look for error patterns - handle the actual HSL format
            const errorMatch = cleanTrimmed.match(/error\[E(\d+)\]:\s*(.+)/);
            if (errorMatch) {
                if (currentError) {
                    diagnostics.push(currentError);
                }
                
                currentError = {
                    severity: 1, // Error
                    range: {
                        start: { line: 0, character: 0 },
                        end: { line: 0, character: 0 }
                    },
                    message: errorMatch[2],
                    source: 'HSL Compiler',
                    code: errorMatch[1]
                };
                console.log('[HSL Language Server] Created error:', currentError);
                continue;
            }

            // Look for file location - handle the actual HSL format
            const locationMatch = cleanTrimmed.match(/-->\s*([^:]+):(\d+):(\d+)/);
            if (locationMatch && currentError) {
                const [, fileName, lineNum, colNum] = locationMatch;
                console.log(`[HSL Language Server] Found location: file=${fileName}, line=${lineNum}, col=${colNum}`);
                if (fileName.includes(path.basename(filePath))) {
                    errorLine = parseInt(lineNum) - 1; // Convert to 0-based
                    errorColumn = parseInt(colNum) - 1; // Convert to 0-based
                    currentError.range = {
                        start: { line: errorLine, character: errorColumn },
                        end: { line: errorLine, character: errorColumn + 1 }
                    };
                    console.log('[HSL Language Server] Updated error range:', currentError.range);
                }
                continue;
            }

            // Look for warning patterns
            const warningMatch = cleanTrimmed.match(/warning\[E(\d+)\]:\s*(.+)/);
            if (warningMatch) {
                if (currentError) {
                    diagnostics.push(currentError);
                }
                
                currentError = {
                    severity: 2, // Warning
                    range: {
                        start: { line: 0, character: 0 },
                        end: { line: 0, character: 0 }
                    },
                    message: warningMatch[2],
                    source: 'HSL Compiler',
                    code: warningMatch[1]
                };
                continue;
            }

            // Look for note patterns
            const noteMatch = cleanTrimmed.match(/note:\s*(.+)/);
            if (noteMatch && currentError) {
                currentError.message += `\nNote: ${noteMatch[1]}`;
                continue;
            }

            // Look for code pointer lines with ^ characters
            if (cleanLine.includes('^') && currentError) {
                // The error is pointing to a specific character
                const caretIndex = cleanLine.indexOf('^');
                if (caretIndex > 0) {
                    currentError.range = {
                        start: { line: errorLine, character: caretIndex },
                        end: { line: errorLine, character: caretIndex + 1 }
                    };
                }
            }
        }

        // Add the last error if any
        if (currentError) {
            diagnostics.push(currentError);
        }

        console.log('[HSL Language Server] Final parsed diagnostics:', diagnostics);
        return diagnostics;
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
