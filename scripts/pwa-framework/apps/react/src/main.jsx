import { createRoot } from "react-dom/client";
import { HashRouter, BrowserRouter, Routes, Route, Link, useLocation } from "react-router";
import Capture from "./routes/Capture.jsx";
import Bill from "./routes/Bill.jsx";
import Share from "./routes/Share.jsx";

window.__probe = { rawHash: "", routeParam: "", ocr: "idle", parsed: null, error: null };

const Router = import.meta.env.VITE_ROUTER_MODE === "hash" ? HashRouter : BrowserRouter;

function HashSync() {
  const location = useLocation();
  window.__probe.rawHash = window.location.hash;
  window.__probe.routePath = location.pathname;
  return null;
}

function Nav() {
  return (
    <nav>
      <Link to="/">capture</Link>
      <Link to="/bill">bill</Link>
      <Link to="/share">share</Link>
    </nav>
  );
}

createRoot(document.getElementById("app")).render(
  <Router>
    <HashSync />
    <Nav />
    <Routes>
      <Route path="/" element={<Capture />} />
      <Route path="/bill" element={<Bill />} />
      <Route path="/share" element={<Share />} />
      <Route path="/v1/:payload" element={<Share />} />
    </Routes>
  </Router>
);

window.__probeMounted = true;
