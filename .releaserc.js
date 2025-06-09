const fs = require("fs");

module.exports = {
  branches: ["main"],
  plugins: [
    [
      "@semantic-release/commit-analyzer",
      {
        preset: "conventionalcommits",
        releaseRules: [],
      },
    ],
    "@semantic-release/release-notes-generator",
    "@semantic-release/npm",
    [
      "@semantic-release/exec",
      {
        successCmd: "scripts/generate-sri.sh ${nextRelease.version}",
      },
    ],
    [
      "@semantic-release/github",
      {
        assets: ["dist/**/*"],
        addReleases: "bottom",
      },
    ],
  ],
  generateNotes: async (pluginConfig, context) => {
    const defaultNotes =
      await require("@semantic-release/release-notes-generator").generateNotes(
        pluginConfig,
        context
      );

    const sriSnippet = fs.existsSync("sri-snippet.txt")
      ? fs.readFileSync("sri-snippet.txt", "utf8").trim()
      : "";

    return `${defaultNotes}\n\n---\n\n🔒 **Subresource Integrity Snippet**\n\n\`\`\`html\n${sriSnippet}\n\`\`\``;
  },
};
