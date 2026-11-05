<script lang="ts">
  import { installBannerState, setInstallBanner } from "../lib/models/model-state.svelte.js";
  import {
    INSTALL_BANNER_STORAGE_KEY,
    consumeInstallPrompt,
    dismissInstallBanner,
    installBannerCopy,
    shouldShowInstallBanner,
    type BannerStorage,
  } from "../lib/sw/install-banner.js";

  /**
   * Ticket 17 — the install banner (DECISIONS/0027 W12).
   *
   * The browser's half of installability is not provable here: headless Chromium fires no
   * `beforeinstallprompt` at all, so this component's own behaviour is pinned against a fabricated event in
   * `offline-reload.spec.ts`, and whether a real browser offers the install is a declared manual check (W20).
   * The words come from `installBannerCopy()`, never from markup, because W12.1 pins them.
   */

  const storage: BannerStorage = {
    get: (key) => localStorage.getItem(key),
    set: (key, value) => localStorage.setItem(key, value),
    remove: (key) => localStorage.removeItem(key),
  };

  interface PromptEvent extends Event {
    prompt(): Promise<void>;
  }

  let deferred: PromptEvent | null = null;

  function dismissedAt(): number | null {
    const raw = localStorage.getItem(INSTALL_BANNER_STORAGE_KEY);
    return raw === null ? null : Number(raw);
  }

  function refresh(): void {
    const visible = shouldShowInstallBanner({
      eventSeen: deferred !== null,
      dismissedAt: dismissedAt(),
      now: Date.now(),
      // An app window already installed: offering install there is noise.
      displayMode: window.matchMedia("(display-mode: standalone)").matches ? "standalone" : "browser",
    });
    setInstallBanner(visible ? installBannerCopy() : null);
  }

  function onDismiss(): void {
    dismissInstallBanner(storage, Date.now());
    refresh();
  }

  async function onInstall(): Promise<void> {
    if (!deferred) return;
    const event = deferred;
    deferred = null;
    consumeInstallPrompt(storage);
    await event.prompt();
    refresh();
  }

  function onBeforeInstallPrompt(event: Event): void {
    event.preventDefault();
    deferred = event as PromptEvent;
    refresh();
  }

  $effect(() => {
    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    refresh();
    return () => window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
  });
</script>

{#if installBannerState()}
  <aside id="install-banner" data-install-banner role="note">
    <p>{installBannerState()?.headline}</p>
    <button type="button" data-install-prompt onclick={onInstall}>{installBannerState()?.install}</button>
    <button type="button" data-install-dismiss onclick={onDismiss}>{installBannerState()?.dismiss}</button>
  </aside>
{/if}
