import { describe, expect, it } from "vitest";
import { realCatalogue } from "../test/fixtures";
import { accessLanes } from "./access-model";

const lane = (lanes: ReturnType<typeof accessLanes>, id: string) => lanes.find((l) => l.id === id)!;

describe("access lanes (how access works, from HCG Store's health answer)", () => {
  it("names the products that download without an account, and says purchases are not open while payments are off", () => {
    const lanes = accessLanes(realCatalogue(), { protectedDownloads: "free-testing-only", payments: "disabled", anonymousFreeProducts: ["hcg-mail"] });
    expect(lanes.map((l) => l.id)).toEqual(["browse", "anonymous", "account", "licensed", "connect", "purchases"]);
    expect(lane(lanes, "anonymous")).toMatchObject({ state: "Available now", tone: "open", products: [{ slug: "hcg-mail", name: "HCG Mail" }] });
    expect(lane(lanes, "anonymous").text).toMatch(/^HCG Mail downloads free, with no HCG account/);
    expect(lane(lanes, "purchases")).toMatchObject({ state: "Not open yet", tone: "later" });
  });

  it("claims nothing it cannot know: no server answer, downloads switched off, or unknown and draft products", () => {
    for (const h of [null, { protectedDownloads: "disabled", payments: "disabled", anonymousFreeProducts: ["hcg-mail"] }, { protectedDownloads: "free-testing-only", payments: "disabled", anonymousFreeProducts: ["no-such-product", "hcg-ads"] }]) {
      const l = lane(accessLanes(realCatalogue(), h), "anonymous");
      expect(l.products).toEqual([]);
      expect(l.state).toBe("Where HCG allows it");
    }
    expect(lane(accessLanes(realCatalogue(), null), "purchases").state).toBe("Not open yet");
  });
});
