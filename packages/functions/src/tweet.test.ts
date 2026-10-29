import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateTweetLength } from "./tweet-validation";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  refresh: vi.fn(),
  upload: vi.fn(),
  tweet: vi.fn(),
  user: vi.fn(),
}));

vi.mock("sst/node/api", () => ({ ApiHandler: (handler: unknown) => handler }));
vi.mock("sst/node/config", () => ({
  Config: {
    OLAF_TEAMPILOT_LAUNCHPAD_SLUG: "test-launchpad",
    discord_olaf_webhook: "https://example.com/discord",
  },
}));
vi.mock("utils/twitter-auth", () => ({
  redis: { get: mocks.get, set: mocks.set },
  twitterClient: { refreshOAuth2Token: mocks.refresh },
  twitterV1Client: { v1: { uploadMedia: mocks.upload } },
}));

import { handler } from "./tweet";

// SST's wrapper is mocked above; all external I/O is mocked, but the real
// Teampilot SDK validates these fixtures, including its console.error paths.
const run = handler as unknown as () => Promise<{
  statusCode: number;
  body: string;
}>;

const valid = { response: { tweet: "Hello", threadTweets: ["World"] } };
const overlong = "x".repeat(281);

function sdkResponse(data: unknown) {
  return new Response(JSON.stringify({
    message: { id: "message", data },
    mediaAttachments: [{ id: "image", type: "IMAGE", url: "https://example.com/image" }],
    usage: { teamTokens: 1 },
    chatroom: { id: "room", url: "https://example.com/room" },
  }));
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.get.mockImplementation(async (key: string) =>
    key === "refreshToken" ? "test-token" : "2000-01-01T00:00:00.000Z"
  );
  mocks.refresh.mockResolvedValue({
    client: { v2: { tweetThread: mocks.tweet }, currentUserV2: mocks.user },
    accessToken: "new-access",
    refreshToken: "new-refresh",
  });
  mocks.upload.mockResolvedValue("media");
  mocks.tweet.mockResolvedValue([{ data: { id: "tweet-id" } }]);
  mocks.user.mockResolvedValue({ data: { username: "olaf" } });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("tweet validation", () => {
  it("accepts 280 characters without truncating", () => {
    const data = { response: { tweet: "x".repeat(280), threadTweets: ["y".repeat(280)] } };
    expect(validateTweetLength(data)).toEqual(data.response);
  });

  it("accepts an empty thread", () => {
    expect(validateTweetLength({ response: { tweet: "Hi", threadTweets: [] } }))
      .toEqual({ tweet: "Hi", threadTweets: [] });
  });

  it.each([
    { response: { tweet: 1, threadTweets: [] } },
    { response: { tweet: overlong, threadTweets: [1] } },
    { response: { tweet: "Hi" } },
    null,
  ])("does not suppress malformed or mixed failures: %j", (data) => {
    expect(() => validateTweetLength(data)).toThrow();
  });
});

describe("tweet handler with real Teampilot SDK", () => {
  it.each([
    { response: { tweet: overlong, threadTweets: [] } },
    { response: { tweet: "Hi", threadTweets: ["Fine", overlong] } },
    { response: { tweet: overlong, threadTweets: [overlong, overlong] } },
  ])("silently skips overlong generations: %j", async (data) => {
    const fetchMock = vi.fn().mockResolvedValueOnce(sdkResponse(data));
    vi.stubGlobal("fetch", fetchMock);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await run();
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ didTweet: false, reason: "tweet_too_long" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(mocks.tweet).not.toHaveBeenCalled();
    expect(mocks.set).not.toHaveBeenCalledWith("lastTweeted", expect.anything());
    expect(errorLog).not.toHaveBeenCalled();
  });

  it("still publishes a valid generation and notifies Discord", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(sdkResponse(valid))
      .mockResolvedValueOnce(new Response("image"))
      .mockResolvedValueOnce(new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);
    const result = await run();
    expect(JSON.parse(result.body).didTweet).toBe(true);
    expect(mocks.tweet).toHaveBeenCalledWith([
      { text: "Hello", media: { media_ids: ["media"] } }, "World",
    ]);
    expect(mocks.set).toHaveBeenCalledWith("lastTweeted", expect.any(String));
    expect(fetchMock).toHaveBeenLastCalledWith("https://example.com/discord", expect.any(Object));
  });

  it("preserves the already-tweeted-today guard", async () => {
    mocks.get.mockImplementation(async (key: string) =>
      key === "refreshToken" ? "test-token" : new Date().toISOString()
    );
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(sdkResponse(valid))
      .mockResolvedValueOnce(new Response("image")));
    expect(JSON.parse((await run()).body).didTweet).toBe(false);
    expect(mocks.tweet).not.toHaveBeenCalled();
  });

  it("propagates network failures", async () => {
    const error = new Error("Network unavailable");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(error));
    await expect(run()).rejects.toBe(error);
  });

  it("propagates malformed SDK responses even alongside an overlong tweet", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(sdkResponse({
      response: { tweet: overlong, threadTweets: [42] },
    })));
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(run()).rejects.toThrow();
    expect(mocks.tweet).not.toHaveBeenCalled();
  });

  it("propagates Twitter failures", async () => {
    const error = new Error("Twitter unavailable");
    mocks.tweet.mockRejectedValueOnce(error);
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(sdkResponse(valid))
      .mockResolvedValueOnce(new Response("image")));
    await expect(run()).rejects.toBe(error);
  });
});
