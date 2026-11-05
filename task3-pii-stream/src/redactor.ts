const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const SSN_PATTERN = /(?<!\d)\d{3}[- ]\d{2}[- ]\d{4}(?!\d)/g;
const CARD_PATTERN = /(?<!\d)\d(?:[ -]?\d){12,18}(?!\d)/g;

export type RedactorOptions = {
  emailReplacement?: string;
  ssnReplacement?: string;
  cardReplacement?: string;
  maxTail?: number;
};

function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;

  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = digits.charCodeAt(index) - 48;

    if (double) {
      digit *= 2;

      if (digit > 9) {
        digit -= 9;
      }
    }

    sum += digit;
    double = !double;
  }

  return sum % 10 === 0;
}

function trailingNonWhitespaceLength(text: string): number {
  let index = text.length;

  while (index > 0) {
    const code = text.charCodeAt(index - 1);

    if (code === 32 || (code >= 9 && code <= 13)) {
      break;
    }

    index -= 1;
  }

  return text.length - index;
}

function isDigitOrSeparator(code: number): boolean {
  return (code >= 48 && code <= 57) || code === 32 || code === 45;
}

function trailingNumberLength(text: string): number {
  let index = text.length;

  while (index > 0 && isDigitOrSeparator(text.charCodeAt(index - 1))) {
    index -= 1;
  }

  return text.length - index;
}

function isWordCharacter(code: number): boolean {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 95
  );
}

function isTrailingPunctuation(code: number): boolean {
  return code !== 32 && !(code >= 9 && code <= 13) && !isWordCharacter(code);
}

function trailingNumberAfterPunctuationLength(text: string): number {
  let punctuationStart = text.length;

  while (
    punctuationStart > 0 &&
    isTrailingPunctuation(text.charCodeAt(punctuationStart - 1))
  ) {
    punctuationStart -= 1;
  }

  let numberStart = punctuationStart;

  while (numberStart > 0 && isDigitOrSeparator(text.charCodeAt(numberStart - 1))) {
    numberStart -= 1;
  }

  if (numberStart === punctuationStart) {
    return 0;
  }

  return text.length - numberStart;
}

export class Redactor {
  private pending = "";
  private readonly emailReplacement: string;
  private readonly ssnReplacement: string;
  private readonly cardReplacement: string;
  private readonly maxTail: number;

  constructor(options: RedactorOptions = {}) {
    this.emailReplacement = options.emailReplacement ?? "[EMAIL]";
    this.ssnReplacement = options.ssnReplacement ?? "[SSN]";
    this.cardReplacement = options.cardReplacement ?? "[CARD]";
    this.maxTail = options.maxTail ?? 256;
  }

  push(text: string): string {
    this.pending += text;

    const tailLength = Math.min(
      this.maxTail,
      Math.max(
        trailingNonWhitespaceLength(this.pending),
        trailingNumberLength(this.pending),
        trailingNumberAfterPunctuationLength(this.pending)
      )
    );
    const headLength = this.pending.length - tailLength;

    if (headLength <= 0) {
      return "";
    }

    const head = this.pending.slice(0, headLength);
    this.pending = this.pending.slice(headLength);

    return this.redact(head);
  }

  flush(): string {
    if (this.pending === "") {
      return "";
    }

    const output = this.redact(this.pending);
    this.pending = "";

    return output;
  }

  private redact(text: string): string {
    return text
      .replace(EMAIL_PATTERN, this.emailReplacement)
      .replace(SSN_PATTERN, this.ssnReplacement)
      .replace(CARD_PATTERN, (match) =>
        luhn(match.replace(/\D/g, "")) ? this.cardReplacement : match
      );
  }
}
