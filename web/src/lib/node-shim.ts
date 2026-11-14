// Browser stand-in for the Node built-ins that backend modules in ../src import at the top level (node:fs, node:crypto).
// The UI only calls their pure functions (pipeline, CSV parsing/export); anything that really needs Node throws here.
// If a backend change imports a new name, add it below and the build goes green again.
const unavailable = (): never => { throw new Error("This Node API is not available in the browser build"); };
export const readFileSync = unavailable;
export const writeFileSync = unavailable;
export const appendFileSync = unavailable;
export const mkdirSync = unavailable;
export const existsSync = (): boolean => false;
export const createSign = unavailable;
export const createHash = unavailable;
export const randomUUID = (): string => globalThis.crypto.randomUUID();
export default { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, createSign, createHash, randomUUID };
