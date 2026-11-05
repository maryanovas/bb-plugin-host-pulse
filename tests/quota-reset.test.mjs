import { test } from "node:test";
import assert from "node:assert/strict";
import { quotaResetCountdown } from "../lib/quota-reset.ts";

const now = Date.parse("2026-11-05T10:00:00Z");
const after = (ms) => new Date(now + ms).toISOString();

test("reset countdown uses compact day/hour and hour/minute values", () => {
  const cases = [
    [60_000, "1м"], [59 * 60_000, "59м"], [60 * 60_000, "1ч"],
    [135 * 60_000, "2ч 15м"], [1439 * 60_000, "23ч 59м"],
    [1440 * 60_000, "1д"], [(3 * 1440 + 4 * 60 + 29) * 60_000, "3д 4ч"],
  ];
  for (const [duration, expected] of cases) assert.equal(quotaResetCountdown(after(duration), now).text, expected);
});

test("invalid and missing deadlines never become a fabricated zero countdown", () => {
  for (const deadline of [null, "", "not-a-date"]) assert.equal(quotaResetCountdown(deadline, now).text, "—");
  assert.equal(quotaResetCountdown(after(60_000), NaN).text, "—");
});

test("the last minute and expired deadlines remain distinct without assuming a quota reset", () => {
  for (const duration of [1, 59_999]) assert.equal(quotaResetCountdown(after(duration), now).text, "<1м");
  for (const duration of [0, -1, -86_400_000]) assert.equal(quotaResetCountdown(after(duration), now).text, "ждём");
});

test("countdowns follow real timestamps and timezone offsets across clock updates", () => {
  const deadline = "2026-11-05T14:01:00+03:00";
  assert.equal(quotaResetCountdown(deadline, now).text, "1ч 1м");
  assert.equal(quotaResetCountdown(deadline, now + 60_000).text, "1ч");
  assert.equal(quotaResetCountdown(deadline, now + 61 * 60_000).text, "ждём");
});
