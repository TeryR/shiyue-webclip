import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";

mkdirSync("dist", { recursive: true });
const { version } = JSON.parse(readFileSync("manifest.json", "utf-8"));
const files = ["main.js", "manifest.json", "styles.css", "README.md"];
const ps = `Compress-Archive -Path ${files.map((f) => `'${f}'`).join(",")} -DestinationPath 'dist/shiyue-webclip-${version}.zip' -Force`;
const r = spawnSync("powershell", ["-NoProfile", "-Command", ps], { stdio: "inherit", shell: false });
process.exit(r.status ?? 1);
