(() => {
  "use strict";
  try {
    if (localStorage.getItem("abl.featuresExpanded") === "0") {
      document.documentElement.classList.add("features-collapsed");
    }
  } catch {
    // ignore
  }
})();
