import { describe, it, expect } from "vitest";
import { Api, errors } from "telegram";
import { toLong } from "../../utils/gramjs-bigint";
import {
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

describe("isDefiniteSendFailure", () => {
  it("RPCError is definite", () => {
    const request = new Api.messages.GetChats({});
    const rpcError = new errors.RPCError("PEER_ID_INVALID", request, 400);
    expect(isDefiniteSendFailure(rpcError)).toBe(true);
  });

  it("FloodWaitError is definite", () => {
    const floodError = new errors.FloodWaitError({ capture: 5, request: undefined });
    expect(isDefiniteSendFailure(floodError)).toBe(true);
  });

  it("flood-retry's plain 'FLOOD_WAIT exceeds max' Error is definite", () => {
    expect(isDefiniteSendFailure(new Error("FLOOD_WAIT 500s exceeds max 120s — aborting"))).toBe(
      true
    );
  });

  it("network errors are ambiguous (not definite)", () => {
    expect(isDefiniteSendFailure(new Error("ECONNRESET"))).toBe(false);
    expect(isDefiniteSendFailure(new TypeError("socket hang up"))).toBe(false);
  });
});
