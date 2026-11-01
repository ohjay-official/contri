//! A bump allocator for the wasm build.
//!
//! Every NEAR call runs in a fresh wasm instance that lives for one call, so
//! memory never has to be handed back: allocation just moves a pointer
//! forward and grows memory when needed. That is smaller and cheaper in gas
//! than a general-purpose allocator. A call that kept allocating would hit
//! NEAR's memory limit and fail cleanly; Contri's calls use a few hundred KB
//! at most.

use core::alloc::{GlobalAlloc, Layout};
use core::arch::wasm32::{memory_grow, memory_size};
use core::cell::UnsafeCell;

const PAGE: usize = 64 * 1024;

struct Bump {
    /// Next free address. 0 until the first allocation.
    next: UnsafeCell<usize>,
}

// One thread per wasm instance.
unsafe impl Sync for Bump {}

#[global_allocator]
static ALLOCATOR: Bump = Bump { next: UnsafeCell::new(0) };

unsafe impl GlobalAlloc for Bump {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let next = &mut *self.next.get();
        if *next == 0 {
            // Start after everything the module already uses (data and stack).
            *next = memory_size(0) * PAGE;
        }
        let start = (*next + layout.align() - 1) & !(layout.align() - 1);
        let Some(end) = start.checked_add(layout.size()) else {
            return core::ptr::null_mut();
        };
        let available = memory_size(0) * PAGE;
        if end > available && memory_grow(0, (end - available).div_ceil(PAGE)) == usize::MAX {
            return core::ptr::null_mut();
        }
        *next = end;
        start as *mut u8
    }

    unsafe fn dealloc(&self, _ptr: *mut u8, _layout: Layout) {}
}
