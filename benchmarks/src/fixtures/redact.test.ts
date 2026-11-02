import { describe, expect, it } from "vitest";
import { redactWords } from "./redact.js";

// Seam S1: redactWords(lines, entities) -> { lines, redactions, unmatchedEntities }.
// Fixtures are the parser's input; redaction may only touch non-scored PII.
//
// These literals are SYNTHETIC. They reproduce the printed shapes found in the pinned
// snapshots (see DECISIONS/0005) without committing a real receipt's email, account
// number, phone or name into a test file.

describe("redactWords — email", () => {
  it("redacts an email glued to its label and keeps the label", () => {
    const result = redactWords([["HEAD", "OFFICE", "WEST"], ["EMAIL:LOCAL@DOMAIN.COM"]]);

    expect(result.lines.map((line) => [...line])).toEqual([["HEAD", "OFFICE", "WEST"], ["EMAIL:[EMAIL]"]]);
  });

  it("redacts a standalone email token", () => {
    const result = redactWords([["local@domain.com"]]);

    expect([...result.lines[0]!]).toEqual(["[EMAIL]"]);
  });

  it("logs what it changed so the audit can read the method", () => {
    const result = redactWords([["EMAIL:LOCAL@DOMAIN.COM"]]);

    expect(result.redactions).toEqual([
      { class: "EMAIL", line: 0, word: 0, before: "EMAIL:LOCAL@DOMAIN.COM", after: "EMAIL:[EMAIL]" },
    ]);
  });
});

describe("redactWords — UPI / VPA", () => {
  it("redacts a VPA on a known PSP handle", () => {
    const result = redactWords([["PAYMENT", "user.one@ybl"]]);

    expect([...result.lines[0]!]).toEqual(["PAYMENT", "[UPI]"]);
    expect(result.redactions[0]!.class).toBe("UPI");
  });

  it("redacts an ok-prefixed and a bare-upi handle", () => {
    const result = redactWords([["9000000001@okhdfcbank"], ["shop@upi"]]);

    expect([...result.lines[0]!]).toEqual(["[UPI]"]);
    expect([...result.lines[1]!]).toEqual(["[UPI]"]);
  });

  it("does not mistake a real email for a VPA", () => {
    const result = redactWords([["local@domain.com"]]);

    expect(result.redactions[0]!.class).toBe("EMAIL");
    expect([...result.lines[0]!]).toEqual(["[EMAIL]"]);
  });

  it("leaves an unknown-handle at-token alone rather than guessing", () => {
    const result = redactWords([["invoice@somewhere-nobody-knows"]]);

    expect(result.redactions).toEqual([]);
    expect([...result.lines[0]!]).toEqual(["invoice@somewhere-nobody-knows"]);
  });
});

describe("redactWords — phone, card and account numbers", () => {
  it("redacts a phone glued to its TEL label and keeps the label", () => {
    const result = redactWords([["TEL:07-555 0100"]]);

    expect([...result.lines[0]!]).toEqual(["TEL:[PHONE]"]);
  });

  it("redacts an international number token", () => {
    const result = redactWords([["+603-5550 1200"]]);

    expect([...result.lines[0]!]).toEqual(["[PHONE]"]);
  });

  it("redacts a bank account tail while keeping BANK ACC and the bank name", () => {
    // Printed shape found in the snapshot: `BANK ACC <bank> ### ### ### ####`.
    const result = redactWords([["BANK ACC BANKX 1111 2222 3333"]]);

    expect([...result.lines[0]!]).toEqual(["BANK ACC BANKX [ACCOUNT]"]);
    expect(result.redactions[0]!.class).toBe("ACCOUNT");
  });

  it("redacts a masked card tail", () => {
    const result = redactWords([["XXXXXXXXXXXX0007"]]);

    expect([...result.lines[0]!]).toEqual(["[CARD_XXXX]"]);
  });

  it("never touches money, because money is the scored field", () => {
    const result = redactWords([
      ["193.00"],
      ["17500"],
      ["23.000"],
      ["16,500"],
      ["000000111", "1", "193.00", "193.00 SR"],
      ["TOTAL:", "193.00"],
    ]);

    expect(result.redactions).toEqual([]);
    expect(result.lines.map((line) => [...line])).toEqual([
      ["193.00"],
      ["17500"],
      ["23.000"],
      ["16,500"],
      ["000000111", "1", "193.00", "193.00 SR"],
      ["TOTAL:", "193.00"],
    ]);
  });
});

