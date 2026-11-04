<script lang="ts">
  /**
   * Ticket 10 — capture, review, reprocess.
   *
   * The rules live in `lib/capture/*` (DECISIONS/0018 P1–P6) and are pinned by
   * `tests/capture/pins.test.ts`; this component is the shell over them: it owns the file/camera
   * intake, the preview geometry, and the accept/discard lifecycle. OCR is reached only through
   * `lib/ocr.ts`, so `onnxruntime-web` never enters the entry chunk (DECISIONS/0017 D4).
   *
   * No receipt image is persisted: the source is a Blob in memory and `/bill` receives a draft, not
   * bytes. The opt-in retention toggle belongs to ticket 14's storage layer and is deliberately absent.
   */
  import { onMount } from "svelte";
  import { ACCEPT_ATTRIBUTE, isAcceptedImageType, unsupportedTypeMessage } from "../lib/capture/formats.js";
  import { browserEnvironment, applyTransformations, type Rect } from "../lib/capture/transform.js";
  import { decideDeskew, estimateSkew } from "../lib/capture/deskew.js";
  import { CONTRAST_LIMIT_PERCENT, clampContrastPercent } from "../lib/capture/contrast.js";
  import { extractInBrowser } from "../lib/ocr.js";
  import { setDraft } from "../lib/draft.js";
  import { targetUrl } from "../lib/router.js";
  import type { ParseResult, ParseValidationResult, ParsedItem, ParsedOtherCharge } from "@receipt-lens/core";

  const VALIDATION_OPTIONS = {
    criticalOcrConfidenceFloor: 0.5,
    warningOcrConfidenceFloor: 0.7,
    strictArithmetic: true,
  } as const;

  const MAX_PREVIEW_PX = 560;

  type DeskewStatus = "idle" | "estimating" | "applied" | "skipped";

  interface ParseState {
    items: ParsedItem[];
    charges: ParsedOtherCharge[];
    parse: ParseResult;
    validation: ParseValidationResult;
  }

  let source = $state<Blob | null>(null);
  let previewUrl = $state<string | null>(null);
  let naturalWidth = $state(0);
  let naturalHeight = $state(0);
  let rotationDegrees = $state(0);
  let contrastPercent = $state(0);
  let deskewDegrees = $state(0);
  let deskewStatus = $state<DeskewStatus>("idle");
  let crop = $state<Rect | null>(null);
  let dragging = $state(false);
  let dragOrigin = $state<{ x: number; y: number } | null>(null);
  let frameBox = $state<{ x: number; y: number } | null>(null);

  let error = $state<string | null>(null);
  let notice = $state<string | null>(null);
  let busy = $state(false);
  let cameraDenied = $state(false);
  let cameraAvailable = $state(false);

  let current = $state<ParseState | null>(null);
  let previous = $state<ParseState | null>(null);

  let fileInput = $state<HTMLInputElement | null>(null);

  const fit = $derived.by(() => {
    const width = naturalWidth || 1;
    const height = naturalHeight || 1;
    const swap = rotationDegrees === 90 || rotationDegrees === 270;
    const outerWidth = swap ? height : width;
    const outerHeight = swap ? width : height;
    const scale = Math.min(MAX_PREVIEW_PX / outerWidth, MAX_PREVIEW_PX / outerHeight);
    return {
      scale,
      outerWidth: outerWidth * scale,
      outerHeight: outerHeight * scale,
      innerWidth: width * scale,
      innerHeight: height * scale,
    };
  });

  const overlayStyle = $derived(
    crop
      ? `left:${crop.x * fit.scale}px;top:${crop.y * fit.scale}px;width:${crop.width * fit.scale}px;height:${crop.height * fit.scale}px`
      : "",
  );

  onMount(() => {
    void detectCamera();
  });

  /** Feature detection only — no stream is opened until the user asks for the camera. */
  async function detectCamera(): Promise<void> {
    try {
      if (!navigator.mediaDevices?.enumerateDevices) return;
      const devices = await navigator.mediaDevices.enumerateDevices();
      cameraAvailable = devices.some((device) => device.kind === "videoinput");
    } catch {
      cameraAvailable = false;
    }
  }

  function describeFailure(cause: unknown): string {
    const error__ = cause as { code?: string; message?: string } | null;
    switch (error__?.code) {
      case "IMAGE_UNREADABLE":
        return "That image could not be decoded. Try another JPEG, PNG or WebP file.";
      case "MODEL_LOAD_FAILED":
        return "The OCR model could not be loaded. Check the connection for the asset download, then retry.";
      case "RECOGNIZE_FAILED":
        return "OCR failed on this image. Try a tighter crop or another photo.";
      default:
        return error__?.message || "OCR failed for an unknown reason.";
    }
  }

  function adoptBlob(blob: Blob): void {

    if (previewUrl) URL.revokeObjectURL(previewUrl);
    source = blob;
    previewUrl = URL.createObjectURL(blob);
    rotationDegrees = 0;
    contrastPercent = 0;
    deskewDegrees = 0;
    deskewStatus = "idle";
    crop = null;
    current = null;
    previous = null;
    error = null;
    notice = null;
    // The confirm-once working copy §10 describes is the preview; OCR starts from it immediately.
    void runOcr();
  }

  /**
   * Natural size comes from the load event, not `bind:naturalWidth`. A binding is torn down with its
   * element, and the element's existence here is gated on the size it reports — with a binding the two
   * chase each other and the preview remounts in a loop, which starves every canvas call behind it.
   */
  function onPreviewLoad(event: Event): void {
    const image = event.currentTarget as HTMLImageElement;
    naturalWidth = image.naturalWidth;
    naturalHeight = image.naturalHeight;
  }

  function handleFileSelect(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    if (!isAcceptedImageType(file.type)) {
      error = unsupportedTypeMessage(file.type);
      return;
    }
    adoptBlob(file);
  }

  async function captureFromCamera(): Promise<void> {
    error = null;
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
      const video = document.createElement("video");
      video.playsInline = true;
      video.srcObject = stream;
      await video.play();

      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext("2d")?.drawImage(video, 0, 0);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.95));
      if (blob) adoptBlob(blob);
    } catch {
      cameraDenied = true;
      fileInput?.click();
    } finally {
      stream?.getTracks().forEach((track) => track.stop());
    }
  }

  async function runOcr(): Promise<void> {
    if (!source || busy) return;
    busy = true;
    error = null;
    if (notice) notice = null;
    if (current) previous = current;

    try {
      const transformed = await applyTransformations(
        source,
        { rotationDegrees, crop, contrastPercent, deskewDegrees },
        browserEnvironment(),
      );
      const result = await extractInBrowser(transformed.blob, VALIDATION_OPTIONS);
      current = {
        items: result.parse.items ?? [],
        charges: result.parse.otherCharges ?? [],
        parse: result.parse,
        validation: result.validation,
      };
      if (result.ocr.lines.length === 0) {
        notice = "This image contains no readable text.";
      }
    } catch (cause) {
      error = describeFailure(cause);
    } finally {
      busy = false;
    }
  }

  function rotate(): void {
    rotationDegrees = (rotationDegrees + 90) % 360;
    void runOcr();
  }

  function adjustContrast(delta: number): void {
    const next = clampContrastPercent(contrastPercent + delta);
    if (next === contrastPercent) return;
    contrastPercent = next;
    void runOcr();
  }

  function resetCrop(): void {
    crop = null;
    void runOcr();
  }

  /** Pixels of the current (rotated, cropped) image, for the P4 estimator. */
  async function probePixels(): Promise<ImageData | null> {
    if (!source) return null;
    const transformed = await applyTransformations(
      source,
      { rotationDegrees, crop, contrastPercent: 0, deskewDegrees: 0 },
      browserEnvironment(),
    );
    const bitmap = await createImageBitmap(transformed.blob);
    const scale = Math.min(1, 600 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    bitmap.close();
    if (!context) return null;
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return context.getImageData(0, 0, canvas.width, canvas.height);
  }

  async function deskew(): Promise<void> {
    if (!source || busy) return;
    deskewStatus = "estimating";
    try {
      const pixels = await probePixels();
      const estimate = pixels ? estimateSkew(pixels) : null;
      const decision = decideDeskew(estimate === null ? null : { degrees: estimate, reliable: true });
      if (decision.applied) {
        deskewDegrees = decision.degrees;
        deskewStatus = "applied";
        await runOcr();
      } else {
        deskewDegrees = 0;
        deskewStatus = "skipped";
      }
    } catch {
      deskewDegrees = 0;
      deskewStatus = "skipped";
    }
  }

  function toSource(x: number, y: number): { x: number; y: number } {
    const width = naturalWidth * fit.scale;
    const height = naturalHeight * fit.scale;
    switch (rotationDegrees) {
      case 90:
        return { x: y, y: height - x };
      case 180:
        return { x: width - x, y: height - y };
      case 270:
        return { x: width - y, y: x };
      default:
        return { x, y };
    }
  }

  function rectFrom(a: { x: number; y: number }, b: { x: number; y: number }): Rect {
    const left = Math.min(a.x, b.x);
    const top = Math.min(a.y, b.y);
    return {
      x: Math.round(left),
      y: Math.round(top),
      width: Math.round(Math.abs(b.x - a.x)),
      height: Math.round(Math.abs(b.y - a.y)),
    };
  }

  function onPointerDown(event: PointerEvent): void {
    if (busy) return;
    const outer = (event.currentTarget as HTMLElement).getBoundingClientRect();
    frameBox = { x: outer.left, y: outer.top };
    dragging = true;
    dragOrigin = toSource(event.clientX - outer.left, event.clientY - outer.top);
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  }

  function onPointerMove(event: PointerEvent): void {
    if (!dragging || !dragOrigin || !frameBox) return;
    const point = toSource(event.clientX - frameBox.x, event.clientY - frameBox.y);
    crop = rectFrom(dragOrigin, point);
  }

  function onPointerUp(): void {
    if (!dragging) return;
    dragging = false;
    dragOrigin = null;
    if (crop && (crop.width < 8 || crop.height < 8)) crop = null;
    void runOcr();
  }

  function accept(): void {
    if (!current) return;
    setDraft(current);
    window.history.pushState({}, "", targetUrl("/bill", window.location.hash));
    window.dispatchEvent(new PopStateEvent("popstate"));
  }

  /** Restores the prior parse without asking OCR again — the rerun already happened. */
  function discard(): void {
    if (previous) {
      current = previous;
      previous = null;
      return;
    }
    current = null;
    crop = null;
    rotationDegrees = 0;
    contrastPercent = 0;
    deskewDegrees = 0;
  }
</script>

<h1>Capture</h1>
<p data-testid="capture-note">
  Capture a receipt or choose a file, adjust it non-destructively, then review the extracted draft.
  Nothing leaves the device and no image is stored.
</p>

{#if error}
  <div class="alert alert-error" role="alert" data-testid="capture-error">{error}</div>
{/if}
{#if notice}
  <div class="notice" data-testid="capture-notice">{notice}</div>
{/if}

<div class="intake">
  <input
    bind:this={fileInput}
    data-testid="file-input"
    type="file"
    accept={ACCEPT_ATTRIBUTE}
    onchange={handleFileSelect}
  />
  <button type="button" data-testid="choose-file" onclick={() => fileInput?.click()}>Choose a file</button>
  {#if cameraAvailable}
    <button type="button" data-testid="camera-btn" onclick={captureFromCamera}>Use camera</button>
  {/if}
  {#if cameraDenied}
    <span class="hint" data-testid="camera-denied">Camera unavailable — file selection still works.</span>
  {/if}
</div>

{#snippet previewImage()}
  <!-- The image must exist to report its natural size, so it is rendered before the frame can be measured. -->
  <img
    onload={onPreviewLoad}
    alt="Receipt preview"
    data-testid="receipt-preview"
    src={previewUrl ?? ""}
    draggable="false"
  />
{/snippet}

{#if !source}
  <p class="hint" data-testid="empty-state">No image yet.</p>
{:else}
  <div class="stage" aria-label="Receipt preview">
    {#if naturalWidth > 0}
      <div
        class="frame-outer"
        style={`width:${fit.outerWidth}px;height:${fit.outerHeight}px`}
        role="group"
        aria-label="Drag to crop"
        data-testid="preview-frame"
        onpointerdown={onPointerDown}
        onpointermove={onPointerMove}
        onpointerup={onPointerUp}
      >
        <div
          class="frame-inner"
          style={`width:${fit.innerWidth}px;height:${fit.innerHeight}px;transform:rotate(${rotationDegrees}deg)`}
        >
          {@render previewImage()}
          {#if crop}
            <div class="crop-box" style={overlayStyle} data-testid="crop-overlay"></div>
          {/if}
        </div>
      </div>
    {:else}
      {@render previewImage()}
    {/if}

    <div class="controls">
      <button type="button" data-testid="rotate-btn" onclick={rotate} disabled={busy}>
        Rotate 90°
      </button>
      <span data-testid="rotate-status">Rot {rotationDegrees}°</span>

      <button type="button" data-testid="contrast-minus" onclick={() => adjustContrast(-5)} disabled={busy || contrastPercent <= -CONTRAST_LIMIT_PERCENT}>
        −5%
      </button>
      <span data-testid="contrast-value">{contrastPercent}%</span>
      <button type="button" data-testid="contrast-plus" onclick={() => adjustContrast(5)} disabled={busy || contrastPercent >= CONTRAST_LIMIT_PERCENT}>
        +5%
      </button>

      <button type="button" data-testid="deskew-btn" onclick={deskew} disabled={busy || deskewStatus === "estimating" || deskewStatus === "applied"}>
        Deskew
      </button>
      <span data-testid="deskew-status">
        {deskewStatus === "applied"
          ? `Deskew applied ${deskewDegrees}°`
          : deskewStatus === "skipped"
            ? "Deskew skipped — skew could not be estimated"
            : deskewStatus === "estimating"
              ? "Estimating skew…"
              : "Deskew idle"}
      </span>

      <button type="button" data-testid="reset-crop" onclick={resetCrop} disabled={busy}>Reset crop</button>
      <span data-testid="crop-info">
        {crop ? `Crop ${crop.width} × ${crop.height} px` : "Full image"}
      </span>

      <button type="button" data-testid="process-btn" onclick={runOcr} disabled={busy}>
        {current ? "Re-run OCR" : "Run OCR"}
      </button>
    </div>

    {#if busy}
      <p class="hint" data-testid="busy-state">Running OCR on this device…</p>
    {/if}

    {#if current}
      <section class="draft-review" data-testid="draft-review">
        <h2 data-testid="review-title">Review extracted items and charges</h2>
        {#if previous}
          <p class="hint" data-testid="previous-parse-note">
            A previous parse is held. Accept replaces it; discard restores it.
          </p>
        {/if}

        <h3>Items</h3>
        <div data-testid="items-section">
          {#each current.items as item (item.id)}
            <div class="row" data-testid="item-row">
              <span class="row-name">{item.name}</span>
              {#if item.qty !== null}<span class="row-qty">qty {item.qty}</span>{/if}
              <span class="row-provenance" data-testid="provenance">
                {item.priceSource} · {item.quantitySource}
              </span>
              {#if item.confidence !== null}
                <span class="row-confidence">confidence {item.confidence.toFixed(2)}</span>
              {/if}
              {#each item.warnings as warning (warning.code)}
                <span class="badge" data-testid="warning-badge">{warning.code}</span>
              {/each}
            </div>
          {/each}
          {#if current.items.length === 0}
            <p class="critical" data-testid="zero-items-state">
              No items detected — this image produced no readable item rows.
            </p>
          {/if}
        </div>

        <h3>Charges</h3>
        <div data-testid="charges-section">
          {#each current.charges as charge, index (index)}
            <div class="row" data-testid="charge-row">
              <span class="row-name">{charge.label || "Unnamed charge"}</span>
              <span class="row-amount">{charge.amount === null ? "unresolved" : `${charge.amount} paise`}</span>
            </div>
          {/each}
          {#if current.charges.length === 0}
            <p class="hint">No charges detected.</p>
          {/if}
        </div>

        <div class="actions">
          <button type="button" data-testid="accept-btn" onclick={accept}>Accept and open bill</button>
          <button type="button" data-testid="discard-btn" onclick={discard}>
            {previous ? "Discard rerun and restore previous parse" : "Discard"}
          </button>
          <button type="button" data-testid="reprocess-btn" onclick={runOcr} disabled={busy}>Reprocess</button>
        </div>
      </section>
    {/if}
  </div>
{/if}

<style>
  .intake {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    margin: 8px 0 16px;
  }

  .stage {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .frame-outer {
    position: relative;
    margin: 0 auto;
    touch-action: none;
    cursor: crosshair;
  }

  .frame-inner {
    position: absolute;
    top: 50%;
    left: 50%;
    translate: -50% -50%;
    transform-origin: center;
  }

  .frame-inner img {
    width: 100%;
    height: 100%;
    display: block;
    user-select: none;
    border: 1px solid #dee2e6;
  }

  .crop-box {
    position: absolute;
    border: 2px dashed #3a7bd5;
    background: rgba(58, 123, 213, 0.08);
    pointer-events: none;
  }

  .controls {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
  }

  .draft-review {
    margin-top: 16px;
  }

  .row {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    align-items: baseline;
    border-bottom: 1px solid #eee;
    padding: 6px 0;
  }

  .row-provenance,
  .row-confidence,
  .row-qty,
  .row-amount {
    font-size: 0.8em;
    color: #555;
  }

  .badge {
    background: #fee2e2;
    color: #991b1b;
    border-radius: 3px;
    padding: 1px 6px;
    font-size: 0.7em;
  }

  .critical {
    background: #f8d7da;
    color: #842029;
    border: 1px solid #f5c6cb;
    border-radius: 4px;
    padding: 8px 12px;
  }

  .alert-error {
    background: #f8d7da;
    color: #842029;
    border: 1px solid #f5c6cb;
    border-radius: 4px;
    padding: 8px 12px;
  }

  .notice {
    background: #d1e7dd;
    color: #0f5132;
    border: 1px solid #badbcc;
    border-radius: 4px;
    padding: 8px 12px;
  }

  .hint {
    color: #666;
    font-size: 0.85em;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 16px;
  }
</style>
