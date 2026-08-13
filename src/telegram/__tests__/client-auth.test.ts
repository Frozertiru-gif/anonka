import { describe, expect, it } from "vitest";
import { isInvalidTelegramSessionError, TelegramAuthRequiredError } from "../client.js";

describe("non-interactive Telegram authentication classification", () => {
  it("missing session has an explicit AUTH_REQUIRED outcome", () => {
    const error = new TelegramAuthRequiredError();
    expect(error.code).toBe("AUTH_REQUIRED");
    expect(error.message).toContain("creator login");
  });

  it.each(["AUTH_KEY_UNREGISTERED", "SESSION_REVOKED", "SESSION_EXPIRED", "AUTH_KEY_DUPLICATED"])(
    "invalid persisted session code %s requires a new login",
    (errorMessage) => {
      expect(isInvalidTelegramSessionError({ errorMessage })).toBe(true);
    }
  );

  it.each([
    new Error("ECONNRESET"),
    { errorMessage: "FLOOD_WAIT_30" },
    { errorMessage: "NETWORK_MIGRATE_2" },
    { errorMessage: "PHONE_CODE_INVALID" },
  ])("ordinary transport/authentication failure remains an ordinary error: %#", (error) => {
    expect(isInvalidTelegramSessionError(error)).toBe(false);
  });
});