describe("redactWords — label-value spans", () => {
  it("redacts a cashier name after the label and keeps the label", () => {
    const result = redactWords([["CASHIER", ":", "ANA", "TOKO", "SINTA", "SALES PERSON : BUDI"]]);

    expect([...result.lines[0]!]).toEqual([
      "CASHIER",
      ":",
      "[NAME]",
      "[NAME]",
      "[NAME]",
      "SALES PERSON : [NAME]",
    ]);
  });

  it("redacts a name glued after CASHIER: and stops at the next structural word", () => {
    const result = redactWords([["CASHIER:", "MIRA", "COVER"]]);

    expect([...result.lines[0]!]).toEqual(["CASHIER:", "[NAME]", "COVER"]);
  });

  it("redacts a BILL TO customer identity word by word", () => {
    const result = redactWords([["BILL TO", ":", "ACME", "TRADING", "CO", "ADDRESS"]]);

    expect([...result.lines[0]!]).toEqual([
      "BILL TO",
      ":",
      "[CUSTOMER]",
      "[CUSTOMER]",
      "[CUSTOMER]",
      "ADDRESS",
    ]);
  });

  it("redacts an invoice number value and keeps the label", () => {
    const result = redactWords([["INVOICE NO", ": INV-0000123"]]);

    expect([...result.lines[0]!]).toEqual(["INVOICE NO", ": [INVOICE_NNN]"]);
  });

  it("leaves item name lines alone, because item names are kept verbatim", () => {
    const result = redactWords([["KINGS", "SAFETY", "SHOES", "KWD", "B05"]]);

    expect(result.redactions).toEqual([]);
    expect([...result.lines[0]!]).toEqual(["KINGS", "SAFETY", "SHOES", "KWD", "B05"]);
  });

  it("does not read the header word TAX INVOICE as an invoice-number label", () => {
    const result = redactWords([["TAX INVOICE"]]);

    expect(result.redactions).toEqual([]);
    expect([...result.lines[0]!]).toEqual(["TAX INVOICE"]);
  });

  it("treats a punctuation-only tail as no value and does not eat the currency marker", () => {
    const result = redactWords([["CASHIER#:", ":", "RM", "CODE"]]);

    expect(result.redactions).toEqual([]);
    expect([...result.lines[0]!]).toEqual(["CASHIER#:", ":", "RM", "CODE"]);
  });
});

describe("redactWords — business and address, anchored to the dataset's own entities", () => {
  it("redacts the company entity where it appears in the header", () => {
    const result = redactWords(
      [["HEAD CLERK", "*** COPY ***", "ACME MARKETING SDN BHD", "ROC NO: 000000-X"]],
      { company: "ACME MARKETING SDN BHD" }
    );

    expect([...result.lines[0]!]).toEqual(["HEAD CLERK", "*** COPY ***", "[BUSINESS]", "ROC NO: 000000-X"]);
  });

  it("redacts an address spread across several header tokens", () => {
    const result = redactWords(
      [["NO 9 & 9A", "JALAN CONTOH 1", "99999 CONTOH"]],
      { address: "NO 9 & 9A, JALAN CONTOH 1, 99999 CONTOH, WILAYAH" }
    );

    expect([...result.lines[0]!]).toEqual(["[ADDRESS]", "[ADDRESS]", "[ADDRESS]"]);
    expect(result.redactions.map((redaction) => redaction.class)).toEqual([
      "ADDRESS",
      "ADDRESS",
      "ADDRESS",
    ]);
  });

  it("reports an entity it could not locate instead of dropping it silently", () => {
    const result = redactWords([["WARUNG CONTOH", "TAX INVOICE"]], { company: "SUKSES JAYA RAYA" });

    expect(result.redactions).toEqual([]);
    expect(result.unmatchedEntities).toEqual([{ class: "BUSINESS", text: "SUKSES JAYA RAYA" }]);
  });

  it("never reaches past the header block, so a matching item name survives", () => {
    const itemLines = Array.from({ length: 9 }, (_, index) => [`LINE ${index}`]);
    const result = redactWords(
      [...itemLines, ["ACME SAFETY SHOES KWD B05"]],
      { company: "ACME SAFETY" }
    );

    expect(result.redactions).toEqual([]);
    expect([...result.lines.at(-1)!]).toEqual(["ACME SAFETY SHOES KWD B05"]);
  });
});
