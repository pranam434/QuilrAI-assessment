import { test } from "node:test";
import assert from "node:assert/strict";

import { SseParser } from "../src/sse-parser.js";

test("handles LF and CRLF terminators", () => {
  const parser = new SseParser();
  const events = parser.push('data: {"a":1}\r\n\r\n');

  assert.equal(events.length, 1);
  assert.equal(events[0]?.data, '{"a":1}');
});

test("joins multiple data lines", () => {
  const parser = new SseParser();
  const events = parser.push("data: one\ndata: two\n\n");

  assert.equal(events.length, 1);
  assert.equal(events[0]?.data, "one\ntwo");
});

test("keeps an event split mid-JSON buffered", () => {
  const parser = new SseParser();

  assert.deepEqual(parser.push('data: {"a":'), []);

  const events = parser.push("1}\n\n");

  assert.equal(events.length, 1);
  assert.equal(events[0]?.data, '{"a":1}');
});

test("flushes a final event with no trailing blank line", () => {
  const parser = new SseParser();

  assert.deepEqual(parser.push("data: tail"), []);

  const events = parser.flush();

  assert.equal(events.length, 1);
  assert.equal(events[0]?.data, "tail");
  assert.ok(events[0]?.raw.endsWith("\n\n"));
});

test("passes comments and keepalives through", () => {
  const parser = new SseParser();
  const events = parser.push(": ping\n\n");

  assert.equal(events.length, 1);
  assert.equal(events[0]?.data, null);
  assert.equal(events[0]?.raw, ": ping\n\n");
});

test("preserves comments and fields alongside data", () => {
  const parser = new SseParser();
  const events = parser.push(': keepalive\nevent: message\ndata: payload\n\n');

  assert.equal(events.length, 1);
  assert.equal(events[0]?.data, "payload");
  assert.deepEqual(events[0]?.comments, [": keepalive"]);
  assert.deepEqual(events[0]?.fields, [{ name: "event", value: "message" }]);
});

test("passes a standalone blank line through", () => {
  const parser = new SseParser();
  const events = parser.push("\n");

  assert.equal(events.length, 1);
  assert.equal(events[0]?.data, null);
  assert.equal(events[0]?.raw, "\n");
});

test("does not split a CRLF pair across chunks", () => {
  const parser = new SseParser();

  assert.deepEqual(parser.push("data: x\r"), []);
  const events = parser.push("\n\r\n");

  assert.equal(events.length, 1);
  assert.equal(events[0]?.data, "x");
});
