import { expect } from "chai";
import { validateRequest } from "../../src/services/artifactEndpoint";

describe("artifact import request protocol", function () {
  const base = {
    libraryID: 1,
    parentItemKey: "ABCD1234",
    workflowRunID: "run-1",
  };

  it("accepts a figure with page and normalized PDF coordinates", function () {
    const request = {
      ...base,
      artifacts: [
        {
          role: "figure",
          path: "C:\\output\\fig-1.png",
          sha256: "a".repeat(64),
          title: "Figure 1",
          figure: {
            id: "fig-1",
            caption: "实验结果",
            pageIndex: 3,
            rect: { x: 0.1, y: 0.2, width: 0.5, height: 0.4 },
          },
        },
      ],
    };
    expect(validateRequest(request)).to.equal(request);
  });

  it("rejects a figure without a valid manifest entry", function () {
    expect(() =>
      validateRequest({
        ...base,
        artifacts: [
          {
            role: "figure",
            path: "C:\\output\\fig-1.png",
            sha256: "a".repeat(64),
            title: "Figure 1",
          },
        ],
      }),
    ).to.throw("图表产物");
  });
});
