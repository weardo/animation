import { Config } from "@remotion/cli/config";

// Deterministic render config (harvested from the spike, §14.1 retired risk).
// These settings make two renders of the same Scene IR byte-identical.
Config.setVideoImageFormat("png"); // lossless intermediate frames
Config.setChromiumOpenGlRenderer("swangle"); // SOFTWARE GL: hardware 'angle' is non-deterministic across runs; SwiftShader is reproducible
Config.setConcurrency(1); // 1 is safe; the absolute-seek rig path is order-independent so higher also works

// The codebase authors ESM/NodeNext-style `.js` import specifiers that resolve to `.ts`/`.tsx`
// source (tsx does this natively). Teach Remotion's webpack the same mapping so Studio + the
// `remotion render` CLI resolve `./Root.js` → `Root.tsx`, matching the programmatic CLI's bundle.
Config.overrideWebpackConfig((config) => ({
  ...config,
  resolve: {
    ...config.resolve,
    extensionAlias: {
      ...(config.resolve?.extensionAlias ?? {}),
      ".js": [".ts", ".tsx", ".js"],
      ".jsx": [".tsx", ".jsx"],
    },
  },
}));

export {};
