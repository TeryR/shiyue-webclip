import esbuild from "esbuild";

await esbuild.build({
  entryPoints: ["src/test/tests.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: "test/dist/tests.mjs",
  alias: { obsidian: "./src/test/obsidian-stub.ts" },
  external: ["jsdom"],
  logLevel: "info",
  target: "node18",
});
