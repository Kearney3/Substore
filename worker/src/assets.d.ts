declare module '*.txt' { const source: string; export default source; }
declare module '*.wasm' { const module: WebAssembly.Module; export default module; }
