import { describe, it, expect } from "vitest";
import { Api, errors } from "telegram";
import { toLong } from "../../utils/gramjs-bigint";
import {
  classifySendFailure,
  extractMessageIdMappings,
  extractSentMessageResult,
  isDefiniteSendFailure,
} from "../send-result";

describe("extractMessageIdMappings", () => {
  it("extracts UpdateMessageID mappings from Api.Updates", () => {
    const result = new Api.Updates({
      updates: [
        new Api.UpdateMessageID({ id: 100, randomId: toLong(10n) }),
        new Api.UpdateMessageID({ id: 101, randomId: toLong(20n) }),
      ],
      users: [],
      chats: [],
      date: 1,
      seq: 0,
    });

    const mappings = extractMessageIdMappings(result);
    expect(mappings.get("10")).toBe(100);
    expect(mappings.get("20")).toBe(101);
  });

  it("handles UpdateShort with a single UpdateMessageID", () => {
    const result = new Api.UpdateShort({
      update: new Api.UpdateMessageID({ id: 55, randomId: toLong(7n) }),
      date: 1,
    });

    expect(extractMessageIdMappings(result).get("7")).toBe(55);
  });
});

describe("extractSentMessageResult", () => {
  it("resolves the message for OUR randomId from Api.Updates", () => {
    const message = new Api.Message({
      id: 100,
      date: 1234,
      message: "hi",
      peerId: new Api.PeerUser({ userId: toLong(111n) }),
    });
    const result = new Api.Updates({
      updates: [
        new Api.UpdateMessageID({ id: 100, randomId: toLong(10n) }),
        new Api.UpdateMessageID({ id: 101, randomId: toLong(20n) }),
        new Api.UpdateNewMessage({ message, pts: 1, ptsCount: 0 }),
      ],
      users: [],
      chats: [],
      date: 1234,
      seq: 0,
    });

    const sent = extractSentMessageResult(result, 20n);
    expect(sent).toBeDefined();
    expect(sent?.messageId).toBe(101);
  });

  it("uses UpdateNewMessage date when the mapping resolves to a message", () => {
    const message = new Api.Message({
      id: 100,
      date: 9999,
      message: "hi",
      peerId: new Api.PeerUser({ userId: toLong(111n) }),
    });
    const result = new Api.Updates({
      updates: [
        new Api.UpdateMessageID({ id: 100, randomId: toLong(10n) }),
        new Api.UpdateNewMessage({ message, pts: 1, ptsCount: 0 }),
      ],
      users: [],
      chats: [],
      date: 9999,
      seq: 0,
    });

    const sent = extractSentMessageResult(result, 10n);
    expect(sent?.messageId).toBe(100);
    expect(sent?.date).toBe(9999);
  });

  it("handles UpdateShortSentMessage directly", () => {
    const result = new Api.UpdateShortSentMessage({
      id: 77,
      date: 555,
      pts: 1,
      ptsCount: 0,
      out: true,
    });

    const sent = extractSentMessageResult(result, 123n);
    expect(sent).toEqual({ messageId: 77, date: 555 });
  });

  it("handles UpdateShortMessage with out=true as our sent message", () => {
    const result = new Api.UpdateShortMessage({
      out: true,
      id: 42,
      date: 777,
      userId: toLong(1n),
      message: "hi",
      pts: 1,
      ptsCount: 0,
    });

    const sent = extractSentMessageResult(result, 9n);
    expect(sent).toEqual({ messageId: 42, date: 777 });
  });

  it("returns undefined when OUR randomId has no mapping", () => {
    const result = new Api.Updates({
      updates: [new Api.UpdateMessageID({ id: 100, randomId: toLong(10n) })],
      users: [],
      chats: [],
      date: 1,
      seq: 0,
    });

    expect(extractSentMessageResult(result, 999n)).toBeUndefined();
  });
});

describe("classifySendFailure", () => {
  const request = new Api.messages.GetChats({});

  function rpcError(message: string, code?: number): errors.RPCError {
    return new errors.RPCError(message, request, code);
  }

  it("RPC 400 validation error → definite", () => {
    expect(classifySendFailure(rpcError("PEER_ID_INVALID", 400))).toBe("definite");
    expect(isDefiniteSendFailure(rpcError("PEER_ID_INVALID", 400))).toBe(true);
  });

  it("RPC 403 permission error → definite", () => {
    expect(classifySendFailure(rpcError("CHAT_WRITE_FORBIDDEN", 403))).toBe("definite");
  });

  it("RPC 401 → definite", () => {
    expect(classifySendFailure(rpcError("SESSION_REVOKED", 401))).toBe("definite");
  });

  it("RPC 420 FLOOD → definite", () => {
    expect(classifySendFailure(rpcError("FLOOD_WAIT_10", 420))).toBe("definite");
  });

  it("RPC 303 migrate → definite (not executed on this DC)", () => {
    expect(classifySendFailure(rpcError("PHONE_MIGRATE_5", 303))).toBe("definite");
  });

  it("RPC 500 → ambiguous", () => {
    expect(classifySendFailure(rpcError("INTERNAL", 500))).toBe("ambiguous");
  });

  it("RPC 503 timeout → ambiguous", () => {
    expect(classifySendFailure(rpcError("Timeout", 503))).toBe("ambiguous");
  });

  it("negative server code (-500) → ambiguous", () => {
    expect(classifySendFailure(rpcError("INTERNAL", -500))).toBe("ambiguous");
  });

  it("INTERNAL server error without code → ambiguous", () => {
    expect(classifySendFailure(rpcError("INTERNAL"))).toBe("ambiguous");
  });

  it("RANDOM_ID_DUPLICATE → ambiguous even with 500 code", () => {
    expect(classifySendFailure(rpcError("RANDOM_ID_DUPLICATE", 500))).toBe("ambiguous");
  });

  it("unknown RPC code → ambiguous (conservative default)", () => {
    expect(classifySendFailure(rpcError("SOMETHING_NEW", 418))).toBe("ambiguous");
  });

  it("FloodWaitError instance → definite", () => {
    const floodError = new errors.FloodWaitError({ capture: 5, request: undefined });
    expect(classifySendFailure(floodError)).toBe("definite");
  });

  it("ECONNRESET → ambiguous", () => {
    expect(classifySendFailure(new Error("ECONNRESET"))).toBe("ambiguous");
  });

  it("socket timeout → ambiguous", () => {
    expect(classifySendFailure(new TypeError("socket hang up"))).toBe("ambiguous");
    expect(classifySendFailure(new Error("network timeout"))).toBe("ambiguous");
  });

  it("flood-retry's plain 'FLOOD_WAIT exceeds max' Error → definite", () => {
    expect(classifySendFailure(new Error("FLOOD_WAIT 500s exceeds max 120s — aborting"))).toBe(
      "definite"
    );
  });
});
