# HSL Language Server Integration

This VSCode extension now includes a language server that provides real-time error checking for HSL source files using the Java-based HSL compiler.

## Features

- **Real-time Error Checking**: Compiler errors and warnings are displayed as you type
- **Accurate Error Locations**: Errors are pinpointed to specific lines and characters
- **Comprehensive Error Messages**: Full error descriptions with error codes
- **Automatic Compilation**: Files are automatically checked when saved or modified

## How It Works

1. The language server wraps the Java-based HSL compiler
2. When you edit an HSL file, the extension automatically runs the compiler
3. Compiler output is parsed to extract error information
4. Errors are displayed as VSCode diagnostics (red squiggly lines)

## Requirements

- Java runtime environment (JRE 8 or higher)
- HSL compiler JAR file (built from the `hsl/` directory)

## Building the HSL Compiler

To enable error checking, you need to build the HSL compiler JAR:

```bash
cd hsl
./gradlew build
```

This will create a JAR file in `hsl/build/libs/` that the language server will automatically detect.

## Error Types

The language server can detect various types of errors:

- **Syntax Errors**: Missing brackets, invalid syntax
- **Type Errors**: Type mismatches, invalid types
- **Variable Errors**: Unknown variables, redeclaration
- **Function Errors**: Unknown functions, incorrect arguments
- **Semantic Errors**: Invalid operations, circular references

## Configuration

The language server automatically:
- Finds the HSL JAR file in the workspace
- Uses the workspace root as the compilation context
- Checks only `.hsl` files
- Provides a 10-second timeout for compilation

## Troubleshooting

If error checking isn't working:

1. Ensure Java is installed and accessible via `java` command
2. Build the HSL compiler: `cd hsl && ./gradlew build`
3. Check the VSCode developer console for error messages
4. Verify the HSL JAR file exists in `hsl/build/libs/`

## Performance

- Error checking runs asynchronously to avoid blocking the editor
- Files are only checked when they are modified
- A 10-second timeout prevents hanging on problematic files
- Temporary files are cleaned up automatically
