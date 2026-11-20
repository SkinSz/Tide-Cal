// Build identity (TD-104). The values are compiled in by `npm run
// sidecar:build` (scripts/build_sidecar.mjs, esbuild --define); in any other
// run (tests, ts source) they read "unknown".
declare const __TIDE_BUILD_COMMIT__: string;
declare const __TIDE_BUILD_DIRTY__: boolean;
declare const __TIDE_BUILD_LABEL__: string;
declare const __TIDE_VERSION__: string;

export interface BuildInfo {
  version: string;
  commit: string;
  dirty: boolean;
  label: string;
}

export function getBuildInfo(): BuildInfo {
  return {
    version: typeof __TIDE_VERSION__ !== "undefined" ? __TIDE_VERSION__ : "unknown",
    commit: typeof __TIDE_BUILD_COMMIT__ !== "undefined" ? __TIDE_BUILD_COMMIT__ : "unknown",
    dirty: typeof __TIDE_BUILD_DIRTY__ !== "undefined" ? __TIDE_BUILD_DIRTY__ : false,
    label: typeof __TIDE_BUILD_LABEL__ !== "undefined" ? __TIDE_BUILD_LABEL__ : "unknown",
  };
}
