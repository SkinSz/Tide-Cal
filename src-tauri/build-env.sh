#!/bin/bash
# Local (unprivileged) pkg-config environment for building the Tide Tauri shell.
# System devel RPMs are not installable without root, so headers/.pc files were
# extracted from Fedora RPMs into ~/.local/sysroot (+ pre-existing ~/.local/deps).
export PKG_CONFIG_PATH="\
/home/skins/.local/sysroot/usr/lib64/pkgconfig:\
/home/skins/.local/sysroot/usr/share/pkgconfig:\
/home/skins/.local/deps/usr/lib64/pkgconfig:\
/home/skins/.local/deps/usr/share/pkgconfig:\
/home/skins/.local/dbus/usr/lib64/pkgconfig:\
/usr/lib64/pkgconfig:/usr/share/pkgconfig"
exec "$@"
