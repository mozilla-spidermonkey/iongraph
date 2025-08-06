import * as esbuild from "esbuild";

const ctx = await esbuild.context({
  entryPoints: [
    "src/index.ts", // JS-only entrypoint
    "src/index_react.ts", // Entrypoint including React components
    "src/test.tsx", // Test entrypoint
  ],
  outdir: "dist",
  bundle: true,
  format: "esm",
  target: ["es2020"],
  sourcemap: true,
});

if (process.argv.includes("--serve")) {
  await ctx.watch();
  const { hosts, port } = await ctx.serve({
    servedir: ".",
  });
  console.log(`Now serving on http://localhost:${port}`);
} else {
  await ctx.rebuild();
  await ctx.dispose();
  console.log("Built successfully.");
}
