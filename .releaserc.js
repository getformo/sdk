module.exports = {
  branches: ["main"],
  plugins: [
    [
      "@semantic-release/commit-analyzer",
      {
        preset: "conventionalcommits",
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
        assets: ["dist"],
        addReleases: "bottom",
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
