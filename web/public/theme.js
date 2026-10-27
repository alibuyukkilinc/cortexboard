// The viewer's chosen theme, applied before the board paints (no flash). A file, not an inline script,
// so the page's Content-Security-Policy can allow scripts from this origin only.
try {
  var t = localStorage.getItem("cortex.theme");
  if (t) document.documentElement.dataset.theme = t;
} catch (e) {}
