export interface DesktopConfig {
  sidecarBaseUrl: string;
  platform: "browser" | "tauri";
}

declare global {
  interface Window {
    __OCTO_DESKTOP_CONFIG__?: Partial<DesktopConfig>;
    __TAURI__?: unknown;
  }
}

function normalizeUrl(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const normalized = value.trim().replace(/\/+$/, "");
  return normalized || null;
}

export function getDesktopConfig(): DesktopConfig {
  if (typeof window === "undefined") {
    return {
      sidecarBaseUrl: "http://127.0.0.1:4317",
      platform: "browser",
    };
  }

  const queryUrl = normalizeUrl(
    new URLSearchParams(window.location.search).get("desktopBaseUrl"),
  );
  const injectedUrl = normalizeUrl(window.__OCTO_DESKTOP_CONFIG__?.sidecarBaseUrl);

  return {
    sidecarBaseUrl: injectedUrl ?? queryUrl ?? "http://127.0.0.1:4317",
    platform: window.__OCTO_DESKTOP_CONFIG__?.platform
      ?? (window.__TAURI__ ? "tauri" : "browser"),
  };
}
