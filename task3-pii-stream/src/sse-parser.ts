export type SseField = {
  name: string;
  value: string;
};

export type SseEvent = {
  comments: string[];
  fields: SseField[];
  data: string | null;
  raw: string;
};

export class SseParser {
  private buffer = "";
  private raw = "";
  private comments: string[] = [];
  private fields: SseField[] = [];
  private dataLines: string[] = [];
  private hasLines = false;

  push(chunk: string): SseEvent[] {
    this.buffer += chunk;

    const events: SseEvent[] = [];
    let newline = this.buffer.indexOf("\n");

    while (newline !== -1) {
      const rawLine = this.buffer.slice(0, newline + 1);
      this.buffer = this.buffer.slice(newline + 1);
      this.consumeLine(rawLine, events);
      newline = this.buffer.indexOf("\n");
    }

    return events;
  }

  flush(): SseEvent[] {
    const events: SseEvent[] = [];

    if (this.buffer.length > 0) {
      const rawLine = this.buffer;
      this.buffer = "";
      this.consumeLine(rawLine, events);
    }

    if (this.hasLines) {
      events.push(this.dispatch(""));
    }

    return events;
  }

  private consumeLine(rawLine: string, events: SseEvent[]): void {
    let content = rawLine;

    if (content.endsWith("\n")) {
      content = content.slice(0, -1);
    }

    if (content.endsWith("\r")) {
      content = content.slice(0, -1);
    }

    if (content.length === 0) {
      if (this.hasLines) {
        events.push(this.dispatch(rawLine));
      } else {
        events.push({ comments: [], fields: [], data: null, raw: rawLine });
      }

      return;
    }

    this.hasLines = true;
    this.raw += rawLine;

    if (content.startsWith(":")) {
      this.comments.push(content);
      return;
    }

    const colon = content.indexOf(":");
    const name = colon === -1 ? content : content.slice(0, colon);
    let value = colon === -1 ? "" : content.slice(colon + 1);

    if (value.startsWith(" ")) {
      value = value.slice(1);
    }

    if (name === "data") {
      this.dataLines.push(value);
    } else {
      this.fields.push({ name, value });
    }
  }

  private dispatch(blankRaw: string): SseEvent {
    let raw = this.raw + blankRaw;

    if (blankRaw === "") {
      if (!raw.endsWith("\n")) {
        raw += "\n";
      }

      raw += "\n";
    }

    const event: SseEvent = {
      comments: this.comments,
      fields: this.fields,
      data: this.dataLines.length > 0 ? this.dataLines.join("\n") : null,
      raw,
    };

    this.raw = "";
    this.comments = [];
    this.fields = [];
    this.dataLines = [];
    this.hasLines = false;

    return event;
  }
}
