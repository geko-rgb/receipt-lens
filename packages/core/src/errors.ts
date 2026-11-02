export type ReceiptLensErrorCode =
  | "IMAGE_UNREADABLE"
  | "MODEL_LOAD_FAILED"
  | "RECOGNIZE_FAILED";

export class ReceiptLensError extends Error {
  readonly code: ReceiptLensErrorCode;

  constructor(code: ReceiptLensErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ReceiptLensError";
    this.code = code;
  }
}
