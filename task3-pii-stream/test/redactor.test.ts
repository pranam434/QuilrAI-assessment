import { test } from "node:test";
import assert from "node:assert/strict";

import { Redactor } from "../src/redactor.js";

function runRedactor(chunks: string[]): string {
  const redactor = new Redactor();
  let output = "";

  for (const chunk of chunks) {
    output += redactor.push(chunk);
  }

  output += redactor.flush();

  return output;
}

function mulberry32(seed: number): () => number {
  let state = seed;

  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function randomChunks(text: string, random: () => number): string[] {
  const chunks: string[] = [];
  let index = 0;

  while (index < text.length) {
    const size = 1 + Math.floor(random() * 7);
    chunks.push(text.slice(index, index + size));
    index += size;
  }

  return chunks.length > 0 ? chunks : [""];
}

test("separates PII at end of a single chunk", () => {
  assert.equal(runRedactor(["email alice@example.com"]), "email [EMAIL]");
  assert.equal(runRedactor(["ssn 123-45-6789"]), "ssn [SSN]");
  assert.equal(runRedactor(["card 4242 4242 4242 4242"]), "card [CARD]");
});

test("email split across three chunks is redacted", () => {
  const text = "email alice@example.com here";
  const chunks = [text.slice(0, 9), text.slice(9, 14), text.slice(14)];

  assert.equal(runRedactor(chunks), "email [EMAIL] here");
});

test("ssn split across three chunks is redacted", () => {
  const text = "ssn 123-45-6789 end";
  const chunks = [text.slice(0, 7), text.slice(7, 11), text.slice(11)];

  assert.equal(runRedactor(chunks), "ssn [SSN] end");
});

test("card split across three chunks is redacted", () => {
  const text = "card 4242 4242 4242 4242 done";
  const chunks = [text.slice(0, 10), text.slice(10, 15), text.slice(15)];

  assert.equal(runRedactor(chunks), "card [CARD] done");
});

test("non-Luhn, dates and normal numbers are preserved", () => {
  const text =
    "not a card 1234567890123456 on 2024-01-15 with counts 42 and 1234567890.";

  assert.equal(runRedactor([text]), text);
});

test("any random chunking gives the same output as one chunk", () => {
  const text =
    "email a@b.co, ssn 123-45-6789, card 4242 4242 4242 4242, " +
    "also 4111-1111-1111-1111, fake 1234567890123456, date 2024-01-15, " +
    "numbers 42 and 1234567890, and trailing text.";
  const expected = runRedactor([text]);
  const random = mulberry32(0x5eed);

  for (let trial = 0; trial < 500; trial += 1) {
    assert.equal(runRedactor(randomChunks(text, random)), expected);
  }
});

test("holds a partial card until a safe boundary", () => {
  const redactor = new Redactor();

  assert.equal(redactor.push("card 4242 4242"), "card");
  assert.equal(redactor.push(" 4242 4242 is"), " [CARD] ");
  assert.equal(redactor.flush(), "is");
});

test("holds a space separated card followed by punctuation", () => {
  assert.equal(
    runRedactor(["card 4242 4242 ", "4242 4242, ok"]),
    "card [CARD], ok"
  );
});
