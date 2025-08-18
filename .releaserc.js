module.exports = {
  branches: ["main"],
  plugins: [
    [
      "@semantic-release/commit-analyzer",
      {
        preset: "conventionalcommits",
        releaseRules: [
          { type: "feat", release: "minor" },
          { type: "Feat", release: "minor" },
          { type: "feature", release: "minor" },
          { type: "Feature", release: "minor" },
          { type: "update", release: "patch" },
          { type: "Update", release: "patch" },
          { type: "fix", release: "patch" },
          { type: "Fix", release: "patch" },
          { type: "chore", release: "patch" },
          { type: "Chore", release: "patch" },
          { type: "breaking changes", release: "major" },
          { type: "Breaking Changes", release: "major" },
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
