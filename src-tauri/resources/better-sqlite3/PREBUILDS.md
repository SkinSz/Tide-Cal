# better-sqlite3 vendored prebuilds — platform map

The bundle ships ONE vendored better-sqlite3 tree
(`src-tauri/resources/better-sqlite3/`, mapped to `node_modules/better-sqlite3/`
inside the app resources, tauri.conf.json §resources). The `.node` binaries
below are the ABI-pinned prebuilds for the pinned runtime.

| Path | Platform / ABI | Origin | sha256 (first 16) |
|---|---|---|---|
| build/Release/better_sqlite3.node | linux-x64, node NODE_MODULE_VERSION 147 (Node 24/26 ABI line) | npm better-sqlite3@12.11.1 install (fork prebuild) | 64bb95e1… (ELF x86-64) |
| `build/win32-x64-147/better_sqlite3.node` | win32-x64, NODE_MODULE_VERSION 147 (**= Node 26**; Node 24 = 137) | WiseLibs/better-sqlite3 release v12.11.1 asset `better-sqlite3-v12.11.1-node-v147-win32-x64.tar.gz` | 1aabe4eeb892f089… (PE32+ x86-64 DLL) |

Full sha256 of the win32 prebuild:
1aabe4eeb892f0899e7bc9682c1ab3f5168ac02d08a9d4aa5f5828ece227e0dc

Rules (DC-24 §4.4):
- Prebuild ABI MUST match the bundled node.exe's NODE_MODULE_VERSION at
  build time. Verify with `node -p process.versions.modules` on the build
  host's pinned Node and re-download the matching `-node-vXXX-win32-x64`
  asset if the runtime moves.
- Version 12.x line is REQUIRED (the v13 cross-platform segfault class,
  TD-025). Never upgrade past 12.x without a new gate round.
- Re-verify the prebuild actually LOADS on the bundled node.exe before
  shipping (DC-24 §4.4 acceptance: `node -e "require('better-sqlite3')"`
  from the staged bundle tree on a Windows machine / CI job).
