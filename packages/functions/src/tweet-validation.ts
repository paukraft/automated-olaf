import { z } from "zod";

// Keep structural validation in the SDK, but check length locally so an
// expected overlong generation never reaches the SDK's console.error path.
export const generatedTweetSchema = z.object({
  response: z.object({
    tweet: z.string(),
    threadTweets: z.array(z.string()),
  }),
}).describe(
  "tweet must be at most 280 chars. threadTweets should be an array of tweets each max 280 chars long but min 200 chars long, so split it up"
);

const boundedTweetSchema = z.object({
  response: z.object({
    tweet: z.string().max(280),
    threadTweets: z.array(z.string().max(280)),
  }),
});

export function validateTweetLength(value: unknown) {
  const result = boundedTweetSchema.safeParse(value);
  if (result.success) return result.data.response;

  const onlyOverlongTweets = result.error.issues.every((issue) => {
    const path = issue.path;
    const isTweet = path.length === 2 && path[1] === "tweet";
    const isThreadTweet = path.length === 3 &&
      path[1] === "threadTweets" && typeof path[2] === "number";

    return path[0] === "response" && (isTweet || isThreadTweet) &&
      issue.code === "too_big" && issue.type === "string" &&
      issue.maximum === 280 && issue.inclusive === true && !issue.exact;
  });

  if (onlyOverlongTweets) return null;
  throw result.error;
}
