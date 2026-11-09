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
  import { billStore, clearBillDocument } from "../lib/bill/bill-document.svelte.js";
  import { targetUrl } from "../lib/router.js";
  import type { ParseResult, ParseValidationResult, ParsedItem } from "@receipt-lens/core";
  import { draftChargesFromParse } from "../lib/bill/mapping.js";
  import type { DraftCharge } from "../lib/bill/working-bill.js";
  import { formatPaise } from "../lib/bill/paise-input.js";

  const VALIDATION_OPTIONS = {
    criticalOcrConfidenceFloor: 0.5,
    warningOcrConfidenceFloor: 0.7,
    strictArithmetic: true,
  } as const;

  const MAX_PREVIEW_PX = 560;

  type DeskewStatus = "idle" | "estimating" | "applied" | "skipped";

  interface ParseState {
    items: ParsedItem[];
    /** Typed charges — taxes included — so the review shows what the parse actually read. */
    charges: DraftCharge[];
    parse: ParseResult;
    validation: ParseValidationResult;
    /** The frame the parse's bounding boxes were measured in, for the editor's evidence overlay. */
    imageSize?: { width: number; height: number };
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

  /**
   * Ticket 14 (DECISIONS/0023 P6): the working copy the accepted parse came from — rotated, cropped,
   * contrast-adjusted — kept in memory only. The checkbox below decides whether it is *carried* into the
   * handoff; carrying it is still not storing it, because the byte only reaches IndexedDB after the bill's own
   * record has been written, and never at all unless this box was ticked.
   */
  let workingBlob = $state<Blob | null>(null);
  let keepPhoto = $state(false);

  let fileInput = $state<HTMLInputElement | null>(null);
  let fileHover = $state(false);

  /**
   * The confirm that stands between an edited bill and a new capture. The bill root is module-scope, so it
   * survives the route change; accepting a receipt while one is open would otherwise hand `/bill` the old
   * document. An untouched import (revision 0) is dropped silently — there is nothing to lose.
   */
  let pendingReplace = $state(false);

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
    workingBlob = null;
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

  function handleDrop(event: DragEvent): void {
    event.preventDefault();
    fileHover = false;
    const file = event.dataTransfer?.files?.[0];
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
      workingBlob = transformed.blob;
      current = {
        items: result.parse.items ?? [],
        charges: draftChargesFromParse(result.parse),
        parse: result.parse,
        validation: result.validation,
        imageSize: { width: transformed.width, height: transformed.height },
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
    // T5's identity rule, read the other way round: a bill already in memory came from a different capture.
    // Revision 0 means nobody has touched it, so discarding it costs nothing; above 0 the edits exist
    // nowhere else, so the creator is asked before they are thrown away.
    const open = billStore.document;
    if (open && open.revision > 0) {
      pendingReplace = true;
      return;
    }
    openAccepted();
  }

  /** Publishes the handoff the reviewer accepted, over a cleared root. */
  function openAccepted(): void {
    if (!current) return;
    clearBillDocument();
    setDraft(
      keepPhoto && workingBlob
        ? { ...current, retainedImage: { blob: workingBlob, mediaType: workingBlob.type || "image/jpeg" } }
        : current,
    );
    window.history.pushState({}, "", targetUrl("/bill", window.location.hash));
    window.dispatchEvent(new PopStateEvent("popstate"));
  }

  function confirmReplace(): void {
    pendingReplace = false;
    openAccepted();
  }

  function cancelReplace(): void {
    pendingReplace = false;
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

<div class="capture-page">
  <div class="capture-heading">
    <div class="capture-heading-copy">
      <p class="capture-eyebrow"><span class="eyebrow-mark"></span> THE FAIRER WAY TO SPLIT</p>
      <h1 class="visually-hidden">Capture</h1>
      <h2 class="capture-title">Split the bill.<br /><span>Keep your privacy.</span></h2>
      <p class="capture-note" data-testid="capture-note">
        Capture a receipt or choose a file, adjust it non-destructively, then review the extracted draft.
        The photo is read in your browser. {#if keepPhoto}This photo is kept on this device until you delete it.{:else}No photo is stored by default.{/if}
      </p>
    </div>
    <div class="capture-privacy-pill"><span class="status-dot"></span> On-device processing</div>
  </div>

  {#if pendingReplace}
    <div class="dialog-backdrop">
      <div
        class="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="unfinished-bill-title"
        data-testid="unfinished-bill-warning"
      >
        <h2 id="unfinished-bill-title">You have an unfinished bill</h2>
        <p>Discard it and start a new bill?</p>
        <p class="hint">
          The current bill keeps your edits. Starting over drops them from this screen; a bill already saved is
          still in your past bills.
        </p>
        <div class="actions">
          <button type="button" data-testid="unfinished-bill-cancel" onclick={cancelReplace}>Keep the current bill</button>
          <button type="button" data-testid="unfinished-bill-confirm" onclick={confirmReplace}>
            Discard and start a new bill
          </button>
        </div>
      </div>
    </div>
  {/if}

  <div class="capture-steps" aria-label="How receipt splitting works">
    <div class="capture-step active"><span class="step-number">01</span><span>Capture receipt</span></div>
    <span class="step-connector"></span>
    <div class="capture-step"><span class="step-number">02</span><span>Review items</span></div>
    <span class="step-connector"></span>
    <div class="capture-step"><span class="step-number">03</span><span>Split fairly</span></div>
  </div>

  <div class="capture-grid">
    <section class="capture-panel" aria-labelledby="capture-panel-title">
      <div class="capture-panel-head">
        <div>
          <span class="panel-step">STEP 01 <span>·</span> RECEIPT</span>
          <h2 id="capture-panel-title">Start with a receipt</h2>
          <p>Choose a clear photo so every line is easy to check.</p>
        </div>
        <span class="panel-private"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2.5 16 5v4.7c0 3.3-2.5 5.9-6 7.8-3.5-1.9-6-4.5-6-7.8V5l6-2.5Z"/><path d="m7.5 9.7 1.7 1.7 3.4-3.6"/></svg> Private</span>
      </div>

      {#if error}
        <div class="alert alert-error" role="alert" data-testid="capture-error">{error}</div>
      {/if}
      {#if notice}
        <div class="notice" data-testid="capture-notice">{notice}</div>
      {/if}

      <input
        class="visually-hidden"
        bind:this={fileInput}
        data-testid="file-input"
        type="file"
        accept={ACCEPT_ATTRIBUTE}
        onchange={handleFileSelect}
      />

      {#if !source}
        <div
          class="intake-dropzone"
          class:file-hover={fileHover}
          role="group"
          aria-label="Receipt image upload area"
          ondragenter={(event) => { event.preventDefault(); fileHover = true; }}
          ondragover={(event) => { event.preventDefault(); fileHover = true; }}
          ondragleave={() => (fileHover = false)}
          ondrop={handleDrop}
        >
          <div class="upload-icon" aria-hidden="true">
            <svg viewBox="0 0 48 48" fill="none"><path d="M14 8h15l8 8v23H14a4 4 0 0 1-4-4V12a4 4 0 0 1 4-4Z"/><path d="M29 8v9h8M18 26h14M18 32h10"/><path d="M24 19v6m-3-3 3-3 3 3"/></svg>
          </div>
          <h3>Drop your receipt here</h3>
          <p class="drop-helper">or browse a photo from your device</p>
          <div class="intake">
            <button type="button" class="button-primary" data-testid="choose-file" onclick={() => fileInput?.click()}>
              <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 13V3m0 0L6.5 6.5M10 3l3.5 3.5M4 12v4h12v-4"/></svg>
              Choose a photo
            </button>
            {#if cameraAvailable}
              <button type="button" class="button-secondary" data-testid="camera-btn" onclick={captureFromCamera}>
                <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 6h3l1.2-1.7h5.6L14 6h3v9H3V6Z"/><circle cx="10" cy="10.5" r="2.6"/></svg>
                Use camera
              </button>
            {/if}
          </div>
          {#if cameraDenied}
            <span class="hint camera-hint" data-testid="camera-denied">Camera unavailable — file selection still works.</span>
          {/if}
          <p class="format-hint">JPG, PNG or WebP <span>·</span> Your image stays on this device</p>
        </div>
        <p class="hint empty-state" data-testid="empty-state">No image yet.</p>
      {:else}
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

        <div class="preview-area">
          <div class="preview-meta"><span>RECEIPT PREVIEW</span><span class="preview-private"><span class="status-dot"></span> Stays on this device</span></div>
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
          </div>

          <!-- P6: default off, per capture, never remembered — a saved "always keep" would let one click on an
               unrelated screen flip the privacy default for every future receipt. -->
          <label class="retention" data-testid="keep-photo-row">
            <input type="checkbox" data-testid="keep-photo" bind:checked={keepPhoto} />
            <span>Keep this photo on this device</span>
          </label>
          <p class="hint retention-hint" data-testid="retention-hint">
            {#if keepPhoto}
              Stored in this browser only, beside the bill, and deletable from the bill. Never in a share link and
              never in a backup file.
            {:else}
              Off by default: the photo stays in memory for this session and is gone when you leave.
            {/if}
          </p>

          <div class="controls">
            <button type="button" data-testid="rotate-btn" onclick={rotate} disabled={busy}>Rotate 90°</button>
            <span data-testid="rotate-status">Rot {rotationDegrees}°</span>
            <button type="button" data-testid="contrast-minus" onclick={() => adjustContrast(-5)} disabled={busy || contrastPercent <= -CONTRAST_LIMIT_PERCENT}>−5%</button>
            <span data-testid="contrast-value">{contrastPercent}%</span>
            <button type="button" data-testid="contrast-plus" onclick={() => adjustContrast(5)} disabled={busy || contrastPercent >= CONTRAST_LIMIT_PERCENT}>+5%</button>
            <button type="button" data-testid="deskew-btn" onclick={deskew} disabled={busy || deskewStatus === "estimating" || deskewStatus === "applied"}>Deskew</button>
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
            <span data-testid="crop-info">{crop ? `Crop ${crop.width} × ${crop.height} px` : "Full image"}</span>
            <button type="button" class="button-primary" data-testid="process-btn" onclick={runOcr} disabled={busy}>
              {current ? "Re-run OCR" : "Run OCR"}
            </button>
          </div>
          {#if busy}
            <p class="hint busy-state" data-testid="busy-state"><span class="processing-dot"></span> Running OCR on this device…</p>
          {/if}
        </div>
      {/if}

      {#if current}
        <section class="draft-review" data-testid="draft-review">
          <div class="review-heading"><div><span class="panel-step">STEP 02 <span>·</span> REVIEW</span><h2 data-testid="review-title">Check what we found</h2></div><span class="review-count">{current.items.length} items</span></div>
          {#if previous}
            <p class="hint" data-testid="previous-parse-note">A previous parse is held. Accept replaces it; discard restores it.</p>
          {/if}
          <h3>Items</h3>
          <div class="review-rows" data-testid="items-section">
            {#each current.items as item (item.id)}
              <div class="row review-row" data-testid="item-row">
                <span class="row-name">{item.name}</span>
                {#if item.qty !== null}<span class="row-qty" data-testid="item-qty">qty {item.qty}</span>{/if}
                {#if item.unitPrice !== null}
                  <span class="row-rate" data-testid="item-rate">{formatPaise(item.unitPrice)} each</span>
                {/if}
                {#if item.lineTotal !== null}
                  <span class="row-total" data-testid="item-line-total">{formatPaise(item.lineTotal)}</span>
                {/if}
                <span class="row-provenance" data-testid="provenance">{item.priceSource} · {item.quantitySource}</span>
                {#if item.confidence !== null}<span class="row-confidence">confidence {item.confidence.toFixed(2)}</span>{/if}
                {#each item.warnings as warning (warning.code)}<span class="badge" data-testid="warning-badge">{warning.code}</span>{/each}
              </div>
            {/each}
            {#if current.items.length === 0}<p class="critical" data-testid="zero-items-state">No items detected — this image produced no readable item rows.</p>{/if}
          </div>
          <h3>Charges</h3>
          <div class="review-rows" data-testid="charges-section">
            {#each current.charges as charge (charge.id)}
              <div class="row review-row" data-testid="charge-row" data-charge-type={charge.type ?? "unresolved"}>
                <span class="row-name">{charge.label || "Unnamed charge"}</span>
                {#if charge.rate !== null && charge.rate !== undefined}
                  <span class="row-rate" data-testid="charge-rate">{charge.rate / 100}%</span>
                {/if}
                <span class="row-amount" data-testid="charge-amount">
                  {charge.amount === null ? "unresolved" : formatPaise(charge.amount)}
                </span>
                {#if charge.included === null && (charge.type === "tax" || charge.type === "service_charge" || charge.type === "tip" || charge.type === "other")}
                  <span class="row-provenance" data-testid="charge-inclusion">
                    inclusion unresolved — confirm in the bill
                  </span>
                {:else if charge.included === true}
                  <span class="row-provenance" data-testid="charge-inclusion">already in the prices</span>
                {/if}
              </div>
            {/each}
            {#if current.charges.length === 0}<p class="hint">No charges detected.</p>{/if}
          </div>
          <div class="actions">
            <button type="button" class="button-primary" data-testid="accept-btn" onclick={accept}>Accept and open bill</button>
            <button type="button" data-testid="discard-btn" onclick={discard}>{previous ? "Discard rerun and restore previous parse" : "Discard"}</button>
            <button type="button" data-testid="reprocess-btn" onclick={runOcr} disabled={busy}>Reprocess</button>
          </div>
        </section>
      {/if}
    </section>

    <aside class="capture-aside" aria-label="Receipt Lens privacy and process">
      <section class="aside-card privacy-aside-card">
        <div class="aside-card-top"><span class="aside-icon"><svg viewBox="0 0 24 24"><path d="M12 3 19 6v5.4c0 4.5-3 7.8-7 9.6-4-1.8-7-5.1-7-9.6V6l7-3Z"/><path d="m9 12 2 2 4-4"/></svg></span><span class="aside-card-label">BUILT FOR PRIVACY</span></div>
        <h3>Your receipt is yours.</h3>
        <p>OCR and bill calculations happen in your browser. Your image isn't uploaded to a server.</p>
        <div class="receipt-art" aria-hidden="true">
          <div class="receipt-art-shadow"></div>
          <div class="receipt-paper"><span class="receipt-logo-mark"></span><span class="receipt-line wide"></span><span class="receipt-line"></span><span class="receipt-line short"></span><span class="receipt-dash"></span><span class="receipt-total"><i></i><b></b></span></div>
          <span class="receipt-spark spark-one"></span><span class="receipt-spark spark-two"></span><span class="receipt-spark spark-three"></span>
          <div class="receipt-check">✓</div>
        </div>
        <div class="aside-card-foot"><span class="status-dot"></span> Image stays in your browser</div>
      </section>

      <section class="aside-card how-card">
        <div class="aside-card-label">THREE SIMPLE STEPS</div>
        <div class="how-step"><span>01</span><div><strong>Capture</strong><p>Choose a receipt photo</p></div><i class="step-done">✓</i></div>
        <div class="how-step"><span>02</span><div><strong>Review</strong><p>Check every detected line</p></div><i></i></div>
        <div class="how-step"><span>03</span><div><strong>Split</strong><p>Assign items to your people</p></div><i></i></div>
      </section>
      <p class="aside-footnote">No account. No cloud OCR. Just a clearer way to settle up.</p>
    </aside>
  </div>
</div>

<style>
  .capture-page { width: 100%; }
  .capture-heading { display: flex; align-items: flex-end; justify-content: space-between; gap: 20px; margin-bottom: 24px; }
  .capture-heading-copy { max-width: 650px; }
  .capture-eyebrow { display: flex; align-items: center; gap: 8px; margin: 0 0 10px !important; color: #788775 !important; font-size: 9px; font-weight: 760; letter-spacing: .15em; }
  .eyebrow-mark { width: 7px; height: 7px; border-radius: 2px; background: #a4d447; transform: rotate(45deg); }
  .capture-title { margin: 0 0 10px !important; color: #182a20 !important; font-size: clamp(34px, 4.3vw, 53px) !important; font-weight: 650 !important; line-height: 1.04; letter-spacing: -.065em !important; }
  .capture-title span { color: #74866c; }
  .capture-note { max-width: 590px; margin: 0 !important; color: #758078 !important; font-size: 13px; line-height: 1.65; }
  .capture-privacy-pill { display: inline-flex; flex: 0 0 auto; align-items: center; gap: 8px; margin-bottom: 8px; padding: 9px 12px; border: 1px solid #e0e9d2; border-radius: 999px; color: #506b44; background: #f0f6e7; font-size: 10px; font-weight: 650; }
  .capture-privacy-pill .status-dot { width: 6px; height: 6px; flex-basis: 6px; box-shadow: none; }
  .capture-steps { display: flex; align-items: center; gap: 13px; margin: 0 0 20px; padding: 13px 17px; border: 1px solid #e9ece5; border-radius: 14px; background: rgba(255,255,255,.72); }
  .capture-step { display: flex; align-items: center; gap: 8px; color: #98a19a; font-size: 10px; font-weight: 590; white-space: nowrap; }
  .capture-step.active { color: #35493a; }
  .step-number { display: grid; width: 22px; height: 22px; place-items: center; border: 1px solid #e2e6df; border-radius: 50%; color: #89948c; background: white; font-size: 9px; font-weight: 680; }
  .capture-step.active .step-number { border-color: #d8e8bf; color: #405a31; background: #edf6de; }
  .step-connector { flex: 1 1 auto; height: 1px; min-width: 16px; background: #e8ebe5; }
  .capture-grid { display: grid; grid-template-columns: minmax(0, 1.65fr) minmax(238px, .78fr); gap: 18px; align-items: start; }
  .capture-panel { min-width: 0; margin: 0 !important; padding: 25px; border: 1px solid #e8ebe4; border-radius: 20px; background: white; box-shadow: 0 15px 40px rgba(31,48,35,.055); }
  .capture-panel-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; margin-bottom: 20px; }
  .panel-step { display: block; margin-bottom: 7px; color: #71816f; font-size: 9px; font-weight: 760; letter-spacing: .13em; }
  .panel-step span { padding: 0 4px; color: #bac5b3; }
  .capture-panel-head h2, .review-heading h2 { margin: 0 0 4px !important; font-size: 20px !important; font-weight: 660 !important; }
  .capture-panel-head p { margin: 0 !important; color: #879188 !important; font-size: 11px; }
  .panel-private { display: inline-flex; align-items: center; gap: 5px; margin-top: 3px; padding: 6px 8px; border: 1px solid #edf0e9; border-radius: 99px; color: #71806d; font-size: 9px; font-weight: 650; white-space: nowrap; }
  .panel-private svg { width: 14px; height: 14px; fill: none; stroke: #79936a; stroke-width: 1.4; stroke-linecap: round; stroke-linejoin: round; }
  .intake-dropzone { display: flex; min-height: 305px; flex-direction: column; align-items: center; justify-content: center; padding: 26px 18px; border: 1.5px dashed #d9e2d2; border-radius: 16px; background: #fbfcf9; text-align: center; transition: border-color .18s ease, background .18s ease, box-shadow .18s ease; }
  .intake-dropzone.file-hover { border-color: #a4d447; background: #f5faea; box-shadow: inset 0 0 0 3px rgba(164,212,71,.08); }
  .upload-icon { display: grid; width: 60px; height: 60px; margin: 0 0 15px; place-items: center; border: 1px solid #e5ebde; border-radius: 18px; color: #526e47; background: #f2f6eb; box-shadow: 0 6px 16px rgba(52,81,44,.045); }
  .upload-icon svg { width: 37px; height: 37px; stroke: currentColor; stroke-width: 1.45; stroke-linecap: round; stroke-linejoin: round; }
  .intake-dropzone h3 { margin: 0 0 5px !important; color: #25352b !important; font-size: 16px !important; font-weight: 650; letter-spacing: -.035em; }
  .drop-helper { margin: 0 !important; color: #929c93 !important; font-size: 11px; }
  .intake { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; align-items: center; margin: 16px 0 0; }
  .intake-dropzone .button-primary, .capture-panel .actions .button-primary, .capture-panel .controls .button-primary { display: inline-flex; align-items: center; justify-content: center; gap: 8px; border-color: #1d3023; color: #f6f8f3; background: #1d3023; }
  .intake-dropzone .button-primary:hover, .capture-panel .actions .button-primary:hover, .capture-panel .controls .button-primary:hover { border-color: #304a35; color: white; background: #304a35; }
  .intake-dropzone .button-secondary { display: inline-flex; align-items: center; justify-content: center; gap: 7px; }
  .intake-dropzone button svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-linecap: round; stroke-linejoin: round; stroke-width: 1.5; }
  .format-hint { margin: 16px 0 0 !important; color: #a0a9a0 !important; font-size: 9px; }
  .format-hint span { padding: 0 4px; color: #c6cec3; }
  .camera-hint { margin-top: 9px; }
  .empty-state { margin: 10px 0 0 !important; text-align: center; font-size: 9px !important; }
  .capture-aside { display: grid; gap: 14px; }
  .aside-card { overflow: hidden; margin: 0 !important; padding: 18px; border: 1px solid #e8ebe4; border-radius: 18px; background: white; box-shadow: 0 12px 30px rgba(31,48,35,.04); }
  .privacy-aside-card { position: relative; padding-bottom: 14px; }
  .aside-card-top { display: flex; align-items: center; gap: 9px; }
  .aside-icon { display: grid; width: 31px; height: 31px; place-items: center; border-radius: 10px; color: #527047; background: #eff5e7; }
  .aside-icon svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
  .aside-card-label { color: #879486; font-size: 8px; font-weight: 760; letter-spacing: .13em; }
  .aside-card h3 { margin: 14px 0 6px !important; font-size: 18px !important; font-weight: 660; letter-spacing: -.045em; }
  .aside-card > p { margin: 0 !important; color: #808b82 !important; font-size: 10px; line-height: 1.6; }
  .receipt-art { position: relative; display: grid; height: 143px; margin: 7px -8px 5px; place-items: center; background: radial-gradient(ellipse at 51% 53%, #f3f7ea 0, #f8faf4 47%, transparent 72%); }
  .receipt-paper { position: relative; z-index: 1; display: flex; width: 87px; height: 115px; flex-direction: column; align-items: center; padding: 13px 11px; border: 1px solid #eaede4; border-radius: 7px 7px 3px 3px; background: #fff; box-shadow: 0 10px 22px rgba(39,58,41,.10); transform: rotate(-5deg); }
  .receipt-paper::after { position: absolute; right: 0; bottom: -5px; left: 0; height: 6px; background: linear-gradient(135deg, transparent 50%, #fff 50%) 0 0/9px 9px repeat-x; content: ""; }
  .receipt-logo-mark { width: 18px; height: 18px; margin-bottom: 9px; border: 1.4px solid #7e9a6b; border-radius: 50%; background: radial-gradient(circle, #b2d779 0 2px, transparent 3px); }
  .receipt-line { width: 100%; height: 3px; margin-top: 6px; border-radius: 4px; background: #e8ece5; }
  .receipt-line.wide { width: 80%; background: #cfd9c8; }
  .receipt-line.short { width: 54%; align-self: flex-start; }
  .receipt-dash { width: 100%; margin-top: 9px; border-top: 1px dashed #e0e6dc; }
  .receipt-total { display: flex; width: 100%; justify-content: space-between; margin-top: 8px; }
  .receipt-total i, .receipt-total b { display: block; height: 4px; border-radius: 4px; background: #879e74; }
  .receipt-total i { width: 19px; opacity: .45; }
  .receipt-total b { width: 25px; }
  .receipt-check { position: absolute; z-index: 2; right: calc(50% - 61px); bottom: 21px; display: grid; width: 27px; height: 27px; place-items: center; border: 3px solid white; border-radius: 50%; color: #263c2b; background: #c7eb78; font-size: 12px; font-weight: 800; box-shadow: 0 4px 12px rgba(50,78,39,.16); }
  .receipt-spark { position: absolute; width: 5px; height: 5px; border-radius: 50%; background: #b2d977; }
  .spark-one { top: 30px; left: 21%; }.spark-two { top: 54px; right: 18%; width: 4px; height: 4px; }.spark-three { bottom: 30px; left: 24%; width: 3px; height: 3px; }
  .aside-card-foot { display: flex; align-items: center; gap: 7px; padding-top: 11px; border-top: 1px solid #f0f1ed; color: #6e7e68; font-size: 9px; font-weight: 620; }
  .aside-card-foot .status-dot { width: 6px; height: 6px; flex-basis: 6px; box-shadow: none; }
  .how-card { padding: 18px 18px 8px; }
  .how-step { position: relative; display: flex; align-items: flex-start; gap: 11px; padding: 15px 0; border-bottom: 1px solid #f0f1ed; }
  .how-step:last-child { border: 0; }
  .how-step > span { display: grid; flex: 0 0 24px; width: 24px; height: 24px; place-items: center; border: 1px solid #e6eae2; border-radius: 50%; color: #778377; background: #fbfcf9; font-size: 8px; font-weight: 700; }
  .how-step:first-of-type > span { border-color: #deebcb; color: #526c43; background: #f0f6e7; }
  .how-step strong { display: block; margin-top: 1px; color: #39463b; font-size: 10px; font-weight: 680; }
  .how-step p { margin: 2px 0 0 !important; color: #969f97 !important; font-size: 9px; }
  .how-step i { display: block; width: 7px; height: 7px; margin: 8px 0 0 auto; border: 1px solid #dce2d9; border-radius: 50%; }
  .how-step .step-done { border: 0; color: #7fa546; font-size: 12px; font-style: normal; font-weight: 800; }
  .aside-footnote { margin: 0 5px !important; color: #a0a89f !important; font-size: 9px; line-height: 1.5; }
  .preview-area { padding: 15px; border: 1px solid #ebeee8; border-radius: 14px; background: #f8faf6; }
  .preview-meta { display: flex; align-items: center; justify-content: space-between; gap: 8px; color: #839081; font-size: 8px; font-weight: 730; letter-spacing: .09em; }
  .preview-private { display: inline-flex; align-items: center; gap: 6px; color: #72836e; font-size: 8px; font-weight: 620; letter-spacing: 0; }
  .preview-private .status-dot { width: 5px; height: 5px; flex-basis: 5px; box-shadow: none; }
  .stage { display: flex; min-height: 120px; flex-direction: column; align-items: center; justify-content: center; gap: 8px; padding: 14px; }
  .frame-outer { max-width: 100%; border-radius: 7px; box-shadow: 0 8px 22px rgba(38,52,39,.12); }
  .frame-inner img { border: 0 !important; border-radius: 7px; }
  .crop-box { border-color: #b4e45d !important; background: rgba(178,228,93,.12) !important; }
  .retention { display: flex; align-items: center; gap: 9px; margin-top: 12px; padding: 11px 12px; border: 1px solid #edf0e8; border-radius: 10px; background: #fff; color: #4e5f50; font-size: 10px; font-weight: 590; }
  .retention input { margin: 0; }
  .retention-hint { margin: 6px 2px 0 !important; font-size: 9px !important; line-height: 1.5; }
  .controls { display: flex; flex-wrap: wrap; gap: 7px; align-items: center; margin-top: 12px; }
  .controls button { min-height: 31px !important; padding: 6px 9px !important; border-radius: 8px !important; font-size: 9px !important; }
  .controls span { color: #8c958d; font-size: 9px; }
  .busy-state { display: flex; align-items: center; gap: 7px; margin: 11px 1px 0 !important; font-size: 10px !important; }
  .processing-dot { width: 7px; height: 7px; border-radius: 50%; background: #9ac94d; animation: pulse 1.1s ease-in-out infinite; }
  @keyframes pulse { 50% { opacity: .35; transform: scale(.75); } }
  .draft-review { margin-top: 22px; padding-top: 20px; border-top: 1px solid #ecefe9; }
  .review-heading { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  .review-count { padding: 6px 9px; border-radius: 99px; color: #677763; background: #f0f5e9; font-size: 9px; font-weight: 650; }
  .draft-review h3 { margin: 18px 0 7px !important; color: #758171 !important; font-size: 9px !important; font-weight: 750; letter-spacing: .1em; text-transform: uppercase; }
  .review-rows { border-top: 1px solid #eff1ed; }
  .review-row { display: grid !important; grid-template-columns: minmax(100px,1fr) auto auto auto; gap: 8px 12px !important; padding: 10px 2px !important; border-bottom: 1px solid #eff1ed !important; font-size: 10px; }
  .review-row .row-name { color: #3f4c40; font-weight: 620; }
  .review-row .row-provenance, .review-row .row-qty, .review-row .row-confidence, .review-row .row-amount { color: #89938a; font-size: 9px; }
  .draft-review .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }

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

  @media (max-width: 1050px) {
    .capture-grid { grid-template-columns: minmax(0, 1.35fr) minmax(220px, .8fr); gap: 14px; }
    .capture-panel { padding: 20px; }
  }

  @media (max-width: 900px) {
    .capture-grid { grid-template-columns: minmax(0, 1fr); }
    .capture-aside { grid-template-columns: repeat(2, minmax(0, 1fr)); align-items: start; }
    .aside-footnote { grid-column: 1 / -1; }
  }

  @media (max-width: 760px) {
    .capture-heading { align-items: flex-start; flex-direction: column; gap: 12px; margin-bottom: 20px; }
    .capture-privacy-pill { margin: 0; }
    .capture-panel { padding: 17px; }
    .intake-dropzone { min-height: 270px; }
    .capture-steps { gap: 8px; padding: 11px 10px; }
    .capture-step { gap: 6px; font-size: 9px; }
    .step-connector { min-width: 7px; }
  }

  @media (max-width: 520px) {
    .capture-aside { grid-template-columns: minmax(0, 1fr); }
    .capture-step { flex-direction: column; align-items: flex-start; gap: 4px; }
    .step-connector { align-self: center; margin-top: -12px; }
    .capture-steps { align-items: flex-start; }
    .capture-panel-head { gap: 8px; }
    .panel-private { padding: 5px 6px; font-size: 8px; }
    .preview-meta { align-items: flex-start; flex-direction: column; }
    .review-row { grid-template-columns: 1fr auto !important; }
    .review-row .row-rate, .review-row .row-total { grid-column: 1 / -1; }
  }
</style>
