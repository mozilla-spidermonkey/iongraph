import * as esbuild from "esbuild";
import { readdirSync, copyFileSync, statSync } from "fs";
import { join, relative } from "path";
import { mkdirSync, rmSync } from "fs";

let outDir = "dist-www";

function findFiles(dir, matches, result) {
  for (const file of readdirSync(dir)) {
    const filepath = join(dir, file);
    const stat = statSync(filepath);
    if (stat.isDirectory()) {
      findFiles(filepath, result);
    } else if (matches.test(file)) {
      result.push(filepath);
    }
  }
}

function copyFiles(fromDir, pattern) {
  const files = [];
  findFiles(fromDir, pattern, files);
  for (const file of files) {
    const dest = join(outDir, relative(fromDir, file));
    copyFileSync(file, dest);
  }
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
copyFiles("www", /\.(html|css|json)$/);
copyFiles("src", /\.(html|css)$/);

const ctx = await esbuild.context({
  entryPoints: ["www/main.tsx"],
  outdir: outDir,
  bundle: true,
  format: "esm",
  target: ["es2020"],
  sourcemap: true,
});

if (process.argv.includes("--serve")) {
  await ctx.watch();
  const { hosts, port } = await ctx.serve({
    servedir: "./dist-www/",
  });
  console.log(`Re-run this command for changes to HTML or CSS.`);
  console.log(`Now serving on http://localhost:${port}`);
} else {
  await ctx.rebuild();
  await ctx.dispose();
  console.log("Built successfully.");
}
