// node:sqlite ships FTS5 (keyword search) from Node 22.16 on; earlier builds fail with "no such module: fts5".
export const MIN_NODE = "22.16.0";

export function nodeTooOld(version = process.versions.node): boolean {
  const [a, b] = version.split(".").map(Number);
  const [x, y] = MIN_NODE.split(".").map(Number);
  return a < x || (a === x && b < y);
}

export const NODE_TOO_OLD_MESSAGE = (version = process.versions.node) =>
  `Cortex needs Node.js ${MIN_NODE.replace(/\.0$/, "")} or newer (you have ${version}). Install the current LTS from https://nodejs.org and try again.`;
