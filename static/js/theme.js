// =========================================================================
// VERIFACE LIQUID GLASS - PERSISTENT THEME & DARK MODE MANAGER
// =========================================================================

(function() {
  // Execute immediately in <head> to eliminate Flash of Unstyled Theme (FOUT)
  try {
    const savedTheme = localStorage.getItem("veriface_theme");
    const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    if (savedTheme === "dark" || (!savedTheme && prefersDark)) {
      document.documentElement.classList.add("dark");
    } else {
      document.documentElement.classList.remove("dark");
    }
  } catch (e) {
    console.warn("Theme initialization error:", e);
  }
})();

function toggleTheme() {
  const isDark = document.documentElement.classList.toggle("dark");
  try {
    localStorage.setItem("veriface_theme", isDark ? "dark" : "light");
  } catch (e) {}
  updateThemeUI();
}

function updateThemeUI() {
  const isDark = document.documentElement.classList.contains("dark");
  const toggles = document.querySelectorAll(".theme-toggle-btn");
  toggles.forEach(btn => {
    btn.setAttribute("title", isDark ? "Switch to Light Mode" : "Switch to Dark Mode");
    btn.setAttribute("aria-label", isDark ? "Switch to Light Mode" : "Switch to Dark Mode");
    const iconContainer = btn.querySelector(".theme-icon-container") || btn;
    if (isDark) {
      iconContainer.innerHTML = '<i data-lucide="sun" class="w-4 h-4 text-amber-300"></i>';
    } else {
      iconContainer.innerHTML = '<i data-lucide="moon" class="w-4 h-4 text-slate-700"></i>';
    }
  });

  if (window.lucide && typeof lucide.createIcons === "function") {
    lucide.createIcons();
  }
}

// =========================================================================
// MOBILE & DESKTOP NAVIGATION SIDE PORTAL / OFF-CANVAS DRAWER CONTROLLER
// =========================================================================
function openMobileDrawer() {
  const backdrop = document.getElementById("mobileDrawerBackdrop");
  const drawer = document.getElementById("mobileDrawer");
  if (backdrop && drawer) {
    backdrop.classList.add("active");
    drawer.classList.add("active");
    backdrop.classList.remove("pointer-events-none", "opacity-0", "hidden");
    drawer.classList.remove("translate-x-full", "hidden");
    document.body.style.overflow = "hidden";
  }
  if (window.lucide && typeof lucide.createIcons === "function") {
    lucide.createIcons();
  }
}

function closeMobileDrawer() {
  const backdrop = document.getElementById("mobileDrawerBackdrop");
  const drawer = document.getElementById("mobileDrawer");
  if (backdrop && drawer) {
    backdrop.classList.remove("active");
    drawer.classList.remove("active");
    document.body.style.overflow = "";
  }
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closeMobileDrawer();
  }
});

document.addEventListener("DOMContentLoaded", () => {
  updateThemeUI();

  // Register Progressive Web App (PWA) Service Worker
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/static/sw.js").then(
        (reg) => {
          console.log("VeriFace PWA Service Worker registered with scope:", reg.scope);
        },
        (err) => {
          console.warn("VeriFace PWA Service Worker registration failed:", err);
        }
      );
    });
  }
});
