import { describe, expect, it } from "vitest";
import { resolveCreatorSessionPath } from "../creator-session.js";

describe("resolveCreatorSessionPath", () => {
  const config = { session_path: "C:/anonka/sessions", session_name: "legacy" };

  it("isolates a creator session beneath the configured session directory", () => {
    expect(resolveCreatorSessionPath(config, "creator_1").replaceAll("\\", "/")).toBe(
      "C:/anonka/sessions/creators/creator_1/telegram_session.txt"
    );
  });

  it("keeps the configured legacy session path when no creator is selected", () => {
    expect(resolveCreatorSessionPath(config).replaceAll("\\", "/")).toBe(
      "C:/anonka/sessions/legacy.txt"
    );
  });

  it("rejects path traversal in a creator id", () => {
    expect(() => resolveCreatorSessionPath(config, "../other")).toThrow("Creator id");
  });
});
