/* HCG Store: apply the visitor's saved theme before the first paint. Same keys and IDs as src/theme/theme.ts. */
(function () {
  var ids = ["sovereign", "cyberpunk", "crimson", "founder", "frost", "horizon"];
  var root = document.documentElement;
  root.setAttribute("data-theme", "sovereign");
  root.setAttribute("data-effects", "on");
  try {
    var t = window.localStorage.getItem("hcg-store.theme");
    if (t && ids.indexOf(t) >= 0) root.setAttribute("data-theme", t);
    if (window.localStorage.getItem("hcg-store.effects") === "off") root.setAttribute("data-effects", "off");
  } catch (e) {
    /* storage unavailable: defaults */
  }
})();
