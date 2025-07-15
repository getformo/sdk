module.exports = {
  branches: ["main"],
  plugins: [
    [
      "@semantic-release/commit-analyzer",
      {
        preset: "conventionalcommits",
        releaseRules: [
          { type: "feat", release: "minor" },
          { type: "feature", release: "minor" },
          { type: "update", release: "patch" },
          { type: "fix", release: "patch" },
          { type: "chore", release: "patch" },
          { type: "breaking changes", release: "major" },
        ],
      },
    ],
    "@semantic-release/release-notes-generator",
    "@semantic-release/npm",
    // Uncomment if you want to commit version bump to package.json
    // [
    //   "@semantic-release/git",
    //   {
    //     assets: ["package.json", "package-lock.json"],
    //     message: "chore(release): ${nextRelease.version} [skip ci]\n\n${nextRelease.notes}",
    //   },
    // ],
    [
      "@semantic-release/github",
      {
        addReleases: "bottom",
        successComment:
          "🎉 This PR is included in version ${nextRelease.version} 🎉 ",
      },
    ],
    [
      "@semantic-release/exec",
      {
        successCmd: "scripts/generate-sri.sh ${nextRelease.version}",
      },
    ],
  ],
};
