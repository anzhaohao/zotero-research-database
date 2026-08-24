import { expect } from "chai";
import { setCurrentArtifact } from "../../src/services/artifactMetadata";
import type { ManagedArtifact } from "../../src/domain/types";

describe("internal artifact metadata", function () {
  it("supersedes an artifact in the same slot without using tags", function () {
    const current: ManagedArtifact[] = [
      {
        attachmentKey: "OLDIMG01",
        role: "figure",
        sha256: "a".repeat(64),
        figureID: "fig-1",
      },
    ];
    const next = setCurrentArtifact(
      current,
      {
        attachmentKey: "NEWIMG01",
        role: "figure",
        sha256: "b".repeat(64),
        figureID: "fig-1",
      },
      (artifact) => artifact.figureID === "fig-1",
    );

    expect(next[0].history).to.equal(true);
    expect(next[1].history).to.equal(undefined);
    expect(JSON.stringify(next)).not.to.include("#ZRDB/");
  });
});
