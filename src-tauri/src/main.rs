#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! FloatView binary shim. All behavior lives in `lib.rs`.

fn main() {
    floatview::run()
}
