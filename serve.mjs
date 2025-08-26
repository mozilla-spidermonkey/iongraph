import * as esbuild from "esbuild";

const ctx = await esbuild.context({
  entryPoints: ["src/test.tsx"],
  outdir: "dist",
  bundle: true,
  format: "esm",
  target: ["es2020"],
  sourcemap: true,
});
await ctx.watch();
const { hosts, port } = await ctx.serve({
  servedir: ".",
});
console.log(`Now serving on http://localhost:${port}`);
