import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Semantic search is opt-in (`cortexboard semantic on`): the ONNX runtime is ~290 MB, so it is installed once
// per machine under ~/.cortex/runtime instead of shipping with every `npx` run. Models are cached in
// ~/.cortex/models and shared by all projects.

export const MODEL = "Xenova/paraphrase-multilingual-MiniLM-L12-v2";
const PACKAGE = "@huggingface/transformers";
const VERSION = "^4.3.0";

export function cortexHome(): string {
  return process.env.CORTEX_HOME ?? join(homedir(), ".cortex");
}

const runtimeDir = () => join(cortexHome(), "runtime");
export const modelsDir = () => join(cortexHome(), "models");
const settingsFile = () => join(cortexHome(), "settings.json");

interface Settings {
  semantic?: boolean;
}

export function readSettings(): Settings {
  try {
    return JSON.parse(readFileSync(settingsFile(), "utf8")) as Settings;
  } catch {
    return {};
  }
}

export function writeSettings(s: Settings): void {
  mkdirSync(cortexHome(), { recursive: true });
  writeFileSync(settingsFile(), JSON.stringify({ ...readSettings(), ...s }, null, 2) + "\n", "utf8");
}

// Where the runtime can be found: the per-machine install first, then the project's own node_modules (development).
function resolveRuntime(): string | null {
  const bases = [join(runtimeDir(), "package.json"), import.meta.url];
  for (const base of bases) {
    try {
      return createRequire(base).resolve(PACKAGE);
    } catch {
      // not installed here
    }
  }
  return null;
}

export function runtimeInstalled(): boolean {
  return resolveRuntime() !== null;
}

export function modelDownloaded(): boolean {
  return existsSync(join(modelsDir(), ...MODEL.split("/"), "onnx"));
}

export function semanticEnabled(): boolean {
  return readSettings().semantic === true && runtimeInstalled();
}

type Transformers = {
  pipeline: (task: string, model: string, opts: Record<string, unknown>) => Promise<FeatureExtractor>;
  env: { cacheDir: string; allowRemoteModels: boolean };
};
export type FeatureExtractor = (texts: string[], opts: Record<string, unknown>) => Promise<{ tolist(): number[][] }>;

export async function loadTransformers(): Promise<Transformers> {
  const path = resolveRuntime();
  if (!path) throw new Error("Semantic runtime is not installed. Run `npx cortexboard semantic on`.");
  // The CommonJS build arrives as a namespace whose exports may sit under `default`.
  const mod = (await import(pathToFileURL(path).href)) as Partial<Transformers> & { default?: Transformers };
  const tf = (mod.pipeline ? mod : mod.default) as Transformers;
  tf.env.cacheDir = modelsDir();
  return tf;
}

export function installRuntime(onLine: (line: string) => void): Promise<void> {
  const dir = runtimeDir();
  mkdirSync(dir, { recursive: true });
  if (!existsSync(join(dir, "package.json"))) {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "cortex-runtime", private: true }, null, 2) + "\n");
  }
  return new Promise((resolve, reject) => {
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    const child = spawn(npm, ["install", `${PACKAGE}@${VERSION}`, "--no-audit", "--no-fund", "--omit=dev"], {
      cwd: dir,
      shell: process.platform === "win32", // .cmd files need a shell on Windows
      stdio: ["ignore", "pipe", "pipe"],
    });
    const forward = (b: Buffer) => b.toString().split(/\r?\n/).filter(Boolean).forEach(onLine);
    child.stdout.on("data", forward);
    child.stderr.on("data", forward);
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`npm install exited with code ${code}`))));
  });
}
