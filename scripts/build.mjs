// Bundles the CLI with esbuild. Ink, React, zod and yaml are dev-dependencies that
// end up inside dist/, so the dashboard adds nothing to the runtime install.
import { build } from "esbuild";
import fs from "node:fs";

const banner = {
  js: [
    "import { createRequire as __csCreateRequire } from 'node:module';",
    "const require = __csCreateRequire(import.meta.url);",
  ].join("\n"),
};

const common = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  sourcemap: false,
  legalComments: "none",
  banner,
  logLevel: "info",
  define: { "process.env.DEV": '"false"' },
};

const { version } = JSON.parse(fs.readFileSync("package.json", "utf8"));
fs.rmSync("dist", { recursive: true, force: true });

// The TUI lives in its own bundle so one-shot commands stay fast to start.
await build({
  ...common,
  entryPoints: { dash: "src/cli/dash.tsx" },
  outdir: "dist",
  jsx: "automatic",
  // Ink only uses devtools when DEV=true; stub the optional package out of the bundle.
  plugins: [
    {
      name: "stub-devtools",
      setup(b) {
        b.onResolve({ filter: /^react-devtools-core$/ }, () => ({ path: "stub", namespace: "stub-devtools" }));
        b.onLoad({ filter: /.*/, namespace: "stub-devtools" }, () => ({ contents: "export default { initialize() {}, connectToDevTools() {} };", loader: "js" }));
      },
    },
  ],
});

// Supervisor: node-pty is a native module, so it stays a runtime dependency.
await build({
  ...common,
  entryPoints: { supervise: "src/cli/supervise.ts" },
  outdir: "dist",
  external: ["./dash.js", "node-pty"],
});

// Hook scripts run inside claude; they're copied as-is (zero dependencies).
fs.mkdirSync("dist/hooks", { recursive: true });
for (const f of fs.readdirSync("hooks")) fs.copyFileSync(`hooks/${f}`, `dist/hooks/${f}`);

await build({
  ...common,
  entryPoints: { csuper: "src/cli/main.ts" },
  outdir: "dist",
  external: ["./dash.js", "./supervise.js"],
  define: { ...common.define, __CSUPER_VERSION__: JSON.stringify(version) },
  banner: { js: "#!/usr/bin/env node\n" + banner.js },
});

fs.chmodSync("dist/csuper.js", 0o755);
