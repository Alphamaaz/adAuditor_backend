import { beforeEach, describe, expect, it, vi } from "vitest";
import axios from "axios";
import {
  fetchAdGroupReport,
  fetchAdReport,
  fetchCampaignReport,
} from "./tiktok.service.js";

vi.mock("axios", () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
  },
}));

const okResponse = { data: { code: 0, message: "OK", data: { list: [] } } };

describe("TikTok reporting requests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    axios.get.mockResolvedValue(okResponse);
  });

  it("uses one campaign dimension and supported v1.3 campaign metrics", async () => {
    await fetchCampaignReport("token", "123", 30);

    const params = axios.get.mock.calls[0][1].params;
    expect(JSON.parse(params.dimensions)).toEqual(["campaign_id"]);
    expect(JSON.parse(params.metrics)).toContain("campaign_automation_type");
    expect(JSON.parse(params.metrics)).not.toContain("campaign_budget_mode");
    expect(params.advertiser_id).toBe("123");
  });

  it("uses one ad-group dimension and reporting attribute names", async () => {
    await fetchAdGroupReport("token", 123, 30);

    const params = axios.get.mock.calls[0][1].params;
    const metrics = JSON.parse(params.metrics);
    expect(JSON.parse(params.dimensions)).toEqual(["adgroup_id"]);
    expect(metrics).toEqual(expect.arrayContaining(["campaign_id", "bid", "optimization_event"]));
    expect(metrics).not.toEqual(expect.arrayContaining(["bid_price", "optimization_goal", "status"]));
    expect(params.advertiser_id).toBe("123");
  });

  it("uses one ad dimension and requests parent IDs as attributes", async () => {
    await fetchAdReport("token", "123", 30);

    const params = axios.get.mock.calls[0][1].params;
    expect(JSON.parse(params.dimensions)).toEqual(["ad_id"]);
    expect(JSON.parse(params.metrics)).toEqual(
      expect.arrayContaining(["adgroup_id", "campaign_id"])
    );
  });

  it("returns an actionable operational error when reporting permission is absent", async () => {
    axios.get.mockResolvedValue({
      data: {
        code: 40001,
        message: "No permission to access reporting scope",
        request_id: "req-abc",
      },
    });

    await expect(fetchCampaignReport("token", "123", 30)).rejects.toMatchObject({
      statusCode: 403,
      isOperational: true,
      message: expect.stringContaining("Reporting > Consolidated Report"),
      details: expect.objectContaining({ requestId: "req-abc" }),
    });
  });
});
