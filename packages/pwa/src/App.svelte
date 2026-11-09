<script lang="ts">
  import { onMount } from "svelte";
  import { resolveLocation, targetUrl, ROUTE_PATHS, type RouteName } from "./lib/router.js";
  import Capture from "./routes/Capture.svelte";
  import Bill from "./routes/Bill.svelte";
  import Bills from "./routes/Bills.svelte";
  import StorageStatus from "./components/StorageStatus.svelte";
  import Share from "./routes/Share.svelte";
  import InstallBanner from "./components/InstallBanner.svelte";
  import ModelStatus from "./components/ModelStatus.svelte";
  import { onRouteChange } from "./lib/models/model-state.svelte.js";
  import NotFound from "./routes/NotFound.svelte";

  let route = $state<RouteName>("capture");
  let fragment = $state("");
  let renders = $state(0);

  // One read of the location into shell state. It is also the render counter: DECISIONS/0017 D3a
  // condition 1 is proved by this number advancing on a hash change while the document does not change.
  function sync(): void {
    const resolved = resolveLocation(window.location);
    route = resolved.route;
    fragment = resolved.fragment;
    renders += 1;
    // DECISIONS/0027 W2.1 (ruled): `/capture` is the only route that may prepare a model set. Every other
    // route reaches this same function and is refused by the trigger predicate, so a `/share` recipient or a
    // ledger browser never downloads weights.
    onRouteChange(route);
  }

  function go(pathname: string): void {
    // targetUrl carries the fragment through the path change byte-for-byte (D3a condition 3),
    // by concatenation — never through a URL object, which would re-encode it.
    window.history.pushState({}, "", targetUrl(pathname, fragment));
    sync();
  }

  function onNavClick(event: MouseEvent, pathname: string): void {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    go(pathname);
  }

  onMount(() => {
    sync();
    window.addEventListener("hashchange", sync);
    window.addEventListener("popstate", sync);
    return () => {
      window.removeEventListener("hashchange", sync);
      window.removeEventListener("popstate", sync);
    };
  });
</script>

<div class="app-shell">
  <aside class="sidebar">
    <a class="brand" id="shell-wordmark" href={ROUTE_PATHS.capture} onclick={(e) => onNavClick(e, ROUTE_PATHS.capture)}>
      <span class="brand-mark" aria-hidden="true">
        <svg viewBox="0 0 36 36" fill="none">
          <path d="M7 10.5h5l2-3h8l2 3h5.5v17H7v-17Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" />
          <circle cx="18" cy="19" r="5.1" stroke="currentColor" stroke-width="1.7" />
          <circle cx="18" cy="19" r="1.5" fill="currentColor" />
          <path d="M26.2 14h.1" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" />
        </svg>
      </span>
      <span class="brand-name">receipt-lens</span>
    </a>

    <div class="sidebar-caption">PRIVATE BILL SPLITTER</div>
    <nav aria-label="Views" id="shell-nav" class="side-nav">
      <a href={ROUTE_PATHS.capture} data-nav="capture" aria-current={route === "capture" ? "page" : undefined} class:active={route === "capture"} onclick={(e) => onNavClick(e, ROUTE_PATHS.capture)}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7.5h4l1.5-2h5l1.5 2h4v11H4v-11Z" /><circle cx="12" cy="13" r="3.2" /></svg>
        <span>Capture</span><span class="nav-plus" aria-hidden="true">+</span>
      </a>
      <a href={ROUTE_PATHS.bill} data-nav="bill" aria-current={route === "bill" ? "page" : undefined} class:active={route === "bill"} onclick={(e) => onNavClick(e, ROUTE_PATHS.bill)}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 4.5h12v15l-2-1.4-2 1.4-2-1.4-2 1.4-2-1.4-2 1.4v-15Z" /><path d="M9 9h6M9 12.5h6M9 16h3" /></svg>
        <span>Bill</span>
      </a>
      <a href={ROUTE_PATHS.bills} data-nav="bills" aria-current={route === "bills" ? "page" : undefined} class:active={route === "bills"} onclick={(e) => onNavClick(e, ROUTE_PATHS.bills)}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7.5h14M7 4.5h10v15H7zM9.5 11h5M9.5 14.5h5" /></svg>
        <span>Past bills</span>
      </a>
      <a href={ROUTE_PATHS.share} data-nav="share" aria-current={route === "share" ? "page" : undefined} class:active={route === "share"} onclick={(e) => onNavClick(e, ROUTE_PATHS.share)}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="18" cy="5.5" r="2.5" /><circle cx="6" cy="12" r="2.5" /><circle cx="18" cy="18.5" r="2.5" /><path d="m8.2 10.8 7.5-4M8.2 13.2l7.5 4" /></svg>
        <span>Share</span>
      </a>
    </nav>

    <div class="sidebar-bottom">
      <div class="privacy-card">
        <span class="privacy-card-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24"><path d="M12 3 19 6v5.4c0 4.5-3 7.8-7 9.6-4-1.8-7-5.1-7-9.6V6l7-3Z" /><path d="m9 12 2 2 4-4" /></svg>
        </span>
        <div>
          <strong>Private by default</strong>
          <p>Your receipt stays on this device.</p>
        </div>
      </div>
      <div class="sidebar-footnote"><span class="status-dot"></span> No account needed</div>
    </div>
  </aside>

  <div class="main-column">
    <header class="topbar">
      <div class="topbar-context">
        <span class="topbar-kicker">YOUR WORKSPACE</span>
        <span class="topbar-divider">/</span>
        <span>{route === "capture" ? "New split" : route === "bill" ? "Bill" : route === "bills" ? "Past bills" : route === "share" ? "Shared bill" : "Not found"}</span>
      </div>
      <div class="topbar-private"><span class="status-dot"></span><span>Processed on your device</span></div>
    </header>

    <InstallBanner />
    {#if route !== "share"}
      <!-- Ticket 17: like the storage screens below, the model cache is shell state, not a condition of one view.
           It is absent on /share for the same reason DECISIONS/0023 gives — a recipient has no model history on
           this device and must not be told about one. -->
      <ModelStatus />
      <!-- Ticket 14: the storage screens are shell-level, because a migration gate or a full disk is not a
           condition of any one view — and /share must not show them (a recipient has no ledger on this device). -->
      <StorageStatus />
    {/if}

    <main id="shell-view" data-route={route} data-renders={renders} data-fragment-length={fragment.length}>
      {#if route === "capture"}
        <Capture />
      {:else if route === "bill"}
        <Bill />
      {:else if route === "bills"}
        <Bills />
      {:else if route === "share"}
        <Share {fragment} />
      {:else}
        <NotFound {fragment} />
      {/if}
    </main>
    <footer class="app-footer"><span>receipt-lens</span><span>Thoughtfully split. Locally processed.</span></footer>
  </div>
</div>
