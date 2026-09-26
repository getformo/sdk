import path from "path";

const shared = {
  resolve: {
    extensions: [".ts", ".tsx", ".js"],
  },
  devtool: "source-map",
  module: {
    rules: [{ test: /\.tsx?$/, loader: "ts-loader" }],
  },
};

module.exports = [
  {
    ...shared,
    entry: {
      bundle: "./src/index.ts",
      "bundle.min": "./src/index.ts",
    },
    output: {
      path: path.resolve(__dirname, "dist"),
      filename: "index.umd.min.js",
      libraryTarget: "umd",
      library: "FormoAnalytics",
      libraryExport: "FormoAnalytics",
      umdNamedDefine: true,
    },
  },
  // Session replay: the recorder and rrweb, loaded by the core from a CDN
  // only when replay starts. It sets window.FormoReplay itself.
  {
    ...shared,
    entry: "./src/replay/bundle.ts",
    output: {
      path: path.resolve(__dirname, "dist"),
      filename: "replay.umd.min.js",
    },
  },
];
